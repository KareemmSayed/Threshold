/**
 * The archive schema. It is created and upgraded on first use, so a fresh
 * deploy needs no migration step.
 */
import { ACTIVITY_COLUMNS_V1, DAILY_COLUMNS } from "./flatten";

// Migration 1 builds its tables from these lists, so they are part of a shipped migration:
// new columns go into a new migration (ALTER TABLE), never into DAILY_COLUMNS or ACTIVITY_COLUMNS_V1.
const dailyColumns = Object.values(DAILY_COLUMNS)
  .flat()
  .map((c) => `${c} ${c.endsWith("_local") || c === "hrv_status" ? "TEXT" : "REAL"}`)
  .join(",\n  ");

const TEXT_ACTIVITY = new Set(["name", "type", "sport", "date", "start_local", "start_gmt", "training_effect_label", "raw_json"]);
const activityColumns = ACTIVITY_COLUMNS_V1.filter((c) => c !== "activity_id")
  .map((c) => `${c} ${TEXT_ACTIVITY.has(c) ? "TEXT" : "REAL"}`)
  .join(",\n  ");

/** Activities with a distance effort faster than its limit. Part of migration 3: a frozen copy of DISTANCE_EFFORTS in src/fit/analyze.ts. */
const IMPOSSIBLE_EFFORTS = `SELECT activity_id FROM best_efforts WHERE kind = 'time_s' AND value < CASE effort
  WHEN '400m' THEN 43 WHEN '1k' THEN 131 WHEN '1mi' THEN 223 WHEN '5k' THEN 755 WHEN '10k' THEN 1571 WHEN 'half' THEN 3402 WHEN 'marathon' THEN 7235
  WHEN '10k_bike' THEN 400 WHEN '20k_bike' THEN 800 WHEN '40k_bike' THEN 1600 WHEN '100k_bike' THEN 4000
  WHEN '100m_swim' THEN 44 WHEN '400m_swim' THEN 212 WHEN '1500m_swim' THEN 840 END`;

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
  // Before GPS glitches were filtered, some files produced efforts faster than the world records.
  // Queue those activities for a fresh decode and drop their distance efforts until then.
  [
    `UPDATE activities SET fit_status = NULL, fit_attempts = 0, fit_json = NULL WHERE activity_id IN (${IMPOSSIBLE_EFFORTS})`,
    `DELETE FROM best_efforts WHERE kind = 'time_s' AND activity_id IN (${IMPOSSIBLE_EFFORTS})`,
  ],
  // Version 1.0: workout structure, cleaned heart rate, form, strength and swim details, the race calendar.
  // FIT results now carry fit_version, so a newer analysis re-decodes old files without another migration.
  [
    // From the activity list (ACTIVITY_COLUMNS_ADDED in flatten.ts).
    `ALTER TABLE activities ADD COLUMN event_type TEXT`,
    `ALTER TABLE activities ADD COLUMN stride_length_m REAL`,
    `ALTER TABLE activities ADD COLUMN ground_contact_ms REAL`,
    `ALTER TABLE activities ADD COLUMN vertical_oscillation_cm REAL`,
    `ALTER TABLE activities ADD COLUMN vertical_ratio_pct REAL`,
    `ALTER TABLE activities ADD COLUMN total_sets REAL`,
    `ALTER TABLE activities ADD COLUMN total_reps REAL`,
    `ALTER TABLE activities ADD COLUMN swolf REAL`,
    `ALTER TABLE activities ADD COLUMN pool_length_m REAL`,
    `ALTER TABLE activities ADD COLUMN active_lengths REAL`,
    `ALTER TABLE activities ADD COLUMN strokes REAL`,
    // From the decoded FIT file.
    `ALTER TABLE activities ADD COLUMN fit_version INTEGER`,
    `ALTER TABLE activities ADD COLUMN workout_type TEXT`,
    `ALTER TABLE activities ADD COLUMN workout_structure TEXT`,
    `ALTER TABLE activities ADD COLUMN rep_count REAL`,
    `ALTER TABLE activities ADD COLUMN rep_distance_m REAL`,
    `ALTER TABLE activities ADD COLUMN rep_time_s REAL`,
    `ALTER TABLE activities ADD COLUMN work_speed_mps REAL`,
    `ALTER TABLE activities ADD COLUMN work_hr REAL`,
    `ALTER TABLE activities ADD COLUMN rest_s REAL`,
    `ALTER TABLE activities ADD COLUMN fit_max_hr REAL`,
    `ALTER TABLE activities ADD COLUMN avg_temp_c REAL`,
    `ALTER TABLE activities ADD COLUMN device TEXT`,
    // Fill the activity-list columns for rows already archived.
    `UPDATE activities SET
  event_type = json_extract(raw_json, '$.eventType.typeKey'),
  stride_length_m = ROUND(NULLIF(json_extract(raw_json, '$.avgStrideLength'), 0) / CASE WHEN json_extract(raw_json, '$.avgStrideLength') > 5 THEN 100.0 ELSE 1.0 END, 2),
  ground_contact_ms = NULLIF(json_extract(raw_json, '$.avgGroundContactTime'), 0),
  vertical_oscillation_cm = NULLIF(json_extract(raw_json, '$.avgVerticalOscillation'), 0),
  vertical_ratio_pct = NULLIF(json_extract(raw_json, '$.avgVerticalRatio'), 0),
  total_sets = NULLIF(COALESCE(json_extract(raw_json, '$.activeSets'), json_extract(raw_json, '$.totalSets')), 0),
  total_reps = NULLIF(json_extract(raw_json, '$.totalReps'), 0),
  swolf = NULLIF(json_extract(raw_json, '$.averageSwolf'), 0),
  pool_length_m = ROUND(NULLIF(json_extract(raw_json, '$.poolLength'), 0) / CASE WHEN json_extract(raw_json, '$.poolLength') > 200 THEN 100.0 ELSE 1.0 END, 2),
  active_lengths = NULLIF(json_extract(raw_json, '$.activeLengths'), 0),
  strokes = NULLIF(json_extract(raw_json, '$.strokes'), 0)
WHERE raw_json IS NOT NULL AND json_valid(raw_json)`,
    // Files decoded before this version are analyzed again; give each its full number of attempts.
    `UPDATE activities SET fit_attempts = 0 WHERE fit_status = 'done'`,
    `CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  sport TEXT,
  distance_m REAL,
  goal_time_s REAL,
  priority TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS events_date ON events (date)`,
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
activities(activity_id PK, name, type (Garmin typeKey), sport (running|cycling|swimming|walking|hiking|strength|rowing_paddling|winter|mind_body|other), event_type (Garmin event key, e.g. race), date, start_local, start_gmt, distance_m, duration_s, moving_s, elapsed_s, elevation_gain_m, elevation_loss_m, avg_speed_mps, max_speed_mps, avg_hr, max_hr (Garmin's value; may hold sensor spikes), avg_power_w, max_power_w, norm_power_w, avg_cadence, stride_length_m, ground_contact_ms, vertical_oscillation_cm, vertical_ratio_pct, calories, aerobic_te, anaerobic_te, garmin_load (Garmin training load), tss, intensity_factor, vo2max, hr_zone1_s..hr_zone5_s, steps, avg_respiration, training_effect_label, total_sets, total_reps (strength), swolf, pool_length_m, active_lengths, strokes (swimming), raw_json (full Garmin JSON; use json_extract),
  from the FIT file: fit_status (NULL = not imported yet | done | missing | error), fit_version, fit_attempts, workout_type (intervals|long|tempo|steady|recovery|variable|other), workout_structure (e.g. '10 x 1000 m'), rep_count, rep_distance_m, rep_time_s, work_speed_mps, work_hr, rest_s (interval sessions), fit_max_hr (spikes removed), fit_vo2max, fit_recovery_min, fit_performance_condition, decoupling_pct, efficiency_factor (both NULL unless the effort was steady), fit_np_w, avg_temp_c, device, fit_json)
best_efforts(activity_id, date, sport, effort ('200m','400m','800m','1k','1500m','1mi','3k','5k','10k','half','marathon','20k_bike','40k_bike', power '5s','1min','5min','20min','60min', heart rate '5min_hr','20min_hr','60min_hr'), kind ('time_s' = seconds to cover the distance, 'power_w' = best average watts, 'hr_bpm' = highest average heart rate), value)
events(id PK, date, name, sport, distance_m, goal_time_s, priority, note): the athlete's race calendar (race_calendar tool).
raw_daily(dataset ('daily_summaries'|'sleep'|'hrv'|'weight'), date, json (Garmin JSON or NULL when Garmin had no data), fetched_at)
Units: meters, seconds, m/s, kg, bpm, ms. Pace min/km = 1000 / avg_speed_mps / 60.`;
