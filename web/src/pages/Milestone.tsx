import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, money, type Detail } from "../api.ts";
import { useSession } from "../session.tsx";
import { StateBadge, Stepper, Note, nextStep } from "../components/ui.tsx";
import Clarify from "./Clarify.tsx";
import Agreement from "./Agreement.tsx";
import Fund from "./Fund.tsx";
import Submit from "./Submit.tsx";
import Review from "./Review.tsx";
import Timeline from "../components/Timeline.tsx";

export function useMilestone(id: string) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Detail>("GET", `/api/milestones/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [load]);
  return { d, error, reload: load };
}

export default function Milestone() {
  const { id } = useParams();
  const { role } = useSession();
  const { d, error, reload } = useMilestone(id!);
  if (error) return <Note tone="error">{error}</Note>;
  if (!d) return <p className="text-sm text-stone-500">Loading…</p>;
  const s = d.milestone.state;
  const panel = (() => {
    switch (s) {
      case "DRAFT": return <Clarify d={d} reload={reload} />;
      case "PROPOSED": return <Agreement d={d} reload={reload} />;
      case "LOCKED": case "AUTH_EXPIRED": case "CAPTURE_FAILED": return <Fund d={d} reload={reload} />;
      case "FUNDED": case "FAILED": case "VERIFYING": return <Submit d={d} reload={reload} />;
      case "REVIEW": case "DISPUTE": return <Review d={d} reload={reload} />;
      default: return <Closed d={d} />;
    }
  })();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 text-sm text-stone-500"><Link to="/" className="hover:text-stone-800">Milestones</Link> <span className="text-stone-300">/</span> {d.project.title}</div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">{d.milestone.title} <span className="text-stone-300">·</span> <span className="tabular">{money(d.milestone.amount_cents, d.milestone.currency)}</span></h1>
          <blockquote className="mt-2 max-w-3xl border-l-2 border-stone-200 pl-3 text-sm italic text-stone-600">{d.project.brief}</blockquote>
        </div>
        <div className="flex items-center gap-2">
          <StateBadge state={s} />
          <Link to={`/m/${d.milestone.id}/report`} className="btn-ghost px-3 py-1.5">View report</Link>
        </div>
      </div>
      <div className="card px-5 py-4">
        <Stepper state={s} />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500">
          <span>Viewing as <b className="text-stone-700">{role}</b></span>
          {nextStep(s, role) ? <span className="inline-flex items-center gap-1.5 font-medium text-teal-800"><span className="h-1.5 w-1.5 rounded-full bg-teal-600" />Your next step: {nextStep(s, role)}</span> : <span>Nothing for you to do right now</span>}
        </div>
      </div>
      {panel}
      <details className="card">
        <summary className="cursor-pointer text-[15px] font-semibold tracking-tight">Event timeline <span className="font-normal text-stone-500">({d.events.length})</span></summary>
        <div className="mt-3"><Timeline events={d.events} compact /></div>
      </details>
    </div>
  );
}

function Closed({ d }: { d: Detail }) {
  const s = d.milestone.state;
  const cap = [...d.events].reverse().find((e) => e.type === "transition" && e.data.event === "CAPTURE_COMPLETED");
  return (
    <div className="card space-y-3">
      {s === "CAPTURED" && cap && <Note tone="ok">PayPal confirmed capture <b className="font-mono">{cap.data.captureId}</b>, status <b>{cap.data.paypalStatus}</b>. The freelancer has been paid.</Note>}
      {s === "CAPTURE_PENDING" && <Note tone="warn">The client accepted. Capture has been requested from PayPal and the outcome is not confirmed yet. Nothing is shown as paid until PayPal reports COMPLETED.</Note>}
      {s === "VOID_PENDING" && <Note tone="warn">The authorization is being voided. Waiting for PayPal to confirm.</Note>}
      {s === "VOIDED" && <Note>PayPal confirmed the authorization was voided. No money moved.</Note>}
      <Link to={`/m/${d.milestone.id}/report`} className="btn-primary">Open the report</Link>
    </div>
  );
}
