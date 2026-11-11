import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getDb, newId, now } from "../db/migrate.ts";
import { requireRole, DEMO_USERS, sessionKey } from "./auth.ts";
import { rateLimit } from "../services/rateLimit.ts";
import { HttpError } from "../services/errors.ts";
import { MilestoneState } from "../domain/milestoneState.ts";
import { getMilestone, transition } from "../services/milestoneService.ts";
import { approve, editAgreement, getAgreement, setProposal } from "../services/agreementService.ts";
import * as payments from "../services/paymentService.ts";
import { runsFor, submit } from "../services/verificationService.ts";
import { listEvents, logEvent } from "../services/eventService.ts";
import { clarify, propose } from "../ai/brief.ts";
import { llmConfigured, modelName } from "../ai/engine.ts";

export const milestonesRouter = Router();
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, "invalid request", r.error.issues);
  return r.data;
};

milestonesRouter.get("/config", (_req, res) => {
  res.json({
    paypalClientId: process.env.PAYPAL_CLIENT_ID ?? "",
    fakePaypal: process.env.FAKE_PAYPAL === "1",
    llm: llmConfigured() ? modelName() : null,
    allowedHosts: (process.env.ALLOWED_HOSTS ?? "").split(",").filter(Boolean),
    demoSites: (process.env.DEMO_SITE_URLS ?? "http://localhost:5174/broken/,http://localhost:5174/fixed/").split(",").filter(Boolean),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3001",
  });
});

milestonesRouter.post("/projects", requireRole("client"), (req, res) => {
  const b = parse(
    z.object({
      title: z.string().min(1).max(120),
      brief: z.string().min(10).max(4000),
      milestoneTitle: z.string().min(1).max(120).default("Website delivery"),
      amount: z.number().positive().max(10000),
      deadlineDays: z.number().int().min(1).max(25), // max 25 days: authorizations live 29
      reviewWindowHours: z.number().int().min(1).max(168).default(72),
    }),
    req.body,
  );
  const projectId = newId("prj");
  const milestoneId = newId("ms");
  const db = getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO projects (id, title, brief, client_id, freelancer_id, freelancer_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(projectId, b.title, b.brief, DEMO_USERS.client.id, DEMO_USERS.freelancer.id, process.env.PAYPAL_PAYEE_EMAIL ?? "freelancer@example.com", now());
    db.prepare("INSERT INTO milestones (id, project_id, title, amount_cents, currency, state, deadline_at, review_window_hours, inbox_token) VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?)")
      .run(milestoneId, projectId, b.milestoneTitle, Math.round(b.amount * 100), MilestoneState.DRAFT, new Date(Date.now() + b.deadlineDays * 86400_000).toISOString(), b.reviewWindowHours, randomBytes(12).toString("hex"));
    logEvent(milestoneId, "client", "project_created", { projectId, title: b.title, amount: b.amount });
  })();
  res.status(201).json({ projectId, milestoneId });
});

milestonesRouter.get("/milestones", requireRole(), (_req, res) => {
  res.json(getDb().prepare("SELECT m.id, m.title, m.state, m.amount_cents, m.currency, m.deadline_at, p.title AS project_title, p.created_at FROM milestones m JOIN projects p ON p.id = m.project_id ORDER BY p.created_at DESC").all());
});

milestonesRouter.get("/milestones/:id", requireRole(), (req, res) => {
  const m = getMilestone(req.params.id as string);
  const project = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(m.project_id);
  res.json({
    milestone: m,
    project,
    agreement: getAgreement(m.id),
    authorizations: payments.listAuths(m.id),
    operations: payments.listOps(m.id),
    runs: runsFor(m.id),
    events: listEvents(m.id),
    inboxUrl: `${(process.env.PUBLIC_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "")}/inbox/${m.inbox_token}`,
  });
});

// Routes that call the model or start a browser run cost quota: limit them per session.
const aiLimit = rateLimit({ name: "AI", max: 12, windowMs: 60_000, keyOf: sessionKey });

milestonesRouter.post("/milestones/:id/clarify", requireRole("client"), aiLimit, async (req, res) => {
  const m = getMilestone(req.params.id as string);
  if (m.state !== MilestoneState.DRAFT) throw new HttpError(409, `clarify is only valid in DRAFT, not ${m.state}`);
  const { brief } = getDb().prepare("SELECT brief FROM projects WHERE id = ?").get(m.project_id) as { brief: string };
  const out = await clarify(m.id, brief);
  logEvent(m.id, "ai", "brief_questions", { ...out.data, source: out.source });
  res.json({ ...out.data, source: out.source });
});

milestonesRouter.post("/milestones/:id/propose", requireRole("client"), aiLimit, async (req, res) => {
  const { answers } = parse(z.object({ answers: z.record(z.string(), z.string().max(300)).default({}) }), req.body);
  const m = getMilestone(req.params.id as string);
  if (![MilestoneState.DRAFT, MilestoneState.PROPOSED].includes(m.state)) throw new HttpError(409, `propose is not valid in ${m.state}`);
  const { brief } = getDb().prepare("SELECT brief FROM projects WHERE id = ?").get(m.project_id) as { brief: string };
  logEvent(m.id, "client", "brief_answers", { answers });
  const out = await propose(m.id, brief, answers);
  setProposal(m.id, out.data, out.source);
  res.json({ agreement: getAgreement(m.id), source: out.source });
});

milestonesRouter.patch("/milestones/:id/agreement", requireRole("client", "freelancer"), (req, res) => {
  const b = parse(z.object({ proposal: z.unknown(), baseVersion: z.number().int() }), req.body);
  editAgreement(req.params.id as string, (req as any).role, b.proposal, b.baseVersion);
  res.json({ agreement: getAgreement(req.params.id as string) });
});

milestonesRouter.post("/milestones/:id/approve", requireRole("client", "freelancer"), async (req, res) => {
  const { version } = parse(z.object({ version: z.number().int() }), req.body);
  const id = req.params.id as string;
  const locked = approve(id, (req as any).role, version, () => payments.queueOrderInLockTx(id));
  let orderError: string | undefined;
  if (locked) await payments.ensureOrder(id).catch((e) => (orderError = e.message));
  res.json({ locked, agreement: getAgreement(id), orderError });
});

milestonesRouter.post("/milestones/:id/paypal-order", requireRole("client"), async (req, res) => {
  res.json({ orderId: await payments.ensureOrder(req.params.id as string) });
});

milestonesRouter.post("/milestones/:id/authorize", requireRole("client"), async (req, res) => {
  const { orderId } = parse(z.object({ orderId: z.string().min(1) }), req.body);
  const state = await payments.authorize(req.params.id as string, orderId);
  res.json({ state });
});

milestonesRouter.post("/milestones/:id/submit", requireRole("freelancer"), aiLimit, (req, res) => {
  const { url } = parse(z.object({ url: z.string().max(2000) }), req.body);
  res.json({ submissionId: submit(req.params.id as string, url) });
});

milestonesRouter.post("/milestones/:id/accept", requireRole("client"), async (req, res) => {
  const id = req.params.id as string;
  transition(id, "ACCEPT", "client", { data: { note: "client explicitly accepted" } });
  await payments.capture(id);
  res.json({ state: getMilestone(id).state });
});

milestonesRouter.post("/milestones/:id/reject", requireRole("client"), (req, res) => {
  const id = req.params.id as string;
  const b = parse(
    z.object({
      criterionId: z.string().max(20),
      reason: z.string().min(10).max(2000),
      attachment: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("note"), content: z.string().min(1).max(2000) }),
        // Only an inline raster image; rendered as <img src>, so no other URL scheme is accepted.
        z.object({ kind: z.literal("screenshot"), content: z.string().max(3_000_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, "screenshot must be a PNG, JPEG, WebP or GIF image") }),
      ]),
    }),
    req.body,
  );
  const a = getAgreement(id);
  if (!a?.body.manual.some((mc) => mc.id === b.criterionId))
    throw new HttpError(400, "a rejection must cite one of the manual criteria in the locked agreement; failed automated checks go to the fix loop instead");
  transition(id, "REJECT", "client", { data: { criterionId: b.criterionId, reason: b.reason, attachment: b.attachment } });
  res.json({ state: getMilestone(id).state });
});

milestonesRouter.post("/milestones/:id/resolve", requireRole("admin"), async (req, res) => {
  const id = req.params.id as string;
  const b = parse(z.object({ for: z.enum(["freelancer", "client"]), note: z.string().max(2000).optional() }), req.body);
  transition(id, b.for === "freelancer" ? "RESOLVE_FOR_FREELANCER" : "RESOLVE_FOR_CLIENT", "admin", { data: { note: b.note } });
  await payments.drive(id);
  res.json({ state: getMilestone(id).state });
});

milestonesRouter.post("/milestones/:id/cancel", requireRole("client"), async (req, res) => {
  const id = req.params.id as string;
  transition(id, "CANCEL", "client");
  await payments.voidAuth(id);
  res.json({ state: getMilestone(id).state });
});

milestonesRouter.post("/milestones/:id/close", requireRole("admin"), async (req, res) => {
  const id = req.params.id as string;
  transition(id, "ADMIN_CLOSE", "admin", { ctx: { liveAuth: Boolean(payments.liveAuth(id)) } });
  await payments.drive(id);
  res.json({ state: getMilestone(id).state });
});

/** Admin can trigger the reconciler instead of waiting a minute. */
milestonesRouter.post("/admin/reconcile", requireRole("admin"), async (_req, res) => {
  await payments.reconcile();
  res.json({ ok: true });
});
