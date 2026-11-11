import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, money } from "../api.ts";
import { useSession } from "../session.tsx";
import { PageHeader, Stat, StateBadge, nextStep } from "../components/ui.tsx";

type Row = { id: string; title: string; state: string; amount_cents: number; currency: string; deadline_at: string; project_title: string; created_at: string };

const HELD = ["FUNDED", "VERIFYING", "FAILED", "REVIEW", "DISPUTE", "CAPTURE_PENDING"];
const STEPS = [
  { n: "1", t: "Brief → checks", d: "AI flags vague words and proposes measurable checks from a fixed catalog." },
  { n: "2", t: "Lock → authorize", d: "Both sides approve. The SHA-256 of the agreement goes to PayPal as custom_id." },
  { n: "3", t: "Agent verifies", d: "A sandboxed browser agent tests the live site. Code, not the AI, decides pass or fail." },
  { n: "4", t: "Accept → capture", d: "Capture happens only after the client accepts, and shows PayPal's confirmed status." },
];

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function Home() {
  const { role } = useSession();
  const nav = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => { api<Row[]>("GET", "/api/milestones").then(setRows); }, [role]);

  const sum = (states: string[]) => (rows ?? []).filter((r) => states.includes(r.state)).reduce((a, r) => a + r.amount_cents, 0);
  const yours = (rows ?? []).filter((r) => nextStep(r.state, role)).length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Milestones"
        subtitle="Every milestone moves from a brief to signed checks, an authorized PayPal payment, verified delivery and a capture after the client accepts."
        right={role === "client" && <Link to="/new" className="btn-primary">+ New project</Link>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Milestones" value={rows ? rows.length : "–"} hint="all projects" />
        <Stat label="Waiting on you" value={rows ? yours : "–"} hint={`as ${role}`} accent={yours > 0} />
        <Stat label="Authorized" value={rows ? money(sum(HELD)) : "–"} hint="reserved at PayPal, not captured" />
        <Stat label="Captured" value={rows ? money(sum(["CAPTURED"])) : "–"} hint="confirmed COMPLETED by PayPal" />
      </div>

      <div className="card overflow-hidden p-0">
        {rows === null ? (
          <p className="p-6 text-sm text-stone-500">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-base font-semibold">No milestones yet</div>
            <p className="mt-1 text-sm text-stone-600">{role === "client" ? "Paste a brief and Proof-Pay will turn it into acceptance checks." : "Switch to the client role to create the first project."}</p>
            {role === "client" && <Link to="/new" className="btn-primary mt-4">Create a project</Link>}
          </div>
        ) : (
          <>
          <ul className="divide-y divide-stone-100 sm:hidden">
            {rows.map((r) => {
              const step = nextStep(r.state, role);
              return (
                <li key={r.id}>
                  <Link to={`/m/${r.id}`} className="block px-4 py-3.5 active:bg-stone-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0"><div className="truncate font-semibold">{r.project_title}</div><div className="text-xs text-stone-500">{r.title}</div></div>
                      <div className="tabular font-semibold">{money(r.amount_cents, r.currency)}</div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <StateBadge state={r.state} />
                      {step && <span className="text-xs font-medium text-teal-800">→ {step}</span>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-stone-200 bg-stone-50/70">
                <tr><th className="th">Project</th><th className="th">Status</th><th className="th">Your next step</th><th className="th text-right">Amount</th><th className="th text-right">Created</th></tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {rows.map((r) => {
                  const step = nextStep(r.state, role);
                  return (
                    <tr key={r.id} className="cursor-pointer transition hover:bg-stone-50" onClick={() => nav(`/m/${r.id}`)}>
                      <td className="td">
                        <Link to={`/m/${r.id}`} className="font-semibold text-stone-900 hover:text-teal-800" onClick={(e) => e.stopPropagation()}>{r.project_title}</Link>
                        <div className="text-xs text-stone-500">{r.title}</div>
                      </td>
                      <td className="td"><StateBadge state={r.state} /></td>
                      <td className="td">{step ? <span className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-800"><span className="h-1.5 w-1.5 rounded-full bg-teal-600" />{step}</span> : <span className="text-sm text-stone-400">Nothing for you</span>}</td>
                      <td className="td tabular text-right font-semibold">{money(r.amount_cents, r.currency)}</td>
                      <td className="td tabular text-right text-stone-500">{r.created_at ? date(r.created_at) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>

      <section>
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-stone-500">How Proof-Pay works</div>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="card p-4">
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-teal-700 text-xs font-bold text-white">{s.n}</span>
                <span className="text-sm font-semibold">{s.t}</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-stone-600">{s.d}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
