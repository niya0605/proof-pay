// End-to-end through the HTTP API (needs `npm run dev` running).
// FAKE_PAYPAL=1: approval via the stand-in. Real sandbox: set SANDBOX_BUYER_EMAIL/PASSWORD and the
// script approves the order as the sandbox buyer in a headless browser.
// Usage: node --env-file=.env scripts/e2e-api.mjs [fixedRuns=1]
const API = process.env.API ?? "http://localhost:3001";
const SITES = process.env.SITES ?? "http://localhost:5174";
const fixedRuns = Number(process.argv[2] ?? 1);

async function as(role) {
  const r = await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(API + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
}
/** Approve a real sandbox order as the buyer (the step a client does in the PayPal popup). */
async function sandboxApprove(orderId) {
  const { chromium } = await import("playwright");
  const b = await chromium.launch();
  const p = await b.newPage();
  try {
    await p.goto(`https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForSelector("#email", { timeout: 45000 });
    await p.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
    if (await p.locator("#btnNext").isVisible().catch(() => false)) await p.click("#btnNext");
    await p.waitForSelector("#password", { state: "visible", timeout: 30000 });
    await p.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
    await p.click("#btnLogin");
    const btn = p.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Continue"), button:has-text("Agree"), button:has-text("Pay")').first();
    await btn.waitFor({ state: "visible", timeout: 60000 });
    await btn.click();
    await p.waitForURL((u) => !u.pathname.startsWith("/checkoutnow"), { timeout: 30000 }).catch(() => {});
    await sleep(2000);
    console.log("sandbox buyer approved", orderId);
  } catch (e) {
    await p.screenshot({ path: "sandbox-approve-error.png" }).catch(() => {});
    throw new Error(`sandbox approval failed at ${p.url()}: ${e.message.split("\n")[0]}`);
  } finally {
    await b.close();
  }
}

const client = await as("client"), freelancer = await as("freelancer");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitState(id, states, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = await client("GET", `/api/milestones/${id}`);
    if (states.includes(d.milestone.state)) return d;
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${states}`);
}

const { milestoneId: id } = await client("POST", "/api/projects", { title: "Bakery", brief: "A fast, mobile-friendly landing page with a working contact form.", amount: 200, deadlineDays: 14 });
const q = await client("POST", `/api/milestones/${id}/clarify`);
console.log("questions:", q.questions.map((x) => x.term), `(${q.source})`);
const p = await client("POST", `/api/milestones/${id}/propose`, { answers: { "mobile-friendly": "375px", "contact form": "name, email, message / Send" } });
console.log("checks:", p.agreement.body.checks.map((c) => `${c.id}:${c.type}`).join(" "), `(${p.source})`);
const v = p.agreement.version;
await client("POST", `/api/milestones/${id}/approve`, { version: v });
const lock = await freelancer("POST", `/api/milestones/${id}/approve`, { version: v });
console.log("locked:", lock.locked, "hash:", lock.agreement.hash.slice(0, 16) + "…");
const { orderId } = await client("POST", `/api/milestones/${id}/paypal-order`);
if (process.env.FAKE_PAYPAL === "1") await client("POST", `/api/dev/fake-approve/${orderId}`);
else await sandboxApprove(orderId);
console.log("authorize →", (await client("POST", `/api/milestones/${id}/authorize`, { orderId })).state);

const inbox = (await client("GET", `/api/milestones/${id}`)).inboxUrl;
const site = (kind) => `${SITES}/${kind}/?inbox=${encodeURIComponent(inbox)}`;

await freelancer("POST", `/api/milestones/${id}/submit`, { url: site("broken") });
let d = await waitState(id, ["FAILED", "REVIEW", "FUNDED"]);
let run = d.runs.at(-1);
console.log("broken →", d.milestone.state, run.results.map((r) => `${r.checkId}:${r.status}`).join(" "));
const f = run.results.find((r) => r.status === "failed");
if (f) console.log("  measured:", JSON.stringify(f.measured), "\n  coach:", f.explanation?.explanation);

let passes = 0;
for (let i = 0; i < fixedRuns; i++) {
  await freelancer("POST", `/api/milestones/${id}/submit`, { url: site("fixed") });
  d = await waitState(id, ["FAILED", "REVIEW", "FUNDED"]);
  run = d.runs.at(-1);
  console.log(`fixed #${i + 1} →`, d.milestone.state, run.results.map((r) => `${r.checkId}:${r.status}`).join(" "));
  if (d.milestone.state === "REVIEW") passes++;
  if (i < fixedRuns - 1 && d.milestone.state === "REVIEW") {
    // stay in the loop: REVIEW can't be resubmitted, so stop repeating here
    break;
  }
}
const acc = await client("POST", `/api/milestones/${id}/accept`);
d = await client("GET", `/api/milestones/${id}`);
const cap = d.operations.find((o) => o.type === "capture");
console.log("accept →", acc.state, "capture op:", cap?.status, cap?.paypal_ref);
console.log(`milestone ${id}`);
process.exit(acc.state === "CAPTURED" && passes > 0 ? 0 : 1);
