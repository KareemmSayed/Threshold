/**
 * Training status and load focus.
 *
 * Garmin's Training Status and Load Focus are not in the Personal API. These are Threshold's
 * own versions, built from what the archive holds: the load chart, the VO2 max decoded from
 * each activity, and the training effect and heart-rate zones of each activity. The rules are
 * simple and shown; they are not Garmin's algorithms.
 */
import type { ActivityRow } from "../archive/store";
import type { ProfileFacts } from "../context";
import { addDays, daysBetween } from "../util/dates";
import { activityLoad, type LoadReport } from "./load";
import { finite, mean, round } from "./stats";

export interface FocusBucket {
  load: number;
  pct: number | null;
}

export interface LoadFocus {
  from: string;
  to: string;
  low_aerobic: FocusBucket;
  high_aerobic: FocusBucket;
  anaerobic: FocusBucket;
  /** Load of activities with no zones and no training effect label. */
  unclassified_load: number;
  shortages: string[];
  verdict: string;
  rule: string;
}

const LOW_LABELS = new Set(["RECOVERY", "AEROBIC_BASE"]);
const HIGH_LABELS = new Set(["TEMPO", "LACTATE_THRESHOLD", "VO2MAX", "ANAEROBIC_CAPACITY", "SPEED"]);

/**
 * Where the last four weeks of load went. The anaerobic share of an activity is its anaerobic
 * training effect over the sum of both effects; the rest is split between low aerobic (HR zones
 * 1-2) and high aerobic (zones 3-5) by time in zone, or by Garmin's label when there are no zones.
 */
export function loadFocus(activities: ActivityRow[], facts: ProfileFacts, start: string, end: string): LoadFocus {
  let low = 0;
  let high = 0;
  let anaerobic = 0;
  let unclassified = 0;
  for (const a of activities) {
    if (!a.date || a.date < start || a.date > end) continue;
    const { load } = activityLoad(a, facts);
    if (!(load > 0)) continue;
    const te = (a.aerobic_te ?? 0) + (a.anaerobic_te ?? 0);
    const anaerobicLoad = te > 0 ? load * ((a.anaerobic_te ?? 0) / te) : 0;
    const aerobicLoad = load - anaerobicLoad;
    const easy = (a.hr_zone1_s ?? 0) + (a.hr_zone2_s ?? 0);
    const hard = (a.hr_zone3_s ?? 0) + (a.hr_zone4_s ?? 0) + (a.hr_zone5_s ?? 0);
    const label = a.training_effect_label ?? "";
    anaerobic += anaerobicLoad;
    if (easy + hard > 0) {
      low += aerobicLoad * (easy / (easy + hard));
      high += aerobicLoad * (hard / (easy + hard));
    } else if (LOW_LABELS.has(label)) low += aerobicLoad;
    else if (HIGH_LABELS.has(label)) high += aerobicLoad;
    else {
      // Nothing says how hard it was.
      anaerobic -= anaerobicLoad;
      unclassified += load;
    }
  }
  const total = low + high + anaerobic;
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : null);
  const shortages: string[] = [];
  if (total > 0) {
    if (low / total < 0.45) shortages.push("low aerobic (easy volume)");
    if (high / total < 0.2) shortages.push("high aerobic (tempo, threshold, VO2 max work)");
    if (anaerobic / total < 0.05) shortages.push("anaerobic (short, hard reps and sprints)");
  }
  const heavy = total > 0 && anaerobic / total > 0.25;
  return {
    from: start,
    to: end,
    low_aerobic: { load: Math.round(low), pct: pct(low) },
    high_aerobic: { load: Math.round(high), pct: pct(high) },
    anaerobic: { load: Math.round(anaerobic), pct: pct(anaerobic) },
    unclassified_load: Math.round(unclassified),
    shortages,
    verdict: !total ? "No classified load in this period." : heavy ? "Anaerobic-heavy: more than a quarter of the load came from hard, short efforts." : shortages.length ? `Short on ${shortages.join(" and ")}.` : "Balanced across low aerobic, high aerobic and anaerobic work.",
    rule: "Rule-of-thumb bands, not Garmin's Load Focus targets: low aerobic at least 45%, high aerobic at least 20%, anaerobic 5 to 25% of classified load.",
  };
}

export interface Vo2Trend {
  sport: string;
  latest: number;
  latest_date: string;
  /** Mean of the last 14 days minus the mean of the 28 days before; null with too few readings. */
  change: number | null;
  direction: "rising" | "falling" | "flat" | "unknown";
  readings: number;
}

/** The trend of the VO2 max estimate over six weeks, for the sport with the most readings. */
export function vo2Trend(activities: ActivityRow[], end: string): Vo2Trend | null {
  const from = addDays(end, -41);
  const bySport = new Map<string, Array<{ date: string; v: number }>>();
  for (const a of activities) {
    const v = a.vo2max ?? a.fit_vo2max;
    if (!a.date || a.date < from || a.date > end || !finite(v)) continue;
    bySport.set(a.sport, [...(bySport.get(a.sport) ?? []), { date: a.date, v }]);
  }
  let best: [string, Array<{ date: string; v: number }>] | null = null;
  for (const entry of bySport) if (!best || entry[1].length > best[1].length) best = entry;
  if (!best) return null;
  const [sport, points] = best;
  const split = addDays(end, -13);
  const recent = points.filter((p) => p.date >= split).map((p) => p.v);
  const earlier = points.filter((p) => p.date < split).map((p) => p.v);
  const change = recent.length >= 2 && earlier.length >= 2 ? mean(recent)! - mean(earlier)! : null;
  const last = points[points.length - 1];
  return {
    sport,
    latest: last.v,
    latest_date: last.date,
    change: round(change, 1),
    direction: change === null ? "unknown" : change >= 0.4 ? "rising" : change <= -0.4 ? "falling" : "flat",
    readings: points.length,
  };
}

export type Status = "productive" | "maintaining" | "peaking" | "recovery" | "unproductive" | "overreaching" | "detraining" | "building" | "easing" | "not enough data";

export interface TrainingStatus {
  status: Status;
  basis: "load and VO2 max" | "load only";
  reason: string;
  rule: string;
}

/**
 * One word for how training is going, from the load chart and the VO2 max trend:
 *   detraining: almost no load for a week or more
 *   overreaching: load spiked (ACWR above 1.5) or form is far below fitness
 *   peaking / recovery: load is easing; peaking when fitness holds and form is positive
 *   unproductive: load is holding but VO2 max is falling
 *   productive: load is holding or rising and VO2 max is rising
 *   maintaining: both steady. Without a VO2 max trend: building, maintaining or easing from the CTL ramp.
 */
export function trainingStatus(load: LoadReport, vo2: Vo2Trend | null, lastActivityDate: string | null): TrainingStatus {
  const c = load.current;
  const rule = "Threshold's own rules from the load chart and the VO2 max trend; not Garmin's Training Status.";
  const basis = vo2 && vo2.direction !== "unknown" ? "load and VO2 max" : "load only";
  if (c.fitness_ctl === null || c.fitness_ctl < 5 || c.acwr === null) return { status: "not enough data", basis: "load only", reason: "Too little training history for a status.", rule };
  const tsbPct = ((c.form_tsb ?? 0) / c.fitness_ctl) * 100;
  const idle = lastActivityDate ? daysBetween(lastActivityDate, load.as_of) : null;
  const vo2Text = vo2 && vo2.change !== null ? `VO2 max ${vo2.change > 0 ? "+" : ""}${vo2.change} over the last two weeks` : "no VO2 max trend";
  const say = (status: Status, reason: string): TrainingStatus => ({ status, basis, reason, rule });

  if (c.acwr < 0.5 && (idle === null || idle >= 7)) return say("detraining", `Load has almost stopped (ACWR ${c.acwr}${idle !== null ? `, ${idle} days since the last activity` : ""}): fitness is fading.`);
  if (c.acwr > 1.5 || tsbPct < -30) return say("overreaching", `Load is far above what you are used to (ACWR ${c.acwr}, form ${Math.round(tsbPct)}% of fitness): back off before it costs you.`);
  if (c.acwr < 0.8) {
    if (tsbPct >= 5 && vo2?.direction !== "falling") return say("peaking", `Load is easing (ACWR ${c.acwr}) while form is positive and fitness holds (${vo2Text}): ready for a key effort.`);
    return say("recovery", `Load is easing (ACWR ${c.acwr}); ${vo2Text}. A lighter spell that lets the body absorb earlier work.`);
  }
  if (vo2?.direction === "falling") return say("unproductive", `Load is holding (ACWR ${c.acwr}) but ${vo2Text}: check recovery, sleep and whether the easy days are easy.`);
  if (vo2?.direction === "rising") return say("productive", `Load is holding or rising (ACWR ${c.acwr}) and ${vo2Text}.`);
  if (vo2?.direction === "flat") return say("maintaining", `Load is steady (ACWR ${c.acwr}) and ${vo2Text}.`);
  const ramp = c.ramp_rate_ctl_per_week ?? 0;
  if (ramp >= 1.5) return say("building", `Fitness load is rising (CTL ${ramp > 0 ? "+" : ""}${ramp} per week, ACWR ${c.acwr}); ${vo2Text}.`);
  if (ramp <= -1.5) return say("easing", `Fitness load is falling (CTL ${ramp} per week, ACWR ${c.acwr}); ${vo2Text}.`);
  return say("maintaining", `Load is steady (ACWR ${c.acwr}, CTL ${ramp > 0 ? "+" : ""}${ramp} per week); ${vo2Text}.`);
}
