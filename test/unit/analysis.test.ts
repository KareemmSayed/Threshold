import { describe, expect, it } from "vitest";
import { flattenActivity, flattenDaily, sportOf } from "../../src/archive/flatten";
import { checkReadOnly, SqlRejected } from "../../src/archive/sql";
import type { ActivityRow, DailyRow } from "../../src/archive/store";
import { activityLoad, acwrLabel, loadReport, loadWarmupStart, performanceChart } from "../../src/analysis/load";
import { briefing } from "../../src/analysis/readiness";
import { hrvReport, rhrReport, sleepReport } from "../../src/analysis/recovery";
import { linearTrend, mean, sd } from "../../src/analysis/stats";
import { metricTrend } from "../../src/analysis/trends";
import { weeklyReport } from "../../src/analysis/weekly";
import { hrvBaselineFrom, profileFacts, type ProfileFacts } from "../../src/context";
import type { Env } from "../../src/env";
import { compact } from "../../src/garmin/compact";
import { addDays, eachDate, isIsoDate, isoWeek, runs, todayIn, weekStart, windows } from "../../src/util/dates";

const facts: ProfileFacts = { unit: "km", hrZoneFloors: {}, restingHr: 50, maxHr: 190, gender: "male" };

function days(end: string, n: number, make: (d: string, i: number) => Partial<DailyRow>): DailyRow[] {
  return eachDate(addDays(end, -(n - 1)), end).map((d, i) => ({ date: d, ...make(d, i) }) as DailyRow);
}

function act(date: string, load: number, extra: Partial<ActivityRow> = {}): ActivityRow {
  return {
    activity_id: Date.parse(date) / 1000,
    name: "Run",
    type: "running",
    sport: "running",
    date,
    start_local: `${date} 07:00:00`,
    distance_m: 10000,
    duration_s: 3000,
    moving_s: 3000,
    elevation_gain_m: 50,
    avg_speed_mps: 3.33,
    avg_hr: 145,
    max_hr: 170,
    avg_power_w: null,
    norm_power_w: null,
    calories: 600,
    aerobic_te: 3,
    anaerobic_te: 1,
    garmin_load: load,
    tss: null,
    vo2max: 52,
    hr_zone1_s: 300,
    hr_zone2_s: 2000,
    hr_zone3_s: 500,
    hr_zone4_s: 200,
    hr_zone5_s: 0,
    training_effect_label: "AEROBIC_BASE",
    fit_status: null,
    fit_vo2max: null,
    fit_recovery_min: null,
    fit_performance_condition: null,
    decoupling_pct: null,
    efficiency_factor: null,
    ...extra,
  };
}

describe("dates", () => {
  it("validates and walks dates", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekStart("2026-10-25")).toBe("2026-10-19"); // Sunday -> Monday
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
  });
  it("splits ranges into windows and runs", () => {
    expect(windows("2026-01-01", "2026-01-10", 4)).toEqual([
      ["2026-01-01", "2026-01-04"],
      ["2026-01-05", "2026-01-08"],
      ["2026-01-09", "2026-01-10"],
    ]);
    expect(runs(["2026-01-01", "2026-01-02", "2026-01-04", "2026-01-05", "2026-01-06"], 2)).toEqual([
      ["2026-01-01", "2026-01-02"],
      ["2026-01-04", "2026-01-05"],
      ["2026-01-06", "2026-01-06"],
    ]);
  });
  it("knows today in a time zone", () => {
    const late = new Date("2026-10-23T23:30:00Z");
    expect(todayIn("UTC", late)).toBe("2026-10-23");
    expect(todayIn("Europe/Berlin", late)).toBe("2026-10-24");
    expect(todayIn("America/Los_Angeles", late)).toBe("2026-10-23");
    expect(todayIn("Not/AZone", late)).toBe("2026-10-23");
  });
});

describe("flatten", () => {
  it("reads Garmin's nested daily summary", () => {
    const row = flattenDaily("daily_summaries", {
      calendarDate: "2026-10-20",
      movement: { steps: { value: 9120, goal: 10000, distanceInMeters: 7034 }, floorsAscended: { value: 9 } },
      heartRate: { restingValue: 52, minValue: 47, maxValue: 151 },
      stress: { avgLevel: -1, maxLevel: 80 },
      bodyBattery: { maxValue: 88 },
    });
    expect(row).toMatchObject({ steps: 9120, step_goal: 10000, distance_m: 7034, floors: 9, resting_hr: 52, stress_avg: null, stress_max: 80, body_battery_high: 88 });
  });
  it("drops days the watch was not worn and implausible values", () => {
    expect(flattenDaily("daily_summaries", { calendarDate: "2026-10-20", movement: { steps: { value: 0 } } })).toBeNull();
    expect(flattenDaily("daily_summaries", { heartRate: { restingValue: 148, minValue: 80 } })?.resting_hr).toBeNull();
    expect(flattenDaily("sleep", { calendarDate: "2026-10-20", sleepTimeSeconds: 0 })).toBeNull();
    expect(flattenDaily("hrv", { calendarDate: "2026-10-20", status: "NONE" })).toBeNull();
  });
  it("converts weight from grams", () => {
    expect(flattenDaily("weight", { summaryDate: "2026-10-20", latestWeight: { weight: 72450, bmi: 22.13, bodyFat: 14.52 } })).toMatchObject({ weight_kg: 72.45, bmi: 22.1, body_fat_pct: 14.5 });
  });
  it("maps activities and sports", () => {
    const row = flattenActivity({ activityId: 1, activityName: "Trail", startTimeLocal: "2026-10-20 07:00:00", activityType: { typeKey: "trail_running" }, distance: 12000, activityTrainingLoad: 140 });
    expect(row).toMatchObject({ activity_id: 1, sport: "running", date: "2026-10-20", distance_m: 12000, garmin_load: 140 });
    expect(sportOf("road_biking")).toBe("cycling");
    expect(sportOf("lap_swimming")).toBe("swimming");
    expect(sportOf("strength_training")).toBe("strength");
    expect(sportOf("yoga")).toBe("mind_body");
  });
});

describe("compact", () => {
  it("drops samples, personal and location fields", () => {
    const out = compact({ a: 1, b: null, ownerFullName: "X", startLatitude: 52.5, locationName: "Home", values: Array.from({ length: 50 }, (_, i) => [i, 60]) }) as Record<string, unknown>;
    expect(out).toEqual({ a: 1, values: { omittedSamples: 50 } });
    expect(compact({ startLatitude: 52.5 }, { location: true })).toEqual({ startLatitude: 52.5 });
    expect((compact({ v: Array.from({ length: 50 }, (_, i) => i) }, { samples: true }) as { v: number[] }).v).toHaveLength(50);
  });
});

describe("read-only SQL", () => {
  const ok = ["SELECT * FROM daily", "with x as (select date from daily) select * from x;", "SELECT replace(name, 'a', 'b') FROM activities", "SELECT 'drop table x' AS s", "select json_extract(raw_json, '$.calories') from activities -- delete"];
  const bad = [
    "DELETE FROM daily",
    "SELECT 1; DROP TABLE daily",
    "WITH x AS (SELECT 1) DELETE FROM daily",
    "WITH x AS (SELECT 1) REPLACE INTO daily (date) VALUES ('x')",
    "PRAGMA table_info(daily)",
    "SELECT * FROM meta",
    "SELECT * FROM \"_cf_KV\"",
    "ATTACH DATABASE 'x' AS y",
    "select 'unterminated",
  ];
  it.each(ok)("allows %s", (sql) => expect(() => checkReadOnly(sql)).not.toThrow());
  it.each(bad)("rejects %s", (sql) => expect(() => checkReadOnly(sql)).toThrow(SqlRejected));
});

describe("stats", () => {
  it("computes basics", () => {
    expect(mean([1, 2, null, 3])).toBe(2);
    expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(linearTrend([[0, 1], [1, 3], [2, 5]])).toEqual({ slopePerDay: 2, r2: 1 });
  });
});

describe("training load", () => {
  it("prefers Garmin load, then TSS, then TRIMP", () => {
    expect(activityLoad(act("2026-10-01", 80), facts)).toEqual({ load: 80, source: "garmin" });
    expect(activityLoad(act("2026-10-01", 0, { tss: 70 }), facts).source).toBe("tss");
    const trimp = activityLoad(act("2026-10-01", 0), facts);
    expect(trimp.source).toBe("trimp");
    expect(trimp.load).toBeGreaterThan(50);
    expect(activityLoad(act("2026-10-01", 0, { avg_hr: null }), facts).source).toBe("none");
  });
  it("converges CTL to a steady daily load", () => {
    const loads = new Map(eachDate("2026-01-01", "2026-12-31").map((d) => [d, 100]));
    const chart = performanceChart(loads, "2026-01-01", "2026-12-31");
    expect(chart.at(-1)!.ctl).toBeCloseTo(100, 0);
    expect(chart.at(-1)!.tsb).toBeCloseTo(0, 0);
  });
  it("reports ACWR spikes", () => {
    const acts = [...eachDate("2026-08-01", "2026-09-30").map((d) => act(d, 50)), ...eachDate("2026-10-01", "2026-10-07").map((d) => act(d, 150))];
    const report = loadReport(acts, facts, "2026-09-01", "2026-10-07", "2026-06-01");
    expect(report.current.acwr).toBeGreaterThan(1.5);
    expect(report.current.acwr_zone).toMatch(/spike/);
    expect(report.weekly.length).toBeGreaterThan(4);
    expect(report.load_sources.garmin).toBe(acts.length);
    expect(acwrLabel(1)).toMatch(/sweet spot/);
  });
  it("reports the same form for a day whatever the window", () => {
    const end = "2026-10-20";
    const acts = eachDate("2025-01-01", end).filter((_, i) => i % 3 !== 0).map((d, i) => act(d, 40 + (i % 7) * 15));
    const warmup = loadWarmupStart(end);
    const wide = loadReport(acts, facts, addDays(end, -89), end, warmup);
    const narrow = loadReport(acts, facts, addDays(end, -27), end, warmup);
    expect(narrow.current).toEqual(wide.current);
    expect(briefing(end, [], acts, facts, warmup).training.fitness_ctl).toBe(wide.current.fitness_ctl);
    // The last week's closing form is the current form, not today's CTL - ATL.
    expect(wide.weekly.at(-1)!.tsb_end).toBe(wide.current.form_tsb);
  });
});

describe("recovery", () => {
  const end = "2026-10-20";
  it("flags a suppressed HRV week", () => {
    const rows = days(end, 70, (_, i) => ({ hrv_ms: i < 63 ? 60 + (i % 5) : 45, resting_hr: i < 63 ? 50 + (i % 3) : 57 }));
    const hrv = hrvReport(rows, end);
    expect(hrv.status_7d).toBe("low");
    expect(hrv.days_below_normal_last_7).toBe(7);
    expect(hrv.normal_range_ms![0]).toBeLessThan(hrv.baseline_ms!);
    const rhr = rhrReport(rows, end);
    expect(rhr.status).toBe("elevated");
    expect(rhr.delta_bpm).toBeGreaterThan(5);
  });
  it("is honest without a baseline", () => {
    const rows = days(end, 5, () => ({ hrv_ms: 60 }));
    const hrv = hrvReport(rows, end);
    expect(hrv.baseline_ms).toBeNull();
    expect(hrv.interpretation).toMatch(/Fewer than 14 nights/);
    expect(hrvReport([], end).status_7d).toBe("no data");
  });
  it("counts the nights behind the 7-day mean", () => {
    const rows = days(end, 70, (_, i) => ({ hrv_ms: 60 + (i % 5) }));
    const hrv = hrvReport(rows, end);
    expect(hrv.nights_in_7d).toBe(7);
    expect(hrv.confidence).toBe("good");
    expect(hrvReport([], end).nights_in_7d).toBe(0);
    expect(hrvReport([], end).confidence).toBeNull();
  });
  it("caps the verdict when few of the last 7 nights have HRV", () => {
    // Three nights in the last week, all far below a steady baseline.
    const make = (_: string, i: number) => ({ hrv_ms: i < 63 ? 60 + (i % 5) : i % 2 === 0 ? 45 : null }) as Partial<DailyRow>;
    const thin = hrvReport(days(end, 70, make), end);
    expect(thin.nights_in_7d).toBe(3);
    expect(thin.confidence).toBe("low");
    expect(thin.status_7d).toBe("slightly low");
    expect(thin.interpretation).toMatch(/Only 3 of 7 nights/);
    expect(thin.interpretation).toMatch(/capped at "slightly low"/);
    // The same drop over a full week is a clear "low".
    expect(hrvReport(days(end, 70, (_, i) => ({ hrv_ms: i < 63 ? 60 + (i % 5) : 45 })), end).status_7d).toBe("low");
    // Two nights are too few for any rolling mean.
    const two = hrvReport(days(end, 70, (_, i) => ({ hrv_ms: i < 63 ? 60 + (i % 5) : i === 64 || i === 66 ? 45 : null })), end);
    expect(two.rolling_7d_ms).toBeNull();
    expect(two.status_7d).toBe("no data");
  });
  it("gives no verdict until a baseline exists", () => {
    const hrv = hrvReport(days(end, 5, () => ({ hrv_ms: 60 })), end);
    expect(hrv.rolling_7d_ms).toBe(60);
    expect(hrv.status_7d).toBe("no data");
  });
  it("restarts the baseline after a device change", () => {
    // 40 nights on the old watch (about 62 ms), then 40 on a new one (about 47 ms).
    const switchedAt = "2026-09-10";
    const make = (d: string, i: number) => ({ hrv_ms: d < switchedAt ? 60 + (i % 5) : 45 + (i % 5) }) as Partial<DailyRow>;
    const rows = days("2026-10-20", 80, make);
    const pooled = hrvReport(rows, "2026-10-20");
    expect(pooled.status_7d).not.toBe("normal");
    const reset = hrvReport(rows, "2026-10-20", { baselineFrom: switchedAt });
    expect(reset.status_7d).toBe("normal");
    expect(reset.baseline_from).toBe(switchedAt);
    expect(reset.baseline_ms).toBeLessThan(pooled.baseline_ms!);
    // Right after the switch there is no baseline on the new watch yet, so no verdict.
    const fresh = hrvReport(rows, "2026-09-20", { baselineFrom: switchedAt });
    expect(fresh.status_7d).toBe("no data");
    expect(fresh.nights_in_baseline).toBeLessThan(14);
    expect(fresh.interpretation).toMatch(/Fewer than 14 nights before this week since 2026-09-10/);
  });
  it("counts days below the normal band, not below one SD", () => {
    // Baseline alternates 50 and 70 ms; the week sits at 52 ms: under the band edge (-0.5 SD) but above -1 SD.
    const rows = days(end, 70, (_, i) => ({ hrv_ms: i < 63 ? (i % 2 ? 70 : 50) : 52 }));
    const hrv = hrvReport(rows, end);
    expect(hrv.days_below_normal_last_7).toBe(7);
    expect(hrv.last_night_z!).toBeGreaterThan(-1);
  });
  it("reads the baseline reset from the environment", () => {
    expect(hrvBaselineFrom({ HRV_BASELINE_FROM: " 2026-09-10 " } as Env)).toBe("2026-09-10");
    expect(hrvBaselineFrom({ HRV_BASELINE_FROM: "2026-13-40" } as Env)).toBeUndefined();
    expect(hrvBaselineFrom({ HRV_BASELINE_FROM: "" } as Env)).toBeUndefined();
    expect(hrvBaselineFrom({} as Env)).toBeUndefined();
  });
  it("summarizes sleep", () => {
    const rows = days(end, 40, (_, i) => ({ sleep_seconds: i < 33 ? 8 * 3600 : 5.5 * 3600, sleep_score: 80 }));
    const s = sleepReport(rows, end);
    expect(s.status).toBe("low");
    expect(s.short_nights_last_7).toBe(7);
    expect(s.last_night?.hours).toBe(5.5);
  });
});

describe("briefing", () => {
  it("goes red when recovery signals stack up", () => {
    const end = "2026-10-20";
    const rows = days(end, 70, (_, i) => ({ hrv_ms: i < 63 ? 62 + (i % 4) : 44, resting_hr: i < 63 ? 50 : 58, sleep_seconds: i < 69 ? 8 * 3600 : 5 * 3600, body_battery_high: 35 }));
    const b = briefing(end, rows, [act("2026-10-19", 90)], facts, "2026-06-20");
    expect(b.overall.status).toBe("red");
    expect(b.signals.map((s) => s.signal)).toEqual(expect.arrayContaining(["HRV", "Resting HR", "Sleep", "Body Battery"]));
    expect(b.training.last_activity?.id).toBeDefined();
  });
  it("shows the HRV night count and drops to caution on thin evidence", () => {
    const end = "2026-10-20";
    const rows = days(end, 70, (_, i) => ({ hrv_ms: i < 63 ? 62 + (i % 4) : i % 2 === 0 ? 44 : null, resting_hr: 50, sleep_seconds: 8 * 3600, body_battery_high: 90 }) as Partial<DailyRow>);
    const hrv = briefing(end, rows, [], facts, "2026-06-20").signals.find((s) => s.signal === "HRV")!;
    expect(hrv.level).toBe("caution");
    expect(hrv.detail).toMatch(/from 3 of 7 nights/);
    expect(hrv.detail).toMatch(/low confidence/);
  });
  it("skips the HRV signal until there is a baseline", () => {
    const end = "2026-10-20";
    const rows = days(end, 70, (d, i) => ({ hrv_ms: i >= 63 ? 60 : null, resting_hr: 50, sleep_seconds: 8 * 3600, body_battery_high: 90 }) as Partial<DailyRow>);
    const b = briefing(end, rows, [], facts, "2026-06-20");
    expect(b.signals.map((s) => s.signal)).not.toContain("HRV");
    // A reset date that hides the old watch's nights does the same.
    const old = days(end, 70, () => ({ hrv_ms: 60, resting_hr: 50, sleep_seconds: 8 * 3600, body_battery_high: 90 }));
    const reset = briefing(end, old, [], facts, "2026-06-20", { baselineFrom: "2026-10-10" });
    expect(reset.signals.map((s) => s.signal)).not.toContain("HRV");
    expect(reset.baselines.hrv_baseline_from).toBe("2026-10-10");
  });
  it("goes green when everything is normal", () => {
    const end = "2026-10-20";
    const rows = days(end, 70, (_, i) => ({ hrv_ms: 60 + (i % 5), resting_hr: 50 + (i % 2), sleep_seconds: 8 * 3600, body_battery_high: 90 }));
    const acts = eachDate("2026-07-01", end).filter((_, i) => i % 2 === 0).map((d) => act(d, 70));
    expect(briefing(end, rows, acts, facts, "2026-06-20").overall.status).toBe("green");
  });
});

describe("weekly report and trends", () => {
  it("summarizes weeks with week-over-week change", () => {
    const rows = days("2026-10-18", 28, () => ({ sleep_seconds: 7 * 3600, hrv_ms: 60 }));
    const acts = [act("2026-10-06", 100), act("2026-10-13", 150), act("2026-10-15", 50)];
    const r = weeklyReport(rows, acts, [], facts, "2026-10-05", "2026-10-18");
    expect(r.weeks).toHaveLength(2);
    expect((r.weeks[1].training as { load: number }).load).toBe(200);
    expect((r.weeks[1].vs_previous_week as { load_pct: number }).load_pct).toBe(100);
    expect((r.weeks[0].training as { intensity: { easy_z1_z2_pct: number } }).intensity.easy_z1_z2_pct).toBe(77);
  });
  it("finds a falling resting HR and compares with the previous period", () => {
    const rows = days("2026-10-20", 120, (_, i) => ({ resting_hr: 60 - i / 10 }));
    const cur = rows.slice(60);
    const prev = rows.slice(0, 60);
    const t = metricTrend("resting_hr", cur, [], facts, cur[0].date, "2026-10-20", undefined, prev, []);
    expect(t.trend?.direction).toBe("falling");
    expect(t.trend?.judgement).toBe("improving");
    expect(t.previous_period?.change).toBeLessThan(0);
    expect(t.granularity).toBe("week");
  });
  it("sums activity metrics with rest days as zero", () => {
    const t = metricTrend("running_km", [], [act("2026-10-01", 50), act("2026-10-03", 50)], facts, "2026-10-01", "2026-10-07");
    expect(t.summary.total).toBe(20);
    expect(t.series).toHaveLength(7);
  });
});

describe("profile facts", () => {
  it("reads units, zones and age from Garmin's settings", () => {
    const f = profileFacts(
      { userData: { gender: "FEMALE", birthDate: "1990-05-01", measurementSystem: "statute_us", vo2MaxRunning: 48 }, timeZone: "America/New_York" },
      [{ sport: "RUNNING", zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 160, zone5Floor: 175, maxHeartRateUsed: 188, restingHeartRateUsed: 52 }],
      "2026-10-20",
    );
    expect(f).toMatchObject({ unit: "mi", gender: "female", age: 36, vo2maxRunning: 48, timeZone: "America/New_York", maxHr: 188, restingHr: 52 });
    expect(f.hrZoneFloors.running).toEqual([100, 120, 140, 160, 175]);
  });
});
