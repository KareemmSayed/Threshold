/**
 * Recovery signals against your own baseline.
 *
 * HRV follows the approach used in HRV research (Plews, Buchheit, Kiviniemi):
 * work on the natural log of the nightly value, compare the 7-day rolling mean
 * with a 60-day baseline, and treat +/- 0.5 SD of the baseline as the normal
 * band (the smallest worthwhile change). The nightly value is Garmin's overnight
 * HRV average. Garmin does not document how it is computed and Threshold never
 * sees the beat-to-beat intervals, so it is not recomputed or checked as rMSSD.
 * Resting HR and sleep are compared with the same baseline window.
 */
import type { DailyRow } from "../archive/store";
import { addDays } from "../util/dates";
import { finite, linearTrend, mean, round, sd } from "./stats";

export const BASELINE_DAYS = 60;
const ROLLING_DAYS = 7;
/** Fewer nights than this in the 7-day window gives no rolling mean at all. */
const MIN_WEEK_NIGHTS = 3;
/** Fewer nights than this in the 7-day window caps the verdict at "slightly". */
const GOOD_WEEK_NIGHTS = 5;
const MIN_BASELINE_NIGHTS = 14;

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
  /** Nights with HRV among the last 7. The rolling mean needs 3; fewer than 5 caps the verdict. */
  nights_in_7d: number;
  confidence: "good" | "low" | null;
  /** First night used, when the baseline was reset (new device). */
  baseline_from: string | null;
  interpretation: string;
}

export interface HrvOptions {
  /** Ignore nights before this date. HRV from different devices is not comparable, so set it when the watch changes. */
  baselineFrom?: string;
}

export function hrvReport(allRows: DailyRow[], end: string, opts: HrvOptions = {}): HrvReport {
  const from = opts.baselineFrom ?? null;
  const rows = from ? allRows.filter((r) => r.date >= from) : allRows;
  const weekStart = addDays(end, -(ROLLING_DAYS - 1));
  const baseRows = between(rows, addDays(weekStart, -BASELINE_DAYS), addDays(weekStart, -1));
  const weekRows = between(rows, weekStart, end);
  const ln = (v: number | null) => (v && v > 0 ? Math.log(v) : null);
  const baseLn = col(baseRows, "hrv_ms").map(ln).filter(finite);
  const weekLn = col(weekRows, "hrv_ms").map(ln).filter(finite);
  const latest = [...weekRows].reverse().find((r) => finite(r.hrv_ms as number));
  const bMean = baseLn.length >= MIN_BASELINE_NIGHTS ? mean(baseLn) : null;
  const bSd = baseLn.length >= MIN_BASELINE_NIGHTS ? sd(baseLn) : null;
  const swc = bSd ? 0.5 * bSd : null;
  const rolling = weekLn.length >= MIN_WEEK_NIGHTS ? mean(weekLn) : null;

  // Without a baseline there is nothing to judge against, so no verdict.
  let status: Status = "no data";
  if (rolling !== null && bMean !== null) {
    status = !swc
      ? "normal"
      : rolling < bMean - 2 * swc ? "low" : rolling < bMean - swc ? "slightly low" : rolling > bMean + 2 * swc ? "high" : rolling > bMean + swc ? "slightly high" : "normal";
  }
  const thin = rolling !== null && weekLn.length < GOOD_WEEK_NIGHTS;
  const capped = thin && (status === "low" || status === "high");
  if (capped) status = status === "low" ? "slightly low" : "slightly high";

  const lastLn = ln((latest?.hrv_ms as number) ?? null);
  const z = lastLn !== null && bMean !== null && bSd ? (lastLn - bMean) / bSd : null;
  const below = bMean !== null && swc ? weekLn.filter((v) => v < bMean - swc).length : 0;
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
  const thinNote = thin
    ? ` Only ${weekLn.length} of ${ROLLING_DAYS} nights have HRV, so treat this as less certain${capped ? `; the verdict is capped at "${status}"` : ""}.`
    : "";
  const interpretation =
    rolling === null
      ? "Not enough overnight HRV readings yet. HRV needs the watch worn overnight; Garmin's baseline needs about 3 weeks."
      : bMean === null
        ? `Fewer than ${MIN_BASELINE_NIGHTS} nights before this week${from ? ` since ${from}` : ""}, so no personal baseline yet; values are shown without a verdict.`
        : status === "normal"
          ? `The 7-day HRV average sits inside your normal band: no sign of accumulated stress.${thinNote}`
          : status.includes("low")
            ? `The 7-day HRV average is below your normal band. Common causes: hard training block, poor sleep, illness, alcohol, travel or life stress. Favour easy days until it returns.${thinNote}`
            : `The 7-day HRV average is above your normal band. Usually good recovery; a sudden jump with fatigue can also mean heavy fatigue in trained athletes.${thinNote}`;

  return {
    last_night_ms: (latest?.hrv_ms as number) ?? null,
    last_night_date: latest?.date ?? null,
    rolling_7d_ms: rolling !== null ? round(Math.exp(rolling)) : null,
    baseline_ms: bMean !== null ? round(Math.exp(bMean)) : null,
    normal_range_ms: bMean !== null && swc ? [round(Math.exp(bMean - swc))!, round(Math.exp(bMean + swc))!] : null,
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
    nights_in_7d: weekLn.length,
    confidence: rolling === null ? null : thin ? "low" : "good",
    baseline_from: from,
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
