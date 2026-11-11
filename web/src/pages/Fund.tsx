import { money, type Detail } from "../api.ts";
import { useSession } from "../session.tsx";
import PayPalAuthorize from "../components/PayPalAuthorize.tsx";
import CheckList from "../components/CheckList.tsx";
import { Note, Section } from "../components/ui.tsx";

export default function Fund({ d, reload }: { d: Detail; reload: () => void }) {
  const { role } = useSession();
  const a = d.agreement!;
  const s = d.milestone.state;
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <Section title="Locked agreement">
        <div className="mb-4 rounded-xl bg-stone-900 p-3 text-stone-100">
          <div className="text-[11px] uppercase tracking-wide text-stone-400">Agreement SHA-256 (sent to PayPal as custom_id)</div>
          <div className="break-all font-mono text-sm">{a.hash}</div>
        </div>
        <CheckList agreement={a} />
      </Section>
      <Section title={s === "LOCKED" ? "3 · Authorize the milestone" : "Authorize again"}>
        {s === "AUTH_EXPIRED" && <Note tone="warn">The previous PayPal authorization expired. Authorize a new order for the same agreement hash to continue.</Note>}
        {s === "CAPTURE_FAILED" && <Note tone="error">PayPal didn’t complete the capture. Authorize a new order and capture is retried on it straight away.</Note>}
        <p className="my-3 text-sm text-stone-700">
          You authorize <b>{money(d.milestone.amount_cents)}</b> to <span className="font-mono">{a.body.payee.email}</span> through PayPal. An authorization reserves the funds for a limited time. It is not escrow.
          Proof-Pay verifies the deliverable, and capture is attempted only after you explicitly accept.
        </p>
        {a.body.manual.length === 0 && <Note tone="warn">This agreement has no manual criteria. If every automated check passes, your only option in review is Accept.</Note>}
        <div className="mt-4">{role === "client" ? <PayPalAuthorize milestoneId={d.milestone.id} onDone={reload} /> : <Note>Waiting for the client to authorize the payment.</Note>}</div>
      </Section>
    </div>
  );
}
