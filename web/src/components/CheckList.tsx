import type { Agreement, Result } from "../api.ts";
import { StatusPill } from "./ui.tsx";

const TYPE_LABEL: Record<string, string> = {
  viewport_render: "Viewport", element_present: "Element", text_present: "Text", form_submits: "Form", no_console_errors: "Console",
};
export const paramsText = (type: string, p: any) =>
  type === "viewport_render" ? `width ${p.width}px`
  : type === "element_present" ? `${p.role} “${p.name}”`
  : type === "text_present" ? `“${p.text}”`
  : type === "form_submits" ? p.fields.join(", ")
  : p.allowList?.length ? `allow: ${p.allowList.join(", ")}` : "none allowed";

export default function CheckList({ agreement, results }: { agreement: Agreement; results?: Result[] }) {
  const b = agreement.body;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="label">Automated checks · failures go to the fix loop</h3>
        <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200">
          {b.checks.map((c) => {
            const r = results?.find((x) => x.checkId === c.id);
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="mono w-7 text-stone-400">{c.id}</span>
                <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-600">{TYPE_LABEL[c.type] ?? c.type}</span>
                <span className="flex-1 text-sm">{c.description}</span>
                <span className="mono text-stone-500">{paramsText(c.type, c.params)}</span>
                {r && <StatusPill status={r.status} />}
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <h3 className="label">Manual criteria · the only grounds for rejection</h3>
        {b.manual.length ? (
          <ul className="space-y-1">
            {b.manual.map((m) => (
              <li key={m.id} className="flex gap-3 rounded-lg bg-orange-50 px-3 py-2 text-sm"><span className="mono text-orange-700">{m.id}</span>{m.description}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-600">None. When every automated check passes, the client’s only option in review is <b>Accept</b>.</p>
        )}
      </div>
      {b.advisory.length > 0 && (
        <div>
          <h3 className="label">Advisory · informational, never blocks or justifies rejection</h3>
          <ul className="flex flex-wrap gap-2">{b.advisory.map((a) => <li key={a} className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-700">{a}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
