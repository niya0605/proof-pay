import { processQueue, recoverStaleRuns } from "../services/verificationService.ts";
import { reconcile } from "../services/paymentService.ts";
import { reauthorizeJob } from "./reauthorize.ts";
import { deadlinesJob } from "./deadlines.ts";
import { logEvent } from "../services/eventService.ts";

/** One loop, started on boot. Jobs request transitions; they never call PayPal or write state directly. */
export async function startJobs() {
  recoverStaleRuns();
  await safe("reconcile", () => reconcile());
  let lastMinute = Date.now();
  const tick = async () => {
    await safe("verify", processQueue);
    if (Date.now() - lastMinute >= 60_000) {
      lastMinute = Date.now();
      await safe("reconcile", () => reconcile({ minAgeMs: 30_000 }));
      await safe("reauthorize", reauthorizeJob);
      await safe("deadlines", deadlinesJob);
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  return () => clearInterval(timer);
}

async function safe(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[job ${name}]`, e);
    logEvent(null, "job", "job_error", { job: name, error: (e as Error).message });
  }
}
