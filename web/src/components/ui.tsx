import type { ReactNode } from "react";

// Human labels for the milestone state machine; the raw enum stays available as a tooltip.
export const STATE_LABEL: Record<string, string> = {
  DRAFT: "Draft", PROPOSED: "Agreement proposed", LOCKED: "Locked", FUNDED: "Authorized", VERIFYING: "Verifying",
  FAILED: "Checks failed", REVIEW: "In review", DISPUTE: "In dispute", CAPTURE_PENDING: "Capturing", CAPTURED: "Captured",
  CAPTURE_FAILED: "Capture failed", AUTH_EXPIRED: "Authorization expired", VOID_PENDING: "Voiding", VOIDED: "Voided",
};
const TONE: Record<string, string> = {
  neutral: "bg-stone-100 text-stone-700 ring-stone-200", blue: "bg-sky-50 text-sky-800 ring-sky-200", indigo: "bg-indigo-50 text-indigo-800 ring-indigo-200",
  teal: "bg-teal-50 text-teal-800 ring-teal-200", amber: "bg-amber-50 text-amber-800 ring-amber-200", red: "bg-red-50 text-red-700 ring-red-200",
  violet: "bg-violet-50 text-violet-800 ring-violet-200", green: "bg-emerald-50 text-emerald-800 ring-emerald-300", dark: "bg-stone-800 text-white ring-stone-800",
};
const DOT: Record<string, string> = {
  neutral: "bg-stone-400", blue: "bg-sky-500", indigo: "bg-indigo-500", teal: "bg-teal-500", amber: "bg-amber-500 animate-pulse",
  red: "bg-red-500", violet: "bg-violet-500", green: "bg-emerald-500", dark: "bg-stone-300",
};
const STATE_TONE: Record<string, string> = {
  DRAFT: "neutral", PROPOSED: "blue", LOCKED: "indigo", FUNDED: "teal", VERIFYING: "amber", FAILED: "red", REVIEW: "violet",
  DISPUTE: "amber", CAPTURE_PENDING: "amber", CAPTURED: "green", CAPTURE_FAILED: "red", AUTH_EXPIRED: "red", VOID_PENDING: "neutral", VOIDED: "dark",
};
export const StateBadge = ({ state }: { state: string }) => {
  const tone = STATE_TONE[state] ?? "neutral";
  return (
    <span title={state} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${TONE[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
      {STATE_LABEL[state] ?? state}
    </span>
  );
};

/** What the signed-in role should do next for a milestone in this state, if anything. */
export function nextStep(state: string, role: string | null): string | null {
  const steps: Record<string, Record<string, string>> = {
    client: { DRAFT: "Clarify the brief", PROPOSED: "Review and approve the checks", LOCKED: "Authorize with PayPal", REVIEW: "Accept or reject", AUTH_EXPIRED: "Re-authorize", CAPTURE_FAILED: "Re-authorize" },
    freelancer: { PROPOSED: "Review and approve the checks", FUNDED: "Submit the site URL", FAILED: "Fix and resubmit" },
    admin: { DISPUTE: "Resolve the dispute", CAPTURE_FAILED: "Close or wait for re-authorization", AUTH_EXPIRED: "Close or wait for re-authorization" },
  };
  return (role && steps[role]?.[state]) || null;
}

export const Stat = ({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: boolean }) => (
  <div className={`card p-4 ${accent ? "border-teal-200 bg-gradient-to-br from-teal-50 to-white" : ""}`}>
    <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">{label}</div>
    <div className="tabular mt-1 text-2xl font-bold tracking-tight">{value}</div>
    {hint && <div className="mt-0.5 text-xs text-stone-500">{hint}</div>}
  </div>
);

export const PageHeader = ({ eyebrow, title, subtitle, right }: { eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) => (
  <div className="flex flex-wrap items-end justify-between gap-4">
    <div className="min-w-0">
      {eyebrow && <div className="mb-1 text-sm text-stone-500">{eyebrow}</div>}
      <h1 className="text-2xl font-bold tracking-tight text-stone-900 sm:text-[1.75rem]">{title}</h1>
      {subtitle && <p className="mt-1 max-w-2xl text-sm text-stone-600">{subtitle}</p>}
    </div>
    {right}
  </div>
);

const STATUS: Record<string, string> = { passed: "bg-emerald-100 text-emerald-800", failed: "bg-red-100 text-red-800", error: "bg-amber-100 text-amber-900" };
export const StatusPill = ({ status }: { status: string }) => (
  <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold uppercase ${STATUS[status] ?? "bg-stone-100 text-stone-700"}`}>
    {status === "passed" ? "✓" : status === "failed" ? "✕" : "!"} {status}
  </span>
);

export const Section = ({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) => (
  <section className="card min-w-0">
    <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2 [&>*]:min-w-0 [&>*]:max-w-full">
      <h2 className="text-[15px] font-semibold tracking-tight text-stone-900">{title}</h2>
      {right}
    </div>
    {children}
  </section>
);

export const Note = ({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "error" | "ok" }) => {
  const s = { info: "border-sky-200 bg-sky-50 text-sky-900", warn: "border-amber-200 bg-amber-50 text-amber-900", error: "border-red-200 bg-red-50 text-red-900", ok: "border-emerald-200 bg-emerald-50 text-emerald-900" }[tone];
  return <div className={`rounded-lg border px-3 py-2 text-sm ${s}`}>{children}</div>;
};

const STEPS = ["DRAFT", "PROPOSED", "LOCKED", "FUNDED", "VERIFYING", "REVIEW", "CAPTURE_PENDING", "CAPTURED"];
const STEP_OF: Record<string, number> = { FAILED: 4, DISPUTE: 5, CAPTURE_FAILED: 6, AUTH_EXPIRED: 3, VOID_PENDING: 7, VOIDED: 7 };
export function Stepper({ state }: { state: string }) {
  const at = STEPS.includes(state) ? STEPS.indexOf(state) : STEP_OF[state] ?? 0;
  const labels = ["Brief", "Agreement", "Locked", "Authorized", "Verifying", "Review", "Capture", "Captured"];
  return (
    <ol className="grid grid-cols-4 gap-1 sm:grid-cols-8">
      {labels.map((l, i) => (
        <li key={l} className="flex flex-col gap-1">
          <div className={`h-1.5 rounded-full ${i < at ? "bg-teal-600" : i === at ? "bg-teal-400" : "bg-stone-200"}`} />
          <span className={`text-[11px] ${i === at ? "font-bold text-teal-800" : "text-stone-500"}`}>{l}</span>
        </li>
      ))}
    </ol>
  );
}

export const ErrorText = ({ error }: { error: string | null }) => (error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null);
