/**
 * Activity analysis from a decoded FIT file. Code computes every number here;
 * the model only explains them.
 */
import { sportOf } from "../archive/flatten";
import type { FitFile, Fields, Records } from "./decode";
import { classifyWorkout, detectIntervals, isEndurance, pacingVerdict, STEADY_TYPES, summarizeIntervals, type IntervalSource, type IntervalSummary, type WorkoutType } from "./intervals";
import { ENUMS } from "./profile";

export interface AnalyzeOptions {
  /** Garmin HR zone floors (zone 1..5) in bpm, from the profile. Used when the file has no zone data. */
  hrZoneFloors?: number[];
  /** Functional threshold power for IF/TSS; the file's own value wins. */
  ftp?: number;
  /** Split length. */
  splitUnit?: "km" | "mi";
  /** Evenly spaced samples to return (0 = none). */
  samples?: number;
  /** Return downsampled GPS coordinates. Off by default for privacy. */
  route?: boolean;
  /** Return every field of the undocumented physiology message. */
  rawHidden?: boolean;
}

const MILE_M = 1609.344;
const GAP_S = 10; // longer gaps between samples count as pauses

/** [label, meters, fastest believable seconds]. Foot and swim limits sit just under the world records; bikes allow 90 km/h. */
export type DistanceEffort = [label: string, meters: number, fastestS?: number];

const FOOT: Record<string, DistanceEffort> = {
  "200m": ["200m", 200, 19],
  "400m": ["400m", 400, 43],
  "800m": ["800m", 800, 100],
  "1k": ["1k", 1000, 131],
  "1500m": ["1500m", 1500, 205],
  "1mi": ["1mi", MILE_M, 223],
  "3k": ["3k", 3000, 437],
  "5k": ["5k", 5000, 755],
  "10k": ["10k", 10000, 1571],
  half: ["half", 21097.5, 3402],
  marathon: ["marathon", 42195, 7235],
};

export const DISTANCE_EFFORTS: Record<string, DistanceEffort[]> = {
  running: Object.values(FOOT),
  walking: [FOOT["1k"], FOOT["5k"]],
  hiking: [FOOT["1k"], FOOT["5k"], FOOT["10k"]],
  cycling: [
    ["10k_bike", 10000, 400],
    ["20k_bike", 20000, 800],
    ["40k_bike", 40000, 1600],
    ["100k_bike", 100000, 4000],
  ],
  swimming: [
    ["100m_swim", 100, 44],
    ["400m_swim", 400, 212],
    ["1500m_swim", 1500, 840],
  ],
};

/**
 * Fastest believable speed for one distance step, measured from the last time the
 * distance changed (pool swims step a length at a time). A faster step is a GPS glitch.
 */
export const MAX_STEP_MPS: Record<string, number> = { running: 12, walking: 12, hiking: 12, cycling: 35, swimming: 5 };

/** Meters of each distance effort, by label, across sports. */
export const EFFORT_METERS: Record<string, number> = Object.fromEntries(
  Object.values(DISTANCE_EFFORTS)
    .flat()
    .map(([label, meters]) => [label, meters]),
);

/** Windows for the highest average heart rate; archived as '5min_hr', '20min_hr', '60min_hr'. */
export const HR_PEAK_DURATIONS: Array<[string, number]> = [
  ["5min", 300],
  ["20min", 1200],
  ["60min", 3600],
];

export const POWER_DURATIONS: Array<[string, number]> = [
  ["5s", 5],
  ["15s", 15],
  ["30s", 30],
  ["1min", 60],
  ["5min", 300],
  ["10min", 600],
  ["20min", 1200],
  ["30min", 1800],
  ["60min", 3600],
];

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** "7h 32m" for durations measured in hours. */
export function hoursMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Pace string for a speed in m/s, per km or mile. */
export function pace(speedMps: number | null | undefined, unit: "km" | "mi" = "km"): string | null {
  if (!fin(speedMps) || speedMps <= 0.1) return null;
  return `${formatDuration((unit === "km" ? 1000 : MILE_M) / speedMps)}/${unit}`;
}

function mean(values: ArrayLike<number>, from = 0, to = values.length): number {
  let sum = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const v = values[i];
    if (v === v) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : NaN;
}

const HR_MIN = 30;
const HR_MAX = 230;
/** Fastest change a heart makes, in bpm per second, and the slack allowed on top of it. */
const HR_SLEW_BPM_S = 3;
const HR_SLACK_BPM = 8;

/**
 * Heart rate with the readings no heart produces removed: values outside 30 to 230 bpm,
 * and jumps faster than the heart can change (a strap losing contact, an optical sensor
 * locking on for a few seconds). A jump that lasts is accepted after about 20 s, because
 * then the earlier readings were the wrong ones.
 */
export function cleanHeartRate(time: Float64Array, hr: Float64Array): { hr: Float64Array; removed: number } {
  const out = new Float64Array(hr.length).fill(NaN);
  // Start from the median of the first readings, so an opening spike is not taken as the truth.
  const head: number[] = [];
  for (let i = 0; i < hr.length && head.length < 15; i++) if (hr[i] >= HR_MIN && hr[i] <= HR_MAX) head.push(hr[i]);
  head.sort((a, b) => a - b);
  let ref = head.length ? head[head.length >> 1] : NaN;
  let refT = NaN;
  let removed = 0;
  for (let i = 0; i < hr.length; i++) {
    const v = hr[i];
    if (v !== v) continue;
    if (v < HR_MIN || v > HR_MAX) {
      removed++;
      continue;
    }
    if (refT !== refT) refT = time[i];
    if (Math.abs(v - ref) > HR_SLACK_BPM + HR_SLEW_BPM_S * Math.max(1, time[i] - refT)) {
      removed++;
      continue;
    }
    out[i] = v;
    ref = v;
    refT = time[i];
  }
  return { hr: out, removed };
}

/** Energy cost of running on a slope relative to flat ground (Minetti et al. 2002); grade as a fraction. */
export function slopeCost(grade: number): number {
  const g = Math.max(-0.3, Math.min(0.3, grade));
  return (155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6) / 3.6;
}

const GRADE_WINDOW_M = 40;

/**
 * Grade-adjusted speed: the flat-ground speed that costs the same energy as each sample's
 * speed on its slope. The slope is measured over the last 40 m to steady the altitude.
 */
export function gradeAdjustedSpeed(rec: Records): Float64Array {
  const n = rec.length;
  const out = new Float64Array(n);
  const d = new Float64Array(n);
  const alt = new Float64Array(n);
  const at = new Int32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    out[i] = rec.speed[i];
    if (rec.distance[i] === rec.distance[i] && rec.altitude[i] === rec.altitude[i]) {
      d[m] = rec.distance[i];
      alt[m] = rec.altitude[i];
      at[m++] = i;
    }
  }
  let lo = 0;
  for (let k = 1; k < m; k++) {
    while (lo + 1 < k && d[k] - d[lo + 1] >= GRADE_WINDOW_M) lo++;
    const run = d[k] - d[lo];
    const v = rec.speed[at[k]];
    if (v === v && run >= GRADE_WINDOW_M / 2) out[at[k]] = v * slopeCost((alt[k] - alt[lo]) / run);
  }
  return out;
}

/**
 * How uneven the moving speed (or power) is: about 0.1 on a steady run, above 0.3 with
 * reps, stops or steep terrain. Null when there is too little to judge.
 */
export function outputVariation(output: ArrayLike<number>, movingFloor: number): number | null {
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < output.length; i++) {
    const o = output[i];
    if (o !== o || o < movingFloor) continue;
    n++;
    sum += o;
    sq += o * o;
  }
  if (n < 60 || sum <= 0) return null;
  const m = sum / n;
  return Math.sqrt(Math.max(0, sq / n - m * m)) / m;
}

/** Resample a column onto a 1 Hz grid from the first sample. Gaps longer than GAP_S become `gapValue`. */
export function resample1Hz(rec: Records, col: Exclude<keyof Records, "length">, gapValue: number): Float64Array {
  const n = rec.length;
  if (n < 2) return new Float64Array(0);
  const t0 = rec.time[0];
  const total = Math.max(0, Math.floor(rec.time[n - 1] - t0)) + 1;
  const out = new Float64Array(Math.min(total, 24 * 3600 * 2)).fill(gapValue);
  const src = rec[col];
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (v !== v) continue;
    const start = Math.floor(rec.time[i] - t0);
    const next = i + 1 < n ? Math.floor(rec.time[i + 1] - t0) : start + 1;
    const stop = Math.min(next - start > GAP_S ? start + 1 : next, out.length);
    for (let s = Math.max(0, start); s < stop; s++) out[s] = v;
  }
  return out;
}

/** Best average of a 1 Hz series over each window length. NaN windows are skipped. */
export function bestAverages(series: Float64Array, durations: Array<[string, number]>): Record<string, number> {
  const n = series.length;
  const prefix = new Float64Array(n + 1);
  const missing = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = series[i];
    prefix[i + 1] = prefix[i] + (v === v ? v : 0);
    missing[i + 1] = missing[i] + (v === v ? 0 : 1);
  }
  const out: Record<string, number> = {};
  for (const [label, d] of durations) {
    if (d > n) continue;
    let best = -Infinity;
    for (let i = 0; i + d <= n; i++) {
      if (missing[i + d] - missing[i] > d * 0.05) continue;
      const avg = (prefix[i + d] - prefix[i]) / (d - (missing[i + d] - missing[i]));
      if (avg > best) best = avg;
    }
    if (best > -Infinity) out[label] = Math.round(best);
  }
  return out;
}

/** Calls `visit(i, j, seconds)` with the shortest window ending at each sample j that covers `target` meters. */
function eachWindow(t: number[], d: number[], target: number, visit: (i: number, j: number, seconds: number) => void): void {
  let i = 0;
  for (let j = 1; j < d.length; j++) {
    while (i + 1 < j && d[j] - d[i + 1] >= target) i++;
    const covered = d[j] - d[i];
    // Scale to the exact distance; samples rarely land on it.
    if (covered >= target) visit(i, j, ((t[j] - t[i]) * target) / covered);
  }
}

/**
 * Fastest time over each distance, from the cumulative distance stream.
 * Distance steps faster than `maxStepMps` are dropped (GPS spikes). Any window
 * faster than an effort's believable limit marks its stretch as bad (a car, a
 * train, GPS drift), and no effort may cross a bad stretch.
 */
export function bestDistanceEfforts(rec: Records, efforts: DistanceEffort[], maxStepMps = Infinity): Record<string, { time_s: number; start_offset_s: number }> {
  const t: number[] = [];
  const d: number[] = [];
  let prev = NaN; // last raw distance that changed, and when
  let prevT = NaN;
  let clean = 0;
  for (let i = 0; i < rec.length; i++) {
    const dist = rec.distance[i];
    if (dist !== dist) continue;
    if (dist !== prev) {
      const step = dist - prev;
      // Backward steps and impossible jumps add no distance; the time still counts.
      if (step > 0 && step <= maxStepMps * (rec.time[i] - prevT)) clean += step;
      prev = dist;
      prevT = rec.time[i];
    }
    t.push(rec.time[i]);
    d.push(clean);
  }
  const out: Record<string, { time_s: number; start_offset_s: number }> = {};
  if (d.length < 2) return out;
  const total = d[d.length - 1];
  // Step k joins samples k and k + 1. Mark the steps of every impossible window
  // (a difference array), then turn bad[k] into the count of bad steps before sample k.
  const bad = new Int32Array(d.length);
  for (const [, target, fastest] of efforts) {
    if (fastest === undefined || total < target) continue;
    eachWindow(t, d, target, (i, j, seconds) => {
      if (seconds < fastest) {
        bad[i]++;
        bad[j]--;
      }
    });
  }
  let flagged = 0;
  for (let k = 0, open = 0; k < bad.length; k++) {
    open += bad[k];
    bad[k] = flagged;
    if (open > 0) flagged++;
  }
  for (const [label, target] of efforts) {
    if (total < target) continue;
    let best = Infinity;
    let bestStart = 0;
    eachWindow(t, d, target, (i, j, seconds) => {
      if (seconds < best && bad[j] === bad[i]) {
        best = seconds;
        bestStart = t[i] - t[0];
      }
    });
    if (best < Infinity) out[label] = { time_s: Math.round(best), start_offset_s: Math.round(bestStart) };
  }
  return out;
}

/** Normalized power: 30 s rolling mean, fourth power, mean, fourth root. */
export function normalizedPower(power1Hz: Float64Array): number | null {
  if (power1Hz.length < 60) return null;
  let window = 0;
  let sum4 = 0;
  let n = 0;
  for (let i = 0; i < power1Hz.length; i++) {
    window += power1Hz[i] === power1Hz[i] ? power1Hz[i] : 0;
    if (i >= 30) window -= power1Hz[i - 30] === power1Hz[i - 30] ? power1Hz[i - 30] : 0;
    if (i >= 29) {
      sum4 += (window / 30) ** 4;
      n++;
    }
  }
  return n ? Math.round((sum4 / n) ** 0.25) : null;
}

export interface Durability {
  decoupling_pct: number;
  cardiac_drift_pct: number;
  output: "power" | "speed" | "grade-adjusted speed";
  first_half: { avg_hr: number; avg_output: number; efficiency: number };
  second_half: { avg_hr: number; avg_output: number; efficiency: number };
  verdict: string;
  caveats: string[];
}

/**
 * Aerobic decoupling (Pa:HR / Pw:HR): how much output per heartbeat falls from
 * the first half to the second. Below 5% on a steady effort means good aerobic
 * durability. The first 10 minutes are skipped as warm-up. On a hilly run pass the
 * grade-adjusted speed, so climbs and descents do not pass for fatigue.
 */
export function durability(rec: Records, sport: string, adjusted?: Float64Array | null): Durability | null {
  const usePower = sport === "cycling" && mean(rec.power) > 0;
  const output = usePower ? rec.power : (adjusted ?? rec.speed);
  const moving: number[] = [];
  const t0 = rec.time[0];
  for (let i = 0; i < rec.length; i++) {
    if (rec.time[i] - t0 < 600) continue;
    const hr = rec.hr[i];
    const o = output[i];
    if (hr !== hr || o !== o || hr < 60) continue;
    if (!usePower && o < 0.5) continue; // standing still
    moving.push(i);
  }
  if (moving.length < 2) return null;
  const span = rec.time[moving[moving.length - 1]] - rec.time[moving[0]];
  if (span < 20 * 60) return null;
  const mid = rec.time[moving[0]] + span / 2;
  const halves = [[], []] as [number[], number[]];
  for (const i of moving) halves[rec.time[i] < mid ? 0 : 1].push(i);
  const stats = halves.map((idx) => {
    let hr = 0;
    let o = 0;
    for (const i of idx) {
      hr += rec.hr[i];
      o += output[i];
    }
    return { avg_hr: hr / idx.length, avg_output: o / idx.length };
  });
  const ef = stats.map((s) => s.avg_output / s.avg_hr);
  const decoupling = ((ef[0] - ef[1]) / ef[0]) * 100;
  const drift = ((stats[1].avg_hr - stats[0].avg_hr) / stats[0].avg_hr) * 100;

  const caveats: string[] = [];
  let sum = 0;
  let sq = 0;
  for (const i of moving) {
    sum += output[i];
    sq += output[i] ** 2;
  }
  const m = sum / moving.length;
  const cv = Math.sqrt(Math.max(0, sq / moving.length - m * m)) / m;
  if (cv > 0.3) caveats.push("Output varied a lot (intervals, stops or terrain), so decoupling is less meaningful than on a steady effort.");
  if (!usePower && !adjusted) {
    let gain = 0;
    for (let i = 1; i < rec.length; i++) {
      const d = rec.altitude[i] - rec.altitude[i - 1];
      if (d > 0) gain += d;
    }
    const km = (rec.distance[rec.length - 1] - rec.distance[0]) / 1000;
    if (km > 0 && gain / km > 15) caveats.push("Hilly route: speed is not grade-adjusted, so hills distort the halves.");
  }
  const abs = Math.abs(decoupling);
  const verdict =
    decoupling < -5
      ? "Output per heartbeat rose in the second half; the first half was likely easier or still warming up."
      : abs < 5
        ? "Under 5%: heart rate and output stayed coupled. Good aerobic durability at this effort."
        : decoupling < 10
          ? "5-10%: moderate drift. Common on long or warm efforts; aerobic durability has room to improve."
          : "Over 10%: strong drift. Heat, dehydration, fatigue, or an effort above aerobic threshold.";
  const round = (s: { avg_hr: number; avg_output: number }, e: number) => ({
    avg_hr: r1(s.avg_hr),
    avg_output: usePower ? Math.round(s.avg_output) : r2(s.avg_output),
    efficiency: Math.round(e * 10000) / 10000,
  });
  return {
    decoupling_pct: r1(decoupling),
    cardiac_drift_pct: r1(drift),
    output: usePower ? "power" : adjusted ? "grade-adjusted speed" : "speed",
    first_half: round(stats[0], ef[0]),
    second_half: round(stats[1], ef[1]),
    verdict,
    caveats,
  };
}

export interface Split {
  split: number;
  distance_km: number;
  time: string;
  pace: string | null;
  avg_hr: number | null;
  elevation_gain_m: number;
  /** Grade-adjusted pace; present on hilly runs only. */
  gap_pace?: string | null;
}

export function splits(rec: Records, unit: "km" | "mi", adjusted?: Float64Array | null): Split[] {
  const len = unit === "km" ? 1000 : MILE_M;
  const out: Split[] = [];
  let startIdx = -1;
  let startT = 0;
  let startD = 0;
  for (let i = 0; i < rec.length && out.length < 200; i++) {
    const d = rec.distance[i];
    if (d !== d) continue;
    if (startIdx < 0) {
      startIdx = i;
      startT = rec.time[i];
      startD = d;
      continue;
    }
    const isLast = i === rec.length - 1;
    if (d - startD >= len || isLast) {
      const covered = d - startD;
      if (covered < len * 0.05 && isLast) break;
      let hr = 0;
      let n = 0;
      let gain = 0;
      let raw = 0;
      let flat = 0;
      for (let k = startIdx; k <= i; k++) {
        if (rec.hr[k] === rec.hr[k]) {
          hr += rec.hr[k];
          n++;
        }
        if (k > startIdx) {
          const dz = rec.altitude[k] - rec.altitude[k - 1];
          if (dz > 0) gain += dz;
        }
        if (adjusted && rec.speed[k] === rec.speed[k] && adjusted[k] === adjusted[k]) {
          raw += rec.speed[k];
          flat += adjusted[k];
        }
      }
      const time = rec.time[i] - startT;
      const split: Split = {
        split: out.length + 1,
        distance_km: r2(covered / 1000),
        time: formatDuration(time),
        pace: pace(covered / time, unit),
        avg_hr: n ? Math.round(hr / n) : null,
        elevation_gain_m: Math.round(gain),
      };
      if (adjusted) split.gap_pace = raw > 0 ? pace((covered / time) * (flat / raw), unit) : null;
      out.push(split);
      startIdx = i;
      startT = rec.time[i];
      startD = d;
    }
  }
  return out;
}

export interface HiddenMetrics {
  vo2max?: number;
  performance_condition?: { first?: number; final?: number; min?: number; max?: number };
  experimental?: Record<string, { value: number; note: string }>;
  raw?: Array<Record<number, number | number[]>>;
  note: string;
}

/**
 * Metrics Garmin writes into the FIT file but leaves out of the API JSON.
 * Message 140 is undocumented; the field meanings come from community
 * decoding (Garmin forums, intervals.icu, Runalyze) and are labelled so.
 */
export function hiddenMetrics(fit: FitFile, includeRaw = false): HiddenMetrics {
  const out: HiddenMetrics = { note: "" };
  const phys = fit.physiology[fit.physiology.length - 1];
  if (phys) {
    const vo2 = phys[7];
    if (fin(vo2)) {
      const v = (vo2 * 3.5) / 65536;
      if (v > 15 && v < 100) out.vo2max = r1(v);
    }
    const experimental: Record<string, { value: number; note: string }> = {};
    if (fin(phys[9]) && phys[9] > 0) experimental.recovery_time = { value: phys[9], note: "Message 140 field 9; community reports minutes of recovery. Unverified." };
    if (fin(phys[17]) && phys[17] !== 0) experimental.final_performance_condition = { value: phys[17], note: "Message 140 field 17. Unverified." };
    if (fin(phys[4]) && phys[4] > 0) experimental.aerobic_load = { value: phys[4], note: "Message 140 field 4; community reports aerobic load. Unverified." };
    if (Object.keys(experimental).length) out.experimental = experimental;
    if (includeRaw) out.raw = fit.physiology;
  }
  const pc = fit.records.performanceCondition;
  let first: number | undefined;
  let last: number | undefined;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pc.length; i++) {
    const v = pc[i];
    if (v !== v || v < -30 || v > 30) continue;
    first ??= v;
    last = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (first !== undefined) out.performance_condition = { first, final: last, min, max };
  out.note =
    phys || first !== undefined
      ? "Decoded from Garmin's undocumented FIT data. VO2 max uses the widely confirmed field 7 x 3.5 / 65536; other fields are experimental."
      : "This file has no undocumented physiology data. Garmin may strip it from API downloads, or the device does not record it for this sport.";
  return out;
}

function sessionSummary(s: Fields, sport: string, splitUnit: "km" | "mi") {
  const num = (k: string) => (fin(s[k]) ? (s[k] as number) : undefined);
  const speed = [num("enhancedAvgSpeed"), num("avgSpeed")].find((v) => v !== undefined && v > 0);
  const maxSpeed = [num("enhancedMaxSpeed"), num("maxSpeed")].find((v) => v !== undefined && v > 0);
  const cadence = num("avgCadence");
  const frac = num("avgFractionalCadence") ?? 0;
  const timer = num("totalTimerTime");
  const out: Record<string, unknown> = {
    sport: s.sport,
    sub_sport: s.subSport !== "generic" ? s.subSport : undefined,
    profile: s.sportProfileName,
    start: s.startTime,
    duration: timer !== undefined ? formatDuration(timer) : undefined,
    elapsed: num("totalElapsedTime") !== undefined ? formatDuration(num("totalElapsedTime")!) : undefined,
    distance_km: num("totalDistance") !== undefined ? r2(num("totalDistance")! / 1000) : undefined,
    avg_pace: sport === "running" || sport === "walking" || sport === "hiking" ? pace(speed, splitUnit) : undefined,
    avg_speed_kmh: speed !== undefined ? r1(speed * 3.6) : undefined,
    max_speed_kmh: maxSpeed !== undefined ? r1(maxSpeed * 3.6) : undefined,
    avg_gap_pace: sport === "running" ? pace(num("avgGradeAdjustedSpeed"), splitUnit) : undefined,
    avg_hr: num("avgHeartRate"),
    max_hr: num("maxHeartRate"),
    avg_power_w: num("avgPower"),
    max_power_w: num("maxPower"),
    normalized_power_w: num("normalizedPower"),
    // Running cadence in FIT is per leg; Garmin shows steps per minute.
    avg_cadence: cadence !== undefined ? (sport === "running" ? Math.round((cadence + frac) * 2) : cadence) : undefined,
    ascent_m: num("totalAscent"),
    descent_m: num("totalDescent"),
    calories: num("totalCalories"),
    aerobic_te: num("totalTrainingEffect"),
    anaerobic_te: num("totalAnaerobicTrainingEffect"),
    exercise_load: num("trainingLoadPeak") !== undefined ? Math.round(num("trainingLoadPeak")!) : undefined,
    training_stress_score: num("trainingStressScore"),
    intensity_factor: num("intensityFactor"),
    avg_temperature_c: num("avgTemperature"),
    avg_respiration: num("enhancedAvgRespirationRate"),
    avg_spo2_pct: num("avgSpo2"),
    avg_stress: num("avgStress"),
    rmssd_hrv_ms: num("rmssdHrv"),
    workout_feel: num("workoutFeel"),
    workout_rpe: num("workoutRpe") !== undefined ? num("workoutRpe")! / 10 : undefined,
    pool_length_m: sport === "swimming" ? num("poolLength") : undefined,
    active_lengths: sport === "swimming" ? num("numActiveLengths") : undefined,
    strokes_per_length: sport === "swimming" && num("avgStrokeCount") !== undefined ? r1(num("avgStrokeCount")!) : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === 0 && /te$|load|rpe|feel/.test(k)) delete out[k];
  return out;
}

function hrZones(fit: FitFile, hr1Hz: Float64Array, floors?: number[]) {
  const session = fit.timeInZone.find((z) => z.referenceMesg === "session") ?? fit.timeInZone[fit.timeInZone.length - 1];
  const times = session?.timeInHrZone;
  const bounds = session?.hrZoneHighBoundary;
  if (Array.isArray(times) && Array.isArray(bounds) && times.length >= 6) {
    const total = times.reduce((a, b) => a + (fin(b) ? b : 0), 0);
    return {
      source: "device",
      zones: [1, 2, 3, 4, 5].map((z) => ({
        zone: z,
        from_bpm: fin(bounds[z - 1]) ? Math.round(bounds[z - 1]) : undefined,
        time: formatDuration(fin(times[z]) ? times[z] : 0),
        pct: total ? r1(((fin(times[z]) ? times[z] : 0) / total) * 100) : 0,
      })),
    };
  }
  if (!floors || floors.length < 5 || !hr1Hz.length) return undefined;
  const secs = [0, 0, 0, 0, 0];
  let counted = 0;
  for (const hr of hr1Hz) {
    if (hr !== hr) continue;
    counted++;
    for (let z = 4; z >= 0; z--) {
      if (hr >= floors[z]) {
        secs[z]++;
        break;
      }
    }
  }
  if (!counted) return undefined;
  return {
    source: "profile zones",
    zones: secs.map((s, i) => ({ zone: i + 1, from_bpm: floors[i], time: formatDuration(s), pct: r1((s / counted) * 100) })),
  };
}

function downsample(rec: Records, count: number, route: boolean) {
  if (!count || rec.length < 2) return undefined;
  const step = Math.max(1, Math.ceil(rec.length / count));
  const t0 = rec.time[0];
  const rows: Array<Record<string, number>> = [];
  for (let i = 0; i < rec.length; i += step) {
    const row: Record<string, number> = { t_s: Math.round(rec.time[i] - t0) };
    const add = (k: string, v: number, digits = 1) => {
      if (v === v) row[k] = Math.round(v * 10 ** digits) / 10 ** digits;
    };
    add("distance_km", rec.distance[i] / 1000, 3);
    add("hr", rec.hr[i], 0);
    add("speed_mps", rec.speed[i], 2);
    add("power_w", rec.power[i], 0);
    add("altitude_m", rec.altitude[i]);
    add("cadence", rec.cadence[i], 0);
    if (route) {
      add("lat", rec.lat[i], 5);
      add("lon", rec.lon[i], 5);
    }
    rows.push(row);
  }
  return rows;
}

/** Running form from the session summary, when the watch or a pod records it. */
function formMetrics(s: Fields, sport: string): Record<string, number> | undefined {
  if (sport !== "running" && sport !== "walking" && sport !== "hiking") return undefined;
  const num = (k: string) => (fin(s[k]) && (s[k] as number) > 0 ? (s[k] as number) : undefined);
  const out: Record<string, number> = {};
  const set = (key: string, v: number | undefined, f: (v: number) => number) => {
    if (v !== undefined) out[key] = f(v);
  };
  set("stride_length_m", num("avgStepLength"), (v) => r2(v / 1000));
  set("ground_contact_ms", num("avgStanceTime"), Math.round);
  set("ground_contact_balance_pct", num("avgStanceTimeBalance"), r1);
  set("vertical_oscillation_cm", num("avgVerticalOscillation"), (v) => r1(v / 10));
  set("vertical_ratio_pct", num("avgVerticalRatio"), r1);
  return Object.keys(out).length ? out : undefined;
}

export interface Lap {
  lap: number;
  /** rest, recovery, warmup or cooldown, from a structured workout. Work laps carry no kind. */
  kind?: string;
  distance_km?: number;
  duration?: string;
  avg_pace?: string | null;
  avg_speed_kmh?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_cadence?: number;
  avg_power_w?: number;
  ascent_m?: number;
  stroke?: string;
}

const LAP_KEYS = ["distance_km", "duration", "avg_pace", "avg_speed_kmh", "avg_hr", "max_hr", "avg_cadence", "avg_power_w", "ascent_m"] as const;
const MAX_LAPS = 100;

/** One short row per lap: only the fields that differ from lap to lap. */
function lapRows(laps: Fields[], sport: string, unit: "km" | "mi"): Lap[] {
  return laps.slice(0, MAX_LAPS).map((l, i) => {
    const full = sessionSummary(l, sport, unit);
    const row: Record<string, unknown> = { lap: i + 1 };
    if (typeof l.intensity === "string" && l.intensity !== "active" && l.intensity !== "interval") row.kind = l.intensity;
    for (const k of LAP_KEYS) {
      const v = full[k];
      if (v !== undefined && v !== null && !(k === "ascent_m" && v === 0)) row[k] = v;
    }
    // Some devices leave the lap's average speed out; distance over time gives it.
    if (row.avg_speed_kmh === undefined && fin(l.totalDistance) && fin(l.totalTimerTime) && l.totalDistance > 0 && l.totalTimerTime > 0) {
      const speed = l.totalDistance / l.totalTimerTime;
      row.avg_speed_kmh = r1(speed * 3.6);
      if (sport === "running" || sport === "walking" || sport === "hiking") row.avg_pace = pace(speed, unit);
    }
    if (typeof l.swimStroke === "string") row.stroke = l.swimStroke;
    return row as unknown as Lap;
  });
}

export interface IntervalsReport {
  /** e.g. "10 x 1000 m", "6 x 3:00", "5 x 1000 m + 4 x 200 m". */
  structure: string;
  detected_from: IntervalSource;
  reps: Array<Record<string, number | string | null>>;
  work: Record<string, number | string | null>;
  rest: { avg: string | null; avg_hr_drop_bpm: number | null };
  warmup?: string;
  cooldown?: string;
  verdict: string;
  note?: string;
}

function intervalsReport(s: IntervalSummary, foot: boolean, unit: "km" | "mi"): IntervalsReport {
  const kmh = (v: number | null) => (v !== null ? r1(v * 3.6) : null);
  return {
    structure: s.structure,
    detected_from: s.source,
    reps: s.reps.map((r) => ({
      rep: r.rep,
      distance_m: r.distance_m,
      time: formatDuration(r.time_s),
      ...(foot ? { pace: pace(r.speed_mps, unit) } : { speed_kmh: kmh(r.speed_mps) }),
      avg_hr: r.avg_hr,
      max_hr: r.max_hr,
      avg_power_w: r.avg_power_w,
      rest: r.rest_s !== null ? formatDuration(r.rest_s) : null,
      hr_drop_bpm: r.hr_drop_bpm,
    })),
    work: {
      reps: s.reps.length,
      distance_km: s.work_distance_m !== null ? r2(s.work_distance_m / 1000) : null,
      time: formatDuration(s.work_time_s),
      ...(foot ? { avg_pace: pace(s.work_speed_mps, unit) } : { avg_speed_kmh: kmh(s.work_speed_mps) }),
      avg_hr: s.work_hr,
      fastest: formatDuration(s.fastest),
      slowest: formatDuration(s.slowest),
      spread_s: Math.round(s.slowest - s.fastest),
      fade_pct: s.fade_pct,
      consistency_cv_pct: s.consistency_cv_pct,
    },
    rest: { avg: s.rest_s !== null ? formatDuration(s.rest_s) : null, avg_hr_drop_bpm: s.hr_drop_bpm },
    warmup: s.warmup_s >= 60 ? formatDuration(s.warmup_s) : undefined,
    cooldown: s.cooldown_s >= 60 ? formatDuration(s.cooldown_s) : undefined,
    verdict: pacingVerdict(s),
    note: s.source.endsWith("stream") ? "Reps were found in the data stream, not from laps, so each boundary is accurate to a few seconds." : undefined,
  };
}

/** The recording device's model, e.g. "fr965". Never the serial number. */
function deviceName(fileId: Fields | null): string | null {
  if (!fileId) return null;
  if (typeof fileId.productName === "string" && fileId.productName) return fileId.productName;
  const product = fileId.product;
  if (!fin(product)) return null;
  const garmin = fileId.manufacturer === 1 || fileId.manufacturer === "garmin";
  return (garmin ? ENUMS.garminProduct?.[String(product)] : undefined) ?? `${garmin ? "garmin" : `maker${String(fileId.manufacturer ?? "")}`}-${product}`;
}

/** A run counts as hilly, and gets grade-adjusted pace, from this much climbing per kilometre. */
const HILLY_M_PER_KM = 15;

export interface Analysis {
  summary: Record<string, unknown>;
  /** The session type, and the rep structure of an interval session. */
  workout: { type: WorkoutType; structure?: string };
  intervals?: IntervalsReport;
  hidden: HiddenMetrics;
  best_efforts: { distance: Record<string, { time: string; pace: string | null; starts_at: string }>; power_w: Record<string, number>; hr_bpm: Record<string, number> };
  durability?: Durability;
  /** Why durability is absent, when the reason is the kind of session. */
  durability_note?: string;
  efficiency_factor?: number;
  hr_zones?: unknown;
  splits?: Split[];
  laps?: Lap[];
  form?: Record<string, number>;
  samples?: Array<Record<string, number>>;
  data_quality: Record<string, unknown>;
  /** Flat values for the archive. */
  archive: {
    sport: string;
    vo2max: number | null;
    recovery: number | null;
    performance_condition: number | null;
    decoupling_pct: number | null;
    efficiency_factor: number | null;
    np: number | null;
    workout_type: WorkoutType;
    workout_structure: string | null;
    rep_count: number | null;
    rep_distance_m: number | null;
    rep_time_s: number | null;
    work_speed_mps: number | null;
    work_hr: number | null;
    rest_s: number | null;
    max_hr: number | null;
    avg_temp_c: number | null;
    device: string | null;
    efforts: Array<{ effort: string; kind: "time_s" | "power_w" | "hr_bpm"; value: number }>;
  };
}

export function analyzeFit(fit: FitFile, opts: AnalyzeOptions = {}): Analysis {
  const s = fit.sessions[0] ?? {};
  const sport = sportOf(String(s.sport ?? fit.sport?.sport ?? ""));
  const splitUnit = opts.splitUnit ?? "km";
  const foot = sport === "running" || sport === "walking" || sport === "hiking";
  // Everything below reads heart rate with the sensor spikes removed.
  const cleaned = cleanHeartRate(fit.records.time, fit.records.hr);
  const rec: Records = { ...fit.records, hr: cleaned.hr };
  const power = resample1Hz(rec, "power", 0);
  const hr = resample1Hz(rec, "hr", NaN);
  const hasPower = mean(rec.power) > 0;
  const hasHr = mean(rec.hr) > 0;
  const hasGps = mean(rec.lat) === mean(rec.lat);

  // On a hilly run, pace is judged on its flat-ground equivalent.
  const distanceM = fin(s.totalDistance) ? (s.totalDistance as number) : rec.length ? rec.distance[rec.length - 1] : NaN;
  const hilly = sport === "running" && fin(s.totalAscent) && distanceM > 0 && (s.totalAscent as number) / (distanceM / 1000) >= HILLY_M_PER_KM;
  const gap = hilly ? gradeAdjustedSpeed(rec) : null;
  const rawSpeed = mean(rec.speed);
  const gapRatio = gap && rawSpeed > 0 ? mean(gap) / rawSpeed : 1;

  // Reps: from the laps, else from the speed stream of a run or the power stream of a ride.
  let reps: IntervalSummary | null = null;
  if (isEndurance(sport) && rec.length > 1) {
    const stream =
      sport === "cycling" && hasPower
        ? { series: power, t0: rec.time[0], kind: "power" as const }
        : sport === "running"
          ? { series: resample1Hz(gap ? { ...rec, speed: gap } : rec, "speed", 0), t0: rec.time[0], kind: "speed" as const }
          : null;
    const detected = detectIntervals(fit.laps, stream);
    reps = detected ? summarizeIntervals(rec, detected) : null;
  }

  const distanceEfforts = bestDistanceEfforts(rec, DISTANCE_EFFORTS[sport] ?? [], MAX_STEP_MPS[sport]);
  const powerCurve = hasPower ? bestAverages(power, POWER_DURATIONS) : {};
  const hrPeaks = hasHr ? bestAverages(hr, HR_PEAK_DURATIONS) : {};
  const np = hasPower ? (fin(s.normalizedPower) ? (s.normalizedPower as number) : normalizedPower(power)) : null;
  const ftp = fin(fit.zonesTarget?.functionalThresholdPower) ? (fit.zonesTarget!.functionalThresholdPower as number) : opts.ftp;
  const durationS = fin(s.totalTimerTime) ? (s.totalTimerTime as number) : rec.length > 1 ? rec.time[rec.length - 1] - rec.time[0] : 0;

  const summary = sessionSummary(s, sport, splitUnit);
  if (np && !summary.normalized_power_w) summary.normalized_power_w = np;
  if (np && ftp && !summary.training_stress_score) {
    const intensity = np / ftp;
    summary.intensity_factor = r2(intensity);
    summary.training_stress_score = Math.round(((durationS * np * intensity) / (ftp * 3600)) * 100);
    summary.ftp_w = ftp;
  }

  const avgHr = fin(s.avgHeartRate) ? (s.avgHeartRate as number) : mean(rec.hr);
  const sessionSpeed = (fin(s.enhancedAvgSpeed) && (s.enhancedAvgSpeed as number) > 0 ? s.enhancedAvgSpeed : s.avgSpeed) as number | undefined;
  if (gap && sessionSpeed && !summary.avg_gap_pace) summary.avg_gap_pace = pace(sessionSpeed * gapRatio, splitUnit);

  // The session type decides which steady-effort numbers mean anything.
  const type = classifyWorkout({
    sport,
    duration_s: durationS,
    intervals: reps !== null,
    output_cv: foot ? outputVariation(gap ?? rec.speed, 0.5) : null,
    avg_hr: avgHr > 0 ? avgHr : null,
    zone_floors: opts.hrZoneFloors,
  });
  const steady = STEADY_TYPES.has(type);
  const dur = hasHr && type !== "intervals" && type !== "other" ? durability(rec, sport, gap) : null;
  let ef: number | undefined;
  if (avgHr > 0) {
    if (sport === "cycling" && np) ef = r2(np / avgHr);
    else if (steady && sessionSpeed && sessionSpeed > 0) ef = r2((sessionSpeed * gapRatio * 60) / avgHr); // meters per minute per beat
  }

  // The highest heart rate the cleaned stream holds; the device's own maximum may be a spike.
  let peakHr = -Infinity;
  for (let i = 0; i < rec.length; i++) if (rec.hr[i] > peakHr) peakHr = rec.hr[i];
  const maxHr = peakHr > 0 ? Math.round(peakHr) : null;
  let deviceMaxHr: number | undefined;
  if (maxHr !== null && cleaned.removed > 0 && fin(summary.max_hr) && summary.max_hr > maxHr) {
    deviceMaxHr = summary.max_hr;
    summary.max_hr = maxHr;
  }

  const hidden = hiddenMetrics(fit, opts.rawHidden);
  const distanceOut: Analysis["best_efforts"]["distance"] = {};
  for (const [k, v] of Object.entries(distanceEfforts)) {
    distanceOut[k] = { time: formatDuration(v.time_s), pace: pace(EFFORT_METERS[k] / v.time_s, splitUnit), starts_at: formatDuration(v.start_offset_s) };
  }

  const analysis: Analysis = {
    summary,
    workout: { type, structure: reps?.structure },
    intervals: reps ? intervalsReport(reps, foot, splitUnit) : undefined,
    hidden,
    best_efforts: { distance: distanceOut, power_w: powerCurve, hr_bpm: hrPeaks },
    durability: dur ?? undefined,
    durability_note: type === "intervals" ? "Not computed: this is an interval session, and decoupling only describes one steady effort. See intervals for the reps." : undefined,
    efficiency_factor: ef,
    hr_zones: hrZones(fit, hr, opts.hrZoneFloors),
    splits: ["running", "walking", "hiking", "cycling"].includes(sport) ? splits(rec, splitUnit, gap) : undefined,
    laps: fit.laps.length > 1 ? lapRows(fit.laps, sport, splitUnit) : undefined,
    form: formMetrics(s, sport),
    samples: downsample(rec, opts.samples ?? 0, opts.route ?? false),
    data_quality: {
      records: rec.length,
      sample_interval_s: rec.length > 1 ? r1((rec.time[rec.length - 1] - rec.time[0]) / (rec.length - 1)) : null,
      has_hr: hasHr,
      has_power: hasPower,
      has_gps: hasGps,
      hr_readings_dropped: cleaned.removed || undefined,
      device_max_hr: deviceMaxHr,
      laps: fit.laps.length > MAX_LAPS ? fit.laps.length : undefined,
      warnings: fit.warnings.length ? fit.warnings : undefined,
    },
    archive: {
      sport,
      vo2max: hidden.vo2max ?? null,
      recovery: hidden.experimental?.recovery_time?.value ?? null,
      performance_condition: hidden.performance_condition?.final ?? null,
      decoupling_pct: dur?.decoupling_pct ?? null,
      efficiency_factor: ef ?? null,
      np: np ?? null,
      workout_type: type,
      workout_structure: reps?.structure ?? null,
      rep_count: reps ? reps.reps.length : null,
      rep_distance_m: reps?.main.distance_m ?? null,
      rep_time_s: reps ? Math.round(reps.main.time_s) : null,
      work_speed_mps: reps?.work_speed_mps != null ? Math.round(reps.work_speed_mps * 1000) / 1000 : null,
      work_hr: reps?.work_hr ?? null,
      rest_s: reps?.rest_s ?? null,
      max_hr: maxHr,
      avg_temp_c: fin(s.avgTemperature) ? (s.avgTemperature as number) : null,
      device: deviceName(fit.fileId),
      efforts: [
        ...Object.entries(distanceEfforts).map(([effort, v]) => ({ effort, kind: "time_s" as const, value: v.time_s })),
        ...Object.entries(powerCurve).map(([effort, value]) => ({ effort, kind: "power_w" as const, value })),
        ...Object.entries(hrPeaks).map(([effort, value]) => ({ effort: `${effort}_hr`, kind: "hr_bpm" as const, value })),
      ],
    },
  };
  if (analysis.splits && !analysis.splits.length) delete analysis.splits;
  return analysis;
}
