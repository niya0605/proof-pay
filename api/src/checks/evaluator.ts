/**
 * Deterministic evaluator. It computes passed | failed | error from measurements and
 * stored evidence only. Agent wording (plans, observations) is never an input.
 */
import { testValueFor, type Check } from "./catalog.ts";

export type Evidence = { kind: "trace" | "screenshot" | "inbox" | "console"; ref: string };
export type WorkerCheckOutput = {
  checkId: string;
  infraError?: string;
  measured: any;
  evidence: Evidence[];
  submittedAt?: string;
  agent?: { used: boolean; fallbackReason?: string; plan: any[]; observations: { text: string; evidenceRef: string }[] };
};
export type InboxRow = { id: number; received_at: string; body: Record<string, unknown> };
export type EvalContext = { inboxRows: InboxRow[]; resolves: (ref: string) => boolean };
export type Evaluated = { status: "passed" | "failed" | "error"; expected: unknown; measured: unknown; evidence: Evidence[] };

export const INBOX_WINDOW_MS = 10_000;

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Which listed fields arrived in an inbox row (by their fixed test value). */
export function fieldsInRow(fields: string[], body: Record<string, unknown>) {
  const values = Object.values(body).flatMap((v) => (Array.isArray(v) ? v : [v])).map(norm);
  const received = fields.filter((f) => values.includes(norm(testValueFor(f))));
  return { received, missing: fields.filter((f) => !received.includes(f)) };
}

export function evaluate(check: Check, out: WorkerCheckOutput | undefined, ctx: EvalContext): Evaluated {
  const expected = expectedFor(check);
  if (!out) return { status: "error", expected, measured: { error: "no result from the worker" }, evidence: [] };
  const evidence = [...out.evidence];
  if (out.infraError) return { status: "error", expected, measured: { error: out.infraError, ...out.measured }, evidence };

  let status: Evaluated["status"];
  let measured: any = out.measured;
  const m = out.measured ?? {};
  switch (check.type) {
    case "viewport_render":
      if (!m.loaded) status = m.httpStatus >= 400 ? "failed" : "error";
      else status = m.scrollWidth <= m.clientWidth ? "passed" : "failed";
      break;
    case "element_present":
      status = m.visible === true ? "passed" : "failed";
      break;
    case "text_present":
      status = m.found === true ? "passed" : "failed";
      break;
    case "no_console_errors": {
      const errors: string[] = (m.errors ?? []).filter((e: string) => !check.params.allowList.some((a) => a && e.includes(a)));
      measured = { errors };
      status = errors.length === 0 ? "passed" : "failed";
      break;
    }
    case "form_submits": {
      const submittedAt = out.submittedAt ? Date.parse(out.submittedAt) : NaN;
      const rows = ctx.inboxRows.filter((r) => {
        const t = Date.parse(r.received_at);
        return !Number.isNaN(submittedAt) && t >= submittedAt - 1000 && t <= submittedAt + INBOX_WINDOW_MS;
      });
      const scored = rows.map((r) => ({ r, ...fieldsInRow(check.params.fields, r.body) })).sort((a, b) => b.received.length - a.received.length);
      const best = scored[0];
      measured = {
        submitted: Boolean(out.submittedAt),
        fieldsNotFoundOnPage: m.fieldsNotFound ?? [],
        inboxRowsInWindow: rows.length,
        received: best?.received ?? [],
        missing: best?.missing ?? check.params.fields,
        inboxRowId: best?.r.id ?? null,
      };
      for (const s of scored) evidence.push({ kind: "inbox", ref: `inbox:${s.r.id}` });
      status = best && best.missing.length === 0 ? "passed" : "failed";
      break;
    }
  }
  // A result is only as good as its evidence: unresolved evidence never counts as passed.
  const unresolved = evidence.filter((e) => !ctx.resolves(e.ref));
  if (unresolved.length || (status === "passed" && evidence.length === 0)) {
    return { status: "error", expected, measured: { ...measured, evidenceUnavailable: unresolved.map((e) => e.ref) }, evidence };
  }
  return { status, expected, measured, evidence };
}

export function expectedFor(check: Check): unknown {
  switch (check.type) {
    case "viewport_render": return { width: check.params.width, rule: "scrollWidth <= clientWidth" };
    case "element_present": return { role: check.params.role, name: check.params.name, visible: true };
    case "text_present": return { text: check.params.text };
    case "no_console_errors": return { errors: [], allowList: check.params.allowList };
    case "form_submits": return { fields: Object.fromEntries(check.params.fields.map((f) => [f, testValueFor(f)])), withinMs: INBOX_WINDOW_MS };
  }
}

/** Keep only agent observations whose evidenceRef resolves to an artifact from this run. */
export function filterObservations(obs: { text: string; evidenceRef: string }[] = [], resolves: (ref: string) => boolean) {
  return obs.filter((o) => typeof o.evidenceRef === "string" && resolves(o.evidenceRef));
}
