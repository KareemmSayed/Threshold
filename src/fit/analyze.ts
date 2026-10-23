/**
 * Activity analysis from a decoded FIT file. Code computes every number here;
 * the model only explains them.
 */
import { sportOf } from "../archive/flatten";
import type { FitFile, Fields, Records } from "./decode";

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

export const DISTANCE_EFFORTS: Record<string, Array<[string, number]>> = {
  running: [
    ["400m", 400],
    ["1k", 1000],
    ["1mi", MILE_M],
    ["5k", 5000],
    ["10k", 10000],
    ["half", 21097.5],
    ["marathon", 42195],
  ],
  walking: [
    ["1k", 1000],
    ["5k", 5000],
  ],
  hiking: [
    ["1k", 1000],
    ["5k", 5000],
    ["10k", 10000],
  ],
  cycling: [
    ["10k_bike", 10000],
    ["20k_bike", 20000],
    ["40k_bike", 40000],
    ["100k_bike", 100000],
  ],
  swimming: [
    ["100m_swim", 100],
    ["400m_swim", 400],
    ["1500m_swim", 1500],
  ],
};

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

/** Fastest time over each distance, from the cumulative distance stream. */
export function bestDistanceEfforts(rec: Records, efforts: Array<[string, number]>): Record<string, { time_s: number; start_offset_s: number }> {
  const t: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < rec.length; i++) {
    const dist = rec.distance[i];
    if (dist !== dist) continue;
    if (d.length && dist < d[d.length - 1]) continue; // distance must not go backwards
    t.push(rec.time[i]);
    d.push(dist);
  }
  const out: Record<string, { time_s: number; start_offset_s: number }> = {};
  if (d.length < 2) return out;
  const total = d[d.length - 1] - d[0];
  for (const [label, target] of efforts) {
    if (total < target) continue;
    let best = Infinity;
    let bestStart = 0;
    let i = 0;
    for (let j = 1; j < d.length; j++) {
      while (i + 1 < j && d[j] - d[i + 1] >= target) i++;
      const covered = d[j] - d[i];
      if (covered < target) continue;
      // Scale to the exact distance; samples rarely land on it.
      const time = ((t[j] - t[i]) * target) / covered;
      if (time < best) {
        best = time;
        bestStart = t[i] - t[0];
      }
    }
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
  output: "power" | "speed";
  first_half: { avg_hr: number; avg_output: number; efficiency: number };
  second_half: { avg_hr: number; avg_output: number; efficiency: number };
  verdict: string;
  caveats: string[];
}

/**
 * Aerobic decoupling (Pa:HR / Pw:HR): how much output per heartbeat falls from
 * the first half to the second. Below 5% on a steady effort means good aerobic
 * durability. The first 10 minutes are skipped as warm-up.
 */
export function durability(rec: Records, sport: string): Durability | null {
  const usePower = sport === "cycling" && mean(rec.power) > 0;
  const output = usePower ? rec.power : rec.speed;
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
  if (!usePower) {
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
    output: usePower ? "power" : "speed",
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
}

export function splits(rec: Records, unit: "km" | "mi"): Split[] {
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
      for (let k = startIdx; k <= i; k++) {
        if (rec.hr[k] === rec.hr[k]) {
          hr += rec.hr[k];
          n++;
        }
        if (k > startIdx) {
          const dz = rec.altitude[k] - rec.altitude[k - 1];
          if (dz > 0) gain += dz;
        }
      }
      const time = rec.time[i] - startT;
      out.push({
        split: out.length + 1,
        distance_km: r2(covered / 1000),
        time: formatDuration(time),
        pace: pace(covered / time, unit),
        avg_hr: n ? Math.round(hr / n) : null,
        elevation_gain_m: Math.round(gain),
      });
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

export interface Analysis {
  summary: Record<string, unknown>;
  hidden: HiddenMetrics;
  best_efforts: { distance: Record<string, { time: string; pace: string | null; starts_at: string }>; power_w: Record<string, number>; hr_bpm: Record<string, number> };
  durability?: Durability;
  efficiency_factor?: number;
  hr_zones?: unknown;
  splits?: Split[];
  laps?: Array<Record<string, unknown>>;
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
    efforts: Array<{ effort: string; kind: "time_s" | "power_w"; value: number }>;
  };
}

export function analyzeFit(fit: FitFile, opts: AnalyzeOptions = {}): Analysis {
  const rec = fit.records;
  const s = fit.sessions[0] ?? {};
  const sport = sportOf(String(s.sport ?? fit.sport?.sport ?? ""));
  const splitUnit = opts.splitUnit ?? "km";
  const power = resample1Hz(rec, "power", 0);
  const hr = resample1Hz(rec, "hr", NaN);
  const hasPower = mean(rec.power) > 0;
  const hasHr = mean(rec.hr) > 0;
  const hasGps = mean(rec.lat) === mean(rec.lat);

  const distanceEfforts = bestDistanceEfforts(rec, DISTANCE_EFFORTS[sport] ?? []);
  const powerCurve = hasPower ? bestAverages(power, POWER_DURATIONS) : {};
  const hrPeaks = hasHr
    ? bestAverages(hr, [
        ["5min", 300],
        ["20min", 1200],
        ["60min", 3600],
      ])
    : {};
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

  const dur = hasHr ? durability(rec, sport) : null;
  const avgHr = fin(s.avgHeartRate) ? (s.avgHeartRate as number) : mean(rec.hr);
  let ef: number | undefined;
  if (avgHr > 0) {
    if (sport === "cycling" && np) ef = r2(np / avgHr);
    else if (fin(s.enhancedAvgSpeed) || fin(s.avgSpeed)) {
      const speed = (fin(s.enhancedAvgSpeed) && (s.enhancedAvgSpeed as number) > 0 ? s.enhancedAvgSpeed : s.avgSpeed) as number;
      if (speed > 0) ef = r2((speed * 60) / avgHr); // meters per minute per beat
    }
  }

  const hidden = hiddenMetrics(fit, opts.rawHidden);
  const distanceOut: Analysis["best_efforts"]["distance"] = {};
  const lengths = Object.fromEntries((DISTANCE_EFFORTS[sport] ?? []).map(([k, m]) => [k, m]));
  for (const [k, v] of Object.entries(distanceEfforts)) {
    distanceOut[k] = { time: formatDuration(v.time_s), pace: pace(lengths[k] / v.time_s, splitUnit), starts_at: formatDuration(v.start_offset_s) };
  }

  const laps = fit.laps.length > 1 ? fit.laps.slice(0, 60).map((l) => sessionSummary(l, sport, splitUnit)) : undefined;
  laps?.forEach((l) => {
    delete l.sport;
    delete l.sub_sport;
    delete l.profile;
  });

  const analysis: Analysis = {
    summary,
    hidden,
    best_efforts: { distance: distanceOut, power_w: powerCurve, hr_bpm: hrPeaks },
    durability: dur ?? undefined,
    efficiency_factor: ef,
    hr_zones: hrZones(fit, hr, opts.hrZoneFloors),
    splits: ["running", "walking", "hiking", "cycling"].includes(sport) ? splits(rec, splitUnit) : undefined,
    laps,
    samples: downsample(rec, opts.samples ?? 0, opts.route ?? false),
    data_quality: {
      records: rec.length,
      sample_interval_s: rec.length > 1 ? r1((rec.time[rec.length - 1] - rec.time[0]) / (rec.length - 1)) : null,
      has_hr: hasHr,
      has_power: hasPower,
      has_gps: hasGps,
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
      efforts: [
        ...Object.entries(distanceEfforts).map(([effort, v]) => ({ effort, kind: "time_s" as const, value: v.time_s })),
        ...Object.entries(powerCurve).map(([effort, value]) => ({ effort, kind: "power_w" as const, value })),
      ],
    },
  };
  if (analysis.splits && !analysis.splits.length) delete analysis.splits;
  return analysis;
}
