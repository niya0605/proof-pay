import { useState } from "react";
import { api, money, type Detail } from "../api.ts";
import { useSession } from "../session.tsx";
import EvidenceCard from "../components/EvidenceCard.tsx";
import { ErrorText, Note, Section } from "../components/ui.tsx";

export default function Review({ d, reload }: { d: Detail; reload: () => void }) {
  const { role } = useSession();
  const a = d.agreement!;
  const run = d.runs.filter((r) => r.status === "finished").at(-1)!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [criterionId, setCriterionId] = useState(a.body.manual[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const reject = d.events.findLast?.((e) => e.type === "transition" && e.data.event === "REJECT");

  if (d.milestone.state === "DISPUTE") {
    return (
      <Section title="Dispute">
        <Note tone="warn">The client rejected, citing manual criterion <b className="font-mono">{reject?.data.criterionId}</b>: “{reject?.data.reason}”</Note>
        {reject?.data.attachment?.kind === "screenshot" ? <img src={reject.data.attachment.content} alt="client attachment" className="mt-2 max-h-64 rounded-lg border" /> : <p className="mt-2 text-sm text-stone-600">Note: {reject?.data.attachment?.content}</p>}
        {role === "admin" ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy} onClick={() => act(async () => { await api("POST", `/api/milestones/${d.milestone.id}/resolve`, { for: "freelancer" }); })}>Resolve for freelancer (capture)</button>
            <button className="btn-danger" disabled={busy} onClick={() => act(async () => { await api("POST", `/api/milestones/${d.milestone.id}/resolve`, { for: "client" }); })}>Resolve for client (void)</button>
          </div>
        ) : <p className="mt-3 text-sm text-stone-600">A demo admin resolves disputes.</p>}
        <ErrorText error={error} />
      </Section>
    );
  }

  return (
    <div className="space-y-5">
      <Section title="5 · Every automated check passed" right={<span className="mono block max-w-full break-all text-stone-500">{run.url}</span>}>
        <div className="space-y-3">
          {run.results.map((r) => <EvidenceCard key={r.id} result={r} runId={run.id} check={a.body.checks.find((c) => c.id === r.checkId)} />)}
        </div>
      </Section>
      {role === "client" ? (
        <Section title="Your review">
          {a.body.manual.length > 0 && (
            <div className="mb-3">
              <div className="label">Check these manual criteria yourself</div>
              <ul className="list-disc pl-5 text-sm">{a.body.manual.map((m) => <li key={m.id}><span className="font-mono text-xs">{m.id}</span> {m.description}</li>)}</ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy} onClick={() => act(async () => { await api("POST", `/api/milestones/${d.milestone.id}/accept`); })}>
              Accept and capture {money(d.milestone.amount_cents)}
            </button>
            {a.body.manual.length > 0 && <button className="btn-ghost" onClick={() => setRejecting(!rejecting)}>Reject on a manual criterion…</button>}
          </div>
          <p className="mt-2 text-xs text-stone-500">Accept moves the milestone to CAPTURE_PENDING and the backend attempts capture. It shows as paid only when PayPal reports COMPLETED.</p>
          {rejecting && (
            <form className="mt-4 space-y-3 rounded-xl border border-orange-200 bg-orange-50/50 p-4" onPaste={(e) => {
              // ⌘V / Ctrl+V an image anywhere in the form attaches it as the screenshot.
              const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith("image/"));
              if (!f) return;
              e.preventDefault();
              void shrinkImage(f).then(setShot);
            }} onSubmit={(e) => { e.preventDefault(); act(async () => {
              await api("POST", `/api/milestones/${d.milestone.id}/reject`, { criterionId, reason, attachment: shot ? { kind: "screenshot", content: shot } : { kind: "note", content: note } });
            }); }}>
              <p className="text-sm">You can only reject by citing a manual criterion from the locked agreement. Automated checks already passed and can’t be cited.</p>
              <label className="block"><span className="label">Criterion</span>
                <select className="input" value={criterionId} onChange={(e) => setCriterionId(e.target.value)}>{a.body.manual.map((m) => <option key={m.id} value={m.id}>{m.id}: {m.description}</option>)}</select>
              </label>
              <label className="block"><span className="label">Reason</span><textarea className="input" minLength={10} required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <label className="block"><span className="label">Attach a note…</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. the header uses the old logo" required={!shot} /></label>
              <label className="block"><span className="label">…or a screenshot (choose a file, or paste one with ⌘V)</span><input type="file" accept="image/*" onChange={(e) => {
                const f = e.target.files?.[0]; if (!f) return setShot(null);
                void shrinkImage(f).then(setShot);
              }} /></label>
              {shot && (
                <div className="flex items-start gap-2">
                  <img src={shot} alt="attached screenshot" className="max-h-32 rounded-lg border" />
                  <button type="button" className="btn-ghost text-xs" onClick={() => setShot(null)}>Remove</button>
                </div>
              )}
              <button className="btn-danger" disabled={busy}>Reject and open a dispute</button>
            </form>
          )}
          <ErrorText error={error} />
        </Section>
      ) : <Note>All checks passed. Waiting for the client to accept.</Note>}
    </div>
  );
}

/** Downscale to at most 1600px wide as JPEG so Retina screenshots fit the API's size limit. */
function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not read the image")); };
    img.src = url;
  });
}
