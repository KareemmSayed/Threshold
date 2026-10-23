/** Reads and writes for the D1 archive. */
import { ACTIVITY_COLUMNS, DAILY_COLUMNS, flattenActivity, flattenDaily, type ArchivedDataset, type Row } from "./flatten";

export async function getMeta<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setMetaStmt(db: D1Database, key: string, value: unknown): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, JSON.stringify(value), Date.now());
}

export async function setMeta(db: D1Database, key: string, value: unknown): Promise<void> {
  await setMetaStmt(db, key, value).run();
}

/** Statements that store one day of one dataset: the raw item and its columns. */
export function dailyStatements(db: D1Database, dataset: ArchivedDataset, date: string, item: unknown, fetchedAt: number): D1PreparedStatement[] {
  const row = item === undefined ? null : flattenDaily(dataset, item);
  const columns = DAILY_COLUMNS[dataset];
  const values = columns.map((c) => (row ? (row[c] ?? null) : null));
  const sets = columns.map((c) => `${c} = excluded.${c}`).join(", ");
  return [
    db
      .prepare(`INSERT INTO raw_daily (dataset, date, json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(dataset, date) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`)
      .bind(dataset, date, item === undefined ? null : JSON.stringify(item), fetchedAt),
    db
      .prepare(`INSERT INTO daily (date, ${columns.join(", ")}, updated_at) VALUES (?, ${columns.map(() => "?").join(", ")}, ?) ON CONFLICT(date) DO UPDATE SET ${sets}, updated_at = excluded.updated_at`)
      .bind(date, ...values, fetchedAt),
  ];
}

const ACTIVITY_UPDATE = ACTIVITY_COLUMNS.filter((c) => c !== "activity_id")
  .map((c) => `${c} = excluded.${c}`)
  .join(", ");

export function activityStatement(db: D1Database, activity: unknown, now: number): D1PreparedStatement | null {
  const row = flattenActivity(activity);
  if (!row) return null;
  return db
    .prepare(
      `INSERT INTO activities (${ACTIVITY_COLUMNS.join(", ")}, updated_at) VALUES (${ACTIVITY_COLUMNS.map(() => "?").join(", ")}, ?) ON CONFLICT(activity_id) DO UPDATE SET ${ACTIVITY_UPDATE}, updated_at = excluded.updated_at`,
    )
    .bind(...ACTIVITY_COLUMNS.map((c) => row[c] ?? null), now);
}

/** Run statements in batches that stay well inside D1's per-batch limits. */
export async function runBatched(db: D1Database, statements: D1PreparedStatement[], size = 50): Promise<void> {
  for (let i = 0; i < statements.length; i += size) await db.batch(statements.slice(i, i + size));
}

/** When each date of a dataset was last fetched. */
export async function fetchedDates(db: D1Database, dataset: ArchivedDataset, start: string, end: string): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(`SELECT date, fetched_at FROM raw_daily WHERE dataset = ? AND date BETWEEN ? AND ?`)
    .bind(dataset, start, end)
    .all<{ date: string; fetched_at: number }>();
  return new Map(results.map((r) => [r.date, r.fetched_at]));
}

export type DailyRow = Row & { date: string };

export async function readDaily(db: D1Database, start: string, end: string): Promise<DailyRow[]> {
  const { results } = await db.prepare(`SELECT * FROM daily WHERE date BETWEEN ? AND ? ORDER BY date`).bind(start, end).all<DailyRow>();
  return results;
}

export interface ActivityRow {
  activity_id: number;
  name: string | null;
  type: string | null;
  sport: string;
  date: string | null;
  start_local: string | null;
  distance_m: number | null;
  duration_s: number | null;
  moving_s: number | null;
  elevation_gain_m: number | null;
  avg_speed_mps: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power_w: number | null;
  norm_power_w: number | null;
  calories: number | null;
  aerobic_te: number | null;
  anaerobic_te: number | null;
  garmin_load: number | null;
  tss: number | null;
  vo2max: number | null;
  hr_zone1_s: number | null;
  hr_zone2_s: number | null;
  hr_zone3_s: number | null;
  hr_zone4_s: number | null;
  hr_zone5_s: number | null;
  training_effect_label: string | null;
  fit_status: string | null;
  fit_vo2max: number | null;
  fit_recovery_min: number | null;
  fit_performance_condition: number | null;
  decoupling_pct: number | null;
  efficiency_factor: number | null;
}

const ACTIVITY_SELECT = `activity_id, name, type, sport, date, start_local, distance_m, duration_s, moving_s, elevation_gain_m, avg_speed_mps, avg_hr, max_hr, avg_power_w, norm_power_w, calories, aerobic_te, anaerobic_te, garmin_load, tss, vo2max, hr_zone1_s, hr_zone2_s, hr_zone3_s, hr_zone4_s, hr_zone5_s, training_effect_label, fit_status, fit_vo2max, fit_recovery_min, fit_performance_condition, decoupling_pct, efficiency_factor`;

export async function readActivities(db: D1Database, start: string, end: string): Promise<ActivityRow[]> {
  const { results } = await db
    .prepare(`SELECT ${ACTIVITY_SELECT} FROM activities WHERE date BETWEEN ? AND ? ORDER BY start_local`)
    .bind(start, end)
    .all<ActivityRow>();
  return results;
}

export async function readActivity(db: D1Database, id: number): Promise<(ActivityRow & { raw_json: string | null; fit_json: string | null }) | null> {
  return db.prepare(`SELECT ${ACTIVITY_SELECT}, raw_json, fit_json FROM activities WHERE activity_id = ?`).bind(id).first();
}
