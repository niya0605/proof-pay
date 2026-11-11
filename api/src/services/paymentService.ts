/**
 * The only module that talks to PayPal. Every write is preceded by a payment_operations
 * row with a stable idempotency key (<milestoneId>:<type>:<attempt>) that is sent as
 * PayPal-Request-Id and reused on any retry. Only a PayPal-confirmed response writes
 * CAPTURED or VOIDED.
 */
import { getDb, newId, now, tx } from "../db/migrate.ts";
import { MilestoneState } from "../domain/milestoneState.ts";
import * as paypal from "./paypal.ts";
import { PayPalError } from "./paypal.ts";
import { getMilestone, hasPassingRun, transition } from "./milestoneService.ts";
import { verifiedLockedAgreement } from "./agreementService.ts";
import { logEvent } from "./eventService.ts";
import { HttpError } from "./errors.ts";

type OpType = "create_order" | "authorize" | "reauthorize" | "capture" | "void";
export type PaymentOp = {
  id: string; milestone_id: string; type: OpType; idempotency_key: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  requested_at: string; responded_at: string | null; paypal_ref: string | null; error: string | null; target_ref: string | null;
};
export type AuthRow = { id: string; milestone_id: string; order_id: string; status: string; expires_at: string; replaced_by: string | null; created_at: string };

const db = () => getDb();
/** Operations currently executing in this process; the reconciler skips them. */
const inflight = new Set<string>();

// ---------- operation bookkeeping ----------

export function listOps(milestoneId: string): PaymentOp[] {
  return db().prepare("SELECT * FROM payment_operations WHERE milestone_id = ? ORDER BY requested_at, rowid").all(milestoneId) as PaymentOp[];
}
function latestOp(milestoneId: string, type: OpType): PaymentOp | undefined {
  return db().prepare("SELECT * FROM payment_operations WHERE milestone_id = ? AND type = ? ORDER BY rowid DESC LIMIT 1").get(milestoneId, type) as PaymentOp | undefined;
}

/** Reuse an open (PENDING/UNKNOWN) operation of this type, else start the next attempt. */
export function beginOp(milestoneId: string, type: OpType, targetRef: string | null): PaymentOp {
  return tx(() => {
    const open = db()
      .prepare("SELECT * FROM payment_operations WHERE milestone_id = ? AND type = ? AND status IN ('PENDING','UNKNOWN') AND (target_ref IS ? OR ? IS NULL) ORDER BY rowid DESC LIMIT 1")
      .get(milestoneId, type, targetRef, targetRef) as PaymentOp | undefined;
    if (open) return open;
    const { n } = db().prepare("SELECT COUNT(*) AS n FROM payment_operations WHERE milestone_id = ? AND type = ?").get(milestoneId, type) as { n: number };
    const op: PaymentOp = {
      id: newId("op"), milestone_id: milestoneId, type, idempotency_key: `${milestoneId}:${type}:${n + 1}`,
      status: "PENDING", requested_at: now(), responded_at: null, paypal_ref: null, error: null, target_ref: targetRef,
    };
    db().prepare(
      `INSERT INTO payment_operations (id, milestone_id, type, idempotency_key, status, requested_at, target_ref)
       VALUES (@id, @milestone_id, @type, @idempotency_key, @status, @requested_at, @target_ref)`,
    ).run(op);
    logEvent(milestoneId, "payment", "payment_op_started", { type, key: op.idempotency_key, target: targetRef });
    return op;
  });
}

function finishOp(op: PaymentOp, status: PaymentOp["status"], paypalRef: string | null, error: string | null = null) {
  db().prepare("UPDATE payment_operations SET status = ?, responded_at = ?, paypal_ref = COALESCE(?, paypal_ref), error = ? WHERE id = ?")
    .run(status, now(), paypalRef, error, op.id);
  logEvent(op.milestone_id, "payment", "payment_op_" + status.toLowerCase(), { type: op.type, key: op.idempotency_key, paypalRef, error });
}

async function guarded<T>(op: PaymentOp, fn: () => Promise<T>): Promise<T | undefined> {
  if (inflight.has(op.id)) return undefined;
  inflight.add(op.id);
  try {
    return await fn();
  } finally {
    inflight.delete(op.id);
  }
}

export function liveAuth(milestoneId: string): AuthRow | undefined {
  return db()
    .prepare("SELECT * FROM authorizations WHERE milestone_id = ? AND replaced_by IS NULL AND status IN ('CREATED','PENDING','PARTIALLY_CAPTURED') ORDER BY rowid DESC LIMIT 1")
    .get(milestoneId) as AuthRow | undefined;
}
export function listAuths(milestoneId: string): AuthRow[] {
  return db().prepare("SELECT * FROM authorizations WHERE milestone_id = ? ORDER BY rowid").all(milestoneId) as AuthRow[];
}
function setAuthStatus(authId: string, status: string) {
  db().prepare("UPDATE authorizations SET status = ? WHERE id = ?").run(status, authId);
}

// ---------- order creation ----------

const payeeMode = () => (process.env.PAYPAL_PAYEE_MODE === "self" ? "self" : "override");

/** Called inside the LOCK transaction: the order op is recorded atomically with the lock. */
export function queueOrderInLockTx(milestoneId: string) {
  beginOp(milestoneId, "create_order", null);
}

function orderInput(milestoneId: string, attempt: number) {
  const a = verifiedLockedAgreement(milestoneId);
  return {
    value: a.body.amount.value,
    currency: a.body.amount.currency,
    customId: a.hash,
    invoiceId: attempt === 1 ? milestoneId : `${milestoneId}-${attempt}`,
    payeeEmail: payeeMode() === "override" ? a.body.payee.email : undefined,
    description: `Proof-Pay milestone ${milestoneId}`,
  };
}
const attemptOf = (op: PaymentOp) => Number(op.idempotency_key.split(":").pop());

/** Return an order the client can approve: an unauthorized existing one, or a new one. */
export async function ensureOrder(milestoneId: string): Promise<string> {
  const m = getMilestone(milestoneId);
  if (![MilestoneState.LOCKED, MilestoneState.AUTH_EXPIRED, MilestoneState.CAPTURE_FAILED].includes(m.state))
    throw new HttpError(409, `no payment to authorize in state ${m.state}`);
  const last = latestOp(milestoneId, "create_order");
  if (last?.status === "SUCCEEDED" && last.paypal_ref) {
    const used = db().prepare("SELECT 1 FROM authorizations WHERE order_id = ?").get(last.paypal_ref);
    // PayPal deletes orders nobody approved after a few hours. Reuse the order only while PayPal
    // still has it; once PayPal definitively reports it gone (404) or voided, create a new one.
    // A network error or timeout is not definitive, so the existing order is kept.
    if (!used && !(await orderGone(last.paypal_ref))) return last.paypal_ref;
  }
  const op = beginOp(milestoneId, "create_order", null);
  const id = await runCreateOrder(op);
  if (!id) throw new HttpError(502, "PayPal order creation did not complete; try again");
  return id;
}

async function orderGone(orderId: string): Promise<boolean> {
  try {
    const order: any = await paypal.getOrder(orderId);
    return order?.status === "VOIDED";
  } catch (e) {
    return e instanceof PayPalError && e.definitive && e.status === 404;
  }
}

async function runCreateOrder(op: PaymentOp): Promise<string | undefined> {
  return guarded(op, async () => {
    try {
      const order = await paypal.createOrder(orderInput(op.milestone_id, attemptOf(op)), op.idempotency_key);
      finishOp(op, "SUCCEEDED", order.id);
      return order.id as string;
    } catch (e) {
      handleError(op, e);
      return undefined;
    }
  });
}

function handleError(op: PaymentOp, e: unknown) {
  if (e instanceof PayPalError && e.definitive) finishOp(op, "FAILED", null, e.message);
  else finishOp(op, "UNKNOWN", null, e instanceof Error ? e.message : String(e));
}

// ---------- authorize ----------

export async function authorize(milestoneId: string, orderId: string) {
  const m = getMilestone(milestoneId);
  if (![MilestoneState.LOCKED, MilestoneState.AUTH_EXPIRED, MilestoneState.CAPTURE_FAILED].includes(m.state))
    throw new HttpError(409, `cannot authorize in state ${m.state}`);
  const last = latestOp(milestoneId, "create_order");
  if (last?.paypal_ref !== orderId) throw new HttpError(400, "order id does not belong to this milestone");
  const op = beginOp(milestoneId, "authorize", orderId);
  await guarded(op, async () => {
    try {
      const res = await paypal.authorizeOrder(orderId, op.idempotency_key);
      recordAuthorization(op, res);
    } catch (e) {
      if (e instanceof PayPalError && e.issue === "ORDER_ALREADY_AUTHORIZED") return reconcileAuthorize(op);
      handleError(op, e);
      throw new HttpError(e instanceof PayPalError && e.definitive ? 400 : 502, `authorization failed: ${(e as Error).message}`);
    }
  });
  const after = getMilestone(milestoneId);
  if (after.state === MilestoneState.CAPTURE_PENDING) await capture(milestoneId);
  return getMilestone(milestoneId).state;
}

function recordAuthorization(op: PaymentOp, order: any) {
  const auth = order?.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth?.id) {
    finishOp(op, "FAILED", null, "PayPal returned no authorization");
    return;
  }
  const milestoneId = op.milestone_id;
  const from = getMilestone(milestoneId).state;
  tx(() => {
    const prev = liveAuthAny(milestoneId);
    db().prepare("INSERT OR IGNORE INTO authorizations (id, milestone_id, order_id, status, expires_at, replaced_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
      .run(auth.id, milestoneId, op.target_ref, auth.status, auth.expiration_time ?? addDays(29), now());
    if (prev && prev.id !== auth.id) db().prepare("UPDATE authorizations SET replaced_by = ? WHERE id = ?").run(auth.id, prev.id);
    finishOp(op, "SUCCEEDED", auth.id);
    transition(milestoneId, "AUTHORIZED", "payment", {
      ctx: { hasPassingRun: hasPassingRun(milestoneId) },
      data: { authorizationId: auth.id, orderId: op.target_ref, expiresAt: auth.expiration_time, from },
    });
  });
}
function liveAuthAny(milestoneId: string) {
  return db().prepare("SELECT * FROM authorizations WHERE milestone_id = ? AND replaced_by IS NULL ORDER BY rowid DESC LIMIT 1").get(milestoneId) as AuthRow | undefined;
}
const addDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

async function reconcileAuthorize(op: PaymentOp) {
  const order = await paypal.getOrder(op.target_ref!);
  if (order?.purchase_units?.[0]?.payments?.authorizations?.length) return recordAuthorization(op, order);
  if (order?.status === "APPROVED") {
    try {
      return recordAuthorization(op, await paypal.authorizeOrder(op.target_ref!, op.idempotency_key));
    } catch (e) {
      return handleError(op, e);
    }
  }
  finishOp(op, "FAILED", null, `order status ${order?.status}; buyer approval needed`);
}

// ---------- capture ----------

/** Compare the PayPal order with the locked agreement. Returns a list of mismatches. */
export function precaptureMismatches(milestoneId: string, order: any): string[] {
  const a = verifiedLockedAgreement(milestoneId);
  const pu = order?.purchase_units?.[0] ?? {};
  const out: string[] = [];
  if (pu.amount?.value !== a.body.amount.value) out.push(`amount ${pu.amount?.value} != ${a.body.amount.value}`);
  if (pu.amount?.currency_code !== a.body.amount.currency) out.push(`currency ${pu.amount?.currency_code} != ${a.body.amount.currency}`);
  if (pu.custom_id !== a.hash) out.push("custom_id does not match the agreement hash");
  // In self mode PayPal fills the payee with the app owner's account; the check still applies.
  const email = pu.payee?.email_address;
  if (payeeMode() === "override" || email) {
    if (!email || email.toLowerCase() !== a.body.payee.email.toLowerCase()) out.push(`payee ${email ?? "(none)"} != ${a.body.payee.email}`);
  }
  return out;
}

/** Attempt capture. Only valid in CAPTURE_PENDING (i.e. after an explicit Accept or a resolution for the freelancer). */
export async function capture(milestoneId: string): Promise<void> {
  const m = getMilestone(milestoneId);
  if (m.state !== MilestoneState.CAPTURE_PENDING) throw new HttpError(409, `capture is only attempted in CAPTURE_PENDING, not ${m.state}`);
  const auth = liveAuth(milestoneId);
  if (!auth) {
    transition(milestoneId, "CAPTURE_DECLINED", "payment", { data: { reason: "no live authorization" } });
    return;
  }
  const op = beginOp(milestoneId, "capture", auth.id);
  await guarded(op, () => executeCapture(op, auth));
}

async function executeCapture(op: PaymentOp, auth: AuthRow): Promise<void> {
  // 1. Pre-capture check, and detect an existing capture (crash recovery).
  let order: any;
  try {
    order = await paypal.getOrder(auth.order_id);
  } catch (e) {
    finishOp(op, "UNKNOWN", null, `order lookup failed: ${(e as Error).message}`);
    return;
  }
  if (recordFromOrder(op, auth, order)) return;
  const mismatches = precaptureMismatches(op.milestone_id, order);
  if (mismatches.length) {
    tx(() => {
      finishOp(op, "FAILED", null, `pre-capture check: ${mismatches.join("; ")}`);
      transition(op.milestone_id, "CAPTURE_DECLINED", "payment", { data: { reason: "pre-capture check failed", mismatches } });
    });
    return;
  }
  // 2. Capture with the operation's stable idempotency key.
  try {
    const cap = await paypal.captureAuthorization(auth.id, orderInvoice(order, op.milestone_id), op.idempotency_key);
    applyCaptureStatus(op, auth, cap?.id, cap?.status);
  } catch (e) {
    if (e instanceof PayPalError && e.definitive) {
      // A definitive refusal; first make sure it isn't "already captured".
      try {
        const again = await paypal.getOrder(auth.order_id);
        if (recordFromOrder(op, auth, again)) return;
      } catch {
        /* fall through */
      }
      tx(() => {
        finishOp(op, "FAILED", null, e.message);
        transition(op.milestone_id, "CAPTURE_DECLINED", "payment", { data: { reason: e.message } });
      });
    } else {
      finishOp(op, "UNKNOWN", null, (e as Error).message); // left to the reconciler
    }
  }
}
const orderInvoice = (order: any, fallback: string) => order?.purchase_units?.[0]?.invoice_id ?? fallback;

function applyCaptureStatus(op: PaymentOp, auth: AuthRow, captureId: string | undefined, status: string | undefined) {
  if (status === "COMPLETED") {
    tx(() => {
      setAuthStatus(auth.id, "CAPTURED");
      finishOp(op, "SUCCEEDED", captureId ?? null);
      transition(op.milestone_id, "CAPTURE_COMPLETED", "payment", { data: { captureId, paypalStatus: status } });
    });
  } else if (status === "DECLINED" || status === "FAILED") {
    tx(() => {
      finishOp(op, "FAILED", captureId ?? null, `capture ${status}`);
      transition(op.milestone_id, "CAPTURE_DECLINED", "payment", { data: { captureId, paypalStatus: status } });
    });
  } else {
    // e.g. PENDING: PayPal has not confirmed yet.
    finishOp(op, "UNKNOWN", captureId ?? null, `capture status ${status ?? "missing"}`);
  }
}

/** If the order already shows a capture for this authorization, record it. */
function recordFromOrder(op: PaymentOp, auth: AuthRow, order: any): boolean {
  const payments = order?.purchase_units?.[0]?.payments ?? {};
  const caps: any[] = payments.captures ?? [];
  const cap = caps.find((c) => c.status === "COMPLETED") ?? caps.find((c) => c.status === "DECLINED" || c.status === "FAILED") ?? caps[0];
  if (cap) {
    applyCaptureStatus(op, auth, cap.id, cap.status);
    return true;
  }
  return false;
}

// ---------- void ----------

export async function voidAuth(milestoneId: string): Promise<void> {
  const m = getMilestone(milestoneId);
  if (m.state !== MilestoneState.VOID_PENDING) throw new HttpError(409, `void only from VOID_PENDING, not ${m.state}`);
  const auth = liveAuthAny(milestoneId);
  if (!auth) {
    logEvent(milestoneId, "payment", "void_skipped", { reason: "no authorization on record" });
    return;
  }
  const op = beginOp(milestoneId, "void", auth.id);
  await guarded(op, () => executeVoid(op, auth));
}

async function executeVoid(op: PaymentOp, auth: AuthRow) {
  try {
    const order = await paypal.getOrder(auth.order_id);
    if (confirmVoidFromOrder(op, auth, order)) return;
  } catch (e) {
    finishOp(op, "UNKNOWN", null, `order lookup failed: ${(e as Error).message}`);
    return;
  }
  try {
    await paypal.voidAuthorization(auth.id, op.idempotency_key);
    const order = await paypal.getOrder(auth.order_id); // confirm from PayPal
    if (!confirmVoidFromOrder(op, auth, order)) finishOp(op, "UNKNOWN", null, "void sent, not yet confirmed");
  } catch (e) {
    if (e instanceof PayPalError && e.definitive) {
      try {
        if (confirmVoidFromOrder(op, auth, await paypal.getOrder(auth.order_id))) return;
      } catch {
        /* ignore */
      }
      finishOp(op, "FAILED", null, e.message);
    } else finishOp(op, "UNKNOWN", null, (e as Error).message);
  }
}

function confirmVoidFromOrder(op: PaymentOp, auth: AuthRow, order: any): boolean {
  const a = (order?.purchase_units?.[0]?.payments?.authorizations ?? []).find((x: any) => x.id === auth.id);
  if (a?.status === "VOIDED" || a?.status === "EXPIRED") {
    tx(() => {
      setAuthStatus(auth.id, a.status);
      finishOp(op, "SUCCEEDED", auth.id);
      transition(op.milestone_id, "VOID_CONFIRMED", "payment", { data: { authorizationId: auth.id, paypalStatus: a.status } });
    });
    return true;
  }
  return false;
}

// ---------- reauthorization & expiry ----------

const HONOR_MS = 3 * 86400_000;
const ACTIVE = [MilestoneState.FUNDED, MilestoneState.FAILED, MilestoneState.REVIEW, MilestoneState.DISPUTE];

export async function reauthorizeDue(at = Date.now()) {
  const rows = db()
    .prepare(`SELECT a.* FROM authorizations a JOIN milestones m ON m.id = a.milestone_id
              WHERE a.replaced_by IS NULL AND a.status IN ('CREATED','PENDING') AND m.state IN (${ACTIVE.map(() => "?").join(",")})`)
    .all(...ACTIVE) as AuthRow[];
  for (const auth of rows) {
    if (Date.parse(auth.expires_at) <= at) {
      expire(auth, "authorization expired");
      continue;
    }
    // Reauthorize once, after the honor period, if this authorization is the original one.
    const isOriginal = !db().prepare("SELECT 1 FROM authorizations WHERE replaced_by = ?").get(auth.id);
    if (at - Date.parse(auth.created_at) < HONOR_MS || !isOriginal) continue;
    const op = beginOp(auth.milestone_id, "reauthorize", auth.id);
    await guarded(op, () => executeReauthorize(op, auth));
  }
}

async function executeReauthorize(op: PaymentOp, auth: AuthRow) {
  const a = verifiedLockedAgreement(op.milestone_id);
  try {
    const res = await paypal.reauthorizeAuthorization(auth.id, a.body.amount, op.idempotency_key);
    tx(() => {
      db().prepare("INSERT OR IGNORE INTO authorizations (id, milestone_id, order_id, status, expires_at, replaced_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
        .run(res.id, op.milestone_id, auth.order_id, res.status ?? "CREATED", res.expiration_time ?? auth.expires_at, now());
      db().prepare("UPDATE authorizations SET replaced_by = ? WHERE id = ?").run(res.id, auth.id);
      finishOp(op, "SUCCEEDED", res.id);
    });
  } catch (e) {
    if (e instanceof PayPalError && e.definitive) {
      finishOp(op, "FAILED", null, e.message);
      expire(auth, `reauthorization failed: ${e.message}`);
    } else finishOp(op, "UNKNOWN", null, (e as Error).message);
  }
}

function expire(auth: AuthRow, reason: string) {
  tx(() => {
    const m = getMilestone(auth.milestone_id);
    if (!ACTIVE.includes(m.state)) return;
    setAuthStatus(auth.id, "EXPIRED");
    transition(auth.milestone_id, "AUTH_EXPIRED", "payment", { data: { authorizationId: auth.id, reason } });
  });
}

// ---------- reconciler ----------

/** On startup and every minute: check every PENDING/UNKNOWN operation against PayPal before any retry. */
export async function reconcile(opts: { minAgeMs?: number } = {}) {
  const minAge = opts.minAgeMs ?? 0;
  const ops = db().prepare("SELECT * FROM payment_operations WHERE status IN ('PENDING','UNKNOWN') ORDER BY rowid").all() as PaymentOp[];
  for (const op of ops) {
    if (inflight.has(op.id) || Date.now() - Date.parse(op.requested_at) < minAge) continue;
    try {
      await guarded(op, () => reconcileOne(op));
    } catch (e) {
      logEvent(op.milestone_id, "payment", "reconcile_error", { key: op.idempotency_key, error: (e as Error).message });
    }
  }
}

async function reconcileOne(op: PaymentOp) {
  logEvent(op.milestone_id, "payment", "reconcile", { type: op.type, key: op.idempotency_key, status: op.status });
  switch (op.type) {
    case "create_order": {
      // Same key → PayPal returns the same order if it was already created.
      const order = await paypal.createOrder(orderInput(op.milestone_id, attemptOf(op)), op.idempotency_key).catch((e) => {
        handleError(op, e);
        return null;
      });
      if (order) finishOp(op, "SUCCEEDED", order.id);
      return;
    }
    case "authorize":
      return reconcileAuthorize(op);
    case "capture": {
      const auth = db().prepare("SELECT * FROM authorizations WHERE id = ?").get(op.target_ref) as AuthRow;
      if (getMilestone(op.milestone_id).state !== MilestoneState.CAPTURE_PENDING) {
        const order = await paypal.getOrder(auth.order_id);
        if (!recordFromOrder(op, auth, order)) finishOp(op, "FAILED", null, "milestone left CAPTURE_PENDING");
        return;
      }
      return executeCapture(op, auth); // looks the order up first, retries with the same key only if no capture exists
    }
    case "void": {
      const auth = db().prepare("SELECT * FROM authorizations WHERE id = ?").get(op.target_ref) as AuthRow;
      return executeVoid(op, auth);
    }
    case "reauthorize": {
      const auth = db().prepare("SELECT * FROM authorizations WHERE id = ?").get(op.target_ref) as AuthRow;
      return executeReauthorize(op, auth);
    }
  }
}

/** Kick off the payment action a state implies (used after transitions made by routes and jobs). */
export async function drive(milestoneId: string) {
  const s = getMilestone(milestoneId).state;
  if (s === MilestoneState.CAPTURE_PENDING) await capture(milestoneId);
  else if (s === MilestoneState.VOID_PENDING) await voidAuth(milestoneId);
}
