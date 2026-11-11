import { useState } from "react";
import { api, time, type Detail } from "../api.ts";
import { useSession } from "../session.tsx";
import CheckList from "../components/CheckList.tsx";
import { ErrorText, Note, Section } from "../components/ui.tsx";

/** Both parties review, optionally edit, and approve the same version. The second approval locks and hashes it. */
export default function Agreement({ d, reload }: { d: Detail; reload: () => void }) {
  const { role } = useSession();
  const a = d.agreement!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = role === "client" ? a.client_approved_at : role === "freelancer" ? a.freelancer_approved_at : null;
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return (
    <Section title={`2 · Agreement (version ${a.version})`} right={<span className="text-sm text-stone-500">Payee: <span className="font-mono">{a.body.payee.email}</span> · deadline {time(a.body.deadlineAt)}</span>}>
      <CheckList agreement={a} />
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {(["client", "freelancer"] as const).map((r) => {
          const at = r === "client" ? a.client_approved_at : a.freelancer_approved_at;
          return (
            <div key={r} className={`rounded-xl border px-3 py-2 text-sm ${at ? "border-emerald-200 bg-emerald-50" : "border-stone-200"}`}>
              <b className="capitalize">{r}</b>: {at ? `approved v${a.version} at ${time(at)}` : "not approved yet"}
            </div>
          );
        })}
      </div>
      <div className="mt-4"><Note tone="info">
        Editing any criterion clears both approvals. The second approval locks the agreement, computes its SHA-256 hash and puts that hash on the PayPal order as <span className="font-mono">custom_id</span>.
      </Note></div>
      {(role === "client" || role === "freelancer") && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy || Boolean(mine)} onClick={() => run(async () => { await api("POST", `/api/milestones/${d.milestone.id}/approve`, { version: a.version }); })}>
            {mine ? "You approved this version" : `Approve version ${a.version} as ${role}`}
          </button>
          <button className="btn-ghost" onClick={() => { setDraft(JSON.stringify({ checks: a.body.checks, manual: a.body.manual, advisory: a.body.advisory }, null, 2)); setEditing(!editing); }}>
            {editing ? "Cancel edit" : "Edit criteria"}
          </button>
        </div>
      )}
      {editing && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-stone-500">Edit as JSON. Only the five catalog check types are accepted, and the server validates every field.</p>
          <textarea className="input min-h-72 font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn-primary" disabled={busy} onClick={() => run(async () => {
            await api("PATCH", `/api/milestones/${d.milestone.id}/agreement`, { proposal: JSON.parse(draft), baseVersion: a.version });
            setEditing(false);
          })}>Save as a new version (clears approvals)</button>
        </div>
      )}
      <ErrorText error={error} />
    </Section>
  );
}
