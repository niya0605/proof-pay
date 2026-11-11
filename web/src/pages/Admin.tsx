import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, money } from "../api.ts";
import { useSession } from "../session.tsx";
import { ErrorText, Note, PageHeader, Stat, StateBadge, STATE_LABEL } from "../components/ui.tsx";

type Row = { id: string; title: string; state: string; amount_cents: number; currency: string; project_title: string };

const NEEDS_ADMIN = ["DISPUTE", "CAPTURE_FAILED", "AUTH_EXPIRED"];
const IN_FLIGHT = ["VERIFYING", "CAPTURE_PENDING", "VOID_PENDING"];

export default function Admin() {
  const { role } = useSession();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api<Row[]>("GET", "/api/milestones").then(setRows);
  useEffect(() => { load(); }, []);
  if (role !== "admin") return <Note>Switch to the admin role to open the console.</Note>;

  const act = async (key: string, path: string, body?: unknown) => {
    setError(null); setMsg(null); setBusy(key);
    try {
      const r = await api("POST", path, body);
      setMsg(r.state ? `Done: milestone is now ${STATE_LABEL[r.state] ?? r.state}.` : "Reconciler finished: every pending or unknown PayPal operation was checked.");
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const attention = rows.filter((r) => NEEDS_ADMIN.includes(r.state));
  const count = (states: string[]) => rows.filter((r) => states.includes(r.state)).length;

  const actions = (r: Row) => (
    <div className="flex flex-wrap justify-end gap-2">
      {r.state === "DISPUTE" && <>
        <button className="btn-primary px-3 py-1.5" disabled={!!busy} onClick={() => act(r.id, `/api/milestones/${r.id}/resolve`, { for: "freelancer" })}>Pay freelancer (capture)</button>
        <button className="btn-danger px-3 py-1.5" disabled={!!busy} onClick={() => act(r.id, `/api/milestones/${r.id}/resolve`, { for: "client" })}>Refund client (void)</button>
      </>}
      {(r.state === "CAPTURE_FAILED" || r.state === "AUTH_EXPIRED") && <button className="btn-danger px-3 py-1.5" disabled={!!busy} onClick={() => act(r.id, `/api/milestones/${r.id}/close`)}>Close milestone</button>}
      <Link to={`/m/${r.id}`} className="btn-ghost px-3 py-1.5">Open</Link>
    </div>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Admin console"
        subtitle="Resolve disputes and close milestones stuck in Capture failed or Authorization expired. Admins never mark a failed check as passed; automated verdicts come only from the evaluator."
        right={<button className="btn-ghost" disabled={!!busy} onClick={() => act("reconcile", "/api/admin/reconcile")}>{busy === "reconcile" ? "Reconciling…" : "Run the reconciler now"}</button>}
      />
      {msg && <Note tone="ok">{msg}</Note>}
      <ErrorText error={error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Needs an admin" value={attention.length} hint="disputes and stuck payments" accent={attention.length > 0} />
        <Stat label="In flight" value={count(IN_FLIGHT)} hint="verifying, capturing or voiding" />
        <Stat label="Captured" value={count(["CAPTURED"])} hint="PayPal COMPLETED" />
        <Stat label="Voided" value={count(["VOIDED"])} hint="authorization released" />
      </div>

      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold tracking-tight">Needs attention</h2>
        {attention.length === 0 ? (
          <div className="card p-6 text-sm text-stone-600">Nothing needs an admin right now. Disputes appear here when a client rejects work by citing a manual criterion.</div>
        ) : (
          <div className="grid gap-3">
            {attention.map((r) => (
              <div key={r.id} className="card flex flex-wrap items-center gap-4 border-amber-200 bg-amber-50/40">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{r.project_title} <span className="font-normal text-stone-500">· {money(r.amount_cents, r.currency)}</span></div>
                  <div className="mt-1"><StateBadge state={r.state} /></div>
                </div>
                {actions(r)}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold tracking-tight">All milestones</h2>
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="border-b border-stone-200 bg-stone-50/70"><tr><th className="th">Project</th><th className="th">Status</th><th className="th text-right">Amount</th><th className="th text-right">Actions</th></tr></thead>
              <tbody className="divide-y divide-stone-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="td"><div className="font-semibold">{r.project_title}</div><div className="font-mono text-[11px] text-stone-400">{r.id}</div></td>
                    <td className="td"><StateBadge state={r.state} /></td>
                    <td className="td tabular text-right font-semibold">{money(r.amount_cents, r.currency)}</td>
                    <td className="td">{actions(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
