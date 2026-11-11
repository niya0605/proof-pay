import express from "express";
import { timingSafeEqual } from "node:crypto";
import { runJob, type Job } from "./runChecks.ts";

/** The worker holds no PayPal or LLM keys: only WORKER_JOB_SECRET and ALLOWED_HOSTS. */
// The fallback is for local development only; production must set a real secret.
const secret = process.env.WORKER_JOB_SECRET || (process.env.NODE_ENV === "production" ? "" : "dev-worker-secret");
if (!secret || (process.env.NODE_ENV === "production" && ["dev-worker-secret", "change-me"].includes(secret))) {
  console.error("WORKER_JOB_SECRET must be set to a strong value in production");
  process.exit(1);
}
const app = express();
app.use(express.json({ limit: "1mb" }));
let busy = false;

app.post("/jobs", async (req, res) => {
  const got = Buffer.from(String(req.headers.authorization ?? ""));
  const want = Buffer.from(`Bearer ${secret}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return void res.status(401).json({ error: "unauthorized" });
  if (busy) return void res.status(429).json({ error: "one run at a time" });
  busy = true;
  try {
    res.json(await runJob(req.body as Job));
  } finally {
    busy = false;
  }
});
app.get("/healthz", (_req, res) => void res.json({ ok: true, busy }));
const port = Number(process.env.WORKER_PORT ?? 3002);
app.listen(port, () => console.log(`Proof-Pay worker on :${port}`));
