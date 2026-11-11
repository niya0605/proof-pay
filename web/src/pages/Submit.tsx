import { useState } from "react";
import { api, type Detail } from "../api.ts";
import { useSession } from "../session.tsx";
import EvidenceCard, { Trace } from "../components/EvidenceCard.tsx";
import { ErrorText, Note, Section } from "../components/ui.tsx";

export default function Submit({ d, reload }: { d: Detail; reload: () => void }) {
  const { role, config } = useSession();
  const s = d.milestone.state;
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const withInbox = (site: string) => `${site}${site.includes("?") ? "&" : "?"}inbox=${encodeURIComponent(d.inboxUrl)}`;
  const lastRun = d.runs.at(-1);
  const lastStart = [...d.events].reverse().find((e) => e.type === "run_started");
  const live = s === "VERIFYING" && lastStart ? d.events.filter((e) => e.id > lastStart.id && e.type === "tool_call").map((e) => e.data.step) : [];
  const runErrors = [...d.events].reverse().find((e) => e.type === "transition" && e.data.event === "RUN_ERROR");
  return (
    <div className="space-y-5">
      {s === "VERIFYING" ? (
        <Section title="Verifying the live deliverable…" right={<span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500" />}>
          <p className="text-sm text-stone-600">The verifier is running every locked check in a sandboxed browser. {live.length ? "Live trace:" : "Starting the browser…"}</p>
          {live.length > 0 && <Trace steps={live} />}
        </Section>
      ) : role === "freelancer" ? (
        <Section title={s === "FAILED" ? "Fix and resubmit" : "4 · Submit your deliverable"}>
          <div className="mb-3 rounded-lg bg-stone-100 p-3 text-sm">
            <div className="label">Your contact form must POST to this milestone’s Proof-Pay inbox</div>
            <code className="block break-all font-mono text-xs">{d.inboxUrl}</code>
            <p className="mt-1 text-xs text-stone-500">The demo sites read it from the <span className="font-mono">?inbox=</span> query parameter. Nothing sends real email.</p>
          </div>
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("POST", `/api/milestones/${d.milestone.id}/submit`, { url }); }); }}>
            <input className="input flex-1" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} required />
            <button className="btn-primary" disabled={busy}>Submit for verification</button>
          </form>
          {config?.demoSites?.length ? (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="text-stone-500">Demo deliverables:</span>
              {config.demoSites.map((site) => (
                <button key={site} type="button" className="rounded-full border border-stone-300 px-2 py-0.5 font-mono hover:bg-stone-50" onClick={() => setUrl(withInbox(site))}>{site.replace(/^https?:\/\//, "")}</button>
              ))}
            </div>
          ) : null}
          <p className="mt-2 text-xs text-stone-500">Accepted: https on port 443, hosts on the allowlist only ({(config as any)?.allowedHosts?.join(", ") || "local demo origins in dev"}).</p>
          <ErrorText error={error} />
        </Section>
      ) : (
        <Section title="Waiting for the freelancer">
          <p className="text-sm text-stone-600">The payment is authorized. The freelancer submits a URL and the acceptance agent tests it. Failed checks go straight back to the freelancer; you don’t need to do anything.</p>
          {role === "client" && (
            <div className="mt-3">
              <button className="btn-danger" disabled={busy} onClick={() => confirm("Cancel the milestone and void the PayPal authorization?") && run(async () => { await api("POST", `/api/milestones/${d.milestone.id}/cancel`); })}>Cancel milestone and void authorization</button>
              <ErrorText error={error} />
            </div>
          )}
        </Section>
      )}
      {s === "FUNDED" && runErrors && lastRun?.status === "error" && (
        <Note tone="warn">The last run hit an infrastructure error ({lastRun.error}). It doesn’t count against the freelancer. Resubmit to try again.</Note>
      )}
      {s === "FAILED" && lastRun && (
        <Section title={`Last run: ${lastRun.results.filter((r) => r.status === "failed").length} check(s) failed`} right={<span className="mono block max-w-full break-all text-stone-500">{lastRun.url}</span>}>
          <div className="space-y-3">
            {[...lastRun.results].sort((a, b) => (a.status === "failed" ? -1 : 0) - (b.status === "failed" ? -1 : 0)).map((r) => (
              <EvidenceCard key={r.id} result={r} runId={lastRun.id} check={d.agreement?.body.checks.find((c) => c.id === r.checkId)} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
