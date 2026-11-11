import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { ErrorText } from "../components/ui.tsx";

export default function NewProject() {
  const nav = useNavigate();
  const [title, setTitle] = useState("Bakery landing page");
  const [brief, setBrief] = useState("I need a fast, mobile-friendly landing page for my bakery with a working contact form so customers can send me a message.");
  const [amount, setAmount] = useState(200);
  const [deadlineDays, setDeadlineDays] = useState(14);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="card mx-auto max-w-2xl space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError(null);
      try {
        const { milestoneId } = await api("POST", "/api/projects", { title, brief, amount, deadlineDays });
        nav(`/m/${milestoneId}`);
      } catch (err) { setError((err as Error).message); setBusy(false); }
    }}>
      <div>
        <h1 className="text-xl font-bold">New project</h1>
        <p className="text-sm text-stone-600">Write the brief the way you’d tell a freelancer. Proof-Pay will ask what the vague parts mean.</p>
      </div>
      <label className="block"><span className="label">Project title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
      <label className="block"><span className="label">Brief</span><textarea className="input min-h-32" value={brief} onChange={(e) => setBrief(e.target.value)} required minLength={10} /></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block"><span className="label">Milestone amount (USD)</span><input className="input" type="number" min={1} max={10000} step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></label>
        <label className="block"><span className="label">Deadline (days, max 25)</span><input className="input" type="number" min={1} max={25} value={deadlineDays} onChange={(e) => setDeadlineDays(Number(e.target.value))} /></label>
      </div>
      <p className="text-xs text-stone-500">Milestones run at most 25 days. A PayPal authorization is valid for 29 days, which leaves room to verify and capture.</p>
      <button className="btn-primary" disabled={busy}>{busy ? "Creating…" : "Create and clarify the brief"}</button>
      <ErrorText error={error} />
    </form>
  );
}
