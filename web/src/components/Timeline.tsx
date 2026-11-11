import type { Ev } from "../api.ts";
import { time } from "../api.ts";

const label = (e: Ev) => {
  const d = e.data ?? {};
  switch (e.type) {
    case "transition": return `${d.event}: ${d.from} → ${d.to}${d.captureId ? ` (capture ${d.captureId}, PayPal ${d.paypalStatus})` : ""}${d.hash ? ` · hash ${String(d.hash).slice(0, 12)}…` : ""}`;
    case "approved": return `approved agreement v${d.version}`;
    case "payment_op_started": return `PayPal ${d.type} requested (key ${d.key})`;
    case "payment_op_succeeded": return `PayPal ${d.type} confirmed ${d.paypalRef ?? ""}`;
    case "payment_op_failed": return `PayPal ${d.type} failed: ${d.error}`;
    case "payment_op_unknown": return `PayPal ${d.type} outcome unknown: ${d.error} (reconciler will check)`;
    case "model_call": return `AI ${d.task} (${d.model}, ${d.ms} ms)`;
    case "ai_fallback": return `AI ${d.task} → deterministic fallback: ${d.reason}`;
    case "tool_call": return `${d.step?.by === "agent" ? "agent" : "deterministic plan"} ${d.step?.tool} → ${String(d.step?.result ?? "").slice(0, 80)}`;
    case "form_received": return `inbox received fields: ${(d.fields ?? []).join(", ")}`;
    case "run_started": return `verification run started on ${d.url}`;
    default: return e.type.replace(/_/g, " ");
  }
};

export default function Timeline({ events, compact }: { events: Ev[]; compact?: boolean }) {
  const shown = compact ? events.filter((e) => !["model_call", "tool_call", "payment_op_started", "agent_started", "form_received"].includes(e.type)) : events;
  return (
    <ol className="relative ml-1 space-y-2.5 border-l border-stone-200 pl-5">
      {shown.map((e) => (
        <li key={e.id} className="break-words text-sm [overflow-wrap:anywhere]">
          <span className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${e.type === "transition" ? "bg-teal-600" : e.type.startsWith("payment") ? "bg-indigo-500" : "bg-stone-300"}`} />
          <span className="mono mr-2 text-stone-400">{time(e.at)}</span>
          <span className="mono mr-2 rounded bg-stone-100 px-1 text-stone-600">{e.actor}</span>
          {label(e)}
        </li>
      ))}
    </ol>
  );
}
