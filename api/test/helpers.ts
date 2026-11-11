import express from "express";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb, getDb, newId, now } from "../src/db/migrate.ts";
import { createFakePayPal } from "../src/dev/fakePaypal.ts";
import { resetTokenCache } from "../src/services/paypal.ts";
import { MilestoneState } from "../src/domain/milestoneState.ts";
import { approve, getAgreement, setProposal } from "../src/services/agreementService.ts";
import * as payments from "../src/services/paymentService.ts";
import { templateProposal } from "../src/checks/catalog.ts";
import { transition } from "../src/services/milestoneService.ts";

export const PAYEE = "freelancer-sb@business.example.com";

export async function setup() {
  process.env.PAYPAL_TIMEOUT_MS = "400";
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pp-art-"));
  initDb(":memory:");
  const fake = createFakePayPal();
  const app = express().use(fake.router);
  const server = await new Promise<import("node:http").Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  process.env.PAYPAL_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetTokenCache();
  return { fake, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export function createMilestone(amountCents = 20000) {
  const db = getDb();
  const projectId = newId("prj");
  const id = newId("ms");
  db.prepare("INSERT INTO projects (id, title, brief, client_id, freelancer_id, freelancer_email, created_at) VALUES (?, 't', 'landing page with contact form', 'u_client', 'u_freelancer', ?, ?)").run(projectId, PAYEE, now());
  db.prepare("INSERT INTO milestones (id, project_id, title, amount_cents, currency, state, deadline_at, review_window_hours, inbox_token) VALUES (?, ?, 'm', ?, 'USD', 'DRAFT', ?, 72, ?)").run(id, projectId, amountCents, new Date(Date.now() + 10 * 86400_000).toISOString(), newId("tok"));
  return id;
}

export async function lockAndFund(fake: ReturnType<typeof createFakePayPal>, id = createMilestone()) {
  setProposal(id, templateProposal("contact form"), "test");
  const v = getAgreement(id)!.version;
  approve(id, "client", v, () => {});
  approve(id, "freelancer", v, () => payments.queueOrderInLockTx(id));
  const orderId = await payments.ensureOrder(id);
  fake.approve(orderId);
  await payments.authorize(id, orderId);
  return { id, orderId };
}

/** Insert a finished, all-passed run (as the verification service would) and move to REVIEW. */
export function passRun(id: string) {
  const db = getDb();
  const sub = newId("sub");
  const run = newId("run");
  db.prepare("INSERT INTO submissions (id, milestone_id, url, submitted_at) VALUES (?, ?, 'https://x.test/', ?)").run(sub, id, now());
  transition(id, "SUBMIT", "freelancer");
  db.prepare("INSERT INTO verification_runs (id, submission_id, status, runner_version, started_at, finished_at) VALUES (?, ?, 'finished', 't', ?, ?)").run(run, sub, now(), now());
  db.prepare("INSERT INTO check_results (id, run_id, check_id, status, expected_json, measured_json, evidence_json) VALUES (?, ?, 'c1', 'passed', '{}', '{}', '[]')").run(newId("res"), run);
  transition(id, "RUN_PASSED", "verification");
}

export const state = (id: string) => (getDb().prepare("SELECT state FROM milestones WHERE id = ?").get(id) as { state: MilestoneState }).state;
export const ops = (id: string, type?: string) => payments.listOps(id).filter((o) => !type || o.type === type);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
