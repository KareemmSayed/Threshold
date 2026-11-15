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
  baseline_reset: string | null;
  interpretation: string;
}

export interface HrvOptions {
  /** Ignore nights before this date. HRV from different devices is not comparable, so set it when the watch changes. */
  baselineFrom?: string;
  /** Why the baseline restarts there: the owner's setting, or a watch change found in the activity files. */
  baselineReason?: string;
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
    baseline_reset: from ? (opts.baselineReason ?? null) : null,
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

export type Night = Record<string, number | string | null>;

export interface SleepConsistency {
  /** Nights with a recorded bedtime and wake time among the last 14. */
  nights: number;
  avg_bedtime: string;
  avg_wake: string;
  /** Spread (standard deviation) of bedtime and wake time, in minutes. */
  bedtime_sd_min: number;
  wake_sd_min: number;
  regularity: "very regular" | "regular" | "irregular" | "very irregular";
}

export interface SleepReport {
  /** The night that ended on the report date, or null when it is not in the archive (not synced, or the watch was off). */
  last_night: Night | null;
  /** The most recent night in the archive, when that is not last night. */
  latest_night: Night | null;
  avg_7d_hours: number | null;
  baseline_hours: number | null;
  delta_hours: number | null;
  avg_7d_score: number | null;
  baseline_score: number | null;
  short_nights_last_7: number;
  /** Hours slept below the athlete's usual amount over the nights recorded in the last 7 (never negative). */
  sleep_debt_7d_hours: number | null;
  consistency: SleepConsistency | null;
  status: Status;
}

const CONSISTENCY_DAYS = 14;
const MIN_CONSISTENCY_NIGHTS = 5;

/** Minutes after `origin` (minutes past midnight) of a local "YYYY-MM-DDTHH:MM" time, wrapped into one day. */
function minutesAfter(local: unknown, origin: number): number | null {
  const m = typeof local === "string" ? /T(\d{2}):(\d{2})/.exec(local) : null;
  if (!m) return null;
  return (Number(m[1]) * 60 + Number(m[2]) - origin + 1440) % 1440;
}

const clockTime = (minutes: number, origin: number) => {
  const t = (Math.round(minutes) + origin) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * How regular the sleep times are. Bedtimes are measured from noon and wake times from
 * 18:00 the evening before, so a night that crosses midnight stays in one piece.
 */
export function sleepConsistency(rows: DailyRow[], end: string): SleepConsistency | null {
  const NOON = 12 * 60;
  const EVENING = 18 * 60;
  const nights = between(rows, addDays(end, -(CONSISTENCY_DAYS - 1)), end);
  const beds = nights.map((r) => minutesAfter(r.sleep_start_local, NOON)).filter(finite);
  const wakes = nights.map((r) => minutesAfter(r.sleep_end_local, EVENING)).filter(finite);
  if (beds.length < MIN_CONSISTENCY_NIGHTS || wakes.length < MIN_CONSISTENCY_NIGHTS) return null;
  const bedSd = sd(beds) ?? 0;
  return {
    nights: Math.min(beds.length, wakes.length),
    avg_bedtime: clockTime(mean(beds)!, NOON),
    avg_wake: clockTime(mean(wakes)!, EVENING),
    bedtime_sd_min: Math.round(bedSd),
    wake_sd_min: Math.round(sd(wakes) ?? 0),
    regularity: bedSd <= 30 ? "very regular" : bedSd <= 60 ? "regular" : bedSd <= 90 ? "irregular" : "very irregular",
  };
}

export function sleepReport(rows: DailyRow[], end: string): SleepReport {
  const weekStart = addDays(end, -(ROLLING_DAYS - 1));
  const base = between(rows, addDays(weekStart, -BASELINE_DAYS), addDays(weekStart, -1));
  const week = between(rows, weekStart, end);
  const hours = (r: DailyRow[]) => col(r, "sleep_seconds").map((s) => (s === null ? null : s / 3600));
  const latest = [...week].reverse().find((r) => finite(r.sleep_seconds as number));
  const avg7 = mean(hours(week));
  const baseH = hours(base).filter(finite).length >= 7 ? mean(hours(base)) : null;
  const delta = avg7 !== null && baseH !== null ? avg7 - baseH : null;
  const slept = hours(week).filter(finite);
  const short = slept.filter((h) => h < 6).length;
  const min = (s: unknown) => (finite(s as number) ? Math.round((s as number) / 60) : null);
  const night = (r: DailyRow): Night => ({
    date: r.date,
    hours: round((r.sleep_seconds as number) / 3600, 2),
    score: (r.sleep_score as number) ?? null,
    deep_min: min(r.deep_sleep_seconds),
    rem_min: min(r.rem_sleep_seconds),
    light_min: min(r.light_sleep_seconds),
    awake_min: min(r.awake_seconds),
    avg_hr: (r.sleep_avg_hr as number) ?? null,
    stress: (r.sleep_stress as number) ?? null,
    respiration: (r.sleep_respiration as number) ?? null,
    start: (r.sleep_start_local as string) ?? null,
    end: (r.sleep_end_local as string) ?? null,
  });
  return {
    last_night: latest && latest.date === end ? night(latest) : null,
    latest_night: latest && latest.date !== end ? night(latest) : null,
    avg_7d_hours: round(avg7, 2),
    baseline_hours: round(baseH, 2),
    delta_hours: round(delta, 2),
    avg_7d_score: round(mean(col(week, "sleep_score"))),
    baseline_score: round(mean(col(base, "sleep_score"))),
    short_nights_last_7: short,
    sleep_debt_7d_hours: baseH !== null && slept.length ? round(Math.max(0, slept.reduce((a, h) => a + (baseH - h), 0)), 1) : null,
    consistency: sleepConsistency(rows, end),
    status: avg7 === null ? "no data" : (delta !== null && delta <= -0.75) || short >= 3 ? "low" : "normal",
  };
}

/** One overnight signal against its own baseline: the 7-day mean compared with the 60 days before. */
export interface ShiftReport {
  latest: number | null;
  latest_date: string | null;
  rolling_7d: number | null;
  baseline: number | null;
  delta: number | null;
  /** How far the latest night sits from the baseline, in baseline standard deviations. */
  latest_z: number | null;
  nights_in_7d: number;
  status: Status;
}

function shiftReport(rows: DailyRow[], end: string, key: string, minDelta: number, digits: number): ShiftReport {
  const weekStart = addDays(end, -(ROLLING_DAYS - 1));
  const base = col(between(rows, addDays(weekStart, -BASELINE_DAYS), addDays(weekStart, -1)), key).filter(finite);
  const weekRows = between(rows, weekStart, end);
  const week = col(weekRows, key).filter(finite);
  const latest = [...weekRows].reverse().find((r) => finite(r[key] as number));
  const bMean = base.length >= MIN_BASELINE_NIGHTS ? mean(base) : null;
  const bSd = base.length >= MIN_BASELINE_NIGHTS ? sd(base) : null;
  const rolling = week.length >= MIN_WEEK_NIGHTS ? mean(week) : null;
  const delta = rolling !== null && bMean !== null ? rolling - bMean : null;
  const threshold = Math.max(minDelta, bSd ?? 0);
  return {
    latest: (latest?.[key] as number) ?? null,
    latest_date: latest?.date ?? null,
    rolling_7d: round(rolling, digits),
    baseline: round(bMean, digits),
    delta: round(delta, digits),
    latest_z: latest && bMean !== null && bSd ? round(((latest[key] as number) - bMean) / bSd, 2) : null,
    nights_in_7d: week.length,
    status: delta === null ? "no data" : delta >= threshold ? "elevated" : delta <= -threshold ? "low" : "normal",
  };
}

/**
 * Stress during sleep (Garmin's 0-100 score from overnight heart-rate variability). It rises
 * with hard training, alcohol, late meals, heat and illness. Elevated: the 7-day mean is
 * 4 points or one baseline SD above usual, whichever is larger.
 */
export const overnightStressReport = (rows: DailyRow[], end: string): ShiftReport => shiftReport(rows, end, "sleep_stress", 4, 1);

/**
 * Breathing rate during sleep. It barely moves from night to night in a healthy adult, so a
 * sustained rise (0.8 breaths/min or one baseline SD) is an early sign of illness or strain.
 */
export const sleepRespirationReport = (rows: DailyRow[], end: string): ShiftReport => shiftReport(rows, end, "sleep_respiration", 0.8, 1);

export interface IllnessWatch {
  level: "clear" | "watch" | "elevated";
  /** The signals that are off, in words. */
  signals: string[];
  summary: string;
  rule: string;
}

/**
 * The pattern that often comes before or with an illness, or with heavy strain: resting HR
 * and sleep breathing up, overnight stress up, HRV down. Works without HRV. Not a diagnosis.
 */
export function illnessWatch(r: { hrv: HrvReport; rhr: RhrReport; stress: ShiftReport; respiration: ShiftReport }): IllnessWatch {
  const signals: string[] = [];
  const plus = (v: number | null) => (v === null ? "" : ` ${v > 0 ? "+" : ""}${v}`);
  const rhrUp = r.rhr.status === "elevated";
  const respUp = r.respiration.status === "elevated";
  if (rhrUp) signals.push(`resting HR${plus(r.rhr.delta_bpm)} bpm over 7 days`);
  if (respUp) signals.push(`sleep breathing rate${plus(r.respiration.delta)} breaths/min over 7 days`);
  if (r.stress.status === "elevated") signals.push(`overnight stress${plus(r.stress.delta)} over 7 days`);
  if (r.hrv.status_7d === "low" || r.hrv.status_7d === "slightly low") signals.push(`HRV ${r.hrv.status_7d}`);
  // One night can be enough when breathing rate and resting HR jump together.
  const acute = (r.respiration.latest_z ?? 0) >= 2 && r.rhr.latest_bpm !== null && r.rhr.baseline_bpm !== null && r.rhr.latest_bpm - r.rhr.baseline_bpm >= 5;
  if (acute && !(rhrUp && respUp)) signals.push("the latest night: breathing rate and resting HR both well above usual");
  const level = acute || (signals.length >= 2 && (rhrUp || respUp)) ? "elevated" : signals.length ? "watch" : "clear";
  return {
    level,
    signals,
    summary:
      level === "elevated"
        ? "Several overnight signals moved together. This pattern often comes before or with an illness, or with heavy strain: ease off and watch how you feel."
        : level === "watch"
          ? "One overnight signal is off. Common after hard training, alcohol, heat or a late meal; watch whether a second one joins it."
          : "Overnight signals are in their usual range.",
    rule: "elevated: 2+ signals off including resting HR or sleep breathing rate, or both jumped on the latest night; watch: 1 signal off. Not a diagnosis.",
  };
}
