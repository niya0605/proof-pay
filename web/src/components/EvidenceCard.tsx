import type { Check, Result } from "../api.ts";
import { StatusPill } from "./ui.tsx";

export default function EvidenceCard({ check, result, runId }: { check?: Check; result: Result; runId: string }) {
  const shots = result.evidence.filter((e) => e.kind === "screenshot");
  const coach = result.explanation;
  return (
    <div className={`rounded-xl border p-4 ${result.status === "failed" ? "border-red-200 bg-red-50/40" : result.status === "error" ? "border-amber-200 bg-amber-50/40" : "border-stone-200"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-stone-400">{result.checkId}</span>
        <span className="flex-1 text-sm font-semibold">{check?.description ?? result.checkId}</span>
        <StatusPill status={result.status} />
      </div>
      <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2">
        <div className="min-w-0"><div className="label">Expected</div><pre className="mono overflow-x-auto rounded-lg bg-stone-100 p-2">{JSON.stringify(result.expected, null, 1)}</pre></div>
        <div className="min-w-0"><div className="label">Measured</div><pre className="mono overflow-x-auto rounded-lg bg-stone-100 p-2">{JSON.stringify(result.measured, null, 1)}</pre></div>
      </div>
      {result.status === "error" && <p className="mt-2 text-xs text-amber-900">An error means the infrastructure failed; it never counts against the freelancer.</p>}
      {coach && (
        <div className="mt-3 rounded-lg border border-red-200 bg-white p-3">
          <div className="label text-red-700">Fix coach {coach.source === "fallback" && "(raw result, AI unavailable)"}</div>
          <p className="text-sm">{coach.explanation}</p>
          <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm text-stone-700">{coach.reproSteps?.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
          <p className="mt-2 text-sm"><b>Likely fix:</b> {coach.likelyFix}</p>
        </div>
      )}
      {result.trace?.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-teal-800">
            {result.agent?.used ? "Acceptance agent trace" : "Deterministic plan trace"} ({result.trace.length} steps)
          </summary>
          <Trace steps={result.trace} />
          {result.agent?.observations?.length > 0 && (
            <div className="mt-2">
              <div className="label">Agent observations (evidence-linked; never a verdict)</div>
              <ul className="space-y-1 text-sm">{result.agent.observations.map((o: any, i: number) => <li key={i}>{o.text} <span className="mono text-stone-500">[{o.evidenceRef}]</span></li>)}</ul>
            </div>
          )}
          {result.agent?.droppedObservations > 0 && <p className="mt-1 text-xs text-stone-500">{result.agent.droppedObservations} observation(s) dropped: their evidence didn’t resolve to an artifact from this run.</p>}
        </details>
      )}
      {shots.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {shots.map((s) => (
            <a key={s.ref} href={`/artifacts/${runId}/${s.ref}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-stone-200">
              <img src={`/artifacts/${runId}/${s.ref}`} alt={`evidence ${s.ref}`} className="h-24 w-auto object-cover object-top" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).alt = "evidence unavailable")} />
            </a>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {result.evidence.map((e) => <span key={e.ref} className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600">{e.kind}:{e.ref}</span>)}
      </div>
    </div>
  );
}

export function Trace({ steps }: { steps: any[] }) {
  return (
    <ol className="mt-2 space-y-1">
      {steps.map((s) => (
        <li key={s.id} className="flex min-w-0 flex-wrap gap-x-2 rounded-md bg-stone-900 px-2 py-1 font-mono text-[11px] text-stone-100">
          <span className="text-stone-500">{s.id}</span>
          <span className={s.by === "agent" ? "text-teal-300" : "text-sky-300"}>{s.tool}</span>
          <span className="text-amber-200">{s.input && Object.keys(s.input).length ? JSON.stringify(s.input).slice(0, 90) : ""}</span>
          <span className="truncate text-stone-400">→ {String(s.result).slice(0, 140)}</span>
        </li>
      ))}
    </ol>
  );
}
