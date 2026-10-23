/** Week-by-week report: training volume, intensity, recovery, and changes week over week. */
import type { ActivityRow, DailyRow } from "../archive/store";
import type { ProfileFacts } from "../context";
import { addDays, isoWeek, weekStart } from "../util/dates";
import { activityLoad } from "./load";
import { mean, pctChange, round } from "./stats";

export interface BestEffortRow {
  activity_id: number;
  date: string;
  sport: string;
  effort: string;
  kind: string;
  value: number;
}

export function weeklyReport(rows: DailyRow[], activities: ActivityRow[], efforts: BestEffortRow[], facts: ProfileFacts, firstWeek: string, lastDate: string) {
  const weeks: Array<Record<string, unknown>> = [];
  let prev: { load: number; hours: number; km: number } | null = null;
  for (let ws = weekStart(firstWeek); ws <= lastDate; ws = addDays(ws, 7)) {
    const we = addDays(ws, 6);
    const days = rows.filter((r) => r.date >= ws && r.date <= we);
    const acts = activities.filter((a) => a.date && a.date >= ws && a.date <= we);
    const sports: Record<string, { activities: number; km: number; hours: number; elevation_m: number; load: number }> = {};
    let load = 0;
    let seconds = 0;
    let meters = 0;
    const zones = [0, 0, 0, 0, 0];
    for (const a of acts) {
      const l = activityLoad(a, facts).load;
      const s = (sports[a.sport] ??= { activities: 0, km: 0, hours: 0, elevation_m: 0, load: 0 });
      s.activities++;
      s.km += (a.distance_m ?? 0) / 1000;
      s.hours += (a.duration_s ?? 0) / 3600;
      s.elevation_m += a.elevation_gain_m ?? 0;
      s.load += l;
      load += l;
      seconds += a.duration_s ?? 0;
      meters += a.distance_m ?? 0;
      [a.hr_zone1_s, a.hr_zone2_s, a.hr_zone3_s, a.hr_zone4_s, a.hr_zone5_s].forEach((z, i) => (zones[i] += z ?? 0));
    }
    for (const s of Object.values(sports)) {
      s.km = round(s.km, 1)!;
      s.hours = round(s.hours, 1)!;
      s.elevation_m = Math.round(s.elevation_m);
      s.load = Math.round(s.load);
    }
    const zoneTotal = zones.reduce((a, b) => a + b, 0);
    const longest = acts.reduce<ActivityRow | null>((best, a) => ((a.duration_s ?? 0) > (best?.duration_s ?? 0) ? a : best), null);
    const hours = seconds / 3600;
    const km = meters / 1000;
    const avg = (k: string, digits = 1) => round(mean(days.map((d) => d[k] as number)), digits);
    const sleepAvg = mean(days.map((d) => (d.sleep_seconds as number) ?? null));
    weeks.push({
      week: isoWeek(ws),
      from: ws,
      to: we > lastDate ? `${lastDate} (partial)` : we,
      training: {
        activities: acts.length,
        hours: round(hours, 1),
        km: round(km, 1),
        load: Math.round(load),
        by_sport: sports,
        intensity:
          zoneTotal > 0
            ? {
                easy_z1_z2_pct: round(((zones[0] + zones[1]) / zoneTotal) * 100, 0),
                moderate_z3_pct: round((zones[2] / zoneTotal) * 100, 0),
                hard_z4_z5_pct: round(((zones[3] + zones[4]) / zoneTotal) * 100, 0),
              }
            : null,
        longest: longest ? { id: longest.activity_id, name: longest.name, hours: round((longest.duration_s ?? 0) / 3600, 2), km: round((longest.distance_m ?? 0) / 1000, 1) } : null,
        best_efforts: efforts.filter((e) => e.date >= ws && e.date <= we).length || undefined,
      },
      recovery: {
        sleep_hours: sleepAvg !== null ? round(sleepAvg / 3600, 2) : null,
        sleep_score: avg("sleep_score", 0),
        hrv_ms: avg("hrv_ms"),
        resting_hr: avg("resting_hr"),
        stress_avg: avg("stress_avg", 0),
        body_battery_high: avg("body_battery_high", 0),
        steps: avg("steps", 0),
      },
      vs_previous_week: prev
        ? {
            load_pct: round(pctChange(prev.load, load), 0),
            hours_pct: round(pctChange(prev.hours, hours), 0),
            km_pct: round(pctChange(prev.km, km), 0),
          }
        : null,
    });
    prev = { load, hours, km };
  }
  return {
    weeks,
    notes: [
      "Intensity uses Garmin's time in HR zones per activity; 80/20 (about 80% easy) is the common target for endurance athletes.",
      "Load week-over-week jumps above ~30% raise injury risk for most athletes.",
    ],
  };
}
