/**
 * The archive schema. It is created and upgraded on first use, so a fresh
 * deploy needs no migration step.
 */
import { ACTIVITY_COLUMNS, DAILY_COLUMNS } from "./flatten";

const dailyColumns = Object.values(DAILY_COLUMNS)
  .flat()
  .map((c) => `${c} ${c.endsWith("_local") || c === "hrv_status" ? "TEXT" : "REAL"}`)
  .join(",\n  ");

const TEXT_ACTIVITY = new Set(["name", "type", "sport", "date", "start_local", "start_gmt", "training_effect_label", "raw_json"]);
const activityColumns = ACTIVITY_COLUMNS.filter((c) => c !== "activity_id")
  .map((c) => `${c} ${TEXT_ACTIVITY.has(c) ? "TEXT" : "REAL"}`)
  .join(",\n  ");

/** Each entry is one schema version. Never edit a shipped entry; append a new one. */
export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS raw_daily (
  dataset TEXT NOT NULL,
  date TEXT NOT NULL,
  json TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (dataset, date)
)`,
    `CREATE TABLE IF NOT EXISTS daily (
  date TEXT PRIMARY KEY,
  ${dailyColumns},
  updated_at INTEGER
)`,
    `CREATE TABLE IF NOT EXISTS activities (
  activity_id INTEGER PRIMARY KEY,
  ${activityColumns},
  fit_status TEXT,
  fit_attempts INTEGER,
  fit_vo2max REAL,
  fit_recovery_min REAL,
  fit_performance_condition REAL,
  decoupling_pct REAL,
  efficiency_factor REAL,
  fit_np_w REAL,
  fit_json TEXT,
  updated_at INTEGER
)`,
    `CREATE INDEX IF NOT EXISTS activities_date ON activities (date)`,
    `CREATE INDEX IF NOT EXISTS activities_sport_date ON activities (sport, date)`,
    `CREATE INDEX IF NOT EXISTS activities_fit_status ON activities (fit_status)`,
    `CREATE TABLE IF NOT EXISTS best_efforts (
  activity_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  sport TEXT NOT NULL,
  effort TEXT NOT NULL,
  kind TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (activity_id, effort)
)`,
    `CREATE INDEX IF NOT EXISTS best_efforts_effort ON best_efforts (sport, effort, value)`,
  ],
  [
    // show_view's private links: id is the SHA-256 of the link token, so the table alone cannot rebuild a link.
    `CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  epoch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS views_expires ON views (expires_at)`,
  ],
];

let schemaReady = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  let version = 0;
  try {
    const row = await db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first<{ value: string }>();
    version = Number(row?.value ?? 0) || 0;
  } catch {
    version = 0; // meta does not exist yet
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    try {
      await db.batch([
        ...MIGRATIONS[v].map((sql) => db.prepare(sql)),
        db
          .prepare(`INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .bind(String(v + 1), Date.now()),
      ]);
    } catch (err) {
      // Another isolate may have applied this version at the same moment.
      const row = await db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first<{ value: string }>().catch(() => null);
      if (Number(row?.value ?? 0) <= v) throw err;
    }
  }
  schemaReady = true;
}

/** Human description of the queryable tables, shown to the model by the SQL tool. */
export const SCHEMA_GUIDE = `Tables (SQLite / Cloudflare D1):
daily(date TEXT PK 'YYYY-MM-DD', steps, step_goal, distance_m, floors, resting_hr, min_hr, max_hr, stress_avg, stress_max, body_battery_high, body_battery_low, body_battery_charged, body_battery_drained, calories_total, calories_active, intensity_moderate_min, intensity_vigorous_min, respiration_avg, spo2_avg, sleep_seconds, deep_sleep_seconds, light_sleep_seconds, rem_sleep_seconds, awake_seconds, sleep_score, sleep_avg_hr, sleep_respiration, sleep_stress, sleep_start_local, sleep_end_local, hrv_ms (Garmin overnight HRV average), hrv_weekly_ms, hrv_peak_ms, hrv_baseline_low_ms, hrv_baseline_high_ms, hrv_status TEXT, weight_kg, bmi, body_fat_pct, muscle_mass_kg, body_water_pct, updated_at)
  Sleep columns sit on the date the night ends. NULL means no data, never zero.
activities(activity_id PK, name, type (Garmin typeKey), sport (running|cycling|swimming|walking|hiking|strength|rowing_paddling|winter|mind_body|other), date, start_local, start_gmt, distance_m, duration_s, moving_s, elapsed_s, elevation_gain_m, elevation_loss_m, avg_speed_mps, max_speed_mps, avg_hr, max_hr, avg_power_w, max_power_w, norm_power_w, avg_cadence, calories, aerobic_te, anaerobic_te, garmin_load (Garmin training load), tss, intensity_factor, vo2max, hr_zone1_s..hr_zone5_s, steps, avg_respiration, training_effect_label, raw_json (full Garmin JSON; use json_extract), fit_status (NULL = not imported yet | done | missing | error), fit_attempts, fit_vo2max, fit_recovery_min, fit_performance_condition, decoupling_pct, efficiency_factor, fit_np_w, fit_json)
best_efforts(activity_id, date, sport, effort ('400m','1k','1mi','5k','10k','half','marathon','20k_bike','40k_bike', or power '5s','1min','5min','20min','60min'), kind ('time_s' = seconds to cover the distance, 'power_w' = best average watts), value)
raw_daily(dataset ('daily_summaries'|'sleep'|'hrv'|'weight'), date, json (Garmin JSON or NULL when Garmin had no data), fetched_at)
Units: meters, seconds, m/s, kg, bpm, ms. Pace min/km = 1000 / avg_speed_mps / 60.`;
