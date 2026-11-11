import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authRouter, requireRole } from "./routes/auth.ts";
import { milestonesRouter } from "./routes/milestones.ts";
import { inboxRouter, internalRouter } from "./routes/inbox.ts";
import { HttpError } from "./services/errors.ts";
import { createFakePayPal } from "./dev/fakePaypal.ts";
import { artifactsDir } from "./services/verificationService.ts";

export function createApp(opts: { fakePaypal?: ReturnType<typeof createFakePayPal> } = {}) {
  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy (Render, etc.) set TRUST_PROXY=1 so rate limits see the real client IP.
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 0));
  app.use(securityHeaders);
  app.use("/inbox", inboxRouter); // own body parsers + CORS, before the JSON parser
  app.use(express.json({ limit: "4mb" }));
  app.use("/api/auth", authRouter);
  app.use("/api", milestonesRouter);
  app.use("/internal", internalRouter);
  app.use("/artifacts", requireRole(), express.static(artifactsDir(), { fallthrough: false, dotfiles: "deny" }));
  if (opts.fakePaypal) {
    app.use("/fake-paypal", opts.fakePaypal.router);
    app.post("/api/dev/fake-approve/:orderId", (req, res) => {
      opts.fakePaypal!.approve(req.params.orderId);
      res.json({ ok: true });
    });
  }
  app.get("/healthz", (_req, res) => void res.json({ ok: true }));
  // Production: serve the built React app (web/dist) with an SPA fallback.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(webDist)) {
    // index.html is served by hand so each page load carries its CSP nonce (PayPal's SDK reads it).
    const indexHtml = fs.readFileSync(path.join(webDist, "index.html"), "utf8");
    app.use(express.static(webDist, { index: false }));
    app.get(/^\/(?!api|internal|inbox|artifacts|fake-paypal).*/, (_req, res) => {
      res.type("html").send(indexHtml.replace("<head>", `<head><meta name="csp-nonce" content="${res.locals.nonce}">`));
    });
  }
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, details: err.details });
    const status = (err as any)?.status ?? (err as any)?.statusCode;
    if (status && status < 500) return void res.status(status).json({ error: (err as Error).message });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}

// PayPal's JS SDK loads scripts, frames and images from these origins.
const PAYPAL = "https://*.paypal.com https://*.paypalobjects.com";
const csp = (nonce: string) => [
  "default-src 'self'",
  `script-src 'self' 'nonce-${nonce}' ${PAYPAL}`,
  `frame-src ${PAYPAL}`,
  `connect-src 'self' ${PAYPAL}`,
  `img-src 'self' data: blob: ${PAYPAL}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups"); // PayPal checkout opens a popup
  res.locals.nonce = randomBytes(16).toString("base64");
  if (!req.path.startsWith("/fake-paypal")) res.setHeader("Content-Security-Policy", csp(res.locals.nonce));
  if ((process.env.PUBLIC_BASE_URL ?? "").startsWith("https://")) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
}
