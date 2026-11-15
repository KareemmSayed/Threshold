/**
 * The daily briefing: every recovery and training signal for one day, each
 * judged against the athlete's own baseline, plus a transparent overall call.
 * It is not Garmin's Training Readiness (the Personal API does not expose it);
 * every input and rule is shown so the reasoning can be checked.
 */
import type { ActivityRow, DailyRow } from "../archive/store";
import type { ProfileFacts } from "../context";
import { formatDuration, hoursMinutes } from "../fit/analyze";
import { addDays, daysBetween } from "../util/dates";
import { loadReport } from "./load";
import { hrvReport, illnessWatch, overnightStressReport, rhrReport, sleepReport, sleepRespirationReport, type HrvOptions } from "./recovery";
import { finite, mean, round } from "./stats";

type Level = "good" | "ok" | "caution" | "warning";

interface Signal {
  signal: string;
  level: Level;
  /** The headline number, short enough for a chip: "47 bpm · +1". */
  reading: string;
  detail: string;
  /** The data behind this signal has not arrived yet, so it is not judged and not counted. */
  stale?: true;
}

/** The next race in the calendar, for the countdown. */
export interface UpcomingEvent {
  id: number;
  name: string;
  date: string;
  sport: string | null;
  distance_m: number | null;
  goal_time_s: number | null;
  priority: string | null;
}

export interface BriefingOptions extends HrvOptions {
  /** Today's date. When the briefing is for today, signals whose data has not synced are marked stale. */
  today?: string;
  /** The current time in epoch milliseconds, for the recovery countdown. */
  now?: number;
  event?: UpcomingEvent | null;
}

const RECOVERY_SIGNALS = ["HRV", "Resting HR", "Sleep", "Overnight stress", "Sleep breathing"];
const signed = (v: number | null) => (v === null ? "?" : `${v > 0 ? "+" : ""}${v}`);

export function eventPhase(daysToGo: number): string {
  if (daysToGo <= 0) return "race day";
  if (daysToGo <= 7) return "race week";
  if (daysToGo <= 14) return "taper";
  if (daysToGo <= 56) return "specific build";
  return "base and build";
}

/** Garmin's "...GMT" activity start ("2026-11-12 18:15:12") as epoch milliseconds. */
function gmtMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value.replace(" ", "T").replace(/\.\d+$/, "")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Hours of recovery left, from the recovery time Garmin writes into the FIT file's
 * undocumented message 140 at the end of the latest activity. Experimental.
 */
export function recoveryCountdown(activities: ActivityRow[], now: number) {
  const latest = [...activities].reverse().find((a) => finite(a.fit_recovery_min) && a.fit_recovery_min > 0 && gmtMs(a.start_gmt) !== null);
  if (!latest) return null;
  const end = gmtMs(latest.start_gmt)! + (latest.duration_s ?? 0) * 1000;
  if (end > now || now - end > 5 * 86_400_000) return null;
  const left = latest.fit_recovery_min! - (now - end) / 60_000;
  return {
    hours_left: Math.max(0, Math.round(left / 60)),
    hours_at_finish: Math.round(latest.fit_recovery_min! / 60),
    from_activity_id: latest.activity_id,
    note: "Experimental: counted down from an undocumented field in the activity file. It is not part of the overall call.",
  };
}

export function briefing(date: string, rows: DailyRow[], activities: ActivityRow[], facts: ProfileFacts, warmupStart: string, opts: BriefingOptions = {}) {
  const hrv = hrvReport(rows, date, opts);
  const rhr = rhrReport(rows, date);
  const sleep = sleepReport(rows, date);
  const stress = overnightStressReport(rows, date);
  const breathing = sleepRespirationReport(rows, date);
  const load = loadReport(activities, facts, addDays(date, -27), date, warmupStart);
  const today = rows.find((r) => r.date === date);
  const signals: Signal[] = [];

  // A briefing for today often runs before the watch has synced the night. An athlete who
  // tracks sleep but has no night for today has not synced since waking, so last night's
  // sleep and today's Body Battery are not known yet.
  const isToday = opts.today !== undefined && date === opts.today;
  const tracksSleep = sleep.latest_night !== null && daysBetween(String(sleep.latest_night.date), date) <= 3;
  const awaitingSync = isToday && sleep.last_night === null && tracksSleep;

  if (hrv.status_7d !== "no data") {
    const level: Level = hrv.status_7d === "low" ? "warning" : hrv.status_7d === "slightly low" ? "caution" : "good";
    signals.push({
      signal: "HRV",
      level,
      reading: `${hrv.rolling_7d_ms ?? "?"} ms · ${hrv.status_7d}`,
      detail: `7-day avg ${hrv.rolling_7d_ms ?? "?"} ms from ${hrv.nights_in_7d} of 7 nights vs normal ${hrv.normal_range_ms ? hrv.normal_range_ms.join("-") : "n/a"} ms (${hrv.status_7d}${hrv.confidence === "low" ? ", low confidence" : ""}); last night ${hrv.last_night_ms ?? "?"} ms${hrv.last_night_z !== null ? `, z ${hrv.last_night_z}` : ""}.`,
    });
  }
  if (rhr.status !== "no data") {
    signals.push({
      signal: "Resting HR",
      level: rhr.status === "elevated" ? (rhr.delta_bpm !== null && rhr.delta_bpm >= 5 ? "warning" : "caution") : "good",
      reading: `${rhr.rolling_7d_bpm ?? "?"} bpm · ${signed(rhr.delta_bpm)}`,
      detail: `7-day avg ${rhr.rolling_7d_bpm ?? "?"} bpm vs baseline ${rhr.baseline_bpm ?? "?"} bpm (${signed(rhr.delta_bpm)}).`,
    });
  }
  if (sleep.last_night) {
    const h = sleep.last_night.hours as number;
    const level: Level = h < 5.5 ? "warning" : h < 6.5 || sleep.status === "low" ? "caution" : "good";
    signals.push({
      signal: "Sleep",
      level,
      reading: `${hoursMinutes(h * 3600)}${sleep.last_night.score ? ` · score ${sleep.last_night.score}` : ""}`,
      detail: `Last night ${hoursMinutes(h * 3600)}${sleep.last_night.score ? `, score ${sleep.last_night.score}` : ""}; 7-day avg ${sleep.avg_7d_hours ?? "?"} h vs usual ${sleep.baseline_hours ?? "?"} h.`,
    });
  } else if (sleep.avg_7d_hours !== null) {
    // No night for this date: judge the week only, and say whose night is missing.
    signals.push({
      signal: "Sleep",
      level: sleep.status === "low" ? "caution" : "good",
      reading: `${sleep.avg_7d_hours} h avg · ${awaitingSync ? "not synced" : "no night"}`,
      detail: `${awaitingSync ? "Last night has not synced yet" : "No sleep recorded for last night"}; latest night ${sleep.latest_night?.date ?? "?"}. 7-day avg ${sleep.avg_7d_hours} h vs usual ${sleep.baseline_hours ?? "?"} h.`,
      stale: awaitingSync ? true : undefined,
    });
  }
  if (stress.status !== "no data") {
    const up = stress.status === "elevated";
    signals.push({
      signal: "Overnight stress",
      level: up ? ((stress.delta ?? 0) >= 10 ? "warning" : "caution") : "good",
      reading: `${stress.rolling_7d ?? "?"} · ${signed(stress.delta)}`,
      detail: `Stress during sleep, 7-day avg ${stress.rolling_7d ?? "?"} vs baseline ${stress.baseline ?? "?"} (${signed(stress.delta)}); latest night ${stress.latest ?? "?"}.`,
    });
  }
  if (breathing.status !== "no data") {
    const up = breathing.status === "elevated";
    signals.push({
      signal: "Sleep breathing",
      level: up ? ((breathing.delta ?? 0) >= 2 ? "warning" : "caution") : "good",
      reading: `${breathing.rolling_7d ?? "?"} brpm · ${signed(breathing.delta)}`,
      detail: `Breathing rate during sleep, 7-day avg ${breathing.rolling_7d ?? "?"} vs baseline ${breathing.baseline ?? "?"} breaths/min (${signed(breathing.delta)}); latest night ${breathing.latest ?? "?"}.`,
    });
  }
  const bbHigh = today?.body_battery_high as number | undefined;
  if (awaitingSync) {
    signals.push({
      signal: "Body Battery",
      level: "ok",
      reading: "not synced since waking",
      detail: `Today's Body Battery is not known until the watch syncs${finite(bbHigh) ? ` (the value so far, ${bbHigh}, is from before the night)` : ""}.`,
      stale: true,
    });
  } else if (finite(bbHigh)) {
    const usual = mean(rows.filter((r) => r.date < date && r.date >= addDays(date, -30)).map((r) => r.body_battery_high as number));
    signals.push({
      signal: "Body Battery",
      level: bbHigh < 40 ? "warning" : bbHigh < 60 ? "caution" : "good",
      reading: `charged to ${bbHigh}`,
      detail: `Charged to ${bbHigh} today${usual !== null ? ` (30-day avg ${Math.round(usual)})` : ""}.`,
    });
  }
  if (load.current.fitness_ctl !== null && load.current.fitness_ctl >= 5) {
    const tsb = load.current.form_tsb ?? 0;
    const ctl = load.current.fitness_ctl;
    const pct = (tsb / ctl) * 100;
    signals.push({
      signal: "Training form",
      level: pct < -30 ? "warning" : pct < -10 ? "ok" : "good",
      reading: `TSB ${tsb}`,
      detail: `TSB ${tsb} (CTL ${ctl}, ATL ${load.current.fatigue_atl}): ${load.current.form}.`,
    });
  }
  if (load.current.acwr !== null) {
    const r = load.current.acwr;
    signals.push({
      signal: "Load ramp",
      level: r > 1.5 ? "warning" : r > 1.3 ? "caution" : "good",
      reading: `ACWR ${r}`,
      detail: `ACWR ${r}: ${load.current.acwr_zone}.`,
    });
  }

  const judged = signals.filter((s) => !s.stale);
  const warnings = judged.filter((s) => s.level === "warning").length;
  const cautions = judged.filter((s) => s.level === "caution").length;
  const recoveryHit = judged.filter((s) => RECOVERY_SIGNALS.includes(s.signal) && (s.level === "warning" || s.level === "caution")).length;
  const status = warnings >= 2 || recoveryHit >= 2 ? "red" : warnings === 1 || cautions >= 2 ? "amber" : judged.length ? "green" : "unknown";
  let suggestion = {
    green: "Signals support the planned training, including hard sessions.",
    amber: "Mixed signals. Keep intensity moderate or shift the hardest session by a day; easy aerobic work is fine.",
    red: "Several recovery signals are off. Prioritize rest or very easy movement, sleep and fuelling, and watch for illness.",
    unknown: "Not enough data yet. Wear the watch overnight for a few nights.",
  }[status];

  const event = opts.event ?? null;
  const daysToGo = event ? daysBetween(date, event.date) : null;
  if (event && daysToGo !== null && daysToGo >= 0 && daysToGo <= 7) {
    suggestion += daysToGo === 0 ? ` Race day: ${event.name}.` : ` ${event.name} is in ${daysToGo} day${daysToGo === 1 ? "" : "s"}: keep any intensity short and the volume low.`;
  }

  const lastActivity = [...activities].reverse().find((a) => a.date && a.date <= date);
  return {
    date,
    overall: {
      status,
      suggestion,
      rule: "red: 2+ warnings or 2+ recovery signals off (HRV, resting HR, sleep, overnight stress, sleep breathing); amber: 1 warning or 2+ cautions; else green. Signals marked stale are not counted.",
    },
    data_freshness: isToday
      ? {
          last_night_synced: !awaitingSync,
          latest_night: sleep.last_night?.date ?? sleep.latest_night?.date ?? null,
          note: awaitingSync
            ? `Last night is not in the archive yet (latest night: ${sleep.latest_night?.date}): the watch has most likely not synced since waking. Sleep and Body Battery are left out of the call. Sync the watch in Garmin Connect, run sync_now, and ask again. If the watch was off last night, there is no night to wait for.`
            : undefined,
        }
      : undefined,
    signals,
    illness_watch: illnessWatch({ hrv, rhr, stress, respiration: breathing }),
    last_night: sleep.last_night,
    latest_night: sleep.latest_night,
    sleep_week: {
      debt_7d_hours: sleep.sleep_debt_7d_hours,
      regularity: sleep.consistency?.regularity ?? null,
      avg_bedtime: sleep.consistency?.avg_bedtime ?? null,
      bedtime_sd_min: sleep.consistency?.bedtime_sd_min ?? null,
    },
    today: today
      ? {
          steps: today.steps ?? null,
          resting_hr: today.resting_hr ?? null,
          stress_avg: today.stress_avg ?? null,
          body_battery_high: today.body_battery_high ?? null,
          body_battery_low: today.body_battery_low ?? null,
        }
      : null,
    training: {
      fitness_ctl: load.current.fitness_ctl,
      fatigue_atl: load.current.fatigue_atl,
      form_tsb: load.current.form_tsb,
      acwr: load.current.acwr,
      load_last_7_days: load.current.load_last_7_days,
      recovery_time: isToday && opts.now !== undefined ? recoveryCountdown(activities, opts.now) : null,
      last_activity: lastActivity
        ? {
            id: lastActivity.activity_id,
            date: lastActivity.date,
            name: lastActivity.name,
            sport: lastActivity.sport,
            workout: lastActivity.workout_structure ?? lastActivity.workout_type ?? null,
            duration: lastActivity.duration_s ? formatDuration(lastActivity.duration_s) : null,
            distance_km: lastActivity.distance_m ? round(lastActivity.distance_m / 1000, 2) : null,
            training_effect: lastActivity.training_effect_label ?? null,
          }
        : null,
    },
    next_event:
      event && daysToGo !== null && daysToGo >= 0
        ? {
            id: event.id,
            name: event.name,
            date: event.date,
            days_to_go: daysToGo,
            phase: eventPhase(daysToGo),
            distance_km: event.distance_m !== null ? round(event.distance_m / 1000, 2) : null,
            goal_time: event.goal_time_s !== null ? formatDuration(event.goal_time_s) : null,
          }
        : null,
    baselines: {
      hrv_nights: hrv.nights_in_baseline,
      hrv_nights_in_7d: hrv.nights_in_7d,
      hrv_baseline_from: hrv.baseline_from,
      hrv_baseline_reset: opts.baselineReason ?? null,
      garmin_hrv_status: hrv.garmin_status,
      hrv_trend_30d_ms_per_week: hrv.trend_30d_ms_per_week,
    },
    disclaimer: "Training guidance from wearable data, not medical advice.",
  };
}
