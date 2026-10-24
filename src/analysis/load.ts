/**
 * Training load: acute and chronic load, form, ACWR, monotony and strain.
 *
 * Per-activity load uses Garmin's own training load when the activity has one,
 * then TSS, then Banister TRIMP from heart rate. Fitness (CTL) and fatigue
 * (ATL) are exponentially weighted averages with 42- and 7-day time constants;
 * form (TSB) is yesterday's fitness minus yesterday's fatigue.
 */
import type { ProfileFacts } from "../context";
import type { ActivityRow } from "../archive/store";
import { addDays, eachDate } from "../util/dates";
import { mean, round, sd, sum } from "./stats";

export type LoadSource = "garmin" | "tss" | "trimp" | "none";

export function activityLoad(a: ActivityRow, facts: Pick<ProfileFacts, "restingHr" | "maxHr" | "gender">): { load: number; source: LoadSource } {
  if (a.garmin_load && a.garmin_load > 0) return { load: a.garmin_load, source: "garmin" };
  if (a.tss && a.tss > 0) return { load: a.tss, source: "tss" };
  const minutes = (a.moving_s ?? a.duration_s ?? 0) / 60;
  const rest = facts.restingHr ?? 60;
  const max = facts.maxHr ?? 190;
  if (a.avg_hr && minutes > 0 && max > rest) {
    const ratio = Math.min(1, Math.max(0, (a.avg_hr - rest) / (max - rest)));
    const k = facts.gender === "female" ? 1.67 : 1.92;
    const weight = facts.gender === "female" ? 0.86 : 0.64;
    return { load: minutes * ratio * weight * Math.exp(k * ratio), source: "trimp" };
  }
  return { load: 0, source: "none" };
}

export interface LoadDay {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
}

const CTL_DAYS = 42;
const ATL_DAYS = 7;

/** Longest report window (training_load accepts up to 365 days) plus 120 days to warm up the averages. */
export const LOAD_HISTORY_DAYS = 365 + 120;

/**
 * First day of the load chart for a report ending on `end`. It depends on the
 * end date only, so every tool reports the same CTL, ATL and TSB for a day.
 */
export function loadWarmupStart(end: string): string {
  return addDays(end, -LOAD_HISTORY_DAYS);
}

/** Daily load series with fitness, fatigue and form. `loads` maps date -> total load. */
export function performanceChart(loads: Map<string, number>, start: string, end: string): LoadDay[] {
  const kc = 1 - Math.exp(-1 / CTL_DAYS);
  const ka = 1 - Math.exp(-1 / ATL_DAYS);
  let ctl = 0;
  let atl = 0;
  const out: LoadDay[] = [];
  for (const date of eachDate(start, end)) {
    const load = loads.get(date) ?? 0;
    const tsb = ctl - atl;
    ctl += (load - ctl) * kc;
    atl += (load - atl) * ka;
    out.push({ date, load, ctl, atl, tsb });
  }
  return out;
}

/** Daily load, fitness, fatigue and form from `start` to `end`, for charts. */
export function loadChart(activities: ActivityRow[], facts: ProfileFacts, start: string, end: string, warmupStart: string): LoadDay[] {
  const loads = new Map<string, number>();
  for (const a of activities) if (a.date) loads.set(a.date, (loads.get(a.date) ?? 0) + activityLoad(a, facts).load);
  return performanceChart(loads, warmupStart, end).filter((d) => d.date >= start);
}

export function formLabel(tsb: number, ctl: number): string {
  // Scale thresholds to fitness so they suit both low- and high-volume athletes.
  const pct = ctl > 0 ? (tsb / ctl) * 100 : 0;
  if (ctl < 5) return "not enough training history to judge form";
  if (pct < -30) return "very fatigued: high injury and illness risk if this continues";
  if (pct < -10) return "productive fatigue: typical of a building block";
  if (pct <= 5) return "neutral: balanced training and recovery";
  if (pct <= 25) return "fresh: good for a key session or race";
  return "very fresh: fitness is starting to fade (taper or break)";
}

export function acwrLabel(ratio: number | null): string {
  if (ratio === null) return "not enough history";
  if (ratio < 0.8) return "below 0.8: load is dropping (undertraining or recovery)";
  if (ratio <= 1.3) return "0.8-1.3: sweet spot";
  if (ratio <= 1.5) return "1.3-1.5: caution, load is rising fast";
  return "above 1.5: spike, highest injury risk";
}

export interface LoadReport {
  as_of: string;
  current: {
    fitness_ctl: number | null;
    fatigue_atl: number | null;
    form_tsb: number | null;
    form: string;
    acwr: number | null;
    acwr_zone: string;
    ramp_rate_ctl_per_week: number | null;
    monotony: number | null;
    strain: number | null;
    load_last_7_days: number;
    load_last_28_days: number;
  };
  weekly: Array<{ week_of: string; load: number; ctl_end: number; atl_end: number; tsb_end: number; activities: number; hours: number }>;
  by_sport_last_28_days: Record<string, { activities: number; load: number; hours: number }>;
  load_sources: Record<LoadSource, number>;
  method: string;
}

export function loadReport(activities: ActivityRow[], facts: ProfileFacts, start: string, end: string, warmupStart: string): LoadReport {
  const loads = new Map<string, number>();
  const sources: Record<LoadSource, number> = { garmin: 0, tss: 0, trimp: 0, none: 0 };
  const perActivity = activities.map((a) => {
    const l = activityLoad(a, facts);
    sources[l.source]++;
    if (a.date) loads.set(a.date, (loads.get(a.date) ?? 0) + l.load);
    return { a, ...l };
  });
  const chart = performanceChart(loads, warmupStart, end);
  const visible = chart.filter((d) => d.date >= start);
  const last = chart[chart.length - 1];
  const daily = (days: number) => chart.slice(-days).map((d) => d.load);
  const acute = sum(daily(7)) / 7;
  const chronic = sum(daily(28)) / 28;
  const weekAgo = chart[chart.length - 8];
  const last7 = daily(7);
  const m = mean(last7);
  const s = sd(last7);
  const monotony = m !== null && s ? m / s : null;

  const weekly = new Map<string, { load: number; days: LoadDay[]; activities: number; seconds: number }>();
  for (const d of visible) {
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    const monday = addDays(d.date, -((dow + 6) % 7));
    const w = weekly.get(monday) ?? { load: 0, days: [], activities: 0, seconds: 0 };
    w.load += d.load;
    w.days.push(d);
    weekly.set(monday, w);
  }
  for (const { a } of perActivity) {
    if (!a.date || a.date < start) continue;
    const dow = new Date(`${a.date}T00:00:00Z`).getUTCDay();
    const w = weekly.get(addDays(a.date, -((dow + 6) % 7)));
    if (w) {
      w.activities++;
      w.seconds += a.duration_s ?? 0;
    }
  }

  const bySport: LoadReport["by_sport_last_28_days"] = {};
  const since = addDays(end, -27);
  for (const { a, load } of perActivity) {
    if (!a.date || a.date < since) continue;
    const b = (bySport[a.sport] ??= { activities: 0, load: 0, hours: 0 });
    b.activities++;
    b.load += load;
    b.hours += (a.duration_s ?? 0) / 3600;
  }
  for (const b of Object.values(bySport)) {
    b.load = Math.round(b.load);
    b.hours = round(b.hours, 1)!;
  }

  const acwr = chronic > 0 ? acute / chronic : null;
  return {
    as_of: end,
    current: {
      fitness_ctl: round(last?.ctl),
      fatigue_atl: round(last?.atl),
      form_tsb: round(last?.tsb),
      form: last ? formLabel(last.tsb, last.ctl) : "no data",
      acwr: round(acwr, 2),
      acwr_zone: acwrLabel(acwr),
      ramp_rate_ctl_per_week: last && weekAgo ? round(last.ctl - weekAgo.ctl) : null,
      monotony: round(monotony, 2),
      strain: monotony !== null ? Math.round(sum(last7) * monotony) : null,
      load_last_7_days: Math.round(sum(daily(7))),
      load_last_28_days: Math.round(sum(daily(28))),
    },
    weekly: [...weekly.entries()].map(([week, w]) => {
      const lastDay = w.days[w.days.length - 1];
      return {
        week_of: week,
        load: Math.round(w.load),
        ctl_end: round(lastDay.ctl)!,
        atl_end: round(lastDay.atl)!,
        tsb_end: round(lastDay.tsb)!,
        activities: w.activities,
        hours: round(w.seconds / 3600, 1)!,
      };
    }),
    by_sport_last_28_days: bySport,
    load_sources: sources,
    method:
      "Load per activity: Garmin training load, else TSS, else Banister TRIMP from average HR. CTL/ATL: exponentially weighted 42/7-day averages over the 485 days before as_of. TSB = yesterday's CTL - yesterday's ATL (form going into the day, so the day's own load is not counted). ACWR = 7-day mean load / 28-day mean load. Monotony = 7-day mean / SD; strain = 7-day load x monotony (Foster).",
  };
}
