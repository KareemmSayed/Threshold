/** Small, dependency-free statistics. Inputs may contain nulls; they are skipped. */

export type Maybe = number | null | undefined;

export const finite = (v: Maybe): v is number => typeof v === "number" && Number.isFinite(v);

export function values(xs: Maybe[]): number[] {
  return xs.filter(finite);
}

export function mean(xs: Maybe[]): number | null {
  const v = values(xs);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function sd(xs: Maybe[]): number | null {
  const v = values(xs);
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

export function median(xs: Maybe[]): number | null {
  const v = values(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function sum(xs: Maybe[]): number {
  return values(xs).reduce((a, b) => a + b, 0);
}

/** Least-squares slope and fit of y against x (x in days). */
export function linearTrend(points: Array<[number, number]>): { slopePerDay: number; r2: number } | null {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slopePerDay: slope, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

export function round(v: Maybe, digits = 1): number | null {
  if (!finite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** z-score of `x` against a sample, or null when the sample is too small or flat. */
export function zScore(x: Maybe, sample: Maybe[]): number | null {
  const m = mean(sample);
  const s = sd(sample);
  if (!finite(x) || m === null || !s) return null;
  return (x - m) / s;
}

/** Percent change from `a` to `b`. */
export function pctChange(a: Maybe, b: Maybe): number | null {
  if (!finite(a) || !finite(b) || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}
