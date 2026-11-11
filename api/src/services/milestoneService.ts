import { getDb, tx } from "../db/migrate.ts";
import { MilestoneState, RULES, resolveTarget, type Actor, type MilestoneEvent, type TransitionCtx } from "../domain/milestoneState.ts";
import { logEvent } from "./eventService.ts";
import { HttpError } from "./errors.ts";

export type MilestoneRow = {
  id: string; project_id: string; title: string; amount_cents: number; currency: string;
  state: MilestoneState; deadline_at: string; review_window_hours: number; inbox_token: string;
};

export function getMilestone(id: string): MilestoneRow {
  const m = getDb().prepare("SELECT * FROM milestones WHERE id = ?").get(id) as MilestoneRow | undefined;
  if (!m) throw new HttpError(404, "milestone not found");
  return m;
}

/**
 * The only way a milestone changes state. Runs in one SQLite transaction with a
 * compare-and-set on the current state; `effect` runs inside the same transaction.
 */
export function transition(
  id: string,
  event: MilestoneEvent,
  actor: Actor,
  opts: { ctx?: TransitionCtx; effect?: () => void; data?: Record<string, unknown> } = {},
): { from: MilestoneState; to: MilestoneState } {
  return tx(() => {
    const m = getMilestone(id);
    const rule = RULES[event];
    if (!(rule.actors as Actor[]).includes(actor)) throw new HttpError(403, `${actor} may not ${event}`);
    if (!(rule.from as MilestoneState[]).includes(m.state))
      throw new HttpError(409, `${event} is not valid in state ${m.state}`);
    const to = resolveTarget(event, m.state, opts.ctx ?? {});
    const r = getDb().prepare("UPDATE milestones SET state = ? WHERE id = ? AND state = ?").run(to, id, m.state);
    if (r.changes !== 1) throw new HttpError(409, "state changed concurrently");
    opts.effect?.();
    logEvent(id, actor, "transition", { event, from: m.state, to, ...opts.data });
    return { from: m.state, to };
  });
}

export function hasPassingRun(milestoneId: string): boolean {
  return latestFinishedRunOutcome(milestoneId) === "passed";
}

export function latestFinishedRunOutcome(milestoneId: string): "passed" | "failed" | null {
  const run = getDb()
    .prepare(
      `SELECT r.id FROM verification_runs r JOIN submissions s ON s.id = r.submission_id
       WHERE s.milestone_id = ? AND r.status = 'finished' ORDER BY r.finished_at DESC LIMIT 1`,
    )
    .get(milestoneId) as { id: string } | undefined;
  if (!run) return null;
  const bad = getDb()
    .prepare("SELECT COUNT(*) AS n FROM check_results WHERE run_id = ? AND status != 'passed'")
    .get(run.id) as { n: number };
  return bad.n === 0 ? "passed" : "failed";
}
