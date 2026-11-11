import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getDb, newId, now, tx } from "../db/migrate.ts";
import { MilestoneState } from "../domain/milestoneState.ts";
import { getMilestone, latestFinishedRunOutcome, transition } from "./milestoneService.ts";
import { verifiedLockedAgreement } from "./agreementService.ts";
import { checkSubmittedUrl } from "../checks/urlPolicy.ts";
import { evaluate, fieldsInRow, filterObservations, INBOX_WINDOW_MS, type InboxRow, type WorkerCheckOutput } from "../checks/evaluator.ts";
import { fixCoach } from "../ai/fixCoach.ts";
import { agentAvailable } from "../ai/acceptanceTools.ts";
import { logEvent } from "./eventService.ts";
import { HttpError } from "./errors.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const artifactsDir = () => process.env.ARTIFACTS_DIR ?? path.resolve(here, "../../../artifacts");
export const RUNNER_VERSION = "proofpay-runner/1 playwright@1.65.0";
const RUN_TIMEOUT_MS = 5 * 60_000 + 30_000;

/** Per-run job tokens the worker presents when it calls back. */
const jobTokens = new Map<string, string>();
export const checkJobToken = (runId: unknown, token: unknown) => {
  const want = typeof runId === "string" ? jobTokens.get(runId) : undefined;
  if (!want || typeof token !== "string" || token.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(want));
};

export function submit(milestoneId: string, url: string) {
  let u: URL;
  try {
    u = checkSubmittedUrl(url);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const id = newId("sub");
  transition(milestoneId, "SUBMIT", "freelancer", {
    effect: () => getDb().prepare("INSERT INTO submissions (id, milestone_id, url, submitted_at) VALUES (?, ?, ?, ?)").run(id, milestoneId, u.href, now()),
    data: { submissionId: id, url: u.href },
  });
  return id;
}

export function runningRunFor(milestoneId: string): string | null {
  const r = getDb()
    .prepare(`SELECT r.id FROM verification_runs r JOIN submissions s ON s.id = r.submission_id WHERE s.milestone_id = ? AND r.status = 'running' ORDER BY r.started_at DESC LIMIT 1`)
    .get(milestoneId) as { id: string } | undefined;
  return r?.id ?? null;
}

export function inboxRowsForRun(runId: string): InboxRow[] {
  return (getDb().prepare("SELECT id, received_at, body_json FROM form_inbox WHERE run_id = ? ORDER BY id").all(runId) as any[]).map((r) => ({
    id: r.id,
    received_at: r.received_at,
    body: JSON.parse(r.body_json),
  }));
}

/** On startup: a run left 'running' by a crash is an infrastructure error. */
export function recoverStaleRuns() {
  const stale = getDb()
    .prepare(`SELECT r.id, s.milestone_id FROM verification_runs r JOIN submissions s ON s.id = r.submission_id WHERE r.status = 'running'`)
    .all() as { id: string; milestone_id: string }[];
  for (const r of stale) finishRunAsError(r.milestone_id, r.id, "backend restarted during the run");
}

function finishRunAsError(milestoneId: string, runId: string, error: string) {
  tx(() => {
    getDb().prepare("UPDATE verification_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?").run(now(), error, runId);
    if (getMilestone(milestoneId).state === MilestoneState.VERIFYING)
      transition(milestoneId, "RUN_ERROR", "verification", { ctx: { hadFailingRun: latestFinishedRunOutcome(milestoneId) === "failed" }, data: { runId, error } });
  });
}

let busy = false;
/** One run at a time. */
export async function processQueue() {
  if (busy) return;
  const next = getDb()
    .prepare(
      `SELECT s.* FROM submissions s JOIN milestones m ON m.id = s.milestone_id
       WHERE m.state = 'VERIFYING' AND NOT EXISTS (SELECT 1 FROM verification_runs r WHERE r.submission_id = s.id)
       ORDER BY s.submitted_at LIMIT 1`,
    )
    .get() as { id: string; milestone_id: string; url: string } | undefined;
  if (!next) return;
  busy = true;
  try {
    await runVerification(next.milestone_id, next.id, next.url);
  } finally {
    busy = false;
  }
}

async function runVerification(milestoneId: string, submissionId: string, url: string) {
  const runId = newId("run");
  const m = getMilestone(milestoneId);
  const agreement = verifiedLockedAgreement(milestoneId);
  getDb().prepare("INSERT INTO verification_runs (id, submission_id, status, runner_version, started_at) VALUES (?, ?, 'running', ?, ?)").run(runId, submissionId, RUNNER_VERSION, now());
  logEvent(milestoneId, "verification", "run_started", { runId, url, agent: agentAvailable() });
  const token = randomBytes(24).toString("hex");
  jobTokens.set(runId, token);
  const publicBase = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
  let result: { checks: WorkerCheckOutput[]; artifacts: { ref: string; kind: string; base64: string }[]; consoleLog: any[]; runError?: string };
  try {
    const res = await fetch(`${process.env.WORKER_URL ?? "http://localhost:3002"}/jobs`, {
      method: "POST",
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WORKER_JOB_SECRET ?? "dev-worker-secret"}` },
      body: JSON.stringify({
        runId,
        url,
        checks: agreement.body.checks,
        inboxUrl: `${publicBase}/inbox/${m.inbox_token}`,
        callbackBase: process.env.API_INTERNAL_URL ?? "http://localhost:3001",
        jobToken: token,
        useAgent: agentAvailable(),
      }),
    });
    if (!res.ok) throw new Error(`worker HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    result = (await res.json()) as typeof result;
  } catch (e) {
    jobTokens.delete(runId);
    finishRunAsError(milestoneId, runId, `worker unavailable: ${(e as Error).message}`);
    return;
  }
  jobTokens.delete(runId);
  if (result.runError) logEvent(milestoneId, "verification", "run_infra_error", { runId, error: result.runError });

  const dir = path.join(artifactsDir(), runId);
  fs.mkdirSync(dir, { recursive: true });
  for (const a of result.artifacts ?? []) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(a.ref)) continue; // plain file name only: no paths, no dotfiles
    fs.writeFileSync(path.join(dir, a.ref), Buffer.from(a.base64, "base64"));
  }
  fs.writeFileSync(path.join(dir, "console.json"), JSON.stringify(result.consoleLog ?? [], null, 1));

  // Give the inbox up to the rest of its 10 s window after the last form submission
  // (stop early once every form check has a complete row).
  const lastSubmit = Math.max(0, ...(result.checks ?? []).map((c) => (c.submittedAt ? Date.parse(c.submittedAt) : 0)));
  const formChecks = agreement.body.checks.filter((c) => c.type === "form_submits");
  while (lastSubmit && Date.now() < lastSubmit + INBOX_WINDOW_MS) {
    const rows = inboxRowsForRun(runId);
    if (formChecks.every((c) => rows.some((r) => fieldsInRow(c.params.fields as string[], r.body).missing.length === 0))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const inboxRows = inboxRowsForRun(runId);
  const resolves = makeResolver(runId);

  const evaluated = agreement.body.checks.map((check) => {
    const out = result.runError ? { checkId: check.id, infraError: result.runError, measured: {}, evidence: [] } : result.checks.find((c) => c.checkId === check.id);
    return { check, out, ev: evaluate(check, out, { inboxRows, resolves }) };
  });

  for (const { check, out, ev } of evaluated) {
    let explanation: unknown = null;
    if (ev.status === "failed") {
      const trace = readTrace(runId, check.id);
      const coach = await fixCoach(milestoneId, { check, status: ev.status, expected: ev.expected, measured: ev.measured, traceExcerpt: trace.slice(-12), consoleLog: (result.consoleLog ?? []).slice(-20) });
      explanation = { ...coach.data, source: coach.source };
    }
    const agent = out?.agent ? { ...out.agent, observations: filterObservations(out.agent.observations, resolves), droppedObservations: (out.agent.observations?.length ?? 0) - filterObservations(out.agent.observations, resolves).length } : null;
    getDb()
      .prepare("INSERT INTO check_results (id, run_id, check_id, status, expected_json, measured_json, evidence_json, explanation, agent_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(newId("res"), runId, check.id, ev.status, JSON.stringify(ev.expected), JSON.stringify(ev.measured), JSON.stringify(ev.evidence), explanation ? JSON.stringify(explanation) : null, agent ? JSON.stringify(agent) : null);
  }

  const failed = evaluated.filter((e) => e.ev.status === "failed").length;
  const errored = evaluated.filter((e) => e.ev.status === "error").length;
  const summary = { runId, passed: evaluated.length - failed - errored, failed, errored };
  if (failed === 0 && errored > 0) {
    finishRunAsError(milestoneId, runId, `${errored} check(s) could not run`);
    return;
  }
  tx(() => {
    getDb().prepare("UPDATE verification_runs SET status = 'finished', finished_at = ? WHERE id = ?").run(now(), runId);
    transition(milestoneId, failed ? "RUN_FAILED" : "RUN_PASSED", "verification", { data: summary });
  });
}

function makeResolver(runId: string) {
  const dir = path.join(artifactsDir(), runId);
  return (ref: string) => {
    if (ref.startsWith("inbox:")) return Boolean(getDb().prepare("SELECT 1 FROM form_inbox WHERE id = ? AND run_id = ?").get(Number(ref.slice(6)), runId));
    const [file, step] = ref.split("#");
    if (!/^[a-z0-9._-]+$/i.test(file)) return false;
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return false;
    if (!step) return true;
    try {
      return (JSON.parse(fs.readFileSync(p, "utf8")) as any[]).some((s) => s.id === step);
    } catch {
      return false;
    }
  };
}

function readTrace(runId: string, checkId: string): any[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(artifactsDir(), runId, `trace-${checkId}.json`), "utf8"));
  } catch {
    return [];
  }
}

export function runsFor(milestoneId: string) {
  const runs = getDb()
    .prepare(`SELECT r.*, s.url FROM verification_runs r JOIN submissions s ON s.id = r.submission_id WHERE s.milestone_id = ? ORDER BY r.started_at`)
    .all(milestoneId) as any[];
  return runs.map((r) => ({
    ...r,
    results: (getDb().prepare("SELECT * FROM check_results WHERE run_id = ?").all(r.id) as any[]).map((c) => ({
      id: c.id,
      checkId: c.check_id,
      status: c.status,
      expected: JSON.parse(c.expected_json),
      measured: JSON.parse(c.measured_json),
      evidence: JSON.parse(c.evidence_json),
      explanation: c.explanation ? JSON.parse(c.explanation) : null,
      agent: c.agent_json ? JSON.parse(c.agent_json) : null,
      trace: readTrace(r.id, c.check_id),
    })),
  }));
}
