/**
 * In-process stand-in for the PayPal sandbox REST API: used by the test suite and,
 * with FAKE_PAYPAL=1, for running locally without sandbox credentials. It honours
 * PayPal-Request-Id idempotency and can simulate declines, timeouts and expiry.
 */
import express, { Router } from "express";
import { randomBytes } from "node:crypto";

type Knobs = {
  capture: "ok" | "decline" | "timeout_after_capture" | "server_error";
  void: "ok" | "timeout_after_void";
  reauthorize: "ok" | "fail";
  delayMs: number;
  authExpiresInMs: number;
};

export function createFakePayPal() {
  const orders = new Map<string, any>();
  const auths = new Map<string, { id: string; orderId: string; status: string; expiration_time: string; amount: any }>();
  const idem = new Map<string, { status: number; body: any }>();
  const calls: { method: string; path: string; requestId?: string }[] = [];
  const knobs: Knobs = { capture: "ok", void: "ok", reauthorize: "ok", delayMs: 1500, authExpiresInMs: 29 * 86400_000 };
  const id = (p: string) => p + randomBytes(6).toString("hex").toUpperCase();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const r = Router();
  r.use(express.json());
  r.use((req, _res, next) => {
    calls.push({ method: req.method, path: req.path, requestId: req.header("PayPal-Request-Id") });
    next();
  });
  /** Replay the stored response for a repeated PayPal-Request-Id. */
  const idempotent = (handler: (req: express.Request) => Promise<{ status: number; body: any; delayAfter?: number }>) =>
    async (req: express.Request, res: express.Response) => {
      const key = `${req.path}|${req.header("PayPal-Request-Id") ?? id("NOKEY")}`;
      const prev = idem.get(key);
      if (prev) return void res.status(prev.status).json(prev.body);
      const out = await handler(req);
      if (out.status < 500) idem.set(key, { status: out.status, body: out.body });
      if (out.delayAfter) await sleep(out.delayAfter);
      if (out.status === 204) return void res.sendStatus(204);
      res.status(out.status).json(out.body);
    };
  const err = (status: number, issue: string) => ({ status, body: { name: status === 404 ? "RESOURCE_NOT_FOUND" : "UNPROCESSABLE_ENTITY", details: [{ issue }] } });
  const orderView = (o: any) => ({ ...o, purchase_units: o.purchase_units.map((pu: any) => ({ ...pu, payments: { authorizations: o.authIds.map((a: string) => ({ ...auths.get(a)! })), captures: o.captures } })), authIds: undefined, captures: undefined });

  r.post("/v1/oauth2/token", (_req, res) => void res.json({ access_token: "fake-token", expires_in: 32400 }));

  r.post("/v2/checkout/orders", idempotent(async (req) => {
    const pu = req.body.purchase_units[0];
    const o = { id: id("ORD"), intent: req.body.intent, status: "CREATED", purchase_units: [{ ...pu, payee: pu.payee ?? { email_address: "self-merchant@fake.test" } }], authIds: [] as string[], captures: [] as any[] };
    orders.set(o.id, o);
    return { status: 201, body: orderView(o) };
  }));
  r.get("/v2/checkout/orders/:id", (req, res) => {
    const o = orders.get(req.params.id);
    if (!o) return void res.status(404).json(err(404, "INVALID_RESOURCE_ID").body);
    res.json(orderView(o));
  });
  /** Fake-only: stands in for the buyer approving in the PayPal popup. */
  r.post("/v2/checkout/orders/:id/approve", (req, res) => {
    const o = orders.get(req.params.id);
    if (!o) return void res.sendStatus(404);
    if (o.status === "CREATED") o.status = "APPROVED";
    res.json(orderView(o));
  });
  r.post("/v2/checkout/orders/:id/authorize", idempotent(async (req) => {
    const o = orders.get(req.params.id as string);
    if (!o) return err(404, "INVALID_RESOURCE_ID");
    if (o.authIds.length) return err(422, "ORDER_ALREADY_AUTHORIZED");
    if (o.status !== "APPROVED") return err(422, "ORDER_NOT_APPROVED");
    const a = { id: id("AUTH"), orderId: o.id, status: "CREATED", expiration_time: new Date(Date.now() + knobs.authExpiresInMs).toISOString(), amount: o.purchase_units[0].amount };
    auths.set(a.id, a);
    o.authIds.push(a.id);
    o.status = "COMPLETED";
    return { status: 201, body: orderView(o) };
  }));
  r.post("/v2/payments/authorizations/:id/capture", idempotent(async (req) => {
    const a = auths.get(req.params.id as string);
    if (!a) return err(404, "INVALID_RESOURCE_ID");
    if (a.status === "CAPTURED") return err(422, "AUTHORIZATION_ALREADY_CAPTURED");
    if (a.status !== "CREATED") return err(422, `AUTHORIZATION_${a.status}`);
    if (knobs.capture === "server_error") return { status: 500, body: { name: "INTERNAL_SERVER_ERROR" } };
    const o = orders.get(a.orderId);
    const cap = { id: id("CAP"), status: knobs.capture === "decline" ? "DECLINED" : "COMPLETED", amount: a.amount, final_capture: true, invoice_id: req.body.invoice_id };
    o.captures.push(cap);
    if (cap.status === "COMPLETED") a.status = "CAPTURED";
    return { status: 201, body: cap, delayAfter: knobs.capture === "timeout_after_capture" ? knobs.delayMs : 0 };
  }));
  r.post("/v2/payments/authorizations/:id/void", idempotent(async (req) => {
    const a = auths.get(req.params.id as string);
    if (!a) return err(404, "INVALID_RESOURCE_ID");
    if (a.status !== "CREATED") return err(422, "AUTHORIZATION_ALREADY_" + a.status);
    a.status = "VOIDED";
    return { status: 204, body: null, delayAfter: knobs.void === "timeout_after_void" ? knobs.delayMs : 0 };
  }));
  r.post("/v2/payments/authorizations/:id/reauthorize", idempotent(async (req) => {
    const a = auths.get(req.params.id as string);
    if (!a) return err(404, "INVALID_RESOURCE_ID");
    if (knobs.reauthorize === "fail") return err(422, "REAUTHORIZATION_TOO_SOON");
    const n = { id: id("AUTH"), orderId: a.orderId, status: "CREATED", expiration_time: new Date(Date.now() + knobs.authExpiresInMs).toISOString(), amount: a.amount };
    auths.set(n.id, n);
    orders.get(a.orderId).authIds.push(n.id);
    return { status: 201, body: n };
  }));

  return {
    router: r,
    knobs,
    calls,
    orders,
    auths,
    approve: (orderId: string) => {
      const o = orders.get(orderId);
      if (o && o.status === "CREATED") o.status = "APPROVED";
    },
    tamper: (orderId: string, fn: (pu: any) => void) => fn(orders.get(orderId).purchase_units[0]),
    expire: (authId: string) => {
      const a = auths.get(authId)!;
      a.status = "EXPIRED";
      a.expiration_time = new Date(Date.now() - 1000).toISOString();
    },
  };
}
