/**
 * Load forecast: fitness (CTL), fatigue (ATL) and form (TSB) projected forward for a plan.
 *
 * The future is the athlete's own weekday pattern from the last four weeks, scaled, tapered
 * or replaced by rest, with any explicitly planned days on top. It answers "what will my
 * form be on race day if I taper like this?" with the same arithmetic as training_load,
 * so the numbers line up with today's.
 */
import { addDays, daysBetween, eachDate } from "../util/dates";
import { performanceChart, type LoadDay } from "./load";

export type Scenario = "maintain" | "taper" | "rest";

export interface ForecastPlan {
  scenario: Scenario;
  /** Percent of the usual load to train at (100 = as in the last four weeks). */
  scalePct: number;
  /** Length of the taper before the end date. */
  taperDays: number;
  /** Share of the usual load left on the last day of the taper. */
  taperFloorPct: number;
  /** Loads the athlete has planned for specific dates; these override the scenario. */
  planned: Map<string, number>;
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Mean load on each weekday (0 = Sunday) over the `days` days ending at `end`. */
export function weekdayPattern(loads: Map<string, number>, end: string, days = 28): number[] {
  const sums = new Array<number>(7).fill(0);
  const counts = new Array<number>(7).fill(0);
  for (const d of eachDate(addDays(end, -(days - 1)), end)) {
    sums[weekday(d)] += loads.get(d) ?? 0;
    counts[weekday(d)]++;
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
}

/** The load the plan puts on one future day. */
export function plannedLoad(date: string, end: string, pattern: number[], plan: ForecastPlan): number {
  const explicit = plan.planned.get(date);
  if (explicit !== undefined) return explicit;
  if (plan.scenario === "rest") return 0;
  let load = pattern[weekday(date)] * (plan.scalePct / 100);
  if (plan.scenario === "taper") {
    const before = daysBetween(date, end);
    if (before <= plan.taperDays) {
      const floor = plan.taperFloorPct / 100;
      load *= floor + (1 - floor) * (before / plan.taperDays);
    }
  }
  return load;
}

export interface Forecast {
  /** Today, after today's training so far. */
  now: LoadDay;
  /** One row per day from tomorrow to the end date. `tsb` is the form going into that day. */
  days: LoadDay[];
  end: LoadDay;
  pattern: number[];
}

/**
 * Project the load chart from `today` to `end`. `loads` holds the past (date -> load);
 * `warmupStart` is where the averages start, as in training_load.
 */
export function forecast(loads: Map<string, number>, warmupStart: string, today: string, end: string, plan: ForecastPlan): Forecast {
  const pattern = weekdayPattern(loads, today);
  const all = new Map(loads);
  const todayExtra = plan.planned.get(today);
  if (todayExtra !== undefined) all.set(today, (all.get(today) ?? 0) + todayExtra);
  for (const d of eachDate(addDays(today, 1), end)) all.set(d, plannedLoad(d, end, pattern, plan));
  const chart = performanceChart(all, warmupStart, end);
  const days = chart.filter((d) => d.date > today);
  return { now: chart[chart.length - 1 - days.length], days, end: chart[chart.length - 1], pattern };
}

export interface ScaleSolution {
  reachable: boolean;
  /** Percent of the usual load that lands on the target form, when reachable. */
  scale_pct: number | null;
  /** Form on the end date with full rest and with three times the usual load: the reachable range. */
  highest_tsb: number;
  lowest_tsb: number;
}

/** The load scale that gives a target form on the end date. More load means lower form, so bisect. */
export function solveScale(loads: Map<string, number>, warmupStart: string, today: string, end: string, plan: ForecastPlan, targetTsb: number): ScaleSolution {
  const tsbAt = (scalePct: number) => forecast(loads, warmupStart, today, end, { ...plan, scalePct }).end.tsb;
  const highest = tsbAt(0);
  const lowest = tsbAt(300);
  if (targetTsb > highest || targetTsb < lowest) return { reachable: false, scale_pct: null, highest_tsb: highest, lowest_tsb: lowest };
  let lo = 0;
  let hi = 300;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (tsbAt(mid) > targetTsb) lo = mid;
    else hi = mid;
  }
  return { reachable: true, scale_pct: Math.round((lo + hi) / 2), highest_tsb: highest, lowest_tsb: lowest };
}
