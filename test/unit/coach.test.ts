import { describe, expect, it } from "vitest";
import { compare, lineOf, matchFor } from "../../src/analysis/compare";
import { correlate, pairs } from "../../src/analysis/correlate";
import { forecast, solveScale, weekdayPattern, type ForecastPlan } from "../../src/analysis/forecast";
import { loadReport, loadWarmupStart } from "../../src/analysis/load";
import { criticalSpeed, powerModel, predictRaces, riegel, timeForVdot, trainingPaces, vdot, type Anchor } from "../../src/analysis/predict";
import { briefing, eventPhase, recoveryCountdown } from "../../src/analysis/readiness";
import { hrvReport, illnessWatch, overnightStressReport, rhrReport, sleepConsistency, sleepReport, sleepRespirationReport } from "../../src/analysis/recovery";
import { loadFocus, trainingStatus, vo2Trend } from "../../src/analysis/status";
import { metricSeries, metricTrend } from "../../src/analysis/trends";
import { recordScope, weeklyReport } from "../../src/analysis/weekly";
import { exerciseSets, flattenActivity } from "../../src/archive/flatten";
import type { DailyRow } from "../../src/archive/store";
import { zoneCheck } from "../../src/context";
import { columnar, presentActivity, type ActivityData } from "../../src/mcp/tools";
import { addDays, eachDate } from "../../src/util/dates";
import { act, days, facts } from "../helpers/rows";

const anchor = (effort: string, meters: number, time_s: number): Anchor => ({ effort, meters, time_s, date: "2026-10-01", activity_id: 1 });

describe("race predictor", () => {
  it("scores VDOT and predicts as Daniels' tables do", () => {
    // VDOT 50: 5 km in 19:57, 10 km in 41:21, marathon in 3:10:49.
    expect(vdot(5000, 19 * 60 + 57)).toBeCloseTo(50, 0);
    expect(Math.abs(timeForVdot(50, 10000) - (41 * 60 + 21))).toBeLessThan(6);
    expect(Math.abs(timeForVdot(50, 42195) - (3 * 3600 + 10 * 60 + 49))).toBeLessThan(15);
    expect(Math.round(riegel(1200, 5000, 10000))).toBe(2502);
  });

  it("predicts every distance from the best-scoring effort", () => {
    // A soft 10 km from a training run must not pull the prediction down.
    const model = predictRaces([anchor("5k", 5000, 1197), anchor("10k", 10000, 2900), anchor("400m", 400, 75)]);
    expect(model.vdot).toBeCloseTo(50, 0);
    expect(model.basis?.effort).toBe("5k");
    const at = (d: string) => model.predictions.find((p) => p.distance === d)!;
    expect(Math.abs(at("5k").time_s - 1197)).toBeLessThan(3);
    expect(Math.abs(at("10k").time_s - 2481)).toBeLessThan(6);
    expect(at("10k").confidence).toBe("good");
    expect(at("half").confidence).toBe("fair");
    expect(at("marathon").confidence).toBe("low");
    expect(at("marathon").high_s).toBeGreaterThan(at("marathon").low_s);
  });

  it("falls back to Riegel when no effort is long enough for VDOT", () => {
    const model = predictRaces([anchor("1k", 1000, 190), anchor("400m", 400, 70)]);
    expect(model.vdot).toBeNull();
    expect(model.basis?.effort).toBe("1k");
    expect(model.predictions.find((p) => p.distance === "5k")).toMatchObject({ time_s: Math.round(riegel(190, 1000, 5000)), confidence: "low" });
    expect(predictRaces([anchor("400m", 400, 70)]).predictions).toEqual([]);
  });

  it("derives training paces from the VDOT", () => {
    const p = trainingPaces(50);
    const perKm = (speed: number) => 1000 / speed;
    expect(Math.abs(perKm(p.threshold) - 255)).toBeLessThan(2); // 4:15/km
    expect(Math.abs(perKm(p.interval) - 235)).toBeLessThan(2); // 3:55/km
    expect(Math.abs(perKm(p.repetition) - 217)).toBeLessThan(2); // 3:37/km
    expect(Math.abs(perKm(p.easy[1]) - 307)).toBeLessThan(3); // 5:07/km, the fast end
    expect(p.easy[0]).toBeLessThan(p.easy[1]);
    expect(p.marathon).toBeLessThan(p.threshold);
  });

  it("fits critical speed through near-maximal efforts only", () => {
    // Efforts on the line distance = 4.5 m/s x time + 200 m.
    const cs = criticalSpeed([anchor("a", 1010, 180), anchor("b", 2900, 600), anchor("c", 5600, 1200)]);
    expect(cs?.speed_mps).toBeCloseTo(4.5, 2);
    expect(cs?.d_prime_m).toBe(200);
    expect(cs?.efforts).toEqual(["a", "b", "c"]);
    // One effort, or efforts too close in length, cannot carry the line.
    expect(criticalSpeed([anchor("a", 1010, 180)])).toBeNull();
    expect(criticalSpeed([anchor("a", 1010, 180), anchor("b", 1500, 290)])).toBeNull();
    // A jogged 5 km is left out rather than bending the line.
    expect(criticalSpeed([anchor("a", 1010, 180), anchor("b", 2900, 600), anchor("slow", 5000, 1700)])?.efforts).toEqual(["a", "b"]);
  });

  it("models cycling power from the curve", () => {
    const m = powerModel({ "5min": 330, "20min": 280, "60min": 240 });
    expect(m).toMatchObject({ ftp_estimate_w: 266, critical_power_w: 263, w_prime_kj: 20 });
    expect(m.ftp_basis).toMatch(/95% of the best 20 min/);
    expect(m.zones).toHaveLength(7);
    expect(m.zones![3]).toMatchObject({ zone: 4, name: "threshold", from_w: 242, to_w: 279 });
    // An hour held above 95% of the 20-minute best is the better evidence.
    expect(powerModel({ "20min": 280, "60min": 270 }).ftp_estimate_w).toBe(270);
    expect(powerModel({ "5s": 900 })).toMatchObject({ ftp_estimate_w: null, zones: null, critical_power_w: null });
  });
});

describe("load forecast", () => {
  const today = "2026-10-20";
  const warm = "2025-06-01";
  const loads = new Map(eachDate(warm, today).map((d) => [d, 100]));
  const plan: ForecastPlan = { scenario: "maintain", scalePct: 100, taperDays: 14, taperFloorPct: 40, planned: new Map() };
  const end = addDays(today, 28);

  it("holds fitness when training goes on as usual", () => {
    const f = forecast(loads, warm, today, end, plan);
    expect(f.days).toHaveLength(28);
    expect(f.days[0].date).toBe(addDays(today, 1));
    expect(f.now.date).toBe(today);
    expect(f.end.ctl).toBeCloseTo(100, 0);
    expect(f.end.tsb).toBeCloseTo(0, 0);
    expect(f.pattern).toEqual([100, 100, 100, 100, 100, 100, 100]);
  });

  it("raises form with rest, and with a taper in between", () => {
    const rest = forecast(loads, warm, today, end, { ...plan, scenario: "rest" });
    const taper = forecast(loads, warm, today, end, { ...plan, scenario: "taper" });
    expect(rest.end.tsb).toBeGreaterThan(45);
    expect(rest.end.ctl).toBeLessThan(55);
    expect(taper.end.tsb).toBeGreaterThan(5);
    expect(taper.end.tsb).toBeLessThan(rest.end.tsb);
    expect(taper.end.ctl).toBeGreaterThan(rest.end.ctl);
    // The taper only starts 14 days out.
    expect(taper.days[10].load).toBe(100);
    expect(taper.days[27].load).toBe(40);
  });

  it("puts planned days over the scenario", () => {
    const f = forecast(loads, warm, today, end, { ...plan, scenario: "rest", planned: new Map([[addDays(today, 5), 300]]) });
    expect(f.days[4]).toMatchObject({ date: addDays(today, 5), load: 300 });
    expect(f.days[5].load).toBe(0);
  });

  it("solves for the load that gives a target form", () => {
    const s = solveScale(loads, warm, today, end, plan, 10);
    expect(s.reachable).toBe(true);
    expect(s.scale_pct).toBeGreaterThan(70);
    expect(s.scale_pct).toBeLessThan(90);
    expect(forecast(loads, warm, today, end, { ...plan, scalePct: s.scale_pct! }).end.tsb).toBeCloseTo(10, 0);
    const out = solveScale(loads, warm, today, end, plan, 80);
    expect(out).toMatchObject({ reachable: false, scale_pct: null });
    expect(out.highest_tsb).toBeLessThan(80);
  });

  it("learns the weekday pattern of the last four weeks", () => {
    const mondays = new Map(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"].map((d) => [d, 70]));
    expect(weekdayPattern(mondays, today)).toEqual([0, 70, 0, 0, 0, 0, 0]);
  });
});

describe("training status and load focus", () => {
  const end = "2026-10-20";
  const warm = loadWarmupStart(end);
  const steady = eachDate("2026-05-01", end).map((d) => act(d, 60));
  const report = (acts = steady) => loadReport(acts, facts, addDays(end, -27), end, warm);

  it("splits load into low aerobic, high aerobic and anaerobic", () => {
    // Zones 1-2 hold 2300 s of 3000 s; a quarter of the training effect is anaerobic.
    const f = loadFocus([act("2026-10-10", 100)], facts, addDays(end, -27), end);
    expect(f.low_aerobic).toEqual({ load: 58, pct: 58 });
    expect(f.high_aerobic).toEqual({ load: 18, pct: 18 });
    expect(f.anaerobic).toEqual({ load: 25, pct: 25 });
    expect(f.shortages).toEqual(["high aerobic (tempo, threshold, VO2 max work)"]);
    expect(f.verdict).toMatch(/^Short on high aerobic/);
    const blank = { hr_zone1_s: null, hr_zone2_s: null, hr_zone3_s: null, hr_zone4_s: null, hr_zone5_s: null, training_effect_label: null, aerobic_te: null, anaerobic_te: null };
    expect(loadFocus([act("2026-10-10", 100, blank)], facts, addDays(end, -27), end)).toMatchObject({ unclassified_load: 100, low_aerobic: { load: 0, pct: null } });
    // Without zones, Garmin's label decides.
    expect(loadFocus([act("2026-10-10", 100, { ...blank, training_effect_label: "TEMPO" })], facts, addDays(end, -27), end).high_aerobic.load).toBe(100);
  });

  it("reads the VO2 max trend of the sport with the most readings", () => {
    const acts = eachDate(addDays(end, -40), end).map((d) => act(d, 60, { vo2max: null, fit_vo2max: d >= addDays(end, -13) ? 51.2 : 50 }));
    expect(vo2Trend(acts, end)).toMatchObject({ sport: "running", latest: 51.2, change: 1.2, direction: "rising" });
    expect(vo2Trend([act(end, 60, { vo2max: 50 })], end)).toMatchObject({ change: null, direction: "unknown" });
    expect(vo2Trend([act(end, 60, { vo2max: null })], end)).toBeNull();
  });

  it("names how training is going", () => {
    const rising = vo2Trend(steady.map((a) => ({ ...a, vo2max: a.date! >= addDays(end, -13) ? 53 : 52 })), end);
    expect(trainingStatus(report(), rising, end)).toMatchObject({ status: "productive", basis: "load and VO2 max" });
    const falling = vo2Trend(steady.map((a) => ({ ...a, vo2max: a.date! >= addDays(end, -13) ? 51 : 52 })), end);
    expect(trainingStatus(report(), falling, end).status).toBe("unproductive");
    expect(trainingStatus(report(), null, end)).toMatchObject({ status: "maintaining", basis: "load only" });

    const spike = [...eachDate("2026-08-01", "2026-10-13").map((d) => act(d, 50)), ...eachDate("2026-10-14", end).map((d) => act(d, 150))];
    expect(trainingStatus(report(spike), null, end).status).toBe("overreaching");
    const stopped = eachDate("2026-05-01", "2026-10-06").map((d) => act(d, 60));
    expect(trainingStatus(report(stopped), null, "2026-10-06")).toMatchObject({ status: "detraining" });
    const easing = [...eachDate("2026-05-01", "2026-10-13").map((d) => act(d, 60)), ...eachDate("2026-10-14", end).map((d) => act(d, 25))];
    expect(trainingStatus(report(easing), null, end).status).toBe("peaking");
    expect(trainingStatus(report([]), null, null).status).toBe("not enough data");
  });
});

describe("correlate", () => {
  const xs = Array.from({ length: 40 }, (_, i) => i);

  it("measures how two series move together", () => {
    const c = correlate(xs, xs.map((x, i) => 2 * x + (i % 2 ? 1 : -1)));
    expect(c.n).toBe(40);
    expect(c.pearson_r).toBeGreaterThan(0.99);
    expect(c.spearman_rho).toBeGreaterThan(0.99);
    expect(c.strength).toBe("strong positive");
    expect(c.r_95_interval![0]).toBeGreaterThan(0.98);
    expect(c.y_when_x_high.mean!).toBeGreaterThan(c.y_when_x_low.mean!);
    expect(correlate(xs, xs.map((x) => -x * x)).spearman_rho).toBe(-1); // monotonic, not linear
    expect(correlate(xs, xs.map((_, i) => (i * 7919) % 13)).strength).toMatch(/none|weak/);
  });

  it("pairs x with y a number of days later", () => {
    const wave = xs.map((i) => Math.sin(i / 2));
    const delayed = [null, ...wave.slice(0, -1)];
    expect(correlate(wave, delayed, 1).pearson_r).toBe(1);
    expect(correlate(wave, delayed, 0).pearson_r).toBeLessThan(0.95);
    expect(pairs([1, null, 3, 4], [10, 20, null, 40], 0)).toEqual([[1, 10], [4, 40]]);
    expect(pairs([1, 2, 3], [10, 20, 30], 1)).toEqual([[1, 20], [2, 30]]);
  });

  it("refuses to call a small sample a pattern", () => {
    const few = correlate(xs.slice(0, 12), xs.slice(0, 12));
    expect(few.n).toBe(12);
    expect(few.strength).toBe("not enough data");
    expect(correlate([], []).pearson_r).toBeNull();
  });

  it("serves the sleep and training-time metrics", () => {
    const rows = days("2026-10-20", 3, (d) => ({ sleep_start_local: `${addDays(d, -1)}T23:30`, sleep_end_local: `${d}T07:15`, sleep_stress: 18 })) as DailyRow[];
    expect(metricSeries("bedtime", rows, [], facts, "2026-10-18", "2026-10-20").map(([, v]) => v)).toEqual([11.5, 11.5, 11.5]);
    expect(metricSeries("wake_time", rows, [], facts, "2026-10-20", "2026-10-20")[0][1]).toBe(7.25);
    const evening = act("2026-10-19", 80, { start_local: "2026-10-19 19:30:00", duration_s: 3600 });
    expect(metricSeries("training_end_hour", [], [evening], facts, "2026-10-18", "2026-10-19").map(([, v]) => v)).toEqual([null, 20.5]);
    expect(metricSeries("hard_minutes", [], [evening], facts, "2026-10-18", "2026-10-19").map(([, v]) => v)).toEqual([0, 200 / 60]);
  });
});

describe("recovery without HRV", () => {
  const end = "2026-10-20";

  it("flags a week of elevated overnight stress and breathing rate", () => {
    const rows = days(end, 70, (_, i) => ({ sleep_stress: i < 63 ? 16 + (i % 4) : 28, sleep_respiration: i < 63 ? (i % 2 ? 13.4 : 13.6) : 14.8 }));
    const stress = overnightStressReport(rows, end);
    expect(stress).toMatchObject({ status: "elevated", latest: 28, rolling_7d: 28, nights_in_7d: 7 });
    expect(stress.delta).toBeGreaterThan(10);
    const breathing = sleepRespirationReport(rows, end);
    expect(breathing).toMatchObject({ status: "elevated", baseline: 13.5, delta: 1.3 });
    expect(breathing.latest_z).toBeGreaterThan(2);
    // A small wobble is not a signal.
    const calm = days(end, 70, (_, i) => ({ sleep_stress: 16 + (i % 4), sleep_respiration: 13.5 }));
    expect(overnightStressReport(calm, end).status).toBe("normal");
    expect(sleepRespirationReport(calm, end).status).toBe("normal");
    expect(overnightStressReport([], end).status).toBe("no data");
  });

  it("raises the illness watch when signals move together", () => {
    const sick = days(end, 70, (_, i) => ({ resting_hr: i < 63 ? 50 + (i % 2) : 56, sleep_respiration: i < 63 ? (i % 2 ? 13.4 : 13.6) : 14.8, sleep_stress: 18 }));
    const watch = (rows: DailyRow[]) => illnessWatch({ hrv: hrvReport(rows, end), rhr: rhrReport(rows, end), stress: overnightStressReport(rows, end), respiration: sleepRespirationReport(rows, end) });
    expect(watch(sick)).toMatchObject({ level: "elevated" });
    expect(watch(sick).signals).toHaveLength(2);
    const one = days(end, 70, (_, i) => ({ resting_hr: 50 + (i % 2), sleep_respiration: 13.5, sleep_stress: i < 63 ? 16 + (i % 4) : 28 }));
    expect(watch(one)).toMatchObject({ level: "watch" });
    const fine = days(end, 70, (_, i) => ({ resting_hr: 50 + (i % 2), sleep_respiration: 13.5, sleep_stress: 18 }));
    expect(watch(fine)).toMatchObject({ level: "clear", signals: [] });
    // One bad night is enough when breathing rate and resting HR jump together.
    const acute = days(end, 70, (_, i) => ({ resting_hr: i < 69 ? 50 + (i % 2) : 58, sleep_respiration: i < 69 ? (i % 2 ? 13.4 : 13.6) : 15.5, sleep_stress: 18 }));
    expect(watch(acute).level).toBe("elevated");
    expect(watch(acute).signals.join(" ")).toMatch(/latest night/);
  });

  it("measures sleep regularity across midnight, and sleep debt", () => {
    const rows = days(end, 70, (d, i) => ({
      sleep_seconds: i < 63 ? 8 * 3600 : 7 * 3600,
      sleep_start_local: i % 2 ? `${addDays(d, -1)}T23:50` : `${d}T00:10`,
      sleep_end_local: `${d}T07:00`,
    }));
    const c = sleepConsistency(rows, end)!;
    expect(c).toMatchObject({ nights: 14, avg_bedtime: "00:00", avg_wake: "07:00", bedtime_sd_min: 10, wake_sd_min: 0, regularity: "very regular" });
    const s = sleepReport(rows, end);
    expect(s.sleep_debt_7d_hours).toBe(7); // an hour short of the usual 8 on each of 7 nights
    expect(s.consistency?.avg_bedtime).toBe("00:00");
    const wild = days(end, 14, (d, i) => ({ sleep_seconds: 7 * 3600, sleep_start_local: `${d}T0${i % 5}:00`, sleep_end_local: `${d}T09:00` }));
    expect(sleepConsistency(wild, end)?.regularity).toBe("irregular");
    expect(sleepConsistency(days(end, 3, (d) => ({ sleep_start_local: `${d}T00:10`, sleep_end_local: `${d}T07:00` })), end)).toBeNull();
  });

  it("says which night it is reporting", () => {
    const rows = days(end, 20, (_, i) => ({ sleep_seconds: i < 19 ? 8 * 3600 : null }) as Partial<DailyRow>);
    const s = sleepReport(rows, end);
    expect(s.last_night).toBeNull();
    expect(s.latest_night?.date).toBe("2026-10-19");
    expect(sleepReport(rows, "2026-10-19").last_night?.date).toBe("2026-10-19");
    expect(sleepReport(rows, "2026-10-19").latest_night).toBeNull();
  });
});

describe("briefing: freshness, events and the recovery countdown", () => {
  const end = "2026-10-20";
  // Synced through yesterday; today holds only what the watch knew before the night.
  const rows = days(end, 70, (_, i) => ({ resting_hr: 50, sleep_seconds: i < 69 ? 8 * 3600 : null, body_battery_high: i < 69 ? 85 : 12, sleep_stress: 18, sleep_respiration: 13.5 }) as Partial<DailyRow>);

  it("does not judge a night that has not synced", () => {
    const b = briefing(end, rows, [], facts, "2026-06-20", { today: end });
    expect(b.data_freshness).toMatchObject({ last_night_synced: false, latest_night: "2026-10-19" });
    expect(b.data_freshness?.note).toMatch(/most likely not synced since waking/);
    expect(b.signals.find((s) => s.signal === "Body Battery")).toMatchObject({ level: "ok", stale: true, reading: "not synced since waking" });
    expect(b.signals.find((s) => s.signal === "Sleep")).toMatchObject({ level: "good", stale: true });
    // A Body Battery of 12 would be a warning if it were today's real value.
    expect(b.overall.status).toBe("green");
    expect(b.last_night).toBeNull();
    expect(b.latest_night?.date).toBe("2026-10-19");
    expect(b.signals.map((s) => s.signal)).toEqual(expect.arrayContaining(["Overnight stress", "Sleep breathing"]));
  });

  it("judges the same day as recorded once it is in the past", () => {
    const b = briefing(end, rows, [], facts, "2026-06-20", { today: "2026-10-25" });
    expect(b.data_freshness).toBeUndefined();
    expect(b.signals.find((s) => s.signal === "Body Battery")).toMatchObject({ level: "warning" });
    expect(b.signals.find((s) => s.signal === "Sleep")?.stale).toBeUndefined();
    expect(b.overall.status).toBe("amber");
  });

  it("is fresh when last night is there, and does not wait for an athlete who never tracks sleep", () => {
    const synced = days(end, 70, () => ({ resting_hr: 50, sleep_seconds: 8 * 3600, body_battery_high: 85 }));
    expect(briefing(end, synced, [], facts, "2026-06-20", { today: end }).data_freshness).toEqual({ last_night_synced: true, latest_night: end });
    const noSleep = days(end, 70, () => ({ resting_hr: 50, body_battery_high: 35 }));
    const b = briefing(end, noSleep, [], facts, "2026-06-20", { today: end });
    expect(b.data_freshness?.last_night_synced).toBe(true);
    expect(b.signals.find((s) => s.signal === "Body Battery")).toMatchObject({ level: "warning" });
  });

  it("counts down to the next race", () => {
    const event = { id: 4, name: "City 10k", date: "2026-10-23", sport: "running", distance_m: 10000, goal_time_s: 2550, priority: "A" };
    const b = briefing(end, rows, [], facts, "2026-06-20", { today: end, event });
    expect(b.next_event).toEqual({ id: 4, name: "City 10k", date: "2026-10-23", days_to_go: 3, phase: "race week", distance_km: 10, goal_time: "42:30" });
    expect(b.overall.suggestion).toMatch(/City 10k is in 3 days/);
    expect(briefing(end, rows, [], facts, "2026-06-20", { event: { ...event, date: "2026-12-25" } }).overall.suggestion).not.toMatch(/City 10k/);
    expect([0, 5, 12, 40, 100].map(eventPhase)).toEqual(["race day", "race week", "taper", "specific build", "base and build"]);
  });

  it("counts recovery time down from the latest activity", () => {
    const run = act("2026-10-19", 150, { start_gmt: "2026-10-19 05:00:00", duration_s: 3000, fit_recovery_min: 1260 });
    const finish = Date.parse("2026-10-19T05:50:00Z");
    expect(recoveryCountdown([run], finish + 10 * 3600_000)).toMatchObject({ hours_left: 11, hours_at_finish: 21, from_activity_id: run.activity_id });
    expect(recoveryCountdown([run], finish + 30 * 3600_000)?.hours_left).toBe(0);
    expect(recoveryCountdown([act("2026-10-19", 150)], finish)).toBeNull();
    const b = briefing(end, rows, [run], facts, "2026-06-20", { today: end, now: finish + 10 * 3600_000 });
    expect(b.training.recovery_time?.hours_left).toBe(11);
    expect(b.training.recovery_time?.note).toMatch(/Experimental/);
  });
});

describe("records in the weekly report", () => {
  it("calls an effort a record only against a real history", () => {
    const effort = { activity_id: 1, date: "2026-10-15", sport: "running", effort: "1k", kind: "time_s", value: 196 };
    expect(recordScope({ ...effort, prior: 40, best_before: 199, prior_12mo: 20, best_before_12mo: 199 })).toBe("all-time");
    expect(recordScope({ ...effort, prior: 40, best_before: 190, prior_12mo: 20, best_before_12mo: 199 })).toBe("12-month");
    expect(recordScope({ ...effort, prior: 40, best_before: 190, prior_12mo: 20, best_before_12mo: 195 })).toBeNull();
    expect(recordScope({ ...effort, prior: 2, best_before: 250, prior_12mo: 2, best_before_12mo: 250 })).toBeNull(); // too little history
    expect(recordScope({ ...effort, kind: "power_w", value: 320, prior: 9, best_before: 310 })).toBe("all-time");
    expect(recordScope({ ...effort, kind: "hr_bpm", prior: 9, best_before: 250 })).toBeNull();
  });

  it("lists the week's records, session types and strength work", () => {
    const acts = [
      act("2026-10-13", 150, { workout_type: "intervals" }),
      act("2026-10-15", 50, { workout_type: "steady" }),
      act("2026-10-16", 20, { sport: "strength", workout_type: "other", distance_m: 0, total_sets: 6, total_reps: 62 }),
    ];
    const efforts = [{ activity_id: 5, date: "2026-10-13", sport: "running", effort: "1k", kind: "time_s", value: 196, prior: 40, best_before: 199, prior_12mo: 20, best_before_12mo: 199 }];
    const week = weeklyReport([], acts, efforts, facts, "2026-10-12", "2026-10-18").weeks[0].training as Record<string, any>;
    expect(week.records).toEqual([{ effort: "1k", sport: "running", record: "all-time", time: "3:16", previous: "3:19", date: "2026-10-13", activity_id: 5 }]);
    expect(week.sessions).toEqual({ intervals: 1, steady: 1 });
    expect(week.by_sport.strength).toMatchObject({ sets: 6, reps: 62 });
  });

  it("trends efficiency and decoupling on steady sessions only", () => {
    const acts = [
      act("2026-10-13", 150, { workout_type: "intervals", efficiency_factor: 1.9, decoupling_pct: -2 }),
      act("2026-10-15", 50, { workout_type: "steady", efficiency_factor: 1.4, decoupling_pct: 4 }),
      act("2026-10-17", 50, { efficiency_factor: 1.2 }), // not analyzed yet
    ];
    const t = metricTrend("running_efficiency", [], acts, facts, "2026-10-12", "2026-10-18");
    expect(t.period.days_with_data).toBe(1);
    expect(t.summary.mean).toBe(1.4);
    expect(metricTrend("aerobic_decoupling", [], acts, facts, "2026-10-12", "2026-10-18").summary.mean).toBe(4);
    expect(metricTrend("steady_run_pace", [], acts, facts, "2026-10-12", "2026-10-18").period.days_with_data).toBe(1);
  });
});

describe("compare workouts", () => {
  it("matches interval sessions by their reps and steady efforts by length", () => {
    const reps = matchFor(act("2026-10-13", 150, { workout_type: "intervals", rep_distance_m: 1000 }))!;
    expect(reps.where).toMatch(/rep_distance_m BETWEEN/);
    expect(reps.binds).toEqual([940, 1060]);
    const timed = matchFor(act("2026-10-13", 150, { workout_type: "intervals", rep_time_s: 180 }))!;
    expect(timed.where).toMatch(/rep_distance_m IS NULL AND rep_time_s BETWEEN/);
    const steady = matchFor(act("2026-10-13", 60, { workout_type: "long", distance_m: 20000 }))!;
    expect(steady.where).toMatch(/workout_type IN \('steady', 'long', 'tempo', 'recovery'\) AND distance_m BETWEEN/);
    expect(steady.binds).toEqual([17000, 23000]);
    expect(matchFor(act("2026-10-13", 60, { workout_type: "variable" }))).toBeNull();
    expect(matchFor(act("2026-10-13", 60))).toBeNull(); // not analyzed yet
  });

  it("reports the change in pace, heart rate and speed per heartbeat", () => {
    const session = (date: string, speed: number, hr: number) => lineOf(act(date, 150, { workout_type: "intervals", workout_structure: "10 x 1000 m", rep_distance_m: 1000, work_speed_mps: speed, work_hr: hr, avg_speed_mps: 3, avg_hr: 150 }));
    const ref = session("2026-10-13", 4.0, 160);
    // An interval session is compared on its reps, not on the session average that includes the rests.
    expect(ref).toMatchObject({ workout: "10 x 1000 m", speed_mps: 4, hr: 160, speed_per_beat: 1.5, decoupling_pct: null });
    const c = compare(ref, [session("2026-09-29", 3.9, 162), session("2026-09-15", 3.8, 163), session("2026-09-01", 3.75, 164)]);
    expect(c.vs_previous).toMatchObject({ speed_pct: 2.6, hr_bpm: -2, date: "2026-09-29", days_before: 14 });
    expect(c.vs_average_of_others).toMatchObject({ sessions: 3, hr_bpm: -3 });
    expect(c.vs_average_of_others!.speed_per_beat_pct).toBeGreaterThan(2);
    expect(c.speed_per_beat_trend_pct_per_30d).toBeGreaterThan(0);
    expect(c.verdict).toMatch(/^Fitter/);
    expect(compare(ref, []).verdict).toMatch(/No earlier session/);
    expect(compare(session("2026-10-13", 3.6, 166), [session("2026-09-29", 3.9, 162)]).verdict).toMatch(/Harder for the same speed/);
  });
});

describe("archive shapes and tool output", () => {
  it("reads form, strength and swim fields from Garmin's activity list", () => {
    const run = flattenActivity({ activityId: 1, startTimeLocal: "2026-10-20 07:00:00", activityType: { typeKey: "track_running" }, eventType: { typeKey: "race" }, avgStrideLength: 121.8, avgGroundContactTime: 245, avgVerticalOscillation: 8.9, avgVerticalRatio: 7.5 });
    expect(run).toMatchObject({ event_type: "race", stride_length_m: 1.22, ground_contact_ms: 245, vertical_oscillation_cm: 8.9, vertical_ratio_pct: 7.5, total_sets: null, swolf: null });
    // Pool length arrives in centimetres; zero means "not measured".
    const swim = flattenActivity({ activityId: 2, activityType: { typeKey: "lap_swimming" }, poolLength: 2500, averageSwolf: 38, activeLengths: 40, strokes: 620, avgStrideLength: 0 });
    expect(swim).toMatchObject({ pool_length_m: 25, swolf: 38, active_lengths: 40, strokes: 620, stride_length_m: null });
    const lift = { activityId: 3, activityType: { typeKey: "strength_training" }, totalSets: 6, activeSets: 5, totalReps: 62, summarizedExerciseSets: [{ category: "SQUAT", reps: 30, volume: 1_800_000, sets: 3, maxWeight: 60000 }, { category: "PUSH_UP", reps: 32, volume: 0, sets: 2, maxWeight: 0 }, { reps: 4 }] };
    expect(flattenActivity(lift)).toMatchObject({ sport: "strength", total_sets: 5, total_reps: 62 });
    expect(exerciseSets(lift)).toEqual([
      { exercise: "squat", sets: 3, reps: 30, max_weight_kg: 60, volume_kg: 1800 },
      { exercise: "push_up", sets: 2, reps: 32, max_weight_kg: null, volume_kg: null },
    ]);
    expect(exerciseSets({})).toEqual([]);
  });

  it("checks the heart-rate settings against what was recorded", () => {
    const garmin = { unit: "km" as const, hrZoneFloors: {}, maxHr: 185, lactateThresholdHr: 165 };
    const tooLow = zoneCheck(garmin, { at: 0, observedMaxHr: { bpm: 192, date: "2026-09-01", activity_id: 7, activities: 60 }, best60MinHr: { bpm: 171, date: "2026-08-10" } });
    expect(tooLow.findings).toHaveLength(2);
    expect(tooLow.findings[0]).toMatch(/Max HR is set to 185 bpm, but 192 bpm was recorded/);
    expect(tooLow.findings[1]).toMatch(/Lactate threshold HR is set to 165 bpm, but 171 bpm was held for 60 minutes/);
    const tooHigh = zoneCheck({ ...garmin, maxHr: 200 }, { at: 0, observedMaxHr: { bpm: 186, date: "2026-09-01", activity_id: 7, activities: 60 } });
    expect(tooHigh.findings[0]).toMatch(/may be too high/);
    expect(zoneCheck({ ...garmin, maxHr: 190 }, { at: 0, observedMaxHr: { bpm: 188, date: "2026-09-01", activity_id: 7, activities: 60 } }).findings[0]).toMatch(/fits/);
    expect(zoneCheck(garmin, undefined).findings[0]).toMatch(/cannot be checked/);
    // A max HR that itself came from the archive is not a setting to check.
    expect(zoneCheck({ ...garmin, sources: { maxHr: "archive" } }, { at: 0 }).profile_max_hr).toBeNull();
  });

  it("returns lists as columns and rows, and only the sections asked for", () => {
    expect(columnar([{ lap: 1, kind: "warmup", hr: 130, power: null }, { lap: 2, hr: 150 }])).toEqual({ columns: ["lap", "kind", "hr"], rows: [[1, "warmup", 130], [2, null, 150]] });
    const analysis = {
      summary: { sport: "running" },
      workout: { type: "intervals", structure: "2 x 400 m" },
      intervals: { structure: "2 x 400 m", detected_from: "lap labels", reps: [{ rep: 1, time: "1:20" }, { rep: 2, time: "1:22" }], work: {}, rest: { avg: null, avg_hr_drop_bpm: null }, verdict: "" },
      hidden: { note: "" },
      best_efforts: { distance: {}, power_w: {}, hr_bpm: {} },
      splits: [{ split: 1, distance_km: 1, time: "4:00", pace: "4:00/km", avg_hr: 150, elevation_gain_m: 0 }],
      laps: [{ lap: 1 }, { lap: 2 }, { lap: 3 }],
      data_quality: {},
    } as unknown as NonNullable<ActivityData["analysis"]>;
    const data: ActivityData = { activity: { id: 1 }, analysis, records: [{ effort: "400m", time: "1:20", all_time_rank: 1 }] };
    const byDefault = presentActivity(data);
    const shown = byDefault.data.analysis as Record<string, any>;
    // An interval session shows its reps; the splits and the laps wait to be asked for.
    expect(shown.intervals.reps).toEqual({ columns: ["rep", "time"], rows: [[1, "1:20"], [2, "1:22"]] });
    expect(shown.splits).toBeUndefined();
    expect(shown.laps).toBeUndefined();
    expect(shown.records).toHaveLength(1);
    expect(byDefault.notes[0]).toMatch(/laps \(3\), splits/);
    const chosen = presentActivity(data, ["laps", "splits"]);
    expect(Object.keys(chosen.data.analysis as object).sort()).toEqual(["laps", "splits", "workout"]);
    expect((chosen.data.analysis as Record<string, any>).laps.rows).toHaveLength(3);
    expect(chosen.notes).toEqual([]);
    expect(presentActivity({ activity: { id: 1 }, analysis: null }).data.analysis).toBeNull();
  });
});
