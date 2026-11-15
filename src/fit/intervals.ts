/**
 * Interval detection and session type.
 *
 * A session of reps and rests is not one effort: kilometre splits mix reps with
 * recoveries, and decoupling compares two halves that were never steady. This
 * module finds the work and rest stretches so reps are reported as reps, and
 * names the session type so steady-effort metrics are computed only where they
 * mean something.
 *
 * Reps are found three ways, most trusted first:
 *   1. lap labels: a structured workout marks each lap active, rest, warm-up or cool-down;
 *   2. lap speeds: laps pressed by hand that alternate fast and slow;
 *   3. the speed (or power) stream: regular fast stretches with no laps to mark them.
 */
import type { Fields, Records } from "./decode";

export type SegmentKind = "work" | "rest" | "warmup" | "cooldown";
export type IntervalSource = "lap labels" | "lap speeds" | "speed stream" | "power stream";
export type WorkoutType = "intervals" | "long" | "tempo" | "steady" | "recovery" | "variable" | "other";

/** Session types whose pace and heart rate describe one sustained effort. */
export const STEADY_TYPES: ReadonlySet<string> = new Set<WorkoutType>(["steady", "long", "tempo", "recovery"]);

export interface Segment {
  /** Unix seconds. */
  start: number;
  end: number;
  kind: SegmentKind;
  /** From the lap messages, when the segment came from laps. */
  distance_m?: number;
  timer_s?: number;
  step?: number;
}

export interface Detected {
  segments: Segment[];
  source: IntervalSource;
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown): number | undefined => (fin(v) ? v : undefined);
const r1 = (v: number) => Math.round(v * 10) / 10;

const MIN_REP_S = 10;
const MIN_STREAM_REP_S = 20;
/** Reps count as "the same" when distance or time is within this fraction. */
const SAME_REP = 0.06;

function cv(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  if (!m) return 0;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length) / Math.abs(m);
}

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function meanBetween(col: Float64Array, time: Float64Array, from: number, to: number): { mean: number | null; max: number | null } {
  let sum = 0;
  let n = 0;
  let max = -Infinity;
  for (let i = lowerBound(time, from); i < time.length && time[i] <= to; i++) {
    const v = col[i];
    if (v === v) {
      sum += v;
      n++;
      if (v > max) max = v;
    }
  }
  return { mean: n ? sum / n : null, max: n ? max : null };
}

function distanceBetween(rec: Records, from: number, to: number): number | null {
  let i = lowerBound(rec.time, from);
  let j = lowerBound(rec.time, to + 0.5) - 1;
  while (i < j && rec.distance[i] !== rec.distance[i]) i++;
  while (j > i && rec.distance[j] !== rec.distance[j]) j--;
  if (j <= i) return null;
  const d = rec.distance[j] - rec.distance[i];
  return d === d && d >= 0 ? d : null;
}

/* -------------------------------------------------------------------------- */
/* 1 and 2: laps                                                              */
/* -------------------------------------------------------------------------- */

interface LapInfo {
  start: number;
  end: number;
  timer: number;
  distance: number;
  intensity: string;
  trigger: string;
  step: number | undefined;
}

function lapInfo(laps: Fields[]): LapInfo[] | null {
  const out: LapInfo[] = [];
  for (const l of laps) {
    const start = typeof l.startTime === "string" ? Date.parse(l.startTime) / 1000 : NaN;
    const timer = num(l.totalTimerTime) ?? num(l.totalElapsedTime);
    const elapsed = num(l.totalElapsedTime) ?? timer;
    if (start !== start || timer === undefined || elapsed === undefined) return null;
    out.push({
      start,
      end: start + elapsed,
      timer,
      distance: num(l.totalDistance) ?? 0,
      intensity: typeof l.intensity === "string" ? l.intensity : "active",
      trigger: typeof l.lapTrigger === "string" ? l.lapTrigger : "",
      step: num(l.wktStepIndex),
    });
  }
  return out;
}

/**
 * Add a lap to the segments. Laps of one kind that follow each other join into one segment:
 * a rep the watch auto-lapped in the middle is still one rep. Work laps of different workout
 * steps stay apart.
 */
function push(segs: Segment[], lap: LapInfo, kind: SegmentKind): void {
  const last = segs[segs.length - 1];
  if (last && last.kind === kind && (kind !== "work" || last.step === lap.step)) {
    last.end = lap.end;
    last.distance_m = (last.distance_m ?? 0) + lap.distance;
    last.timer_s = (last.timer_s ?? 0) + lap.timer;
    return;
  }
  segs.push({ start: lap.start, end: lap.end, kind, distance_m: lap.distance, timer_s: lap.timer, step: lap.step });
}

/** A structured workout: the watch labels every lap. Auto-laps inside one step (400 + 400 + 200) join into one rep. */
function fromLapLabels(laps: LapInfo[]): Segment[] | null {
  if (!laps.some((l) => l.intensity === "rest" || l.intensity === "recovery")) return null;
  const segs: Segment[] = [];
  for (const l of laps) {
    const kind: SegmentKind = l.intensity === "rest" || l.intensity === "recovery" ? "rest" : l.intensity === "warmup" ? "warmup" : l.intensity === "cooldown" ? "cooldown" : "work";
    push(segs, l, kind);
  }
  return segs.filter((s) => s.kind === "work").length >= 2 ? segs : null;
}

/** Laps pressed by hand that alternate fast and slow. Auto-laps of equal length are left to the stream. */
function fromLapSpeeds(laps: LapInfo[]): Segment[] | null {
  if (laps.length < 5) return null;
  const moving = laps.filter((l) => l.timer >= MIN_REP_S);
  const manual = moving.filter((l) => l.trigger === "manual").length;
  if (manual < 3 && cv(moving.map((l) => l.distance)) < 0.25) return null;
  const speed = (l: LapInfo) => (l.timer > 0 ? l.distance / l.timer : 0);
  const sorted = moving.map(speed).sort((a, b) => a - b);
  // The widest relative gap between neighbouring lap speeds separates rests from reps.
  let best = 0;
  let threshold = 0;
  for (let k = 1; k < sorted.length - 3; k++) {
    const low = Math.max(sorted[k], 0.3);
    const ratio = sorted[k + 1] / low;
    if (ratio > best) {
      best = ratio;
      threshold = Math.sqrt(low * sorted[k + 1]);
    }
  }
  if (best < 1.2) return null;
  const segs: Segment[] = [];
  for (const l of laps) push(segs, l, speed(l) > threshold && l.timer >= MIN_REP_S ? "work" : "rest");
  // Whatever comes before the first rep and after the last is warm-up and cool-down.
  const first = segs.findIndex((s) => s.kind === "work");
  let last = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].kind === "work") {
      last = i;
      break;
    }
  }
  if (first < 0) return null;
  segs.forEach((s, i) => {
    if (i < first) s.kind = "warmup";
    else if (i > last) s.kind = "cooldown";
  });
  const work = segs.filter((s) => s.kind === "work").length;
  const rests = segs.filter((s) => s.kind === "rest").length;
  return work >= 3 && rests >= 2 ? segs : null;
}

/* -------------------------------------------------------------------------- */
/* 3: the stream                                                              */
/* -------------------------------------------------------------------------- */

/** Otsu's threshold: the split of a histogram that best separates two groups. */
function otsu(values: Float64Array, max: number): number {
  const BINS = 64;
  const hist = new Float64Array(BINS);
  for (let i = 0; i < values.length; i++) hist[Math.min(BINS - 1, Math.floor((values[i] / max) * BINS))]++;
  let total = 0;
  for (let b = 0; b < BINS; b++) total += b * hist[b];
  let below = 0;
  let sumBelow = 0;
  let bestVar = -1;
  let bestBin = 0;
  for (let b = 0; b < BINS - 1; b++) {
    below += hist[b];
    sumBelow += b * hist[b];
    const above = values.length - below;
    if (!below || !above) continue;
    const diff = sumBelow / below - (total - sumBelow) / above;
    const between = below * above * diff * diff;
    if (between > bestVar) {
      bestVar = between;
      bestBin = b;
    }
  }
  return ((bestBin + 1) / BINS) * max;
}

/**
 * Regular fast stretches in a 1 Hz series (speed, or power on a bike). Guards against
 * a steady run cut at random and against stops at traffic lights: reps must be clearly
 * faster than the rests and alike in length.
 */
export function fromStream(series: Float64Array, t0: number, smoothS: number, minRatio = 1.25): Segment[] | null {
  const n = series.length;
  if (n < 600) return null;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (series[i] === series[i] ? series[i] : 0);
  const half = Math.floor(smoothS / 2);
  const smooth = new Float64Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    smooth[i] = (prefix[b] - prefix[a]) / (b - a);
    if (smooth[i] > max) max = smooth[i];
  }
  if (!(max > 0)) return null;
  const threshold = otsu(smooth, max);

  // Runs of work and rest; short rests inside a rep and short blips of work are absorbed.
  type Run = { from: number; to: number; work: boolean };
  let runs: Run[] = [];
  for (let i = 0; i < n; i++) {
    const work = smooth[i] > threshold;
    const last = runs[runs.length - 1];
    if (last && last.work === work) last.to = i + 1;
    else runs.push({ from: i, to: i + 1, work });
  }
  const absorb = (tooShort: (r: Run) => boolean) => {
    const out: Run[] = [];
    for (const r of runs) {
      const work = tooShort(r) ? !r.work : r.work;
      const last = out[out.length - 1];
      if (last && last.work === work) last.to = r.to;
      else out.push({ from: r.from, to: r.to, work });
    }
    runs = out;
  };
  absorb((r) => !r.work && r.to - r.from < 8); // a short dip inside a rep belongs to the rep
  absorb((r) => r.work && r.to - r.from < MIN_STREAM_REP_S); // a short burst is not a rep

  const work = runs.filter((r) => r.work);
  if (work.length < 3) return null;
  const mean = (r: Run) => (prefix[r.to] - prefix[r.from]) / (r.to - r.from);
  const first = runs.indexOf(work[0]);
  const last = runs.indexOf(work[work.length - 1]);
  const between = runs.slice(first, last + 1).filter((r) => !r.work);
  if (between.length < 2) return null;
  const workMean = work.reduce((a, r) => a + mean(r) * (r.to - r.from), 0) / work.reduce((a, r) => a + (r.to - r.from), 0);
  const restMean = between.reduce((a, r) => a + mean(r) * (r.to - r.from), 0) / between.reduce((a, r) => a + (r.to - r.from), 0);
  if (workMean < minRatio * restMean) return null;
  const durations = work.map((r) => r.to - r.from);
  const amounts = work.map((r) => prefix[r.to] - prefix[r.from]);
  if (Math.min(cv(durations), cv(amounts)) > 0.3) return null;
  const workTotal = durations.reduce((a, b) => a + b, 0);
  if (workTotal < 240 || workTotal < 0.12 * n) return null;

  return runs.map((r, i) => ({
    start: t0 + r.from,
    end: t0 + r.to,
    kind: r.work ? "work" : i < first ? "warmup" : i > last ? "cooldown" : "rest",
  }));
}

export function detectIntervals(laps: Fields[], stream: { series: Float64Array; t0: number; kind: "speed" | "power" } | null): Detected | null {
  const info = laps.length > 1 ? lapInfo(laps) : null;
  if (info) {
    const labelled = fromLapLabels(info);
    if (labelled) return { segments: labelled, source: "lap labels" };
    const bySpeed = fromLapSpeeds(info);
    if (bySpeed) return { segments: bySpeed, source: "lap speeds" };
  }
  if (stream) {
    // Power is noisier than speed and coasting pulls the rests down, so it needs a wider gap.
    const segments = stream.kind === "power" ? fromStream(stream.series, stream.t0, 30, 1.4) : fromStream(stream.series, stream.t0, 15, 1.25);
    if (segments) return { segments, source: stream.kind === "power" ? "power stream" : "speed stream" };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Reps                                                                       */
/* -------------------------------------------------------------------------- */

export interface Rep {
  rep: number;
  distance_m: number | null;
  time_s: number;
  speed_mps: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power_w: number | null;
  /** Seconds until the next rep starts. */
  rest_s: number | null;
  /** Heart rate at the end of the rep minus heart rate 60 s later (or at the end of a shorter rest). */
  hr_drop_bpm: number | null;
}

export interface RepGroup {
  count: number;
  /** Snapped rep distance in meters, or null when the reps are set by time. */
  distance_m: number | null;
  time_s: number;
  label: string;
}

export interface IntervalSummary {
  structure: string;
  source: IntervalSource;
  reps: Rep[];
  /** The group that holds most of the work; fade and consistency are measured on it. */
  main: RepGroup;
  work_distance_m: number | null;
  work_time_s: number;
  work_speed_mps: number | null;
  work_hr: number | null;
  fastest: number;
  slowest: number;
  /** Speed lost from the first third of the main group to the last third (positive = slowed). */
  fade_pct: number | null;
  /** Spread of rep times in the main group. */
  consistency_cv_pct: number | null;
  rest_s: number | null;
  hr_drop_bpm: number | null;
  warmup_s: number;
  cooldown_s: number;
}

const STANDARD_M = [100, 150, 200, 300, 400, 500, 600, 800, 1000, 1200, 1500, 1600, 2000, 3000, 5000];

export function snapDistance(m: number): number {
  for (const s of STANDARD_M) if (Math.abs(m - s) / s <= 0.04) return s;
  return m < 1000 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50;
}

const snapTime = (s: number) => (s < 300 ? Math.round(s / 5) * 5 : Math.round(s / 15) * 15);
const clock = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
const distanceLabel = (m: number) => (m <= 3000 ? `${m} m` : `${r1(m / 1000)} km`);

function groupReps(reps: Rep[]): RepGroup[] {
  const groups: Rep[][] = [];
  for (const rep of reps) {
    const g = groups[groups.length - 1];
    if (g) {
      const d = g.reduce((a, r) => a + (r.distance_m ?? 0), 0) / g.length;
      const t = g.reduce((a, r) => a + r.time_s, 0) / g.length;
      const sameDistance = d > 0 && rep.distance_m !== null && Math.abs(rep.distance_m - d) / d <= SAME_REP;
      const sameTime = Math.abs(rep.time_s - t) / t <= SAME_REP;
      if (sameDistance || sameTime) {
        g.push(rep);
        continue;
      }
    }
    groups.push([rep]);
  }
  return groups.map((g) => {
    const distances = g.map((r) => r.distance_m).filter(fin);
    const times = g.map((r) => r.time_s);
    const time = times.reduce((a, b) => a + b, 0) / g.length;
    // Reps are set by distance when the distances agree at least as well as the times do.
    const byDistance = distances.length === g.length && distances.every((d) => d > 0) && cv(distances) <= cv(times);
    const distance = byDistance ? snapDistance(distances.reduce((a, b) => a + b, 0) / g.length) : null;
    return { count: g.length, distance_m: distance, time_s: time, label: `${g.length} x ${distance !== null ? distanceLabel(distance) : clock(snapTime(time))}` };
  });
}

/** Rep-by-rep numbers for the detected segments, or null when there are too few real reps. */
export function summarizeIntervals(rec: Records, detected: Detected): IntervalSummary | null {
  const { segments, source } = detected;
  const work = segments.filter((s) => s.kind === "work" && (s.timer_s ?? s.end - s.start) >= MIN_REP_S);
  if (work.length < (source === "lap labels" ? 2 : 3)) return null;
  const reps: Rep[] = work.map((s, i) => {
    const time = s.timer_s ?? s.end - s.start;
    const distance = s.distance_m && s.distance_m > 0 ? s.distance_m : distanceBetween(rec, s.start, s.end);
    const hr = meanBetween(rec.hr, rec.time, s.start, s.end);
    const power = meanBetween(rec.power, rec.time, s.start, s.end);
    const next = work[i + 1];
    const rest = next ? next.start - s.end : null;
    let drop: number | null = null;
    if (rest !== null && rest >= 20) {
      const atEnd = meanBetween(rec.hr, rec.time, s.end - 5, s.end).mean;
      const later = Math.min(s.end + 60, next.start);
      const after = meanBetween(rec.hr, rec.time, later - 3, later + 2).mean;
      if (atEnd !== null && after !== null) drop = Math.round(atEnd - after);
    }
    return {
      rep: i + 1,
      distance_m: distance !== null && distance > 0 ? Math.round(distance) : null,
      time_s: r1(time),
      speed_mps: distance !== null && distance > 0 && time > 0 ? distance / time : null,
      avg_hr: hr.mean !== null ? Math.round(hr.mean) : null,
      max_hr: hr.max !== null ? Math.round(hr.max) : null,
      avg_power_w: power.mean !== null && power.mean > 0 ? Math.round(power.mean) : null,
      rest_s: rest !== null ? Math.round(rest) : null,
      hr_drop_bpm: drop,
    };
  });

  const groups = groupReps(reps);
  let offset = 0;
  let main = groups[0];
  let mainReps: Rep[] = [];
  let mainTime = -1;
  for (const g of groups) {
    const members = reps.slice(offset, offset + g.count);
    offset += g.count;
    const total = members.reduce((a, r) => a + r.time_s, 0);
    if (total > mainTime) {
      mainTime = total;
      main = g;
      mainReps = members;
    }
  }
  const structure = groups.length <= 4 ? groups.map((g) => g.label).join(" + ") : `${reps.length} reps, ${clock(Math.min(...reps.map((r) => r.time_s)))} to ${clock(Math.max(...reps.map((r) => r.time_s)))}`;

  const workTime = reps.reduce((a, r) => a + r.time_s, 0);
  const allMeasured = reps.every((r) => r.distance_m !== null);
  const workDistance = allMeasured ? reps.reduce((a, r) => a + (r.distance_m ?? 0), 0) : null;
  const hrReps = reps.filter((r) => r.avg_hr !== null);
  const hrTime = hrReps.reduce((a, r) => a + r.time_s, 0);
  const rests = reps.map((r) => r.rest_s).filter(fin);
  const drops = reps.map((r) => r.hr_drop_bpm).filter(fin);

  // Pace on the main group: by time when the reps share a distance, by speed otherwise.
  const pace = (r: Rep) => (main.distance_m !== null ? 1 / r.time_s : (r.speed_mps ?? 0));
  const third = Math.max(1, Math.round(mainReps.length / 3));
  const avg = (list: Rep[]) => list.reduce((a, r) => a + pace(r), 0) / list.length;
  const fade = mainReps.length >= 3 && avg(mainReps.slice(0, third)) > 0 ? ((avg(mainReps.slice(0, third)) - avg(mainReps.slice(-third))) / avg(mainReps.slice(0, third))) * 100 : null;
  const times = mainReps.map((r) => r.time_s);

  return {
    structure,
    source,
    reps,
    main,
    work_distance_m: workDistance,
    work_time_s: r1(workTime),
    work_speed_mps: workDistance !== null && workTime > 0 ? workDistance / workTime : null,
    work_hr: hrTime > 0 ? Math.round(hrReps.reduce((a, r) => a + (r.avg_hr ?? 0) * r.time_s, 0) / hrTime) : null,
    fastest: Math.min(...times),
    slowest: Math.max(...times),
    fade_pct: fade !== null ? r1(fade) : null,
    consistency_cv_pct: mainReps.length >= 3 ? r1(cv(times) * 100) : null,
    rest_s: rests.length ? Math.round(rests.reduce((a, b) => a + b, 0) / rests.length) : null,
    hr_drop_bpm: drops.length ? Math.round(drops.reduce((a, b) => a + b, 0) / drops.length) : null,
    warmup_s: Math.round(segments.filter((s) => s.kind === "warmup").reduce((a, s) => a + (s.end - s.start), 0)),
    cooldown_s: Math.round(segments.filter((s) => s.kind === "cooldown").reduce((a, s) => a + (s.end - s.start), 0)),
  };
}

export function pacingVerdict(s: IntervalSummary): string {
  if (s.fade_pct === null || s.consistency_cv_pct === null) return "Too few reps of one kind to judge pacing.";
  if (s.fade_pct > 4) return `Reps slowed ${s.fade_pct}% from the first third to the last: the start was too fast, or the session was at the limit.`;
  if (s.fade_pct < -3) return `Reps got ${Math.abs(s.fade_pct)}% faster from the first third to the last: a controlled build with room to start quicker.`;
  if (s.consistency_cv_pct <= 2) return `Even reps (times within ${s.consistency_cv_pct}% of each other): well-controlled pacing.`;
  return `Rep times varied by ${s.consistency_cv_pct}% with no clear fade.`;
}

/* -------------------------------------------------------------------------- */
/* Session type                                                               */
/* -------------------------------------------------------------------------- */

const ENDURANCE = new Set(["running", "cycling", "swimming", "walking", "hiking", "rowing_paddling", "winter"]);
const LONG_S: Record<string, number> = { running: 90 * 60, hiking: 180 * 60, walking: 120 * 60, cycling: 150 * 60, swimming: 60 * 60, rowing_paddling: 90 * 60, winter: 120 * 60 };

export const isEndurance = (sport: string) => ENDURANCE.has(sport);

export interface ClassifyInput {
  sport: string;
  duration_s: number;
  intervals: boolean;
  /** Variation of the moving output (speed or power); null when it cannot be measured. */
  output_cv: number | null;
  avg_hr: number | null;
  /** Floors of HR zones 1 to 5. */
  zone_floors?: number[];
}

/**
 * intervals: reps and rests. variable: no structure but far from even (fartlek, hills, stop-and-go).
 * long, tempo, recovery, steady: one sustained effort, named by length and average heart rate.
 */
export function classifyWorkout(c: ClassifyInput): WorkoutType {
  if (!ENDURANCE.has(c.sport)) return "other";
  if (c.intervals) return "intervals";
  if (c.output_cv !== null && c.output_cv > 0.3) return "variable";
  if (c.duration_s >= (LONG_S[c.sport] ?? 120 * 60)) return "long";
  const floors = c.zone_floors;
  if (c.avg_hr !== null && floors && floors.length >= 5) {
    if (c.avg_hr >= floors[3]) return "tempo";
    if (c.avg_hr < floors[1]) return "recovery";
  }
  return "steady";
}
