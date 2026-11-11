import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { money, time } from "../api.ts";
import { useMilestone } from "./Milestone.tsx";
import CheckList from "../components/CheckList.tsx";
import EvidenceCard from "../components/EvidenceCard.tsx";
import Timeline from "../components/Timeline.tsx";
import { Note, PageHeader, Section, StateBadge } from "../components/ui.tsx";

export default function Report() {
  const { id } = useParams();
  const { d, error } = useMilestone(id!);
  if (error) return <Note tone="error">{error}</Note>;
  if (!d) return <p className="text-sm text-stone-500">Loading…</p>;
  const a = d.agreement;
  const capOp = [...d.operations].reverse().find((o) => o.type === "capture");
  const capEvent = [...d.events].reverse().find((e) => e.type === "transition" && e.data.event === "CAPTURE_COMPLETED");
  const lastRun = d.runs.filter((r) => r.status === "finished").at(-1);
  const paid = d.milestone.state === "CAPTURED" && capEvent?.data.paypalStatus === "COMPLETED";
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={<Link to={`/m/${d.milestone.id}`} className="hover:text-stone-800">← Back to milestone</Link>}
        title={<>Delivery report <span className="text-stone-400">·</span> {d.project.title}</>}
        subtitle="Everything that happened, with evidence: the signed agreement, what the verifier measured, and what PayPal confirmed."
        right={<div className="flex items-center gap-2"><StateBadge state={d.milestone.state} /><button className="btn-ghost px-3 py-1.5 print:hidden" onClick={() => window.print()}>Print / PDF</button></div>}
      />

      <section className={`rounded-2xl border p-6 ${paid ? "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white" : "border-stone-200 bg-white"}`}>
        <div className="label">Payment status · reported by PayPal, never by the AI</div>
        {paid ? (
          <div className="mt-2 grid gap-4 sm:grid-cols-3">
            <div><div className="text-xs text-stone-500">PayPal capture id</div><div className="mt-0.5 break-all font-mono text-lg font-semibold">{capEvent!.data.captureId}</div></div>
            <div><div className="text-xs text-stone-500">PayPal status</div><div className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-lg font-semibold text-emerald-700"><span className="h-2 w-2 rounded-full bg-emerald-500" />{capEvent!.data.paypalStatus}</div></div>
            <div><div className="text-xs text-stone-500">Amount captured</div><div className="tabular mt-0.5 text-lg font-semibold">{money(d.milestone.amount_cents, d.milestone.currency)}</div></div>
          </div>
        ) : (
          <p className="text-sm">
            {d.milestone.state === "CAPTURE_PENDING" ? "Capture requested; waiting for PayPal to confirm." : d.milestone.state === "VOIDED" ? "Authorization voided (confirmed by PayPal). Nothing was paid." : `Not paid. Current state ${d.milestone.state}.`}
            {capOp && <span className="ml-1 font-mono text-xs">Last capture op: {capOp.status}{capOp.error ? ` (${capOp.error})` : ""}</span>}
          </p>
        )}
      </section>

      {a && (
        <Section title="Locked agreement" right={a.locked_at && <span className="text-xs text-stone-500">locked {time(a.locked_at)}</span>}>
          {a.hash && (
            <div className="mb-4 rounded-xl bg-stone-900 p-3 text-stone-100">
              <div className="text-[11px] uppercase tracking-wide text-stone-400">SHA-256 of the canonical agreement = PayPal order custom_id</div>
              <div className="break-all font-mono text-sm">{a.hash}</div>
            </div>
          )}
          <CheckList agreement={a} results={lastRun?.results} />
        </Section>
      )}

      {lastRun && (
        <Section title="Verification evidence (latest finished run)" right={<span className="mono text-stone-500">{lastRun.id}</span>}>
          <div className="space-y-3">{lastRun.results.map((r) => <EvidenceCard key={r.id} result={r} runId={lastRun.id} check={a?.body.checks.find((c) => c.id === r.checkId)} />)}</div>
        </Section>
      )}

      <Section title={`Verification runs (${d.runs.length})`}>
        <div className="-mx-5 overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
          <thead className="border-y border-stone-200 bg-stone-50/70"><tr><th className="th">Run</th><th className="th">Status</th><th className="th">Results</th><th className="th">Submitted URL</th></tr></thead>
          <tbody className="divide-y divide-stone-100">{d.runs.map((r) => (
            <tr key={r.id}>
              <td className="td whitespace-nowrap font-mono text-xs">{r.id}</td>
              <td className="td whitespace-nowrap">{r.status}</td>
              <td className="td"><div className="flex flex-wrap gap-1">{r.results.length ? r.results.map((x) => (
                <span key={x.id} className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${x.status === "passed" ? "bg-emerald-50 text-emerald-700" : x.status === "failed" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>{x.checkId} {x.status}</span>
              )) : <span className="text-xs text-stone-500">{r.error}</span>}</div></td>
              <td className="td max-w-[16rem] truncate font-mono text-xs text-stone-500" title={r.url}>{r.url.split("?")[0]}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </Section>

      <Section title="PayPal payment operations">
        <p className="-mt-2 mb-3 text-xs text-stone-500">Each call carries a PayPal-Request-Id of the form milestone:type:attempt. Timeouts are resolved by the reconciler with the same key, never a new one.</p>
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-y border-stone-200 bg-stone-50/70"><tr><th className="th">Operation</th><th className="th">Status</th><th className="th">PayPal reference</th><th className="th">Idempotency key</th><th className="th text-right">Requested</th></tr></thead>
            <tbody className="divide-y divide-stone-100">{d.operations.map((o) => (
              <tr key={o.id}>
                <td className="td whitespace-nowrap font-medium">{o.type.replace(/_/g, " ")}</td>
                <td className="td whitespace-nowrap"><span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold ${o.status === "SUCCEEDED" ? "bg-emerald-50 text-emerald-700" : o.status === "FAILED" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>{o.status}</span>{o.error && <div className="mt-1 max-w-xs text-xs text-stone-500">{o.error}</div>}</td>
                <td className="td whitespace-nowrap font-mono text-xs">{o.paypal_ref ?? "–"}</td>
                <td className="td whitespace-nowrap font-mono text-[11px] text-stone-500">{o.idempotency_key}</td>
                <td className="td tabular whitespace-nowrap text-right text-xs text-stone-500">{time(o.requested_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {d.authorizations.length > 0 && (
          <div className="mt-3 break-all text-xs text-stone-600">Authorizations: {d.authorizations.map((x) => <span key={x.id} className="mr-3 font-mono">{x.id} ({x.status}, order {x.order_id}, expires {time(x.expires_at)})</span>)}</div>
        )}
      </Section>

      <EventLog events={d.events} />
    </div>
  );
}

/** The full log is long (every agent step and model call), so show the key events first. */
function EventLog({ events }: { events: Parameters<typeof Timeline>[0]["events"] }) {
  const [all, setAll] = useState(false);
  const toggle = (
    <div className="flex rounded-lg border border-stone-200 bg-stone-100/80 p-0.5 text-xs font-medium print:hidden">
      <button className={`rounded-md px-2.5 py-1 ${!all ? "bg-white shadow-sm" : "text-stone-600"}`} onClick={() => setAll(false)}>Key events</button>
      <button className={`rounded-md px-2.5 py-1 ${all ? "bg-white shadow-sm" : "text-stone-600"}`} onClick={() => setAll(true)}>Everything ({events.length})</button>
    </div>
  );
  return <Section title="Event timeline · append-only" right={toggle}><Timeline events={events} compact={!all} /></Section>;
}
