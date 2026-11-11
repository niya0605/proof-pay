import type { Page } from "playwright";
import { openSession, type Session } from "./browser.ts";
import { configFromEnv, isDevLocal, resolvePublic, staticCheck, requestAllowed, GuardError } from "./urlGuard.ts";

export type Check = { id: string; type: string; params: any; description: string };
export type Job = { runId: string; url: string; checks: Check[]; inboxUrl: string; callbackBase: string; jobToken: string; useAgent: boolean };
type Evidence = { kind: "trace" | "screenshot" | "inbox" | "console"; ref: string };
type CheckOut = { checkId: string; infraError?: string; measured: any; evidence: Evidence[]; submittedAt?: string; agent?: any };
type TraceStep = { id: string; at: string; tool: string; input?: any; result: string; by: "agent" | "deterministic" };

const CHECK_MS = Number(process.env.WORKER_CHECK_TIMEOUT_MS ?? 60_000);
const RUN_MS = 5 * 60_000;
const MAX_AGENT_STEPS = 25;
const TEST_VALUES: Record<string, string> = { name: "Test User", email: "test@proofpay.dev", message: "Proof-Pay test message", phone: "+1 555 0100", subject: "Proof-Pay test subject", company: "Proof-Pay Test Co" };
const testValueFor = (f: string) => TEST_VALUES[f.toLowerCase()] ?? `Proof-Pay test ${f}`;
const ORDER = ["viewport_render", "element_present", "text_present", "form_submits", "no_console_errors"];

export async function runJob(job: Job) {
  const artifacts: { ref: string; kind: string; base64: string }[] = [];
  const started = Date.now();
  let session: Session | null = null;
  try {
    const cfg = configFromEnv();
    const target = staticCheck(job.url, cfg);
    const inbox = new URL(job.inboxUrl);
    if (!isDevLocal(inbox, cfg) && inbox.protocol !== "https:") throw new GuardError("inbox must be https");
    const pins: { host: string; ip: string }[] = [];
    for (const u of [target, inbox]) if (!isDevLocal(u, cfg) && !pins.some((p) => p.host === u.hostname)) pins.push({ host: u.hostname, ip: await resolvePublic(u.hostname) });
    session = await openSession({ pins, allowedOrigins: new Set([target.origin, inbox.origin]) });
    const s = session;

    const results: CheckOut[] = [];
    const sorted = [...job.checks].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
    for (const check of sorted) {
      if (Date.now() - started > RUN_MS) {
        results.push({ checkId: check.id, infraError: "run time limit (5 min) reached", measured: {}, evidence: [] });
        continue;
      }
      results.push(await withTimeout(runCheck(job, check, s, artifacts), CHECK_MS, check.id));
      if (s.blocked.length) break;
    }
    if (s.blocked.length) {
      return { runError: `blocked request to a non-allowlisted destination: ${s.blocked[0]}`, checks: results, artifacts, consoleLog: s.console };
    }
    return { checks: results, artifacts, consoleLog: s.console };
  } catch (e) {
    return { runError: e instanceof GuardError ? `URL guard: ${e.message}` : `runner error: ${(e as Error).message}`, checks: [], artifacts, consoleLog: session?.console ?? [] };
  } finally {
    await session?.close().catch(() => {});
  }
}

async function withTimeout(p: Promise<CheckOut>, ms: number, checkId: string): Promise<CheckOut> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<CheckOut>((r) => (t = setTimeout(() => r({ checkId, infraError: `check timed out after ${ms / 1000}s`, measured: {}, evidence: [] }), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function newPage(s: Session, width: number) {
  const page = await s.context.newPage();
  await page.setViewportSize({ width, height: 800 });
  return page;
}

async function goto(page: Page, url: string) {
  try {
    const resp = await page.goto(url, { waitUntil: "load", timeout: Number(process.env.WORKER_NAV_TIMEOUT_MS ?? 30_000) });
    return { httpStatus: resp?.status() ?? 0, loaded: Boolean(resp?.ok()) };
  } catch (e) {
    const msg = (e as Error).message;
    if (/ERR_BLOCKED_BY_CLIENT/.test(msg)) return { httpStatus: 0, loaded: false, blocked: true };
    throw new Error(`navigation failed: ${msg.split("\n")[0]}`);
  }
}

async function shot(page: Page, ref: string, artifacts: { ref: string; kind: string; base64: string }[]): Promise<Evidence> {
  const buf = await page.screenshot({ fullPage: false });
  artifacts.push({ ref, kind: "screenshot", base64: buf.toString("base64") });
  return { kind: "screenshot", ref };
}

async function runCheck(job: Job, check: Check, s: Session, artifacts: any[]): Promise<CheckOut> {
  const page = await newPage(s, check.type === "viewport_render" ? check.params.width : 1280);
  try {
    switch (check.type) {
      case "viewport_render": {
        const nav = await goto(page, job.url);
        if (!nav.loaded) return { checkId: check.id, measured: nav, evidence: [await shot(page, `shot-${check.id}.png`, artifacts)], ...(nav.httpStatus ? {} : { infraError: "page did not load" }) };
        await page.waitForTimeout(300);
        const dims = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
        return { checkId: check.id, measured: { ...nav, width: check.params.width, ...dims }, evidence: [await shot(page, `shot-${check.id}.png`, artifacts)] };
      }
      case "element_present": {
        const nav = await goto(page, job.url);
        if (!nav.loaded) return loadFail(check, nav);
        const loc = page.getByRole(check.params.role, { name: check.params.name });
        const count = await loc.count();
        let visible = false;
        for (let i = 0; i < count && !visible; i++) visible = await loc.nth(i).isVisible();
        if (visible) await loc.first().scrollIntoViewIfNeeded().catch(() => {});
        return { checkId: check.id, measured: { count, visible }, evidence: [await shot(page, `shot-${check.id}.png`, artifacts)] };
      }
      case "text_present": {
        const nav = await goto(page, job.url);
        if (!nav.loaded) return loadFail(check, nav);
        const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
        return { checkId: check.id, measured: { found: text.includes(String(check.params.text).replace(/\s+/g, " ")) }, evidence: [await shot(page, `shot-${check.id}.png`, artifacts)] };
      }
      case "no_console_errors": {
        const nav = await goto(page, job.url);
        if (!nav.loaded) return loadFail(check, nav);
        await page.waitForTimeout(1500);
        return { checkId: check.id, measured: { errors: s.console.map((c) => `${c.type}: ${c.text}`) }, evidence: [{ kind: "console", ref: "console.json" }] };
      }
      case "form_submits":
        return await formSubmits(job, check, page, artifacts);
      default:
        return { checkId: check.id, infraError: `unknown check type ${check.type}`, measured: {}, evidence: [] };
    }
  } catch (e) {
    return { checkId: check.id, infraError: (e as Error).message, measured: {}, evidence: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

const loadFail = (check: Check, nav: any): CheckOut => ({ checkId: check.id, measured: nav, evidence: [], ...(nav.httpStatus ? {} : { infraError: "page did not load" }) });

// ---------------- form_submits: acceptance agent, with the deterministic plan as fallback ----------------

async function formSubmits(job: Job, check: Check, page: Page, artifacts: any[]): Promise<CheckOut> {
  const trace: TraceStep[] = [];
  const evidence: Evidence[] = [];
  const traceRef = `trace-${check.id}.json`;
  const state = { submittedAt: undefined as string | undefined, filled: 0, shots: 0, fieldsNotFound: [] as string[] };
  const step = (tool: string, input: any, result: string, by: TraceStep["by"]) => {
    const t = { id: `t${trace.length + 1}`, at: new Date().toISOString(), tool, input, result: result.slice(0, 4000), by };
    trace.push(t);
    void post(job, "/agent/trace", { checkId: check.id, step: t }).catch(() => {}); // live trace for the UI
    return t;
  };
  let agent: any = { used: false, plan: [], observations: [] };

  if (job.useAgent) {
    agent = await runAgent(job, check, page, artifacts, evidence, state, step, traceRef);
  }
  if (!agent.used) {
    if (job.useAgent) step("fallback", {}, `acceptance agent unavailable (${agent.fallbackReason}); using the deterministic plan`, "deterministic");
    await deterministicPlan(job, check, page, artifacts, evidence, state, step);
  } else if (agent.stoppedEarly && !state.submittedAt) {
    // The agent stopped (model error, timeout, step limit) before submitting anything. The verdict
    // comes from inbox evidence either way, so try the deterministic plan rather than return error.
    step("fallback", {}, "acceptance agent stopped before submitting the form; using the deterministic plan", "deterministic");
    await deterministicPlan(job, check, page, artifacts, evidence, state, step);
  }
  artifacts.push({ ref: traceRef, kind: "trace", base64: Buffer.from(JSON.stringify(trace, null, 1)).toString("base64") });
  evidence.unshift({ kind: "trace", ref: traceRef });
  return { checkId: check.id, measured: { fieldsNotFound: state.fieldsNotFound, filled: state.filled }, evidence, submittedAt: state.submittedAt, agent };
}

async function post(job: Job, path: string, body: any) {
  const res = await fetch(`${job.callbackBase}/internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: job.runId, jobToken: job.jobToken, ...body }),
    signal: AbortSignal.timeout(70_000),
  });
  if (!res.ok) throw new Error(`backend ${path} HTTP ${res.status}`);
  return res.json();
}

async function readInbox(job: Job) {
  const res = await fetch(`${job.callbackBase}/internal/inbox?runId=${encodeURIComponent(job.runId)}`, { headers: { "x-job-token": job.jobToken }, signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body)) throw new Error(`inbox read failed: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`);
  return body as { id: number; received_at: string; body: any }[];
}

async function runAgent(job: Job, check: Check, page: Page, artifacts: any[], evidence: Evidence[], state: any, step: any, traceRef: string) {
  const observations: { text: string; evidenceRef: string }[] = [];
  const deadline = Date.now() + CHECK_MS - 8_000;
  try {
    await post(job, "/agent/start", { checkId: check.id });
  } catch (e) {
    return { used: false, fallbackReason: (e as Error).message, plan: [], observations };
  }
  let toolResult: { content: string; isError?: boolean } | undefined;
  let acted = false;
  try {
    for (let i = 0; i < MAX_AGENT_STEPS && Date.now() < deadline; i++) {
      const action = await post(job, "/agent/step", { checkId: check.id, toolResult });
      if (action.kind === "abort") {
        if (!acted) return { used: false, fallbackReason: action.reason, plan: [], observations };
        step("agent_stopped", {}, action.reason, "agent");
        break;
      }
      if (action.kind === "finish") {
        step("finish", { plan: action.plan }, "agent finished", "agent");
        return { used: true, plan: action.plan, observations: [...observations, ...action.observations] };
      }
      acted = true;
      const { content, isError } = await execTool(job, action.name, action.input ?? {}, page, artifacts, evidence, state, observations);
      const t = step(action.name, action.input, content, "agent");
      toolResult = { content: `[evidence ${traceRef}#${t.id}] ${content}`, isError };
    }
    return { used: true, plan: [], observations, stoppedEarly: true };
  } catch (e) {
    if (!acted) return { used: false, fallbackReason: (e as Error).message, plan: [], observations };
    step("agent_error", {}, (e as Error).message, "agent");
    return { used: true, plan: [], observations, stoppedEarly: true };
  } finally {
    void post(job, "/agent/end", { checkId: check.id }).catch(() => {});
  }
}

const LIST_JS = () => {
  const els = Array.from(document.querySelectorAll<HTMLElement>("input, textarea, select, button, a[href], [role=button]"));
  let n = 0;
  return els
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && (el as HTMLInputElement).type !== "hidden";
    })
    .slice(0, 60)
    .map((el) => {
      const idx = String(++n);
      el.setAttribute("data-pp-idx", idx);
      const labels = (el as HTMLInputElement).labels ? Array.from((el as HTMLInputElement).labels!).map((l) => l.innerText.trim()) : [];
      const lb = el.getAttribute("aria-labelledby");
      const label = [el.getAttribute("aria-label"), ...labels, lb ? document.getElementById(lb)?.innerText : null].filter(Boolean).join(" / ");
      return {
        locator: `idx:${idx}`,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") ?? undefined,
        label: label || undefined,
        placeholder: el.getAttribute("placeholder") ?? undefined,
        text: ["BUTTON", "A"].includes(el.tagName) ? el.innerText.trim().slice(0, 60) : undefined,
      };
    });
};

const locate = (page: Page, locator: string) => {
  const m = /^idx:(\d+)$/.exec(String(locator).trim());
  if (!m) throw new Error(`unsupported locator "${locator}"; use idx:N from list_elements`);
  return page.locator(`[data-pp-idx="${m[1]}"]`);
};

async function execTool(job: Job, name: string, input: any, page: Page, artifacts: any[], evidence: Evidence[], state: any, observations: any[]): Promise<{ content: string; isError?: boolean }> {
  try {
    switch (name) {
      case "open_page": {
        const url = new URL(String(input.url ?? job.url), job.url);
        if (url.origin !== new URL(job.url).origin) return { content: "refused: only the submitted site may be opened", isError: true };
        await page.setViewportSize({ width: Number(input.width) || 1280, height: 800 });
        const nav = await goto(page, url.href);
        return { content: JSON.stringify({ ...nav, title: await page.title() }) };
      }
      case "list_elements":
        return { content: JSON.stringify(await page.evaluate(LIST_JS)) };
      case "screenshot": {
        const ref = `shot-${job.runId.slice(-4)}-${++state.shots}.png`;
        evidence.push(await shot(page, ref, artifacts));
        return { content: `screenshot saved as evidence ref ${ref}` };
      }
      case "fill":
        await locate(page, input.locator).fill(String(input.value ?? ""), { timeout: 5000 });
        state.filled++;
        return { content: `filled ${input.locator}` };
      case "click": {
        const before = state.filled;
        await locate(page, input.locator).click({ timeout: 5000 });
        if (before > 0 && !state.submittedAt) state.submittedAt = new Date().toISOString();
        await page.waitForTimeout(1200);
        return { content: `clicked ${input.locator}; page now: ${page.url()}` };
      }
      case "read_inbox": {
        const rows = await readInbox(job);
        return { content: JSON.stringify(rows.map((r) => ({ evidenceRef: `inbox:${r.id}`, received_at: r.received_at, body: r.body }))) };
      }
      case "record_observation":
        observations.push({ text: String(input.text ?? "").slice(0, 500), evidenceRef: String(input.evidenceRef ?? "") });
        return { content: "recorded" };
      default:
        return { content: `unknown tool ${name}`, isError: true };
    }
  } catch (e) {
    return { content: `error: ${(e as Error).message.split("\n")[0]}`, isError: true };
  }
}

/** Deterministic plan: getByLabel / getByPlaceholder / name lookups, then the Send/Submit button. */
async function deterministicPlan(job: Job, check: Check, page: Page, artifacts: any[], evidence: Evidence[], state: any, step: any) {
  const nav = await goto(page, job.url);
  step("open_page", { url: job.url }, JSON.stringify(nav), "deterministic");
  if (!nav.loaded) return;
  const banner = page.getByRole("button", { name: /accept|got it|agree|dismiss|ok$/i }).first();
  if (await banner.isVisible().catch(() => false)) {
    await banner.click().catch(() => {});
    step("click", { locator: "cookie banner" }, "dismissed a blocking banner", "deterministic");
  }
  for (const field of check.params.fields as string[]) {
    const re = new RegExp(field.replace(/[^a-z0-9]/gi, "."), "i");
    const candidates = [page.getByLabel(re), page.getByPlaceholder(re), page.locator(`[name="${field}" i]`), page.locator(`#${CSS.escape(field)}`)];
    let done = false;
    for (const c of candidates) {
      const el = c.first();
      if (await el.isVisible().catch(() => false)) {
        await el.fill(testValueFor(field));
        state.filled++;
        step("fill", { field, value: testValueFor(field) }, "filled", "deterministic");
        done = true;
        break;
      }
    }
    if (!done) {
      state.fieldsNotFound.push(field);
      step("fill", { field }, "no matching field found on the page", "deterministic");
    }
  }
  const btn = page.getByRole("button", { name: /send|submit/i }).first();
  const target = (await btn.isVisible().catch(() => false)) ? btn : page.locator("[type=submit]").first();
  try {
    await target.click({ timeout: 5000 });
    state.submittedAt = new Date().toISOString();
    step("click", { locator: "submit button" }, "submitted the form", "deterministic");
  } catch (e) {
    step("click", { locator: "submit button" }, `could not submit: ${(e as Error).message.split("\n")[0]}`, "deterministic");
  }
  await page.waitForTimeout(1500);
  evidence.push(await shot(page, `shot-${check.id}.png`, artifacts));
  try {
    const rows = await readInbox(job);
    step("read_inbox", {}, JSON.stringify(rows.map((r) => ({ evidenceRef: `inbox:${r.id}`, body: r.body }))), "deterministic");
  } catch (e) {
    step("read_inbox", {}, (e as Error).message, "deterministic"); // the evaluator reads the inbox itself
  }
}

const CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
export { requestAllowed };
