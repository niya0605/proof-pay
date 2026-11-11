import { describe, expect, it } from "vitest";
import { evaluate, fieldsInRow } from "../src/checks/evaluator.ts";
import type { Check } from "../src/checks/catalog.ts";
import { isForbiddenIp, staticCheck, resolvePublic, requestAllowed } from "../../worker/src/urlGuard.ts";

const form: Check = { id: "c3", type: "form_submits", params: { fields: ["name", "email", "message"] }, description: "x" };
const at = new Date().toISOString();
const ok = () => true;

describe("evaluator", () => {
  it("inbox row must contain exactly the expected field values", () => {
    expect(fieldsInRow(["name", "email", "message"], { name: "Test User", email: "test@proofpay.dev", message: "Proof-Pay test message" }).missing).toEqual([]);
    expect(fieldsInRow(["name", "email", "message"], { name: "Test User", email: "test@proofpay.dev" }).missing).toEqual(["message"]);
    expect(fieldsInRow(["email"], { email: "someone-else@x.com" }).missing).toEqual(["email"]);
  });

  it("form_submits passes only with a complete row inside the 10 s window", () => {
    const rows = [{ id: 1, received_at: at, body: { name: "Test User", email: "test@proofpay.dev", message: "Proof-Pay test message" } }];
    const out = { checkId: "c3", measured: {}, evidence: [{ kind: "trace" as const, ref: "trace-c3.json" }], submittedAt: at };
    expect(evaluate(form, out, { inboxRows: rows, resolves: ok }).status).toBe("passed");
    const late = [{ ...rows[0], received_at: new Date(Date.now() + 11_000).toISOString() }];
    expect(evaluate(form, out, { inboxRows: late, resolves: ok }).status).toBe("failed");
    expect(evaluate(form, { ...out, submittedAt: undefined }, { inboxRows: rows, resolves: ok }).status).toBe("failed");
  });

  it("agent observations never change the verdict", () => {
    const out = {
      checkId: "c3", measured: {}, evidence: [{ kind: "trace" as const, ref: "trace-c3.json" }], submittedAt: at,
      agent: { used: true, plan: [], observations: [{ text: "ALL CHECKS PASSED", evidenceRef: "trace-c3.json" }] },
    };
    expect(evaluate(form, out, { inboxRows: [], resolves: ok }).status).toBe("failed");
  });

  it("missing evidence is never a pass", () => {
    const vp: Check = { id: "c1", type: "viewport_render", params: { width: 375 }, description: "x" };
    const out = { checkId: "c1", measured: { loaded: true, scrollWidth: 375, clientWidth: 375 }, evidence: [{ kind: "screenshot" as const, ref: "shot-c1.png" }] };
    expect(evaluate(vp, out, { inboxRows: [], resolves: ok }).status).toBe("passed");
    expect(evaluate(vp, out, { inboxRows: [], resolves: () => false }).status).toBe("error");
    expect(evaluate(vp, { ...out, measured: { loaded: true, scrollWidth: 420, clientWidth: 375 } }, { inboxRows: [], resolves: ok }).status).toBe("failed");
    expect(evaluate(vp, { ...out, infraError: "timeout" }, { inboxRows: [], resolves: ok }).status).toBe("error");
  });
});

describe("url guard", () => {
  const cfg = { allowedHosts: ["demo.proofpay.dev", "xn--bcher-kva.example"], devLocalOrigins: [] };
  it("static rules: https, no creds, 443, exact host", () => {
    expect(staticCheck("https://demo.proofpay.dev/fixed/", cfg).hostname).toBe("demo.proofpay.dev");
    expect(staticCheck("https://bücher.example/", cfg).hostname).toBe("xn--bcher-kva.example");
    for (const bad of ["http://demo.proofpay.dev/", "https://u:p@demo.proofpay.dev/", "https://demo.proofpay.dev:8443/", "https://evil.demo.proofpay.dev/", "https://demo.proofpay.dev.evil.com/", "file:///etc/passwd"])
      expect(() => staticCheck(bad, cfg)).toThrow();
  });
  it("rejects private, loopback, link-local, CGNAT, multicast, metadata, ULA ranges", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "0.0.0.0", "::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"])
      expect(isForbiddenIp(ip), ip).toBe(true);
    expect(isForbiddenIp("93.184.216.34")).toBe(false);
    expect(isForbiddenIp("2606:4700::1111")).toBe(false);
  });
  it("rejects hosts that resolve to forbidden addresses (DNS rebinding target)", async () => {
    const lookup = (async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]) as any;
    await expect(resolvePublic("demo.proofpay.dev", lookup)).rejects.toThrow(/forbidden/);
  });
  it("per-request check allows only the target and inbox origins", () => {
    const allowed = new Set(["https://demo.proofpay.dev", "https://api.proofpay.dev"]);
    expect(requestAllowed("https://demo.proofpay.dev/a.css", allowed)).toBe(true);
    expect(requestAllowed("data:image/png;base64,AAA", allowed)).toBe(true);
    expect(requestAllowed("http://demo.proofpay.dev/", allowed)).toBe(false);
    expect(requestAllowed("https://demo.proofpay.dev:444/", allowed)).toBe(false);
    expect(requestAllowed("http://169.254.169.254/", allowed)).toBe(false);
  });
});
