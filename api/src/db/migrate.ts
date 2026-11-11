import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let db: Database.Database | null = null;

export function initDb(file = process.env.DB_FILE ?? path.resolve(here, "../../../data/proofpay.db")) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  return db;
}

export function getDb(): Database.Database {
  if (!db) initDb();
  return db!;
}

/** Run fn in an IMMEDIATE transaction, or inline if one is already open. */
export function tx<T>(fn: () => T): T {
  const d = getDb();
  if (d.inTransaction) return fn();
  return d.transaction(fn).immediate();
}

export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
