/** npm run demo: seeds one project (in DRAFT, ready for the brief step). */
import { initDb, getDb, newId, now } from "../db/migrate.ts";
import { randomBytes } from "node:crypto";
import { logEvent } from "../services/eventService.ts";

initDb();
const db = getDb();
const projectId = newId("prj");
const milestoneId = newId("ms");
const brief = "I need a fast, mobile-friendly landing page for my bakery with a working contact form so customers can send me a message.";
db.prepare("INSERT INTO projects (id, title, brief, client_id, freelancer_id, freelancer_email, created_at) VALUES (?, ?, ?, 'u_client', 'u_freelancer', ?, ?)")
  .run(projectId, "Bakery landing page", brief, process.env.PAYPAL_PAYEE_EMAIL ?? "freelancer@example.com", now());
db.prepare("INSERT INTO milestones (id, project_id, title, amount_cents, currency, state, deadline_at, review_window_hours, inbox_token) VALUES (?, ?, 'Website delivery', 20000, 'USD', 'DRAFT', ?, 72, ?)")
  .run(milestoneId, projectId, new Date(Date.now() + 14 * 86400_000).toISOString(), randomBytes(12).toString("hex"));
logEvent(milestoneId, "system", "project_created", { projectId, seeded: true });
console.log(`Seeded project ${projectId}, milestone ${milestoneId}. Open http://localhost:5173/m/${milestoneId}`);
