# Proof-Pay

**The contract becomes tests. Passing work gets paid.**

Freelance projects fail at the handover. The client wrote "fast and mobile-friendly", the freelancer built what they understood, payment stalls, and nobody can point to what was agreed.

Proof-Pay turns a client's brief into automated acceptance checks that both sides approve. The client authorizes the milestone payment through PayPal. An AI acceptance agent tests the live deliverable. If every check passes and the client clicks **Accept**, the backend attempts capture and shows the status PayPal confirms.

> AI writes, explores and explains. Deterministic code decides what passed and what gets paid.

Hackathon scope: website deliverables only. This is sandbox only: no real accounts and no production payments.

## How it works

1. **Brief → questions.** The AI flags vague words ("fast", "mobile-friendly", "working form") and asks the client for a measurable value.
2. **Questions → proposal.** The AI proposes automated checks drawn **only** from a five-type catalog (validated with Zod), plus manual criteria and advisory notes.
3. **Approve → lock → hash.** Each party approves a specific version. Editing anything clears both approvals. The second approval locks the agreement and computes a SHA-256 of its canonical JSON (checks, amount, payee, deadline, review rule). The PayPal order is created with that hash as `custom_id`.
4. **Authorize.** The client approves the order in the PayPal popup (`intent=AUTHORIZE`). This is an authorization, not escrow.
5. **Submit → verify.** The freelancer submits a URL. A sandboxed Chromium worker runs every check. For `form_submits`, the acceptance agent explores the page (dismisses the cookie banner, maps "How can we help?" to *message*, fills the fixed test data, submits, reads the inbox). The **evaluator** then decides pass or fail from evidence only.
6. **Fail → fix coach.** Each failure comes with reproduction steps and a likely fix.
7. **Pass → Accept → capture.** Capture is attempted only after an explicit Accept. The report shows PayPal's capture id and status.

## Architecture

```
 React (Vite)  ──►  Express API ──► milestoneService.transition()   (one enum, CAS in one SQLite tx)
                       │   ├──────► agreementService   (canonical JSON, SHA-256, version-checked approvals)
                       │   ├──────► paymentService ──► PayPal REST (only module with PayPal creds)
                       │   │          payment_operations + idempotency keys, reconciler
                       │   ├──────► AI engine runAI() ─► brief (clarify, propose) · fix coach · agent steps
                       │   └──────► verificationService ──► evaluator (deterministic verdicts)
                       │                   │ job + per-run token
                       ▼                   ▼
                 SQLite + artifacts/   Worker (Playwright, no PayPal/LLM keys)
                                         URL guard · DNS checks · pinned resolver · route checks
                                         asks the API for each agent step; form posts → /inbox/:token
```

| Path | What |
|---|---|
| `api/src/domain/milestoneState.ts` | `MilestoneState` enum + transition rules (event, from, to, actor) |
| `api/src/services/milestoneService.ts` | `transition(id, event, actor)`: compare-and-set in one transaction |
| `api/src/services/paymentService.ts` | create/authorize/capture/void/reauthorize, pre-capture check, reconciler |
| `api/src/ai/` | `engine.ts` (runAI, Zod, retry once, logs every call), `brief.ts`, `fixCoach.ts`, `acceptanceTools.ts` |
| `api/src/checks/` | `catalog.ts` (5 check types), `evaluator.ts`, `urlPolicy.ts` |
| `worker/src/` | `urlGuard.ts`, `browser.ts`, `runChecks.ts` (agent loop + deterministic plan) |
| `demo-sites/broken`, `demo-sites/fixed` | The demo deliverables. The broken one's message textarea has no `name`, so it is never sent. |

## Milestone state machine

| From | Event | To | Actor |
|---|---|---|---|
| DRAFT | brief workflow returns a checklist | PROPOSED | system |
| PROPOSED | criterion edited | PROPOSED (approvals cleared) | client / freelancer |
| PROPOSED | second approval | LOCKED (hash + order op in the same tx) | client / freelancer |
| LOCKED | PayPal authorization confirmed | FUNDED | payment |
| FUNDED, FAILED | URL submitted | VERIFYING | freelancer |
| VERIFYING | any automated check failed | FAILED | verification |
| VERIFYING | all automated checks passed | REVIEW | verification |
| VERIFYING | run error | FUNDED or FAILED | verification |
| REVIEW | Accept | CAPTURE_PENDING | client |
| REVIEW | reject citing a manual criterion | DISPUTE | client |
| DISPUTE | resolved for freelancer / client | CAPTURE_PENDING / VOID_PENDING | admin |
| FUNDED, FAILED | cancel / deadline passed | VOID_PENDING | client / job |
| FUNDED, FAILED, REVIEW, DISPUTE | authorization expired / reauth failed | AUTH_EXPIRED | payment |
| AUTH_EXPIRED | new authorization (same hash) | REVIEW if a passing run exists, else FUNDED | payment (after client approval) |
| CAPTURE_PENDING | capture COMPLETED | CAPTURED | payment |
| CAPTURE_PENDING | PayPal decline / pre-capture mismatch | CAPTURE_FAILED | payment |
| CAPTURE_FAILED | new authorization | CAPTURE_PENDING → capture retried | payment |
| CAPTURE_FAILED, AUTH_EXPIRED | admin closes | VOID_PENDING or VOIDED | admin |
| VOID_PENDING | PayPal void confirmed | VOIDED | payment |

**Unknown outcomes.** A timeout leaves the operation `UNKNOWN`. The reconciler runs on startup and every minute. It calls `GET /v2/checkout/orders/{id}` and records an existing capture or void. If PayPal shows none, it retries with the **same** idempotency key. Nothing is ever retried with a new key.

## Setup (local, under 10 commands)

Requires Node 22.

```bash
git clone <this repo> proof-pay && cd proof-pay
npm install
npx -w worker playwright install chromium
cp .env.example .env          # then fill in PayPal + Gemini keys (see below)
npm run demo                  # seeds a project, starts API :3001, worker :3002, web :5173, demo sites :5174
open http://localhost:5173
```

**No credentials yet?** Set `FAKE_PAYPAL=1` in `.env`. A built-in PayPal stand-in (the same one the tests use) replaces the sandbox, and the UI says so in a banner. With `LLM_API_KEY` empty, all three AI workflows use their deterministic fallbacks: template questions, template checklist, and the deterministic form plan plus the raw check result.

### AI model (Gemini)

The three AI workflows use Google Gemini by default. Get a free key at [aistudio.google.com](https://aistudio.google.com) → *Get API key* and put it in `LLM_API_KEY`. Calls go through Gemini's Interactions API (newer `AQ.` keys require it). `LLM_MODEL` is a comma-separated list, `gemini-3.5-flash-lite,gemma-4-26b-a4b-it,gemini-3.5-flash` by default: when a model is overloaded, out of quota or times out (30 s), the next one is tried. Free-tier quotas are per model and per day (`gemini-3.5-flash` allows only 20 requests a day), so the fast Lite model goes first. The free tier has per-minute request limits: rate-limit responses are retried using Google's suggested delay, and `LLM_MIN_INTERVAL_MS` can space calls out. If the model still fails, the workflow falls back to its deterministic path, so a demo never breaks. `LLM_PROVIDER=anthropic` switches to Claude.

### PayPal sandbox

1. In developer.paypal.com → Sandbox accounts, create a **business** account (freelancer, the payee) and a **personal** account (client, the buyer).
2. Create a REST app. Put its client id and secret in `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`, and the business account's email in `PAYPAL_PAYEE_EMAIL`.
3. **Sandbox buyer login:** in the PayPal popup on the Fund step, log in with the personal sandbox account's email and password (Sandbox accounts → ⋯ → View/edit account).
4. If the payee override doesn't work for your app, use the freelancer's own REST credentials and set `PAYPAL_PAYEE_MODE=self`.

PayPal APIs used: Orders v2 create, authorize, get · Payments v2 capture, void, reauthorize · JS SDK (`@paypal/react-paypal-js`, `intent: "authorize"`).

### Demo flow

The header has three demo logins (client, freelancer, admin), held in a server-side session.

1. **Client:** open the seeded milestone → *Find the vague parts* → pick answers → *Propose the checklist* → approve.
2. **Freelancer:** approve the same version. The agreement locks and the hash is shown.
3. **Client:** authorize in PayPal.
4. **Freelancer:** click the `localhost:5174/broken/` chip, which adds the milestone's `?inbox=` URL, then submit. The trace runs live. `form_submits` fails because *message* never reaches the inbox, and the fix coach explains why.
5. **Freelancer:** submit `localhost:5174/fixed/`. All checks pass.
6. **Client:** *Accept and capture* → Report shows the PayPal capture id, status `COMPLETED`, the operations and the timeline.

## Tests

```bash
npm test                         # vitest: payment/state, verifier + AI (real Chromium vs demo sites), evaluator, URL guard
node scripts/e2e-api.mjs         # full loop over HTTP against a running `npm run dev` (FAKE_PAYPAL=1)
```

Covered: duplicate and concurrent Accept capture once · capture timeout → reconciler records the existing capture · crash after capture → startup recovery · void timeout, no duplicate void · no capture before Accept · capture blocked on hash/amount/payee mismatch · expired auth → AUTH_EXPIRED → new auth → REVIEW · concurrent approve/edit · browser timeout = error · invalid model JSON → one retry → fallback · out-of-catalog check rejected · prompt-injection page has no effect · redirect to private IP / non-allowlisted host blocked · inbox field matching · AI narration cannot override a failure · fixed demo site passes 10/10 · append-only events.

Payment tests run against the in-process PayPal stand-in. The agent tests use a scripted model in place of the LLM. Neither replaces the Day-1 sandbox smoke test with real credentials.

## Verifier safety

* **Submit:** https only, no credentials, port 443, punycode hostname matched **exactly** against `ALLOWED_HOSTS`.
* **DNS:** the worker resolves the host itself and rejects anything that isn't global unicast. That covers loopback, RFC1918, link-local and `169.254.169.254`, CGNAT, multicast, `fc00::/7`, `fe80::/10`, and v4-mapped forms. The address is pinned with `--host-resolver-rules` (`MAP host ip, MAP * ~NOTFOUND`), which defeats rebinding.
* **Every request and redirect** is re-checked against the target and inbox origins. Anything else is aborted, and the run ends as `error`.
* **No secrets in the worker:** it gets a job and a per-run token. The agent's model calls go through the backend.
* **Limits:** 60 s and 25 agent steps per check, 5 min per run, one run at a time.
* Page text reaches the model only inside `<untrusted_page_data>` wrappers, and the verdict never depends on model text.
* **App hardening:** CSP with a per-request nonce (PayPal's SDK uses it), `frame-ancestors 'none'`, nosniff, and HSTS on https. HttpOnly, SameSite=Lax session cookies that expire, plus `Secure` on https. Roles come only from the server-side session. Login and the AI/verification routes are rate limited. `/artifacts` requires a login. The public inbox accepts posts only during a verification run, capped per run. Reject screenshots must be inline PNG, JPEG, WebP or GIF data. Job tokens are compared in constant time. Both containers run as non-root users. `npm audit`: 0 vulnerabilities. Covered by `api/test/security.test.ts`.
* **Limitation:** network-level egress restriction (worker can reach only allowlisted hosts and the inbox) must be enforced by the host (firewall / egress proxy). `docker-compose.yml` isolates the worker (no DB volume, no secrets, not published) but cannot restrict egress on its own.
* **Dev only:** `DEV_LOCAL_ORIGINS` lets exact local origins (`http://localhost:5174`, `http://localhost:3001`) bypass https and private-IP rules so the demo runs locally. Leave it empty when deployed.

## Deploy

`docker compose up --build` builds the API (which serves the built web app) and the worker from the official Playwright image. For a public deploy, host `demo-sites/broken` and `demo-sites/fixed` on https, then set `ALLOWED_HOSTS`, `DEMO_SITE_URLS`, `PUBLIC_BASE_URL` (https enables Secure cookies and HSTS), `DEMO_LOGIN_CODE`, `TRUST_PROXY=1` behind a proxy, and clear `DEV_LOCAL_ORIGINS` and `PAYPAL_PREFILL_BUYER_EMAIL`.

## Known gaps

* Reauthorization (`jobs/reauthorize.ts`) needs an authorization more than 3 days old, so it can't be tested against the sandbox before the deadline. It is exercised only against the stand-in.
* No auto-capture, Payouts, disputes API, API deliverables, Lighthouse/axe, or design-quality judging.

## License

MIT
