import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, lockAndFund, passRun, state, ops, sleep, createMilestone, PAYEE } from "./helpers.ts";
import * as payments from "../src/services/paymentService.ts";
import { transition } from "../src/services/milestoneService.ts";
import { MilestoneState as S } from "../src/domain/milestoneState.ts";
import { approve, editAgreement, getAgreement, setProposal } from "../src/services/agreementService.ts";
import { templateProposal } from "../src/checks/catalog.ts";
import { getDb } from "../src/db/migrate.ts";

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.close();
});

const accept = async (id: string) => {
  transition(id, "ACCEPT", "client");
  await payments.capture(id);
};
const captureCalls = () => env.fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/capture"));

describe("payment and state", () => {
  it("an order PayPal deleted (never approved, expired) is replaced; a live one is reused", async () => {
    const id = createMilestone();
    setProposal(id, templateProposal("contact form"), "test");
    const v = getAgreement(id)!.version;
    approve(id, "client", v, () => {});
    approve(id, "freelancer", v, () => payments.queueOrderInLockTx(id));
    const first = await payments.ensureOrder(id);
    expect(await payments.ensureOrder(id)).toBe(first); // still live at PayPal: reused
    env.fake.orders.delete(first); // PayPal expires unapproved orders after a few hours
    const second = await payments.ensureOrder(id);
    expect(second).not.toBe(first);
    expect(ops(id).filter((o: any) => o.type === "create_order").map((o: any) => o.idempotency_key)).toEqual([`${id}:create_order:1`, `${id}:create_order:2`]);
    env.fake.approve(second);
    expect(await payments.authorize(id, second)).toBe(S.FUNDED);
  });

  it("happy path: lock → fund → review → accept → CAPTURED, with PayPal's capture id", async () => {
    const { id, orderId } = await lockAndFund(env.fake);
    expect(state(id)).toBe(S.FUNDED);
    const order = env.fake.orders.get(orderId);
    expect(order.purchase_units[0].custom_id).toBe(getAgreement(id)!.hash);
    expect(order.purchase_units[0].payee.email_address).toBe(PAYEE);
    passRun(id);
    await accept(id);
    expect(state(id)).toBe(S.CAPTURED);
    const cap = ops(id, "capture")[0];
    expect(cap.status).toBe("SUCCEEDED");
    expect(cap.paypal_ref).toMatch(/^CAP/);
  });

  it("duplicate Accept does not capture twice", async () => {
    const { id } = await lockAndFund(env.fake);
    passRun(id);
    await accept(id);
    await expect(accept(id)).rejects.toMatchObject({ status: 409 });
    await expect(payments.capture(id)).rejects.toMatchObject({ status: 409 });
    expect(captureCalls()).toHaveLength(1);
    expect(ops(id, "capture")).toHaveLength(1);
  });

  it("two concurrent Accept requests create one capture operation", async () => {
    const { id } = await lockAndFund(env.fake);
    passRun(id);
    const results = await Promise.allSettled([accept(id), accept(id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(ops(id, "capture")).toHaveLength(1);
    expect(captureCalls()).toHaveLength(1);
    expect(state(id)).toBe(S.CAPTURED);
  });

  it("capture timeout, then reconciliation records the existing capture (no second capture)", async () => {
    const { id } = await lockAndFund(env.fake);
    passRun(id);
    env.fake.knobs.capture = "timeout_after_capture";
    await accept(id);
    expect(state(id)).toBe(S.CAPTURE_PENDING);
    expect(ops(id, "capture")[0].status).toBe("UNKNOWN");
    env.fake.knobs.capture = "ok";
    await payments.reconcile();
    expect(state(id)).toBe(S.CAPTURED);
    expect(ops(id, "capture")).toHaveLength(1);
    expect(ops(id, "capture")[0].status).toBe("SUCCEEDED");
    expect(captureCalls()).toHaveLength(1);
  });

  it("capture succeeds, backend killed before recording, restart recovers it", async () => {
    const { id } = await lockAndFund(env.fake);
    passRun(id);
    transition(id, "ACCEPT", "client");
    // Simulate: op row written PENDING, PayPal captured, process died before recording.
    const op = payments.beginOp(id, "capture", payments.liveAuth(id)!.id);
    const auth = payments.liveAuth(id)!;
    await fetch(`${process.env.PAYPAL_BASE}/v2/payments/authorizations/${auth.id}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", "PayPal-Request-Id": op.idempotency_key },
      body: JSON.stringify({ final_capture: true }),
    });
    expect(ops(id, "capture")[0].status).toBe("PENDING");
    await payments.reconcile(); // startup reconcile
    expect(state(id)).toBe(S.CAPTURED);
    expect(captureCalls()).toHaveLength(1);
  });

  it("void timeout does not create a duplicate void", async () => {
    const { id } = await lockAndFund(env.fake);
    env.fake.knobs.void = "timeout_after_void";
    transition(id, "CANCEL", "client");
    await payments.voidAuth(id);
    expect(state(id)).toBe(S.VOID_PENDING);
    expect(ops(id, "void")[0].status).toBe("UNKNOWN");
    env.fake.knobs.void = "ok";
    await payments.reconcile();
    expect(state(id)).toBe(S.VOIDED);
    expect(ops(id, "void")).toHaveLength(1);
    expect(env.fake.calls.filter((c) => c.path.endsWith("/void"))).toHaveLength(1);
  });

  it("capture is impossible before explicit Accept", async () => {
    const { id } = await lockAndFund(env.fake);
    await expect(payments.capture(id)).rejects.toMatchObject({ status: 409 });
    passRun(id);
    expect(state(id)).toBe(S.REVIEW);
    await expect(payments.capture(id)).rejects.toMatchObject({ status: 409 });
    expect(() => transition(id, "ACCEPT", "freelancer")).toThrow(/may not/);
    expect(captureCalls()).toHaveLength(0);
  });

  for (const [what, mutate] of [
    ["agreement hash", (pu: any) => (pu.custom_id = "0".repeat(64))],
    ["amount", (pu: any) => (pu.amount.value = "1.00")],
    ["payee", (pu: any) => (pu.payee.email_address = "attacker@example.com")],
  ] as const) {
    it(`capture blocked when the ${what} differs`, async () => {
      const { id, orderId } = await lockAndFund(env.fake);
      passRun(id);
      env.fake.tamper(orderId, mutate);
      await accept(id);
      expect(state(id)).toBe(S.CAPTURE_FAILED);
      expect(captureCalls()).toHaveLength(0);
      expect(ops(id, "capture")[0].error).toMatch(/pre-capture check/);
    });
  }

  it("declined capture → CAPTURE_FAILED → new authorization → capture retried", async () => {
    const { id } = await lockAndFund(env.fake);
    passRun(id);
    env.fake.knobs.capture = "decline";
    await accept(id);
    expect(state(id)).toBe(S.CAPTURE_FAILED);
    env.fake.knobs.capture = "ok";
    const order2 = await payments.ensureOrder(id);
    env.fake.approve(order2);
    await payments.authorize(id, order2);
    expect(state(id)).toBe(S.CAPTURED);
    expect(env.fake.orders.get(order2).purchase_units[0].custom_id).toBe(getAgreement(id)!.hash);
  });

  it("expired authorization → AUTH_EXPIRED → new authorization → REVIEW", async () => {
    const { id } = await lockAndFund(env.fake);
    passRun(id);
    const auth = payments.liveAuth(id)!;
    getDb().prepare("UPDATE authorizations SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), auth.id);
    await payments.reauthorizeDue();
    expect(state(id)).toBe(S.AUTH_EXPIRED);
    const order2 = await payments.ensureOrder(id);
    env.fake.approve(order2);
    await payments.authorize(id, order2);
    expect(state(id)).toBe(S.REVIEW);
    expect(payments.liveAuth(id)!.order_id).toBe(order2);
  });

  it("reauthorization failure after the honor period → AUTH_EXPIRED", async () => {
    const { id } = await lockAndFund(env.fake);
    env.fake.knobs.reauthorize = "fail";
    await payments.reauthorizeDue(Date.now() + 4 * 86400_000);
    expect(state(id)).toBe(S.AUTH_EXPIRED);
  });

  it("concurrent approve and edit: lock happens only with both approvals on the final text", async () => {
    const id = createMilestone();
    setProposal(id, templateProposal("contact form"), "test");
    const v1 = getAgreement(id)!.version;
    approve(id, "client", v1, () => {});
    // Freelancer edits before approving: both approvals cleared, version bumps.
    const edited = { ...templateProposal("contact form"), advisory: ["edited"] };
    editAgreement(id, "freelancer", edited, v1);
    // A stale approval of v1 is rejected.
    expect(() => approve(id, "freelancer", v1, () => {})).toThrow(/version/);
    const v2 = getAgreement(id)!.version;
    expect(getAgreement(id)!.client_approved_at).toBeNull();
    expect(approve(id, "freelancer", v2, () => {})).toBe(false);
    expect(state(id)).toBe(S.PROPOSED);
    expect(approve(id, "client", v2, () => payments.queueOrderInLockTx(id))).toBe(true);
    expect(state(id)).toBe(S.LOCKED);
    expect(getAgreement(id)!.body.advisory).toEqual(["edited"]);
    expect(() => editAgreement(id, "client", edited, v2)).toThrow(/not valid in state LOCKED/);
  });

  it("events are append-only", () => {
    const id = createMilestone();
    setProposal(id, templateProposal("x"), "test");
    expect(() => getDb().prepare("UPDATE events SET type = 'x'").run()).toThrow(/append-only/);
    expect(() => getDb().prepare("DELETE FROM events").run()).toThrow(/append-only/);
  });

  it("cancel is impossible after work passed", async () => {
    const { id } = await lockAndFund(env.fake);
    passRun(id);
    expect(() => transition(id, "CANCEL", "client")).toThrow(/not valid in state REVIEW/);
  });
  void sleep;
});
