/** HTTP-level security checks: headers, session cookie, rate limits, artifacts auth, inbox and reject validation. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, createMilestone, lockAndFund, passRun } from "./helpers.ts";
import { createApp } from "../src/app.ts";
import { getDb } from "../src/db/migrate.ts";
import { checkJobToken } from "../src/services/verificationService.ts";

let env: Awaited<ReturnType<typeof setup>>;
let server: http.Server;
let base = "";

beforeAll(async () => {
  env = await setup();
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await env.close();
});

async function login(role: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) });
  return { res: r, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
}

describe("security", () => {
  it("sends security headers including a CSP that allows PayPal", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}' https:\/\/\*\.paypal\.com/);
    expect(csp).not.toContain("'unsafe-inline' https://*.paypal.com"); // no unsafe-inline for scripts
    const second = (await fetch(`${base}/healthz`)).headers.get("content-security-policy");
    expect(second).not.toBe(csp); // a fresh nonce per response
    expect(r.headers.get("x-powered-by")).toBeNull();
  });

  it("session cookie is HttpOnly, SameSite and expires; forged session ids are ignored", async () => {
    const { res } = await login("client");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Max-Age=\d+/);
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: "pp_sid=admin" } })).json();
    expect(me.role).toBeNull();
  });

  it("role comes only from the session, not from request fields", async () => {
    const { cookie } = await login("freelancer");
    const r = await fetch(`${base}/api/admin/reconcile`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-role": "admin" }, body: JSON.stringify({ role: "admin" }) });
    expect(r.status).toBe(403);
  });

  it("artifacts need a login", async () => {
    expect((await fetch(`${base}/artifacts/run_x/shot.png`)).status).toBe(401);
  });

  it("job tokens are checked per run", () => {
    expect(checkJobToken("run_missing", "anything")).toBe(false);
    expect(checkJobToken(undefined, undefined)).toBe(false);
  });

  it("the public inbox refuses posts when no verification is running", async () => {
    const id = createMilestone();
    const { inbox_token } = getDb().prepare("SELECT inbox_token FROM milestones WHERE id = ?").get(id) as any;
    const r = await fetch(`${base}/inbox/${inbox_token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(r.status).toBe(409);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM form_inbox").get() as any).n).toBe(0);
  });

  it("a reject screenshot must be an inline raster image", async () => {
    const { id } = await lockAndFund(env.fake);
    passRun(id);
    const { cookie } = await login("client");
    const manual = (getDb().prepare("SELECT body_json FROM agreements WHERE milestone_id = ? ORDER BY version DESC").get(id) as any).body_json;
    const criterionId = JSON.parse(manual).manual[0].id;
    for (const content of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "https://evil.example/x.png"]) {
      const r = await fetch(`${base}/api/milestones/${id}/reject`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ criterionId, reason: "does not match the brand", attachment: { kind: "screenshot", content } }) });
      expect(r.status).toBe(400);
    }
    const ok = await fetch(`${base}/api/milestones/${id}/reject`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ criterionId, reason: "does not match the brand", attachment: { kind: "screenshot", content: "data:image/png;base64,iVBORw0KGgo=" } }) });
    expect(ok.status).toBe(200);
  });

  it("login is rate limited", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await login("client")).res.status;
    expect(last).toBe(429);
  });
});
