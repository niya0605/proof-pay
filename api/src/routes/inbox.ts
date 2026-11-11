import express, { Router } from "express";
import { getDb, now } from "../db/migrate.ts";
import { runningRunFor, inboxRowsForRun, checkJobToken } from "../services/verificationService.ts";
import { agentStep, startAgent, endAgent } from "../ai/acceptanceTools.ts";
import { verifiedLockedAgreement } from "../services/agreementService.ts";
import { logEvent } from "../services/eventService.ts";
import { HttpError } from "../services/errors.ts";

/** Public: the deliverable's form posts here. Stored against the milestone's current run. */
export const inboxRouter = Router();
inboxRouter.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});
inboxRouter.post("/:token", express.json({ limit: "16kb" }), express.urlencoded({ extended: false, limit: "16kb" }), express.text({ type: "text/plain", limit: "16kb" }), (req, res) => {
  const m = getDb().prepare("SELECT id FROM milestones WHERE inbox_token = ?").get(req.params.token) as { id: string } | undefined;
  if (!m) throw new HttpError(404, "unknown inbox");
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = { text: body };
    }
  }
  if (!body || typeof body !== "object") body = {};
  // Only accept posts while a verification run is in progress, and cap rows per run, so the
  // public endpoint can't be used to fill the database.
  const runId = runningRunFor(m.id);
  if (!runId) throw new HttpError(409, "this inbox only accepts submissions while Proof-Pay is verifying the site");
  const { n } = getDb().prepare("SELECT COUNT(*) AS n FROM form_inbox WHERE run_id = ?").get(runId) as { n: number };
  if (n >= 25) throw new HttpError(429, "too many submissions for this verification run");
  const r = getDb().prepare("INSERT INTO form_inbox (inbox_token, run_id, received_at, body_json) VALUES (?, ?, ?, ?)").run(req.params.token, runId, now(), JSON.stringify(body));
  logEvent(m.id, "inbox", "form_received", { inboxRowId: r.lastInsertRowid, runId, fields: Object.keys(body) });
  if (req.is("application/x-www-form-urlencoded")) res.type("html").send("<p>Thanks, your message was sent.</p>");
  else res.json({ ok: true });
});

/** Internal: called only by the verifier worker with its per-run job token. */
export const internalRouter = Router();
internalRouter.use((req, _res, next) => {
  const runId = (req.body?.runId ?? req.query.runId) as string;
  const token = (req.body?.jobToken ?? req.headers["x-job-token"]) as string;
  if (!checkJobToken(runId, token)) return next(new HttpError(401, "bad job token"));
  next();
});
internalRouter.post("/agent/start", (req, res) => {
  const { runId, checkId } = req.body;
  const row = getDb()
    .prepare("SELECT s.milestone_id, s.url FROM verification_runs r JOIN submissions s ON s.id = r.submission_id WHERE r.id = ?")
    .get(runId) as { milestone_id: string; url: string };
  const check = verifiedLockedAgreement(row.milestone_id).body.checks.find((c) => c.id === checkId);
  if (!check || check.type !== "form_submits") throw new HttpError(400, "agent only explores form_submits checks");
  startAgent(row.milestone_id, runId, check, row.url);
  logEvent(row.milestone_id, "ai", "agent_started", { runId, checkId });
  res.json({ ok: true });
});
internalRouter.post("/agent/end", (req, res) => {
  endAgent(req.body.runId, req.body.checkId);
  res.json({ ok: true });
});
internalRouter.post("/agent/trace", (req, res) => {
  // Every tool call the worker executed, logged to events.
  const row = getDb().prepare("SELECT s.milestone_id FROM verification_runs r JOIN submissions s ON s.id = r.submission_id WHERE r.id = ?").get(req.body.runId) as { milestone_id: string };
  logEvent(row.milestone_id, "ai", "tool_call", { runId: req.body.runId, checkId: req.body.checkId, step: req.body.step });
  res.json({ ok: true });
});
internalRouter.post("/agent/step", async (req, res) => {
  const { runId, checkId, toolResult } = req.body;
  res.json(await agentStep(runId, checkId, toolResult));
});
internalRouter.get("/inbox", (req, res) => {
  res.json(inboxRowsForRun(req.query.runId as string));
});
