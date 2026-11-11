import { useState } from "react";
import { api, type Detail } from "../api.ts";
import { useSession } from "../session.tsx";
import { ErrorText, Note, Section } from "../components/ui.tsx";

type Q = { term: string; question: string; options?: string[] };

/** Brief step 1: the AI flags vague words and asks for measurable values. */
export default function Clarify({ d, reload }: { d: Detail; reload: () => void }) {
  const { role } = useSession();
  const [qs, setQs] = useState<Q[] | null>(null);
  const [source, setSource] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (role !== "client") return <Note>Waiting for the client to clarify the brief.</Note>;
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return (
    <Section title="1 · Make the brief measurable">
      {!qs ? (
        <div className="space-y-3">
          <p className="text-sm text-stone-600">Proof-Pay doesn’t accept vague words. It asks what each one means before it proposes any checks.</p>
          <button className="btn-primary" disabled={busy} onClick={() => run(async () => {
            const r = await api("POST", `/api/milestones/${d.milestone.id}/clarify`);
            setQs(r.questions); setSource(r.source);
            setAnswers(Object.fromEntries(r.questions.map((q: Q) => [q.term, q.options?.[0] ?? ""])));
          })}>{busy ? "Reading the brief…" : "Find the vague parts"}</button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("POST", `/api/milestones/${d.milestone.id}/propose`, { answers }); reload(); }); }}>
          {source === "fallback" && <p className="text-xs text-amber-800">Questions from the deterministic template (AI unavailable).</p>}
          {qs.length === 0 && <p className="text-sm">Nothing vague found. Proceed to the proposal.</p>}
          {qs.map((q) => (
            <fieldset key={q.term} className="rounded-xl border border-stone-200 p-3">
              <legend className="px-1 text-sm"><span className="rounded bg-amber-100 px-1.5 font-semibold text-amber-900">“{q.term}”</span></legend>
              <p className="mb-2 text-sm font-medium">{q.question}</p>
              <div className="flex flex-wrap gap-2">
                {q.options?.map((o) => (
                  <button type="button" key={o} onClick={() => setAnswers({ ...answers, [q.term]: o })}
                    className={`rounded-full border px-3 py-1 text-sm ${answers[q.term] === o ? "border-teal-600 bg-teal-50 text-teal-900" : "border-stone-300 hover:bg-stone-50"}`}>{o}</button>
                ))}
              </div>
              <input className="input mt-2" placeholder="…or type your own measurable answer" value={answers[q.term] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.term]: e.target.value })} />
            </fieldset>
          ))}
          <button className="btn-primary" disabled={busy}>{busy ? "Proposing checks…" : "Propose the checklist"}</button>
        </form>
      )}
      <ErrorText error={error} />
    </Section>
  );
}
