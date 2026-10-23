/**
 * Recovery signals against your own baseline.
 *
 * HRV follows the approach used in HRV research (Plews, Buchheit, Kiviniemi):
 * work on ln(rMSSD), compare the 7-day rolling mean with a 60-day baseline, and
 * treat +/- 0.5 SD of the baseline as the normal band (the smallest worthwhile
 * change). Resting HR and sleep are compared with the same baseline window.
 */
import type { DailyRow } from "../archive/store";
import { addDays } from "../util/dates";
import { finite, linearTrend, mean, round, sd } from "./stats";

export const BASELINE_DAYS = 60;
const ROLLING_DAYS = 7;

const col = (rows: DailyRow[], key: string) => rows.map((r) => (finite(r[key] as number) ? (r[key] as number) : null));

function between(rows: DailyRow[], start: string, end: string): DailyRow[] {
  return rows.filter((r) => r.date >= start && r.date <= end);
}

export type Status = "low" | "slightly low" | "normal" | "slightly high" | "high" | "elevated" | "no data";

export interface HrvReport {
  last_night_ms: number | null;
  last_night_date: string | null;
  rolling_7d_ms: number | null;
  baseline_ms: number | null;
  normal_range_ms: [number, number] | null;
  status_7d: Status;
  last_night_z: number | null;
  days_below_normal_last_7: number;
  cv_7d_pct: number | null;
  trend_30d_ms_per_week: number | null;
  garmin_status: string | null;
  garmin_baseline_ms: [number, number] | null;
  nights_in_baseline: number;
  interpretation: string;
}

export function hrvReport(rows: DailyRow[], end: string): HrvReport {
  const weekStart = addDays(end, -(ROLLING_DAYS - 1));
  const baseRows = between(rows, addDays(weekStart, -BASELINE_DAYS), addDays(weekStart, -1));
  const weekRows = between(rows, weekStart, end);
  const ln = (v: number | null) => (v && v > 0 ? Math.log(v) : null);
  const baseLn = col(baseRows, "hrv_ms").map(ln).filter(finite);
  const weekLn = col(weekRows, "hrv_ms").map(ln).filter(finite);
  const latest = [...weekRows].reverse().find((r) => finite(r.hrv_ms as number));
  const bMean = baseLn.length >= 14 ? mean(baseLn) : null;
  const bSd = baseLn.length >= 14 ? sd(baseLn) : null;
  const rolling = weekLn.length >= 3 ? mean(weekLn) : null;

  let status: Status = "no data";
  if (rolling !== null && bMean !== null && bSd) {
    const swc = 0.5 * bSd;
    status = rolling < bMean - 2 * swc ? "low" : rolling < bMean - swc ? "slightly low" : rolling > bMean + 2 * swc ? "high" : rolling > bMean + swc ? "slightly high" : "normal";
  } else if (rolling !== null) status = "normal";

  const lastLn = ln((latest?.hrv_ms as number) ?? null);
  const z = lastLn !== null && bMean !== null && bSd ? (lastLn - bMean) / bSd : null;
  const below = bMean !== null && bSd ? weekLn.filter((v) => v < bMean - bSd).length : 0;
  const weekSd = sd(weekLn);
  const weekMean = mean(weekLn);
  const cv = weekSd !== null && weekMean ? (weekSd / weekMean) * 100 : null;

  // 7-day rolling mean over the last 30 days, as a trend line in ms.
  const recent = between(rows, addDays(end, -36), end);
  const points: Array<[number, number]> = [];
  for (let i = 0; i < recent.length; i++) {
    const d = recent[i].date;
    if (d < addDays(end, -29)) continue;
    const win = recent.filter((r) => r.date > addDays(d, -ROLLING_DAYS) && r.date <= d);
    const m = mean(col(win, "hrv_ms"));
    if (m !== null) points.push([i, m]);
  }
  const trend = linearTrend(points);

  const garminRow = latest ?? [...rows].reverse().find((r) => r.hrv_status);
  const interpretation =
    status === "no data"
      ? "Not enough overnight HRV readings yet. HRV needs the watch worn overnight; Garmin's baseline needs about 3 weeks."
      : bMean === null
        ? "Fewer than 14 nights before this week, so no personal baseline yet; values are shown without a verdict."
        : status === "normal"
          ? "The 7-day HRV average sits inside your normal band: no sign of accumulated stress."
          : status.includes("low")
            ? "The 7-day HRV average is below your normal band. Common causes: hard training block, poor sleep, illness, alcohol, travel or life stress. Favour easy days until it returns."
            : "The 7-day HRV average is above your normal band. Usually good recovery; a sudden jump with fatigue can also mean heavy fatigue in trained athletes.";

  return {
    last_night_ms: (latest?.hrv_ms as number) ?? null,
    last_night_date: latest?.date ?? null,
    rolling_7d_ms: rolling !== null ? round(Math.exp(rolling)) : null,
    baseline_ms: bMean !== null ? round(Math.exp(bMean)) : null,
    normal_range_ms: bMean !== null && bSd ? [round(Math.exp(bMean - 0.5 * bSd))!, round(Math.exp(bMean + 0.5 * bSd))!] : null,
    status_7d: status,
    last_night_z: round(z, 2),
    days_below_normal_last_7: below,
    cv_7d_pct: round(cv, 1),
    trend_30d_ms_per_week: trend ? round(trend.slopePerDay * 7, 2) : null,
    garmin_status: (garminRow?.hrv_status as string) ?? null,
    garmin_baseline_ms:
      finite(garminRow?.hrv_baseline_low_ms as number) && finite(garminRow?.hrv_baseline_high_ms as number)
        ? [garminRow!.hrv_baseline_low_ms as number, garminRow!.hrv_baseline_high_ms as number]
        : null,
    nights_in_baseline: baseLn.length,
    interpretation,
  };
}

export interface RhrReport {
  latest_bpm: number | null;
  latest_date: string | null;
  rolling_7d_bpm: number | null;
  baseline_bpm: number | null;
  delta_bpm: number | null;
  status: Status;
}

export function rhrReport(rows: DailyRow[], end: string): RhrReport {
  const weekStart = addDays(end, -(ROLLING_DAYS - 1));
  const base = col(between(rows, addDays(weekStart, -BASELINE_DAYS), addDays(weekStart, -1)), "resting_hr");
  const weekRows = between(rows, weekStart, end);
  const week = col(weekRows, "resting_hr");
  const latest = [...weekRows].reverse().find((r) => finite(r.resting_hr as number));
  const bMean = base.filter(finite).length >= 14 ? mean(base) : null;
  const bSd = sd(base);
  const rolling = mean(week);
  const delta = rolling !== null && bMean !== null ? rolling - bMean : null;
  let status: Status = rolling === null ? "no data" : "normal";
  if (delta !== null && delta >= Math.max(3, bSd ?? 0)) status = "elevated";
  else if (delta !== null && delta <= -Math.max(3, bSd ?? 0)) status = "low";
  return {
    latest_bpm: (latest?.resting_hr as number) ?? null,
    latest_date: latest?.date ?? null,
    rolling_7d_bpm: round(rolling),
    baseline_bpm: round(bMean),
    delta_bpm: round(delta),
    status,
  };
}

export interface SleepReport {
  last_night: Record<string, number | string | null> | null;
  avg_7d_hours: number | null;
  baseline_hours: number | null;
  delta_hours: number | null;
  avg_7d_score: number | null;
  baseline_score: number | null;
  short_nights_last_7: number;
  status: Status;
}

export function sleepReport(rows: DailyRow[], end: string): SleepReport {
  const weekStart = addDays(end, -(ROLLING_DAYS - 1));
  const base = between(rows, addDays(weekStart, -BASELINE_DAYS), addDays(weekStart, -1));
  const week = between(rows, weekStart, end);
  const hours = (r: DailyRow[]) => col(r, "sleep_seconds").map((s) => (s === null ? null : s / 3600));
  const last = [...week].reverse().find((r) => finite(r.sleep_seconds as number));
  const avg7 = mean(hours(week));
  const baseH = hours(base).filter(finite).length >= 7 ? mean(hours(base)) : null;
  const delta = avg7 !== null && baseH !== null ? avg7 - baseH : null;
  const short = hours(week).filter((h) => h !== null && h < 6).length;
  const min = (s: unknown) => (finite(s as number) ? Math.round((s as number) / 60) : null);
  return {
    last_night: last
      ? {
          date: last.date,
          hours: round((last.sleep_seconds as number) / 3600, 2),
          score: (last.sleep_score as number) ?? null,
          deep_min: min(last.deep_sleep_seconds),
          rem_min: min(last.rem_sleep_seconds),
          light_min: min(last.light_sleep_seconds),
          awake_min: min(last.awake_seconds),
          avg_hr: (last.sleep_avg_hr as number) ?? null,
          start: (last.sleep_start_local as string) ?? null,
          end: (last.sleep_end_local as string) ?? null,
        }
      : null,
    avg_7d_hours: round(avg7, 2),
    baseline_hours: round(baseH, 2),
    delta_hours: round(delta, 2),
    avg_7d_score: round(mean(col(week, "sleep_score"))),
    baseline_score: round(mean(col(base, "sleep_score"))),
    short_nights_last_7: short,
    status: avg7 === null ? "no data" : (delta !== null && delta <= -0.75) || short >= 3 ? "low" : "normal",
  };
}
