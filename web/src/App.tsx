import { Link, NavLink, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "./session.tsx";
import type { Role } from "./api.ts";
import Home from "./pages/Home.tsx";
import NewProject from "./pages/NewProject.tsx";
import Milestone from "./pages/Milestone.tsx";
import Report from "./pages/Report.tsx";
import Admin from "./pages/Admin.tsx";

const ROLES: { role: Role; label: string; person: string; initials: string; blurb: string }[] = [
  { role: "client", label: "Client", person: "Dana", initials: "DA", blurb: "Writes the brief, pays" },
  { role: "freelancer", label: "Freelancer", person: "Ravi", initials: "RA", blurb: "Builds and submits" },
  { role: "admin", label: "Admin", person: "Ops", initials: "OP", blurb: "Resolves disputes" },
];

function useSwitchRole() {
  const { login } = useSession();
  return (r: Role) =>
    login(r, localStorage.getItem("pp_code") ?? undefined).catch((e) => {
      const code = prompt(`${e.message}. Demo access code:`);
      if (code) { localStorage.setItem("pp_code", code); login(r, code); }
    });
}

const Logo = ({ dark }: { dark?: boolean }) => (
  <span className="flex items-center gap-2.5">
    <span className={`grid h-8 w-8 place-items-center rounded-lg ${dark ? "bg-white/10 ring-1 ring-white/15" : "bg-ink"}`}>
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] text-teal-400" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
    </span>
    <span className={`text-[17px] font-semibold tracking-tight ${dark ? "text-white" : "text-ink"}`}>Proof-Pay</span>
  </span>
);

const navCls = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition ${isActive ? "bg-stone-100 text-ink" : "text-stone-600 hover:bg-stone-50 hover:text-ink"}`;

function RoleSwitcher() {
  const { role } = useSession();
  const switchRole = useSwitchRole();
  return (
    <div className="flex items-center gap-1 rounded-xl border border-stone-200 bg-stone-100 p-1" role="group" aria-label="Demo role">
      {ROLES.map((r) => (
        <button
          key={r.role}
          aria-pressed={role === r.role}
          onClick={() => switchRole(r.role)}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${role === r.role ? "bg-ink text-white shadow-sm" : "text-stone-600 hover:text-ink"}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function Shell() {
  const { role, config } = useSession();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-6">
            <Link to="/" aria-label="Proof-Pay home"><Logo /></Link>
            {role && (
              <nav className="hidden items-center gap-1 sm:flex" aria-label="Main">
                <NavLink to="/" end className={navCls}>Milestones</NavLink>
                {role === "client" && <NavLink to="/new" className={navCls}>New project</NavLink>}
                {role === "admin" && <NavLink to="/admin" className={navCls}>Admin console</NavLink>}
              </nav>
            )}
          </div>
          <RoleSwitcher />
        </div>
        {config && (config.fakePaypal || !config.llm) && (
          <div className="border-t border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">
            {config.fakePaypal && "PayPal: local stand-in (FAKE_PAYPAL=1), not the sandbox. "}
            {!config.llm && "LLM not configured: AI workflows use their deterministic fallbacks."}
          </div>
        )}
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {!role ? <Welcome /> : (
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/new" element={<NewProject />} />
            <Route path="/m/:id" element={<Milestone />} />
            <Route path="/m/:id/report" element={<Report />} />
            <Route path="/admin" element={<Admin />} />
          </Routes>
        )}
      </main>
      <footer className="border-t border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-stone-500">
          <span>Proof-Pay · PayPal sandbox only. Authorizations, not escrow. AI explores and explains; deterministic code decides.</span>
          <span>PayPal Orders v2 · Payments v2 · JS SDK · Gemini · Playwright</span>
        </div>
      </footer>
    </div>
  );
}

function Welcome() {
  const switchRole = useSwitchRole();
  return (
    <div className="mx-auto max-w-3xl py-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-medium text-teal-800">
        <span className="h-1.5 w-1.5 rounded-full bg-teal-500" /> Verified milestone payments
      </div>
      <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight text-ink sm:text-5xl">The contract becomes tests.<br /><span className="text-teal-600">Passing work gets paid.</span></h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-stone-600">
        Proof-Pay turns a freelance brief into acceptance checks both sides sign. An AI agent tests the delivered site, and PayPal captures the payment only after the client accepts.
      </p>
      <div className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-stone-500">Continue as</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {ROLES.map((r) => (
          <button key={r.role} onClick={() => switchRole(r.role)} className="card group p-4 text-left transition hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-md">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-ink text-xs font-bold text-teal-400">{r.initials}</span>
            <span className="mt-3 block font-semibold text-ink">{r.label} <span className="font-normal text-stone-500">· {r.person}</span></span>
            <span className="mt-0.5 block text-sm text-stone-500">{r.blurb}</span>
            <span className="mt-3 block text-sm font-medium text-teal-700 group-hover:text-teal-800">Sign in →</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
