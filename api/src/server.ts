import { modelName, provider } from "./ai/engine.ts";
import { initDb } from "./db/migrate.ts";
import { createApp } from "./app.ts";
import { startJobs } from "./jobs/loop.ts";
import { createFakePayPal } from "./dev/fakePaypal.ts";

initDb();
if (process.env.NODE_ENV === "production" && (!process.env.WORKER_JOB_SECRET || ["dev-worker-secret", "change-me"].includes(process.env.WORKER_JOB_SECRET))) {
  console.error("WORKER_JOB_SECRET must be set to a strong value in production");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3001);
const fake = process.env.FAKE_PAYPAL === "1" ? createFakePayPal() : undefined;
if (fake) process.env.PAYPAL_BASE = `http://localhost:${port}/fake-paypal`;
const app = createApp({ fakePaypal: fake });
app.listen(port, () => {
  console.log(`Proof-Pay API on :${port}  PayPal: ${fake ? "FAKE (local stand-in)" : process.env.PAYPAL_BASE ?? "sandbox"}  LLM: ${process.env.LLM_API_KEY ? `${provider()} ${modelName()}` : "off (deterministic fallbacks)"}`);
  void startJobs();
});
