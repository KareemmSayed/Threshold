/**
 * The daily briefing: every recovery and training signal for one day, each
 * judged against the athlete's own baseline, plus a transparent overall call.
 * It is not Garmin's Training Readiness (the Personal API does not expose it);
 * every input and rule is shown so the reasoning can be checked.
 */
import type { ActivityRow, DailyRow } from "../archive/store";
import type { ProfileFacts } from "../context";
import { formatDuration, hoursMinutes } from "../fit/analyze";
import { addDays } from "../util/dates";
import { loadReport } from "./load";
import { hrvReport, rhrReport, sleepReport, type HrvOptions } from "./recovery";
import { finite, mean, round } from "./stats";

type Level = "good" | "ok" | "caution" | "warning";

interface Signal {
  signal: string;
  level: Level;
  /** The headline number, short enough for a chip: "47 bpm · +1". */
  reading: string;
  detail: string;
}

export function briefing(date: string, rows: DailyRow[], activities: ActivityRow[], facts: ProfileFacts, warmupStart: string, hrvOptions: HrvOptions = {}) {
  const hrv = hrvReport(rows, date, hrvOptions);
  const rhr = rhrReport(rows, date);
  const sleep = sleepReport(rows, date);
  const load = loadReport(activities, facts, addDays(date, -27), date, warmupStart);
  const today = rows.find((r) => r.date === date);
  const signals: Signal[] = [];

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
      reading: `${rhr.rolling_7d_bpm ?? "?"} bpm · ${rhr.delta_bpm !== null && rhr.delta_bpm > 0 ? "+" : ""}${rhr.delta_bpm ?? "?"}`,
      detail: `7-day avg ${rhr.rolling_7d_bpm ?? "?"} bpm vs baseline ${rhr.baseline_bpm ?? "?"} bpm (${rhr.delta_bpm !== null && rhr.delta_bpm > 0 ? "+" : ""}${rhr.delta_bpm ?? "?"}).`,
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
  }
  const bbHigh = today?.body_battery_high as number | undefined;
  if (finite(bbHigh)) {
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

  const warnings = signals.filter((s) => s.level === "warning").length;
  const cautions = signals.filter((s) => s.level === "caution").length;
  const recoveryHit = signals.filter((s) => ["HRV", "Resting HR", "Sleep"].includes(s.signal) && (s.level === "warning" || s.level === "caution")).length;
  const status = warnings >= 2 || recoveryHit >= 2 ? "red" : warnings === 1 || cautions >= 2 ? "amber" : signals.length ? "green" : "unknown";
  const suggestion = {
    green: "Signals support the planned training, including hard sessions.",
    amber: "Mixed signals. Keep intensity moderate or shift the hardest session by a day; easy aerobic work is fine.",
    red: "Several recovery signals are off. Prioritize rest or very easy movement, sleep and fuelling, and watch for illness.",
    unknown: "Not enough data yet. Wear the watch overnight for a few nights.",
  }[status];

  const lastActivity = [...activities].reverse().find((a) => a.date && a.date <= date);
  return {
    date,
    overall: { status, suggestion, rule: "red: 2+ warnings or 2+ recovery signals off; amber: 1 warning or 2+ cautions; else green." },
    signals,
    last_night: sleep.last_night,
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
      last_activity: lastActivity
        ? {
            id: lastActivity.activity_id,
            date: lastActivity.date,
            name: lastActivity.name,
            sport: lastActivity.sport,
            duration: lastActivity.duration_s ? formatDuration(lastActivity.duration_s) : null,
            distance_km: lastActivity.distance_m ? round(lastActivity.distance_m / 1000, 2) : null,
            training_effect: lastActivity.training_effect_label ?? null,
          }
        : null,
    },
    baselines: {
      hrv_nights: hrv.nights_in_baseline,
      hrv_nights_in_7d: hrv.nights_in_7d,
      hrv_baseline_from: hrv.baseline_from,
      garmin_hrv_status: hrv.garmin_status,
      hrv_trend_30d_ms_per_week: hrv.trend_30d_ms_per_week,
    },
    disclaimer: "Training guidance from wearable data, not medical advice.",
  };
}
