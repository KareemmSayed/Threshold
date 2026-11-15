/**
 * Correlation between two daily series, with a lag.
 *
 * SQLite has no correlation function, so without this the model would have to do the
 * arithmetic itself. The numbers here say how two metrics move together; they never say
 * why. Small samples and many comparisons both produce patterns that are not real.
 */
import { finite, mean, round, type Maybe } from "./stats";

function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Ranks from 1, ties sharing their average rank. */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

/** Pair x on day d with y on day d + lag, keeping days where both exist. */
export function pairs(x: Maybe[], y: Maybe[], lag: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + lag < y.length && i < x.length; i++) {
    const a = x[i];
    const b = y[i + lag];
    if (finite(a) && finite(b)) out.push([a, b]);
  }
  return out;
}

export const MIN_PAIRS = 20;

export function strength(r: number | null, n: number): string {
  if (r === null || n < MIN_PAIRS) return "not enough data";
  const a = Math.abs(r);
  const size = a < 0.1 ? "none" : a < 0.3 ? "weak" : a < 0.5 ? "moderate" : "strong";
  return size === "none" ? "none" : `${size} ${r > 0 ? "positive" : "negative"}`;
}

export interface Correlation {
  n: number;
  pearson_r: number | null;
  /** Rank correlation: steadier than Pearson when a few days are extreme. */
  spearman_rho: number | null;
  /** 95% interval for Pearson's r (Fisher transform); null below 10 pairs. */
  r_95_interval: [number, number] | null;
  strength: string;
  /** Mean of y on the days x was in its top third, and in its bottom third. */
  y_when_x_high: { mean: number | null; n: number };
  y_when_x_low: { mean: number | null; n: number };
}

export function correlate(x: Maybe[], y: Maybe[], lag = 0): Correlation {
  const p = pairs(x, y, lag);
  const xs = p.map(([a]) => a);
  const ys = p.map(([, b]) => b);
  const n = p.length;
  const r = pearson(xs, ys);
  const rho = n >= 3 ? pearson(ranks(xs), ranks(ys)) : null;
  let interval: [number, number] | null = null;
  if (r !== null && n >= 10 && Math.abs(r) < 1) {
    const z = Math.atanh(r);
    const se = 1 / Math.sqrt(n - 3);
    interval = [round(Math.tanh(z - 1.96 * se), 2)!, round(Math.tanh(z + 1.96 * se), 2)!];
  }
  const sorted = [...p].sort((a, b) => a[0] - b[0]);
  const third = Math.floor(n / 3);
  const low = third ? sorted.slice(0, third).map(([, b]) => b) : [];
  const high = third ? sorted.slice(-third).map(([, b]) => b) : [];
  return {
    n,
    pearson_r: round(r, 2),
    spearman_rho: round(rho, 2),
    r_95_interval: interval,
    strength: strength(r, n),
    y_when_x_high: { mean: round(mean(high), 2), n: high.length },
    y_when_x_low: { mean: round(mean(low), 2), n: low.length },
  };
}
