/**
 * The race calendar: target events the athlete tells the server about. They are stored
 * in the archive (never sent to Garmin) so the briefing can count down to them, the
 * predictor can measure the gap to a goal, and the forecast knows which day matters.
 */
import type { UpcomingEvent } from "../analysis/readiness";

export interface EventRow extends UpcomingEvent {
  note: string | null;
}

const COLUMNS = `id, date, name, sport, distance_m, goal_time_s, priority, note`;

export interface EventInput {
  date: string;
  name: string;
  sport?: string | null;
  distance_m?: number | null;
  goal_time_s?: number | null;
  priority?: string | null;
  note?: string | null;
}

export async function listEvents(db: D1Database, from?: string): Promise<EventRow[]> {
  const stmt = from ? db.prepare(`SELECT ${COLUMNS} FROM events WHERE date >= ? ORDER BY date, id`).bind(from) : db.prepare(`SELECT ${COLUMNS} FROM events ORDER BY date, id`);
  return (await stmt.all<EventRow>()).results;
}

/** The next event on or after `today`: the most important one on the nearest date. */
export async function nextEvent(db: D1Database, today: string): Promise<EventRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM events WHERE date >= ? ORDER BY date, COALESCE(priority, 'B'), id LIMIT 1`).bind(today).first<EventRow>();
}

export async function getEvent(db: D1Database, id: number): Promise<EventRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM events WHERE id = ?`).bind(id).first<EventRow>();
}

export async function addEvent(db: D1Database, e: EventInput, now: number): Promise<EventRow> {
  const row = await db
    .prepare(`INSERT INTO events (date, name, sport, distance_m, goal_time_s, priority, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`)
    .bind(e.date, e.name, e.sport ?? null, e.distance_m ?? null, e.goal_time_s ?? null, e.priority ?? null, e.note ?? null, now)
    .first<EventRow>();
  if (!row) throw new Error("The event could not be saved.");
  return row;
}

/** Change the given fields of an event. Returns null when there is no such event. */
export async function updateEvent(db: D1Database, id: number, changes: Partial<EventInput>): Promise<EventRow | null> {
  const fields = (["date", "name", "sport", "distance_m", "goal_time_s", "priority", "note"] as const).filter((k) => changes[k] !== undefined);
  if (!fields.length) return getEvent(db, id);
  return db
    .prepare(`UPDATE events SET ${fields.map((k) => `${k} = ?`).join(", ")} WHERE id = ? RETURNING ${COLUMNS}`)
    .bind(...fields.map((k) => changes[k] ?? null), id)
    .first<EventRow>();
}

export async function removeEvent(db: D1Database, id: number): Promise<EventRow | null> {
  return db.prepare(`DELETE FROM events WHERE id = ? RETURNING ${COLUMNS}`).bind(id).first<EventRow>();
}
