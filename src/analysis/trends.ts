/** Trend statistics for any daily metric, with comparison to the previous period. */
import type { ActivityRow, DailyRow } from "../archive/store";
import type { ProfileFacts } from "../context";
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
    description: "Average running pace (distance-weighted)",
    better: "lower",
    combine: "mean",
    source: acts((as) => {
      const runs = sport("running")(as).filter((a) => (a.distance_m ?? 0) > 500 && (a.moving_s ?? a.duration_s));
      const m = sum(runs.map((a) => a.distance_m));
      const s = sum(runs.map((a) => a.moving_s ?? a.duration_s));
      return m > 0 ? s / 60 / (m / 1000) : null;
    }),
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
    description: "Running efficiency factor (speed per heartbeat; higher = fitter at the same effort)",
    better: "higher",
    combine: "mean",
    source: acts((as) => mean(sport("running")(as).map((a) => a.efficiency_factor))),
  },
  aerobic_decoupling: {
    unit: "%",
    description: "Aerobic decoupling on long efforts (lower = better durability)",
    better: "lower",
    combine: "mean",
    source: acts((as) => mean(as.filter((a) => (a.duration_s ?? 0) >= 45 * 60).map((a) => a.decoupling_pct))),
  },
};

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
