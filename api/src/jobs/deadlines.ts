import { getDb } from "../db/migrate.ts";
import { transition } from "../services/milestoneService.ts";
import { voidAuth } from "../services/paymentService.ts";

/** Deadline passed in FUNDED or FAILED → VOID_PENDING → void. */
export async function deadlinesJob(at = new Date().toISOString()) {
  const due = getDb().prepare("SELECT id FROM milestones WHERE state IN ('FUNDED','FAILED') AND deadline_at < ?").all(at) as { id: string }[];
  for (const { id } of due) {
    transition(id, "DEADLINE_PASSED", "job", { data: { deadlinePassed: at } });
    await voidAuth(id);
  }
}
