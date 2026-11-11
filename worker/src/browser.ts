import { chromium, type Browser, type BrowserContext } from "playwright";
import { requestAllowed } from "./urlGuard.ts";

export type Session = {
  browser: Browser;
  context: BrowserContext;
  blocked: string[];
  console: { at: string; type: string; text: string }[];
  close: () => Promise<void>;
};

/**
 * Launch Chromium with the resolved addresses pinned (defeats DNS rebinding: every
 * other hostname fails to resolve) and a route handler that re-checks every request.
 */
export async function openSession(opts: { pins: { host: string; ip: string }[]; allowedOrigins: Set<string> }): Promise<Session> {
  const args: string[] = [];
  if (opts.pins.length) {
    const rules = opts.pins.map((p) => `MAP ${p.host} ${p.ip.includes(":") ? `[${p.ip}]` : p.ip}`);
    args.push(`--host-resolver-rules=${[...rules, "MAP * ~NOTFOUND"].join(", ")}`);
  }
  const browser = await chromium.launch({ args });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false, locale: "en-US", timezoneId: "UTC" });
  const s: Session = { browser, context, blocked: [], console: [], close: () => browser.close() };
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (requestAllowed(url, opts.allowedOrigins)) return route.continue();
    s.blocked.push(url);
    return route.abort("blockedbyclient");
  });
  // Redirect hops are not re-routed by Playwright, so check each one here too.
  context.on("request", (req) => {
    if (req.redirectedFrom() && !requestAllowed(req.url(), opts.allowedOrigins)) s.blocked.push(req.url());
  });
  context.on("page", (page) => attachConsole(page, s));
  return s;
}

export function attachConsole(page: import("playwright").Page, s: Session) {
  page.on("console", (m) => {
    if (m.type() === "error") s.console.push({ at: new Date().toISOString(), type: "console.error", text: m.text().slice(0, 500) });
  });
  page.on("pageerror", (e) => s.console.push({ at: new Date().toISOString(), type: "pageerror", text: String(e.message).slice(0, 500) }));
}
