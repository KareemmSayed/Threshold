/**
 * Race predictions and training paces from best efforts.
 *
 * Garmin's Personal API does not return race predictions, so they are computed here from
 * what the archive does hold: the fastest time over each distance, found in the FIT files.
 *
 *   VDOT (Daniels and Gilbert): a fitness score from one race-like effort. The best score
 *     among recent efforts predicts every other distance and sets the training paces.
 *   Riegel: time2 = time1 x (distance2 / distance1)^1.06, as a second opinion from the same effort.
 *   Critical speed: the line through near-maximal efforts of 2 to 30 minutes; its slope is the
 *     speed that can be held for a long time, close to threshold pace.
 *
 * A best effort is a lower bound on ability: it only predicts well when it was close to all-out.
 */

export interface Anchor {
  effort: string;
  meters: number;
  time_s: number;
  date: string;
  activity_id: number;
}

/** Oxygen cost of running at v meters per minute, in ml/kg/min. */
const oxygenCost = (v: number) => -4.6 + 0.182258 * v + 0.000104 * v * v;
/** Fraction of VO2 max that can be held for a race of t minutes. */
const sustainable = (t: number) => 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);

/** The formula is fitted to races of about 3.5 minutes to 4 hours. */
export const VDOT_MIN_S = 210;
export const VDOT_MAX_S = 4.5 * 3600;

export function vdot(meters: number, seconds: number): number {
  const t = seconds / 60;
  return oxygenCost(meters / t) / sustainable(t);
}

/** Race time in seconds for a distance at a VDOT. VDOT falls as the time grows, so bisect. */
export function timeForVdot(score: number, meters: number): number {
  let lo = meters / 12;
  let hi = meters / 0.8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdot(meters, mid) > score) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Speed in m/s that costs a given fraction of a VDOT. */
export function speedAtFraction(score: number, fraction: number): number {
  const a = 0.000104;
  const b = 0.182258;
  return (-b + Math.sqrt(b * b + 4 * a * (4.6 + fraction * score))) / (2 * a) / 60;
}

export const riegel = (seconds: number, fromMeters: number, toMeters: number) => seconds * (toMeters / fromMeters) ** 1.06;

export const RACE_TARGETS: Array<[label: string, meters: number]> = [
  ["1500m", 1500],
  ["1mi", 1609.344],
  ["3k", 3000],
  ["5k", 5000],
  ["10k", 10000],
  ["half", 21097.5],
  ["marathon", 42195],
];

export interface Prediction {
  distance: string;
  meters: number;
  time_s: number;
  /** The spread between the two models: wide when the target is far from the effort behind it. */
  low_s: number;
  high_s: number;
  confidence: "good" | "fair" | "low";
}

export interface RaceModel {
  vdot: number | null;
  /** The effort every prediction rests on. */
  basis: Anchor | null;
  predictions: Prediction[];
}

/** Predictions for each target from the best recent effort. */
export function predictRaces(anchors: Anchor[], targets: Array<[string, number]> = RACE_TARGETS): RaceModel {
  const scored = anchors.filter((a) => a.time_s >= VDOT_MIN_S && a.time_s <= VDOT_MAX_S).map((a) => ({ a, score: vdot(a.meters, a.time_s) }));
  const top = scored.reduce<{ a: Anchor; score: number } | null>((best, s) => (!best || s.score > best.score ? s : best), null);
  // Without an effort long enough for VDOT, fall back to Riegel from the longest short effort.
  const fallback = anchors.filter((a) => a.time_s >= 120).reduce<Anchor | null>((best, a) => (!best || a.meters > best.meters ? a : best), null);
  const basis = top?.a ?? fallback;
  if (!basis) return { vdot: null, basis: null, predictions: [] };
  const predictions = targets.map(([distance, meters]): Prediction => {
    const byRiegel = riegel(basis.time_s, basis.meters, meters);
    const time = top ? timeForVdot(top.score, meters) : byRiegel;
    const ratio = Math.max(meters / basis.meters, basis.meters / meters);
    return {
      distance,
      meters,
      time_s: Math.round(time),
      low_s: Math.round(Math.min(time, byRiegel)),
      high_s: Math.round(Math.max(time, byRiegel)),
      confidence: !top ? "low" : ratio <= 2.2 ? "good" : ratio <= 4.5 ? "fair" : "low",
    };
  });
  return { vdot: top ? Math.round(top.score * 10) / 10 : null, basis, predictions };
}

export interface TrainingPaces {
  /** m/s, slow end then fast end. */
  easy: [number, number];
  marathon: number;
  threshold: number;
  interval: number;
  repetition: number;
}

/** Daniels-style training speeds: easy about 60 to 70% of VDOT, threshold 88%, interval 97.5%, repetition 107.5%. */
export function trainingPaces(score: number): TrainingPaces {
  return {
    easy: [speedAtFraction(score, 0.6), speedAtFraction(score, 0.7)],
    marathon: 42195 / timeForVdot(score, 42195),
    threshold: speedAtFraction(score, 0.88),
    interval: speedAtFraction(score, 0.975),
    repetition: speedAtFraction(score, 1.075),
  };
}

export interface CriticalSpeed {
  speed_mps: number;
  /** The distance that can be run above critical speed before exhaustion, in meters. */
  d_prime_m: number;
  efforts: string[];
}

/**
 * Critical speed from near-maximal efforts of 2 to 30 minutes: distance = CS x time + D'.
 * Efforts that fall more than 10% short of the best one (by Riegel) were not all-out and are left out.
 * Returns null when the efforts cannot carry the model.
 */
export function criticalSpeed(anchors: Anchor[]): CriticalSpeed | null {
  const eligible = anchors.filter((a) => a.time_s >= 120 && a.time_s <= 1800);
  if (eligible.length < 2) return null;
  const as5k = (a: Anchor) => riegel(a.time_s, a.meters, 5000);
  const best = Math.min(...eligible.map(as5k));
  const used = eligible.filter((a) => as5k(a) <= best * 1.1).sort((x, y) => x.time_s - y.time_s);
  if (used.length < 2 || used[used.length - 1].time_s / used[0].time_s < 2) return null;
  const n = used.length;
  const mt = used.reduce((a, u) => a + u.time_s, 0) / n;
  const md = used.reduce((a, u) => a + u.meters, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const u of used) {
    sxx += (u.time_s - mt) ** 2;
    sxy += (u.time_s - mt) * (u.meters - md);
  }
  if (!sxx) return null;
  const speed = sxy / sxx;
  const dPrime = md - speed * mt;
  if (!(speed > 0) || dPrime < 0 || dPrime > 600 || speed >= used[0].meters / used[0].time_s) return null;
  return { speed_mps: speed, d_prime_m: Math.round(dPrime), efforts: used.map((u) => u.effort) };
}

export interface PowerModel {
  ftp_estimate_w: number | null;
  ftp_basis: string | null;
  critical_power_w: number | null;
  w_prime_kj: number | null;
  zones: Array<{ zone: number; name: string; from_w: number; to_w: number | null }> | null;
}

const COGGAN: Array<[name: string, from: number, to: number | null]> = [
  ["active recovery", 0, 0.55],
  ["endurance", 0.56, 0.75],
  ["tempo", 0.76, 0.9],
  ["threshold", 0.91, 1.05],
  ["VO2 max", 1.06, 1.2],
  ["anaerobic capacity", 1.21, 1.5],
  ["neuromuscular", 1.51, null],
];

/**
 * Threshold power from the power curve: 95% of the best 20 minutes, or the best 60 minutes when
 * that is higher. Critical power and W' come from the line through the 5, 10 and 20 minute bests.
 */
export function powerModel(curve: Record<string, number>): PowerModel {
  const p20 = curve["20min"];
  const p60 = curve["60min"];
  let ftp: number | null = null;
  let basis: string | null = null;
  if (p20) {
    ftp = Math.round(p20 * 0.95);
    basis = `95% of the best 20 min (${p20} W)`;
  }
  if (p60 && (ftp === null || p60 > ftp)) {
    ftp = p60;
    basis = `best 60 min (${p60} W)`;
  }
  const points = [
    [300, curve["5min"]],
    [600, curve["10min"]],
    [1200, curve["20min"]],
  ].filter((p): p is [number, number] => typeof p[1] === "number" && p[1] > 0);
  let cp: number | null = null;
  let wPrime: number | null = null;
  if (points.length >= 2) {
    // Power = CP + W' / t: a line in 1/t.
    const xs = points.map(([t]) => 1 / t);
    const ys = points.map(([, p]) => p);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxx = 0;
    let sxy = 0;
    xs.forEach((x, i) => {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (ys[i] - my);
    });
    const w = sxx ? sxy / sxx : NaN;
    const c = my - w * mx;
    if (w >= 3000 && w <= 50000 && c > 0 && c < points[0][1]) {
      cp = Math.round(c);
      wPrime = Math.round(w / 100) / 10;
    }
  }
  const zonesFor = (watts: number) => COGGAN.map(([name, from, to], i) => ({ zone: i + 1, name, from_w: Math.round(from * watts), to_w: to === null ? null : Math.round(to * watts) }));
  return { ftp_estimate_w: ftp, ftp_basis: basis, critical_power_w: cp, w_prime_kj: wPrime, zones: ftp !== null ? zonesFor(ftp) : null };
}
