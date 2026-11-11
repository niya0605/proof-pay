import { getDb, now } from "../db/migrate.ts";

export type EventRow = { id: number; milestone_id: string; at: string; actor: string; type: string; data: any };

/** Append-only: the app never updates or deletes an event row. */
export function logEvent(milestoneId: string | null, actor: string, type: string, data: unknown = {}) {
  getDb()
    .prepare("INSERT INTO events (milestone_id, at, actor, type, data_json) VALUES (?, ?, ?, ?, ?)")
    .run(milestoneId, now(), actor, type, JSON.stringify(data ?? {}));
}

export function listEvents(milestoneId: string): EventRow[] {
  return getDb()
    .prepare("SELECT * FROM events WHERE milestone_id = ? ORDER BY id")
    .all(milestoneId)
    .map((r: any) => ({ ...r, data: JSON.parse(r.data_json), data_json: undefined }));
}
