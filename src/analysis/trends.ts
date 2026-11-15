/** Trend statistics for any daily metric, with comparison to the previous period. */
import type { ActivityRow, DailyRow } from "../archive/store";
import type { ProfileFacts } from "../context";
import { STEADY_TYPES } from "../fit/intervals";
import { addDays, daysBetween, eachDate, weekStart } from "../util/dates";
import { activityLoad } from "./load";
import { finite, linearTrend, mean, median, pctChange, round, sd, sum } from "./stats";

type DailyFn = (r: DailyRow) => number | null;
type ActivityAgg = { from: "activities"; per: (acts: ActivityRow[], facts: ProfileFacts) => number | null };

interface Metric {
  unit: string;
  description: string;
  /** Higher is better? Used only for wording. */
  better?: "higher" | "lower";
  /** How to combine days into weeks or months. */
  combine: "mean" | "sum";
  source: DailyFn | ActivityAgg;
}

const d = (key: string, scale = 1): DailyFn => (r) => (finite(r[key] as number) ? (r[key] as number) * scale : null);
const acts = (per: ActivityAgg["per"]): ActivityAgg => ({ from: "activities", per });
const sport = (s: string) => (as: ActivityRow[]) => as.filter((a) => a.sport === s);
const km = (as: ActivityRow[]) => (as.length ? sum(as.map((a) => a.distance_m)) / 1000 : null);
/** One sustained effort, as named by the FIT analysis. Sessions not analyzed yet are left out. */
const steady = (a: ActivityRow) => a.workout_type !== null && STEADY_TYPES.has(a.workout_type);
/** A local "YYYY-MM-DDTHH:MM" time as hours after `originHour`, wrapped into one day. */
const clockHours = (key: string, originHour: number): DailyFn => (r) => {
  const m = typeof r[key] === "string" ? /T(\d{2}):(\d{2})/.exec(r[key] as string) : null;
  return m ? (Number(m[1]) + Number(m[2]) / 60 - originHour + 24) % 24 : null;
};
/** Distance-weighted pace in min/km. */
const paceOf = (runs: ActivityRow[]) => {
  const timed = runs.filter((a) => (a.distance_m ?? 0) > 500 && (a.moving_s ?? a.duration_s));
  const m = sum(timed.map((a) => a.distance_m));
  const s = sum(timed.map((a) => a.moving_s ?? a.duration_s));
  return m > 0 ? s / 60 / (m / 1000) : null;
};

export const METRICS: Record<string, Metric> = {
  resting_hr: { unit: "bpm", description: "Resting heart rate", better: "lower", combine: "mean", source: d("resting_hr") },
  hrv: { unit: "ms", description: "Overnight HRV (Garmin's nightly average)", better: "higher", combine: "mean", source: d("hrv_ms") },
  sleep_hours: { unit: "h", description: "Total sleep", better: "higher", combine: "mean", source: d("sleep_seconds", 1 / 3600) },
  sleep_score: { unit: "0-100", description: "Garmin sleep score", better: "higher", combine: "mean", source: d("sleep_score") },
  deep_sleep_min: { unit: "min", description: "Deep sleep", better: "higher", combine: "mean", source: d("deep_sleep_seconds", 1 / 60) },
  rem_sleep_min: { unit: "min", description: "REM sleep", better: "higher", combine: "mean", source: d("rem_sleep_seconds", 1 / 60) },
  steps: { unit: "steps", description: "Daily steps", better: "higher", combine: "mean", source: d("steps") },
  stress: { unit: "0-100", description: "Average stress", better: "lower", combine: "mean", source: d("stress_avg") },
  body_battery_high: { unit: "0-100", description: "Highest Body Battery of the day", better: "higher", combine: "mean", source: d("body_battery_high") },
  body_battery_low: { unit: "0-100", description: "Lowest Body Battery of the day", better: "higher", combine: "mean", source: d("body_battery_low") },
  active_calories: { unit: "kcal", description: "Active calories", combine: "mean", source: d("calories_active") },
  intensity_minutes: {
    unit: "min",
    description: "Intensity minutes (vigorous counts double, as Garmin counts)",
    better: "higher",
    combine: "sum",
    source: (r) => (finite(r.intensity_moderate_min as number) || finite(r.intensity_vigorous_min as number) ? ((r.intensity_moderate_min as number) ?? 0) + 2 * ((r.intensity_vigorous_min as number) ?? 0) : null),
  },
  respiration: { unit: "brpm", description: "Average waking respiration", combine: "mean", source: d("respiration_avg") },
  spo2: { unit: "%", description: "Average SpO2", combine: "mean", source: d("spo2_avg") },
  weight_kg: { unit: "kg", description: "Weight", combine: "mean", source: d("weight_kg") },
  body_fat_pct: { unit: "%", description: "Body fat", better: "lower", combine: "mean", source: d("body_fat_pct") },
  training_load: { unit: "load", description: "Training load per day (Garmin load, TSS or TRIMP)", combine: "sum", source: acts((as, f) => sum(as.map((a) => activityLoad(a, f).load))) },
  training_hours: { unit: "h", description: "Training time", combine: "sum", source: acts((as) => sum(as.map((a) => a.duration_s)) / 3600) },
  running_km: { unit: "km", description: "Running distance", combine: "sum", source: acts((as) => km(sport("running")(as)) ?? 0) },
  cycling_km: { unit: "km", description: "Cycling distance", combine: "sum", source: acts((as) => km(sport("cycling")(as)) ?? 0) },
  swimming_km: { unit: "km", description: "Swimming distance", combine: "sum", source: acts((as) => km(sport("swimming")(as)) ?? 0) },
  running_pace: {
    unit: "min/km",
    description: "Average running pace over every run (distance-weighted; interval sessions include their rests)",
    better: "lower",
    combine: "mean",
    source: acts((as) => paceOf(sport("running")(as))),
  },
  steady_run_pace: {
    unit: "min/km",
    description: "Pace of steady runs only (easy, long, tempo, recovery; no interval sessions)",
    better: "lower",
    combine: "mean",
    source: acts((as) => paceOf(sport("running")(as).filter(steady))),
  },
  vo2max: {
    unit: "ml/kg/min",
    description: "VO2 max estimate (Garmin, or decoded from the FIT file)",
    better: "higher",
    combine: "mean",
    source: acts((as) => {
      const v = as.map((a) => a.vo2max ?? a.fit_vo2max).filter(finite);
      return v.length ? v[v.length - 1] : null;
    }),
  },
  running_efficiency: {
    unit: "m/min per bpm",
    description: "Running efficiency factor on steady runs (speed per heartbeat; higher = fitter at the same effort)",
    better: "higher",
    combine: "mean",
    source: acts((as) => mean(sport("running")(as).filter(steady).map((a) => a.efficiency_factor))),
  },
  aerobic_decoupling: {
    unit: "%",
    description: "Aerobic decoupling on steady efforts of 45 minutes or more (lower = better durability)",
    better: "lower",
    combine: "mean",
    source: acts((as) => mean(as.filter((a) => steady(a) && (a.duration_s ?? 0) >= 45 * 60).map((a) => a.decoupling_pct))),
  },
  sleep_stress: { unit: "0-100", description: "Stress during sleep", better: "lower", combine: "mean", source: d("sleep_stress") },
  sleep_respiration: { unit: "brpm", description: "Breathing rate during sleep", combine: "mean", source: d("sleep_respiration") },
  awake_min: { unit: "min", description: "Time awake during the night", better: "lower", combine: "mean", source: d("awake_seconds", 1 / 60) },
  bedtime: { unit: "h after 12:00", description: "Bedtime as hours after noon (11 = 23:00, 13 = 01:00)", combine: "mean", source: clockHours("sleep_start_local", 12) },
  wake_time: { unit: "h after 00:00", description: "Wake time as hours after midnight", combine: "mean", source: clockHours("sleep_end_local", 0) },
  body_battery_charged: { unit: "points", description: "Body Battery gained during the day's rest and sleep", better: "higher", combine: "mean", source: d("body_battery_charged") },
  hard_minutes: {
    unit: "min",
    description: "Training time in HR zones 4 and 5",
    combine: "sum",
    source: acts((as) => sum(as.map((a) => (a.hr_zone4_s ?? 0) + (a.hr_zone5_s ?? 0))) / 60),
  },
  training_end_hour: {
    unit: "h after 00:00",
    description: "Clock hour the day's last workout ended (for 'does late training hurt my sleep')",
    combine: "mean",
    source: acts((as) => {
      const ends = as
        .map((a) => {
          const m = a.start_local ? /[T ](\d{2}):(\d{2})/.exec(a.start_local) : null;
          return m ? Number(m[1]) + Number(m[2]) / 60 + (a.duration_s ?? 0) / 3600 : null;
        })
        .filter(finite);
      return ends.length ? Math.max(...ends) : null;
    }),
  },
  running_cadence: { unit: "spm", description: "Running cadence", combine: "mean", source: acts((as) => mean(sport("running")(as).filter(steady).map((a) => a.avg_cadence))) },
  stride_length: { unit: "m", description: "Running stride length", combine: "mean", source: acts((as) => mean(sport("running")(as).map((a) => a.stride_length_m))) },
  ground_contact: { unit: "ms", description: "Running ground contact time", better: "lower", combine: "mean", source: acts((as) => mean(sport("running")(as).map((a) => a.ground_contact_ms))) },
  vertical_ratio: { unit: "%", description: "Running vertical ratio (bounce per stride length)", better: "lower", combine: "mean", source: acts((as) => mean(sport("running")(as).map((a) => a.vertical_ratio_pct))) },
  strength_sets: { unit: "sets", description: "Strength training sets", combine: "sum", source: acts((as) => sum(as.map((a) => a.total_sets))) },
  swim_swolf: { unit: "swolf", description: "Swim efficiency score (seconds plus strokes per length; lower = more efficient)", better: "lower", combine: "mean", source: acts((as) => mean(sport("swimming")(as).map((a) => a.swolf))) },
  swim_pace: {
    unit: "s/100m",
    description: "Swimming pace per 100 m (distance-weighted)",
    better: "lower",
    combine: "mean",
    source: acts((as) => {
      const swims = sport("swimming")(as).filter((a) => (a.distance_m ?? 0) > 50 && (a.moving_s ?? a.duration_s));
      const m = sum(swims.map((a) => a.distance_m));
      return m > 0 ? sum(swims.map((a) => a.moving_s ?? a.duration_s)) / (m / 100) : null;
    }),
  },
};

/** The dataset each daily metric reads, when it is not the daily summary. */
export const DATASET_FOR_METRIC: Record<string, "hrv" | "sleep" | "weight"> = {
  hrv: "hrv",
  sleep_hours: "sleep",
  sleep_score: "sleep",
  deep_sleep_min: "sleep",
  rem_sleep_min: "sleep",
  sleep_stress: "sleep",
  sleep_respiration: "sleep",
  awake_min: "sleep",
  bedtime: "sleep",
  wake_time: "sleep",
  weight_kg: "weight",
  body_fat_pct: "weight",
};

/** True when a metric is computed from activities, false when from the daily table. */
export const fromActivities = (name: string) => typeof METRICS[name].source !== "function";

/** One value per day for a metric. Sum metrics count rest days as zero; mean metrics leave them empty. */
export function metricSeries(name: string, rows: DailyRow[], activities: ActivityRow[], facts: ProfileFacts, start: string, end: string): Array<[string, number | null]> {
  return series(METRICS[name], rows, activities, facts, start, end);
}

export type Granularity = "day" | "week" | "month";

function series(metric: Metric, rows: DailyRow[], activities: ActivityRow[], facts: ProfileFacts, start: string, end: string): Array<[string, number | null]> {
  if (typeof metric.source === "function") {
    const fn = metric.source;
    const byDate = new Map(rows.map((r) => [r.date, r]));
    return eachDate(start, end).map((date) => {
      const r = byDate.get(date);
      return [date, r ? fn(r) : null];
    });
  }
  const per = metric.source.per;
  const byDate = new Map<string, ActivityRow[]>();
  for (const a of activities) if (a.date) byDate.set(a.date, [...(byDate.get(a.date) ?? []), a]);
  // Sum metrics count rest days as zero; mean metrics skip them.
  return eachDate(start, end).map((date) => {
    const list = byDate.get(date);
    if (!list?.length) return [date, metric.combine === "sum" ? 0 : null];
    return [date, per(list, facts)];
  });
}

function group(points: Array<[string, number | null]>, granularity: Granularity, combine: "mean" | "sum") {
  if (granularity === "day") return points.filter(([, v]) => v !== null).map(([date, v]) => ({ period: date, value: round(v, 2) }));
  const buckets = new Map<string, Array<number | null>>();
  for (const [date, v] of points) {
    const key = granularity === "week" ? weekStart(date) : date.slice(0, 7);
    buckets.set(key, [...(buckets.get(key) ?? []), v]);
  }
  return [...buckets.entries()].map(([period, vs]) => ({
    period,
    value: round(combine === "sum" ? sum(vs) : mean(vs), 2),
    days_with_data: vs.filter(finite).length,
  }));
}

export function metricTrend(name: string, rows: DailyRow[], activities: ActivityRow[], facts: ProfileFacts, start: string, end: string, granularity?: Granularity, prevRows?: DailyRow[], prevActivities?: ActivityRow[]) {
  const metric = METRICS[name];
  const span = daysBetween(start, end) + 1;
  const gran: Granularity = granularity ?? (span > 120 ? "month" : span > 35 ? "week" : "day");
  const points = series(metric, rows, activities, facts, start, end);
  const vals = points.map(([, v]) => v);
  const withData = points.filter((p): p is [string, number] => finite(p[1]));
  const minP = withData.reduce<[string, number] | null>((m, p) => (!m || p[1] < m[1] ? p : m), null);
  const maxP = withData.reduce<[string, number] | null>((m, p) => (!m || p[1] > m[1] ? p : m), null);
  const trend = linearTrend(points.map(([, v], i): [number, number | null] => [i, v]).filter((p): p is [number, number] => finite(p[1])));
  const edge = Math.min(14, Math.max(3, Math.floor(span / 4)));
  const firstAvg = mean(vals.slice(0, edge));
  const lastAvg = mean(vals.slice(-edge));
  const total = metric.combine === "sum" ? sum(vals) : null;

  let previous = null;
  if (prevRows || prevActivities) {
    const pStart = addDays(start, -span);
    const pEnd = addDays(start, -1);
    const pVals = series(metric, prevRows ?? [], prevActivities ?? [], facts, pStart, pEnd).map(([, v]) => v);
    const pMean = mean(pVals);
    const cur = mean(vals);
    previous = {
      from: pStart,
      to: pEnd,
      mean: round(pMean, 2),
      total: metric.combine === "sum" ? round(sum(pVals), 1) : undefined,
      change: pMean !== null && cur !== null ? round(cur - pMean, 2) : null,
      change_pct: round(pctChange(pMean, cur), 1),
    };
  }

  const perWeek = trend ? trend.slopePerDay * 7 : null;
  let direction = "flat";
  if (trend && perWeek !== null && trend.r2 >= 0.1) {
    const meanAbs = Math.abs(mean(vals) ?? 0) || 1;
    if (Math.abs(perWeek * (span / 7)) / meanAbs > 0.02) direction = perWeek > 0 ? "rising" : "falling";
  }
  const judgement =
    direction === "flat" || !metric.better ? undefined : (direction === "rising") === (metric.better === "higher") ? "improving" : "worsening";

  return {
    metric: name,
    description: metric.description,
    unit: metric.unit,
    period: { from: start, to: end, days: span, days_with_data: withData.length },
    summary: {
      mean: round(mean(vals), 2),
      median: round(median(vals), 2),
      sd: round(sd(vals), 2),
      total: total !== null ? round(total, 1) : undefined,
      min: minP ? { value: round(minP[1], 2), date: minP[0] } : null,
      max: maxP ? { value: round(maxP[1], 2), date: maxP[0] } : null,
    },
    trend: trend
      ? {
          per_week: round(perWeek, 3),
          r2: round(trend.r2, 2),
          direction,
          judgement,
          first_vs_last: { first_days_avg: round(firstAvg, 2), last_days_avg: round(lastAvg, 2), days: edge, change_pct: round(pctChange(firstAvg, lastAvg), 1) },
        }
      : null,
    previous_period: previous,
    series: group(points, gran, metric.combine),
    granularity: gran,
  };
}
