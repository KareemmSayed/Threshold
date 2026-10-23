/**
 * Turn Garmin JSON into archive rows. Every extractor tries the field names seen
 * in Garmin's current payloads first, then older names, and returns null rather
 * than guessing. Garmin's negative "no data" codes (stress -1, -2) become null.
 */
import { datePart } from "../util/dates";

type Obj = Record<string, unknown>;
export type Row = Record<string, string | number | null>;

function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[key];
  }
  return cur;
}

/** First finite, non-negative number among the paths. */
export function num(obj: unknown, ...paths: string[]): number | null {
  for (const p of paths) {
    let v = at(obj, p);
    if (v && typeof v === "object" && "value" in (v as Obj)) v = (v as Obj).value;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

/** First finite number (negatives allowed). */
export function signed(obj: unknown, ...paths: string[]): number | null {
  for (const p of paths) {
    const v = at(obj, p);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function text(obj: unknown, ...paths: string[]): string | null {
  for (const p of paths) {
    const v = at(obj, p);
    if (typeof v === "string" && v && v !== "NONE") return v;
  }
  return null;
}

const round = (v: number | null, digits = 2) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

/** Garmin's "...Local" epoch milliseconds are wall-clock time encoded as UTC. */
function localTime(obj: unknown, ...paths: string[]): string | null {
  for (const p of paths) {
    const v = at(obj, p);
    if (typeof v === "number" && v > 0) return new Date(v).toISOString().slice(0, 16);
    if (typeof v === "string" && v.length >= 16) return v.replace(" ", "T").slice(0, 16);
  }
  return null;
}

// Garmin occasionally reports a resting HR nobody has at rest; treat those as missing.
const MAX_PLAUSIBLE_RESTING_HR = 120;

export const DAILY_COLUMNS = {
  daily_summaries: [
    "steps",
    "step_goal",
    "distance_m",
    "floors",
    "resting_hr",
    "min_hr",
    "max_hr",
    "stress_avg",
    "stress_max",
    "body_battery_high",
    "body_battery_low",
    "body_battery_charged",
    "body_battery_drained",
    "calories_total",
    "calories_active",
    "intensity_moderate_min",
    "intensity_vigorous_min",
    "respiration_avg",
    "spo2_avg",
  ],
  sleep: [
    "sleep_seconds",
    "deep_sleep_seconds",
    "light_sleep_seconds",
    "rem_sleep_seconds",
    "awake_seconds",
    "sleep_score",
    "sleep_avg_hr",
    "sleep_respiration",
    "sleep_stress",
    "sleep_start_local",
    "sleep_end_local",
  ],
  hrv: ["hrv_ms", "hrv_weekly_ms", "hrv_peak_ms", "hrv_baseline_low_ms", "hrv_baseline_high_ms", "hrv_status"],
  weight: ["weight_kg", "bmi", "body_fat_pct", "muscle_mass_kg", "body_water_pct"],
} as const;

export type ArchivedDataset = keyof typeof DAILY_COLUMNS;
export const ARCHIVED_DATASETS = Object.keys(DAILY_COLUMNS) as ArchivedDataset[];

/** Columns for one day from one dataset, or null when the item holds no real data. */
export function flattenDaily(dataset: ArchivedDataset, item: unknown): Row | null {
  if (!item || typeof item !== "object") return null;
  switch (dataset) {
    case "daily_summaries": {
      const resting = num(item, "heartRate.restingValue", "restingHeartRate");
      const row: Row = {
        steps: num(item, "movement.steps", "totalSteps"),
        step_goal: num(item, "movement.steps.goal", "dailyStepGoal"),
        distance_m: num(item, "movement.steps.distanceInMeters", "movement.distanceMeters", "movement.distance", "totalDistanceMeters"),
        floors: num(item, "movement.floorsAscended", "floorsAscended"),
        resting_hr: resting !== null && resting <= MAX_PLAUSIBLE_RESTING_HR ? resting : null,
        min_hr: num(item, "heartRate.minValue", "minHeartRate"),
        max_hr: num(item, "heartRate.maxValue", "maxHeartRate"),
        stress_avg: num(item, "stress.avgLevel", "stress.averageLevel", "averageStressLevel"),
        stress_max: num(item, "stress.maxLevel", "maxStressLevel"),
        body_battery_high: num(item, "bodyBattery.maxValue", "bodyBattery.highestValue", "bodyBatteryHighestValue"),
        body_battery_low: num(item, "bodyBattery.minValue", "bodyBattery.lowestValue", "bodyBatteryLowestValue"),
        body_battery_charged: num(item, "bodyBattery.chargedValue", "bodyBatteryChargedValue"),
        body_battery_drained: num(item, "bodyBattery.drainedValue", "bodyBatteryDrainedValue"),
        calories_total: num(item, "calories.burnedTotal", "calories.total", "totalKilocalories"),
        calories_active: num(item, "calories.burnedActive", "calories.active", "activeKilocalories"),
        intensity_moderate_min: num(item, "intensityMinutes.moderate", "moderateIntensityMinutes"),
        intensity_vigorous_min: num(item, "intensityMinutes.vigorous", "vigorousIntensityMinutes"),
        respiration_avg: num(item, "respiration.avgValue", "respiration.avgWakingValue", "avgWakingRespirationValue"),
        spo2_avg: num(item, "spo2.avgValue", "pulseOx.avgValue", "averageSpo2"),
      };
      // Garmin sends placeholder days when the watch was not worn.
      const worn = row.min_hr !== null || (typeof row.steps === "number" && row.steps > 0);
      return worn ? row : null;
    }
    case "sleep": {
      const seconds = num(item, "sleepTimeSeconds", "dailySleepDTO.sleepTimeSeconds");
      if (!seconds) return null;
      const base = at(item, "dailySleepDTO") ?? item;
      return {
        sleep_seconds: seconds,
        deep_sleep_seconds: num(base, "deepSleepSeconds"),
        light_sleep_seconds: num(base, "lightSleepSeconds"),
        rem_sleep_seconds: num(base, "remSleepSeconds"),
        awake_seconds: num(base, "awakeSleepSeconds"),
        sleep_score: num(base, "sleepScores.overall", "sleepScore", "overallSleepScore"),
        sleep_avg_hr: num(base, "avgHeartRate", "averageHeartRate"),
        sleep_respiration: num(base, "averageRespirationValue", "avgSleepRespirationValue"),
        sleep_stress: num(base, "avgSleepStress"),
        sleep_start_local: localTime(base, "sleepStartTimestampLocal"),
        sleep_end_local: localTime(base, "sleepEndTimestampLocal"),
      };
    }
    case "hrv": {
      const last = num(item, "lastNightAvg");
      if (last === null) return null;
      return {
        hrv_ms: last,
        hrv_weekly_ms: num(item, "weeklyAvg"),
        hrv_peak_ms: num(item, "lastNight5MinHigh"),
        hrv_baseline_low_ms: num(item, "baseline.balancedLow"),
        hrv_baseline_high_ms: num(item, "baseline.balancedUpper"),
        hrv_status: text(item, "status"),
      };
    }
    case "weight": {
      const latest = at(item, "latestWeight") ?? item;
      const grams = num(latest, "weight");
      if (grams === null) return null;
      // Garmin stores grams; tolerate kilograms from older payloads.
      const kg = grams > 1000 ? grams / 1000 : grams;
      const muscle = num(latest, "muscleMass");
      return {
        weight_kg: round(kg),
        bmi: round(num(latest, "bmi"), 1),
        body_fat_pct: round(num(latest, "bodyFat"), 1),
        muscle_mass_kg: muscle === null ? null : round(muscle > 1000 ? muscle / 1000 : muscle),
        body_water_pct: round(num(latest, "bodyWater"), 1),
      };
    }
  }
}

/** Activity-type key to a coarse sport, for grouping and best efforts. */
export function sportOf(typeKey: string | null | undefined): string {
  const t = (typeKey ?? "").toLowerCase();
  if (!t) return "other";
  if (t.includes("swim")) return "swimming";
  if (t.includes("run")) return "running";
  if (/(cycl|bik|ride|bmx|spin)/.test(t)) return "cycling";
  if (t.includes("hik")) return "hiking";
  if (t.includes("walk")) return "walking";
  if (t.includes("strength") || t.includes("hiit")) return "strength";
  if (/(row|paddl|kayak|canoe)/.test(t)) return "rowing_paddling";
  if (/(ski|snowboard|skat)/.test(t)) return "winter";
  if (/(yoga|pilates|breath|meditation|mobility)/.test(t)) return "mind_body";
  return "other";
}

export const ACTIVITY_COLUMNS = [
  "activity_id",
  "name",
  "type",
  "sport",
  "date",
  "start_local",
  "start_gmt",
  "distance_m",
  "duration_s",
  "moving_s",
  "elapsed_s",
  "elevation_gain_m",
  "elevation_loss_m",
  "avg_speed_mps",
  "max_speed_mps",
  "avg_hr",
  "max_hr",
  "avg_power_w",
  "max_power_w",
  "norm_power_w",
  "avg_cadence",
  "calories",
  "aerobic_te",
  "anaerobic_te",
  "garmin_load",
  "tss",
  "intensity_factor",
  "vo2max",
  "hr_zone1_s",
  "hr_zone2_s",
  "hr_zone3_s",
  "hr_zone4_s",
  "hr_zone5_s",
  "steps",
  "avg_respiration",
  "training_effect_label",
  "raw_json",
] as const;

/** One row of the `activities` table from an activity-list item. */
export function flattenActivity(a: unknown): Row | null {
  const id = signed(a, "activityId");
  if (id === null) return null;
  const startLocal = text(a, "startTimeLocal");
  const type = text(a, "activityType.typeKey", "activityTypeDTO.typeKey");
  return {
    activity_id: id,
    name: text(a, "activityName"),
    type,
    sport: sportOf(type),
    date: datePart(startLocal),
    start_local: startLocal,
    start_gmt: text(a, "startTimeGMT"),
    distance_m: num(a, "distance"),
    duration_s: num(a, "duration"),
    moving_s: num(a, "movingDuration"),
    elapsed_s: num(a, "elapsedDuration"),
    elevation_gain_m: num(a, "elevationGain"),
    elevation_loss_m: num(a, "elevationLoss"),
    avg_speed_mps: num(a, "averageSpeed"),
    max_speed_mps: num(a, "maxSpeed"),
    avg_hr: num(a, "averageHR"),
    max_hr: num(a, "maxHR"),
    avg_power_w: num(a, "avgPower"),
    max_power_w: num(a, "maxPower"),
    norm_power_w: num(a, "normPower"),
    avg_cadence: num(a, "averageRunningCadenceInStepsPerMinute", "averageBikingCadenceInRevPerMinute", "averageSwimCadenceInStrokesPerMinute"),
    calories: num(a, "calories"),
    aerobic_te: num(a, "aerobicTrainingEffect"),
    anaerobic_te: num(a, "anaerobicTrainingEffect"),
    garmin_load: num(a, "activityTrainingLoad"),
    tss: num(a, "trainingStressScore"),
    intensity_factor: num(a, "intensityFactor"),
    vo2max: num(a, "vO2MaxValue"),
    hr_zone1_s: num(a, "hrTimeInZone_1"),
    hr_zone2_s: num(a, "hrTimeInZone_2"),
    hr_zone3_s: num(a, "hrTimeInZone_3"),
    hr_zone4_s: num(a, "hrTimeInZone_4"),
    hr_zone5_s: num(a, "hrTimeInZone_5"),
    steps: num(a, "steps"),
    avg_respiration: num(a, "avgRespirationRate"),
    training_effect_label: text(a, "trainingEffectLabel"),
    raw_json: JSON.stringify(a),
  };
}
