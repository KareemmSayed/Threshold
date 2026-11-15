/**
 * Compare a workout with earlier ones of the same kind.
 *
 * "Am I getting faster?" is only a fair question between like sessions: the same reps,
 * or a steady run of about the same length. This lines them up and reports the change in
 * pace, heart rate and speed per heartbeat.
 */
import type { ActivityRow } from "../archive/store";
import { STEADY_TYPES } from "../fit/intervals";
import { daysBetween } from "../util/dates";
import { finite, linearTrend, mean, round } from "./stats";

export interface Match {
  /** SQL condition and its bindings, selecting sessions like the reference. */
  where: string;
  binds: unknown[];
  /** What the match is based on, in words. */
  basis: string;
}

/** How to find sessions like this one, or null when there is nothing to match on. */
export function matchFor(ref: ActivityRow): Match | null {
  if (ref.workout_type === "intervals") {
    if (finite(ref.rep_distance_m) && ref.rep_distance_m > 0) {
      return {
        where: `workout_type = 'intervals' AND rep_distance_m BETWEEN ? AND ?`,
        binds: [ref.rep_distance_m * 0.94, ref.rep_distance_m * 1.06],
        basis: `interval sessions with reps of about ${ref.rep_distance_m} m`,
      };
    }
    if (finite(ref.rep_time_s) && ref.rep_time_s > 0) {
      return {
        where: `workout_type = 'intervals' AND rep_distance_m IS NULL AND rep_time_s BETWEEN ? AND ?`,
        binds: [ref.rep_time_s * 0.9, ref.rep_time_s * 1.1],
        basis: `interval sessions with reps of about ${Math.round(ref.rep_time_s)} s`,
      };
    }
    return null;
  }
  if (!ref.workout_type || !STEADY_TYPES.has(ref.workout_type)) return null;
  const steady = [...STEADY_TYPES].map((t) => `'${t}'`).join(", ");
  if (finite(ref.distance_m) && ref.distance_m > 0) {
    return {
      where: `workout_type IN (${steady}) AND distance_m BETWEEN ? AND ?`,
      binds: [ref.distance_m * 0.85, ref.distance_m * 1.15],
      basis: `steady sessions of ${round(ref.distance_m * 0.85 / 1000, 1)} to ${round(ref.distance_m * 1.15 / 1000, 1)} km`,
    };
  }
  if (finite(ref.duration_s) && ref.duration_s > 0) {
    return {
      where: `workout_type IN (${steady}) AND duration_s BETWEEN ? AND ?`,
      binds: [ref.duration_s * 0.85, ref.duration_s * 1.15],
      basis: "steady sessions of about the same duration",
    };
  }
  return null;
}

export interface Line {
  activity_id: number;
  date: string | null;
  workout: string | null;
  /** Work speed for intervals (reps only), average moving speed otherwise. m/s. */
  speed_mps: number | null;
  /** Work heart rate for intervals, average heart rate otherwise. */
  hr: number | null;
  /** Meters per minute per heartbeat: higher means more speed for the same effort. */
  speed_per_beat: number | null;
  rep_count: number | null;
  rest_s: number | null;
  max_hr: number | null;
  decoupling_pct: number | null;
  temp_c: number | null;
  vo2max: number | null;
}

export function lineOf(a: ActivityRow): Line {
  const intervals = a.workout_type === "intervals";
  const moving = a.moving_s ?? a.duration_s;
  const speed = intervals ? a.work_speed_mps : (a.avg_speed_mps ?? (a.distance_m && moving ? a.distance_m / moving : null));
  const hr = intervals ? a.work_hr : a.avg_hr;
  return {
    activity_id: a.activity_id,
    date: a.date,
    workout: a.workout_structure ?? a.workout_type,
    speed_mps: finite(speed) ? speed : null,
    hr: finite(hr) ? Math.round(hr) : null,
    speed_per_beat: finite(speed) && finite(hr) && hr > 0 ? round((speed * 60) / hr, 3) : null,
    rep_count: a.rep_count,
    rest_s: a.rest_s,
    max_hr: a.fit_max_hr,
    decoupling_pct: intervals ? null : a.decoupling_pct,
    temp_c: a.avg_temp_c,
    vo2max: a.vo2max ?? a.fit_vo2max,
  };
}

export interface Change {
  /** Percent change in speed (positive = faster). */
  speed_pct: number | null;
  hr_bpm: number | null;
  /** Percent change in speed per heartbeat (positive = fitter at the same effort). */
  speed_per_beat_pct: number | null;
}

const pct = (from: number | null, to: number | null) => (finite(from) && finite(to) && from !== 0 ? round(((to - from) / from) * 100, 1) : null);

export function changeFrom(base: Pick<Line, "speed_mps" | "hr" | "speed_per_beat">, ref: Line): Change {
  return {
    speed_pct: pct(base.speed_mps, ref.speed_mps),
    hr_bpm: finite(base.hr) && finite(ref.hr) ? round(ref.hr - base.hr, 0) : null,
    speed_per_beat_pct: pct(base.speed_per_beat, ref.speed_per_beat),
  };
}

export interface Comparison {
  vs_previous: (Change & { date: string | null; days_before: number | null }) | null;
  vs_average_of_others: (Change & { sessions: number }) | null;
  /** Change in speed per heartbeat per 30 days across all matched sessions; null below 4 sessions. */
  speed_per_beat_trend_pct_per_30d: number | null;
  verdict: string;
}

/** `others` are earlier sessions of the same kind, newest first. */
export function compare(ref: Line, others: Line[]): Comparison {
  const prev = others[0] ?? null;
  const average = {
    speed_mps: mean(others.map((o) => o.speed_mps)),
    hr: mean(others.map((o) => o.hr)),
    speed_per_beat: mean(others.map((o) => o.speed_per_beat)),
  };
  // Speed per heartbeat over time, oldest first.
  const dated = [...others, ref].filter((l): l is Line & { date: string; speed_per_beat: number } => l.date !== null && finite(l.speed_per_beat));
  const first = dated.reduce<string | null>((d, l) => (d === null || l.date < d ? l.date : d), null);
  const trend = first && dated.length >= 4 ? linearTrend(dated.map((l): [number, number] => [daysBetween(first, l.date), l.speed_per_beat])) : null;
  const level = mean(dated.map((l) => l.speed_per_beat));
  const vsAverage = others.length ? { ...changeFrom(average, ref), sessions: others.length } : null;

  let verdict = "No earlier session of this kind to compare with.";
  if (vsAverage) {
    const e = vsAverage.speed_per_beat_pct;
    const s = vsAverage.speed_pct;
    const h = vsAverage.hr_bpm;
    if (e === null) verdict = s === null ? "The earlier sessions lack the numbers to compare." : `${Math.abs(s)}% ${s >= 0 ? "faster" : "slower"} than the average of ${others.length} earlier session${others.length === 1 ? "" : "s"}; no heart rate to judge the effort.`;
    else if (e >= 2) verdict = `Fitter: ${e}% more speed per heartbeat than the average of ${others.length} earlier session${others.length === 1 ? "" : "s"}${s !== null && h !== null ? ` (speed ${s >= 0 ? "+" : ""}${s}%, heart rate ${h >= 0 ? "+" : ""}${h} bpm)` : ""}.`;
    else if (e <= -2) verdict = `Harder for the same speed: ${Math.abs(e)}% less speed per heartbeat than the average of ${others.length} earlier session${others.length === 1 ? "" : "s"}. Heat, fatigue and a faster start all do this.`;
    else verdict = `In line with the earlier sessions (speed per heartbeat within ${Math.abs(e)}%).`;
  }
  return {
    vs_previous: prev ? { ...changeFrom(prev, ref), date: prev.date, days_before: prev.date && ref.date ? daysBetween(prev.date, ref.date) : null } : null,
    vs_average_of_others: vsAverage,
    speed_per_beat_trend_pct_per_30d: trend && level ? round(((trend.slopePerDay * 30) / level) * 100, 1) : null,
    verdict,
  };
}
