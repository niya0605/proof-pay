import { createHash } from "node:crypto";
import { getDb, now, tx } from "../db/migrate.ts";
import { MilestoneState } from "../domain/milestoneState.ts";
import { ProposalSchema, type Proposal } from "../checks/catalog.ts";
import { getMilestone, transition } from "./milestoneService.ts";
import { HttpError } from "./errors.ts";
import { logEvent } from "./eventService.ts";

export type AgreementBody = Proposal & {
  milestoneId: string;
  amount: { value: string; currency: string };
  payee: { email: string };
  deadlineAt: string;
  reviewRule: { rejectionOnlyCitingManual: true; manualCriteria: number; reviewWindowHours: number };
};

export type AgreementRow = {
  milestone_id: string; version: number; body_json: string; hash: string | null;
  client_approved_at: string | null; freelancer_approved_at: string | null; locked_at: string | null;
};

/** Canonical JSON: keys sorted recursively, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const hashAgreement = (body: AgreementBody) => createHash("sha256").update(canonicalJson(body)).digest("hex");

export const centsToValue = (cents: number) => (cents / 100).toFixed(2);

export function getAgreement(milestoneId: string): (AgreementRow & { body: AgreementBody }) | null {
  const row = getDb().prepare("SELECT * FROM agreements WHERE milestone_id = ?").get(milestoneId) as AgreementRow | undefined;
  return row ? { ...row, body: JSON.parse(row.body_json) } : null;
}

function buildBody(milestoneId: string, proposal: Proposal): AgreementBody {
  const m = getMilestone(milestoneId);
  const p = getDb().prepare("SELECT freelancer_email FROM projects WHERE id = ?").get(m.project_id) as { freelancer_email: string };
  return {
    milestoneId,
    checks: proposal.checks,
    manual: proposal.manual,
    advisory: proposal.advisory,
    amount: { value: centsToValue(m.amount_cents), currency: m.currency },
    payee: { email: p.freelancer_email },
    deadlineAt: m.deadline_at,
    reviewRule: { rejectionOnlyCitingManual: true, manualCriteria: proposal.manual.length, reviewWindowHours: m.review_window_hours },
  };
}

/** Store a (new) proposal. Clears both approvals and bumps the version. */
function writeProposal(milestoneId: string, proposal: Proposal) {
  const body = buildBody(milestoneId, ProposalSchema.parse(proposal));
  getDb()
    .prepare(
      `INSERT INTO agreements (milestone_id, version, body_json, hash, client_approved_at, freelancer_approved_at, locked_at)
       VALUES (?, 1, ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(milestone_id) DO UPDATE SET version = version + 1, body_json = excluded.body_json,
         client_approved_at = NULL, freelancer_approved_at = NULL
       WHERE locked_at IS NULL`,
    )
    .run(milestoneId, JSON.stringify(body));
  const a = getAgreement(milestoneId)!;
  if (a.locked_at) throw new HttpError(409, "agreement is locked");
}

export function setProposal(milestoneId: string, proposal: Proposal, source: string) {
  transition(milestoneId, "PROPOSAL_READY", "system", { effect: () => writeProposal(milestoneId, proposal), data: { source } });
}

export function editAgreement(milestoneId: string, actor: "client" | "freelancer", proposal: unknown, baseVersion: number) {
  const parsed = ProposalSchema.safeParse(proposal);
  if (!parsed.success) throw new HttpError(400, "invalid agreement", parsed.error.issues);
  transition(milestoneId, "CRITERION_EDITED", actor, {
    effect: () => {
      const a = getAgreement(milestoneId);
      if (!a || a.locked_at) throw new HttpError(409, "agreement is locked");
      if (a.version !== baseVersion) throw new HttpError(409, `agreement changed (now version ${a.version})`);
      writeProposal(milestoneId, parsed.data);
    },
  });
}

/**
 * Record one party's approval of a specific version. The second approval locks the
 * agreement, stores its hash and queues the PayPal order — all in one transaction.
 * Returns true if this call locked the agreement.
 */
export function approve(milestoneId: string, actor: "client" | "freelancer", version: number, onLock: () => void): boolean {
  return tx(() => {
    const m = getMilestone(milestoneId);
    if (m.state !== MilestoneState.PROPOSED) throw new HttpError(409, `cannot approve in state ${m.state}`);
    const a = getAgreement(milestoneId);
    if (!a) throw new HttpError(409, "no agreement");
    if (a.version !== version) throw new HttpError(409, `you approved version ${version}, but the agreement is now version ${a.version}`);
    const col = actor === "client" ? "client_approved_at" : "freelancer_approved_at";
    getDb().prepare(`UPDATE agreements SET ${col} = ? WHERE milestone_id = ? AND version = ?`).run(now(), milestoneId, version);
    logEvent(milestoneId, actor, "approved", { version });
    const after = getAgreement(milestoneId)!;
    if (!(after.client_approved_at && after.freelancer_approved_at)) return false;
    const hash = hashAgreement(after.body);
    transition(milestoneId, "LOCK", actor, {
      effect: () => {
        getDb().prepare("UPDATE agreements SET hash = ?, locked_at = ? WHERE milestone_id = ? AND version = ?").run(hash, now(), milestoneId, version);
        onLock();
      },
      data: { hash, version },
    });
    return true;
  });
}

/** Recompute the hash from the stored body and compare: detects tampering with the locked row. */
export function verifiedLockedAgreement(milestoneId: string) {
  const a = getAgreement(milestoneId);
  if (!a?.locked_at || !a.hash) throw new HttpError(409, "agreement not locked");
  if (hashAgreement(a.body) !== a.hash) throw new HttpError(500, "stored agreement does not match its hash");
  return a as AgreementRow & { body: AgreementBody; hash: string };
}
