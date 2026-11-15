import { describe, expect, it } from "vitest";
import { analyzeFit, cleanHeartRate, gradeAdjustedSpeed, outputVariation, slopeCost } from "../../src/fit/analyze";
import { decodeFit } from "../../src/fit/decode";
import { classifyWorkout, snapDistance } from "../../src/fit/intervals";
import { syntheticActivity, TRIGGER, type LapSpec } from "../helpers/fit-writer";
import { intervalFit } from "../helpers/mock-garmin";

const START = Date.parse("2026-10-20T16:00:00Z") / 1000;

describe("interval detection", () => {
  it("reads a structured workout from its lap labels, joining auto-laps into reps", () => {
    const a = analyzeFit(decodeFit(intervalFit(START)), { splitUnit: "km" });
    expect(a.workout).toEqual({ type: "intervals", structure: "6 x 600 m" });
    const i = a.intervals!;
    expect(i.detected_from).toBe("lap labels");
    expect(i.reps).toHaveLength(6);
    // 400 m + 200 m auto-laps of one workout step are one rep.
    expect(i.reps[0]).toMatchObject({ rep: 1, distance_m: 600, time: "2:38", pace: "4:23/km", rest: "1:30" });
    expect(i.reps[5].rest).toBeNull();
    // Heart rate climbs to 175 in a rep and falls 35 bpm over the 90 s rest: about 23 bpm in the first minute.
    expect(i.reps[0].hr_drop_bpm).toBeGreaterThan(18);
    expect(i.reps[0].hr_drop_bpm).toBeLessThan(28);
    expect(i.reps[0].max_hr).toBeGreaterThanOrEqual(174);
    expect(i.work).toMatchObject({ reps: 6, distance_km: 3.6, fastest: "2:38", slowest: "2:38", spread_s: 0, fade_pct: 0, consistency_cv_pct: 0 });
    expect(i.rest).toMatchObject({ avg: "1:30" });
    expect(i.warmup).toBe("10:00");
    expect(i.cooldown).toBe("5:00");
    expect(i.verdict).toMatch(/Even reps/);
    expect(i.note).toBeUndefined();
  });

  it("does not report decoupling or efficiency for an interval session", () => {
    const a = analyzeFit(decodeFit(intervalFit(START)));
    expect(a.durability).toBeUndefined();
    expect(a.durability_note).toMatch(/interval session/);
    expect(a.efficiency_factor).toBeUndefined();
    expect(a.archive).toMatchObject({
      workout_type: "intervals",
      workout_structure: "6 x 600 m",
      rep_count: 6,
      rep_distance_m: 600,
      rep_time_s: 158,
      rest_s: 90,
      decoupling_pct: null,
      efficiency_factor: null,
    });
    expect(a.archive.work_speed_mps).toBeCloseTo(3.8, 1);
    expect(a.archive.work_hr).toBeGreaterThan(150);
  });

  it("keeps each lap to a short row and names the rests", () => {
    const laps = analyzeFit(decodeFit(intervalFit(START))).laps!;
    expect(laps).toHaveLength(19);
    expect(laps[0]).toMatchObject({ lap: 1, kind: "warmup", duration: "10:00" });
    expect(laps[1].kind).toBeUndefined(); // a work lap
    expect(laps[3].kind).toBe("rest");
    expect(laps[18].kind).toBe("cooldown");
    expect(Object.keys(laps[1]).sort()).toEqual(["avg_hr", "avg_pace", "avg_speed_kmh", "distance_km", "duration", "lap", "max_hr"]);
  });

  it("finds reps from laps pressed by hand, by their speed", () => {
    // Warm-up, five 5-minute reps at slightly different speeds with 2-minute jogs, cool-down.
    const speeds = [4.2, 4.3, 4.1, 4.25, 4.15];
    const laps: LapSpec[] = [{ from: 0, to: 600 }];
    for (let i = 0; i < 5; i++) {
      const s = 600 + i * 420;
      laps.push({ from: s, to: s + 300 }, { from: s + 300, to: s + 420 });
    }
    laps.push({ from: 2700, to: 3000, trigger: TRIGGER.sessionEnd });
    const speed = (t: number) => {
      if (t < 600) return 2.8;
      if (t >= 2700) return 2.6;
      const into = (t - 600) % 420;
      return into < 300 ? speeds[Math.floor((t - 600) / 420)] : 2.0;
    };
    const a = analyzeFit(decodeFit(syntheticActivity({ start: START, seconds: 3000, speed, laps })));
    expect(a.intervals?.detected_from).toBe("lap speeds");
    expect(a.workout).toEqual({ type: "intervals", structure: "5 x 5:00" });
    expect(a.intervals?.reps.map((r) => r.time)).toEqual(["5:00", "5:00", "5:00", "5:00", "5:00"]);
    expect(a.intervals?.warmup).toBe("10:00");
    expect(a.archive.rep_distance_m).toBeNull(); // reps set by time
    expect(a.archive.rep_time_s).toBe(300);
  });

  it("finds reps in the speed stream when there are no laps", () => {
    const speed = (t: number) => {
      if (t < 600) return 2.8;
      if (t >= 2400) return 2.6;
      return (t - 600) % 300 < 180 ? 4.5 : 2.2;
    };
    const a = analyzeFit(decodeFit(syntheticActivity({ start: START, seconds: 2700, speed })));
    expect(a.intervals?.detected_from).toBe("speed stream");
    expect(a.workout.type).toBe("intervals");
    expect(a.intervals?.reps).toHaveLength(6);
    expect(a.intervals?.note).toMatch(/accurate to a few seconds/);
    for (const rep of a.intervals!.reps) expect(Math.abs(Number(rep.distance_m) - 810)).toBeLessThan(60);
  });

  it("leaves a steady run alone, even with stops at traffic lights", () => {
    const steady = analyzeFit(decodeFit(syntheticActivity({ start: START })));
    expect(steady.intervals).toBeUndefined();
    expect(steady.workout).toEqual({ type: "steady" });
    expect(steady.durability).toBeDefined();
    expect(steady.efficiency_factor).toBeGreaterThan(0);

    const stops: Array<[number, number]> = [[300, 340], [1500, 1550], [1700, 1735], [3300, 3345]];
    const stopped = analyzeFit(decodeFit(syntheticActivity({ start: START, speed: (t) => (stops.some(([a, b]) => t >= a && t < b) ? 0 : 3) })));
    expect(stopped.intervals).toBeUndefined();
    expect(stopped.workout.type).toBe("steady");
  });

  it("names the session type from structure, evenness, length and heart rate", () => {
    const base = { sport: "running", duration_s: 3000, intervals: false, output_cv: 0.08, avg_hr: 150, zone_floors: [110, 128, 146, 164, 178] };
    expect(classifyWorkout(base)).toBe("steady");
    expect(classifyWorkout({ ...base, intervals: true })).toBe("intervals");
    expect(classifyWorkout({ ...base, output_cv: 0.4 })).toBe("variable");
    expect(classifyWorkout({ ...base, duration_s: 95 * 60 })).toBe("long");
    expect(classifyWorkout({ ...base, avg_hr: 170 })).toBe("tempo");
    expect(classifyWorkout({ ...base, avg_hr: 120 })).toBe("recovery");
    expect(classifyWorkout({ ...base, sport: "strength" })).toBe("other");
    expect(classifyWorkout({ ...base, sport: "cycling", output_cv: null, duration_s: 160 * 60 })).toBe("long");
    expect(snapDistance(1004)).toBe(1000);
    expect(snapDistance(1260)).toBe(1250);
    expect(snapDistance(398)).toBe(400);
  });
});

describe("heart rate cleaning", () => {
  it("drops readings out of range and spikes that do not last", () => {
    const hr = (t: number) => (t >= 1000 && t < 1005 ? 235 : t >= 2000 && t < 2007 ? 215 : 150);
    const a = analyzeFit(decodeFit(syntheticActivity({ start: START, hr })));
    expect(a.data_quality.hr_readings_dropped).toBe(12);
    // The session message claims 160; the cleaned stream never went above 150.
    expect(a.summary.max_hr).toBe(150);
    expect(a.data_quality.device_max_hr).toBe(160);
    expect(a.archive.max_hr).toBe(150);
    expect(a.best_efforts.hr_bpm["5min"]).toBe(150);
  });

  it("accepts a jump that lasts, and starts from the median of the first readings", () => {
    const time = Float64Array.from({ length: 200 }, (_, i) => i);
    const lasting = cleanHeartRate(time, Float64Array.from({ length: 200 }, (_, i) => (i < 100 ? 150 : 190)));
    expect(lasting.removed).toBe(10); // 8 + 3 bpm per second reaches 40 bpm after 11 s
    expect(lasting.hr[199]).toBe(190);
    const opening = cleanHeartRate(time, Float64Array.from({ length: 200 }, (_, i) => (i < 3 ? 210 : 120)));
    expect(opening.removed).toBe(3);
    expect(Number.isNaN(opening.hr[0])).toBe(true);
    expect(opening.hr[3]).toBe(120);
    expect(cleanHeartRate(time, new Float64Array(200).fill(NaN)).removed).toBe(0);
  });

  it("leaves a clean file untouched", () => {
    const a = analyzeFit(decodeFit(syntheticActivity({ start: START })));
    expect(a.data_quality.hr_readings_dropped).toBeUndefined();
    expect(a.summary.max_hr).toBe(160);
    expect(a.archive.max_hr).toBe(152);
  });
});

describe("grade-adjusted pace", () => {
  it("prices a slope with Minetti's cost curve", () => {
    expect(slopeCost(0)).toBe(1);
    expect(slopeCost(0.1)).toBeCloseTo(1.658, 2);
    expect(slopeCost(-0.1)).toBeCloseTo(0.598, 2);
    // A steady 3 m/s up a 10% climb is worth about 5 m/s on the flat.
    const climb = decodeFit(syntheticActivity({ start: START, seconds: 600, speed: () => 3, altitude: (t) => 100 + 0.3 * t })).records;
    const gap = gradeAdjustedSpeed(climb);
    expect(gap[300]).toBeGreaterThan(4.7);
    expect(gap[300]).toBeLessThan(5.2);
    expect(gap[0]).toBe(3); // no slope known yet
  });

  it("judges a hilly run on its flat-ground equivalent", () => {
    // Half an hour up an 8% climb at 2.6 m/s, then back down at 3.6 m/s, at one heart rate.
    const hilly = syntheticActivity({
      start: START,
      speed: (t) => (t < 1800 ? 2.6 : 3.6),
      hr: () => 150,
      altitude: (t) => (t < 1800 ? 100 + 0.208 * t : 474.4 - 0.208 * (t - 1800)),
      ascent: 374,
    });
    const a = analyzeFit(decodeFit(hilly), { splitUnit: "km" });
    expect(a.durability?.output).toBe("grade-adjusted speed");
    expect(a.durability?.caveats.join(" ")).not.toMatch(/Hilly route/);
    expect(a.summary.avg_gap_pace).toMatch(/\/km$/);
    const first = a.splits![0];
    expect(first.gap_pace).toMatch(/\/km$/);
    // Uphill, the flat-ground equivalent is faster than the pace on the watch.
    expect(first.gap_pace! < first.pace!).toBe(true);
    expect(a.workout.type).toBe("steady");

    const flat = analyzeFit(decodeFit(syntheticActivity({ start: START })));
    expect(flat.durability?.output).toBe("speed");
    expect(flat.splits![0].gap_pace).toBeUndefined();
  });

  it("measures how even the moving speed is", () => {
    expect(outputVariation(new Float64Array(600).fill(3), 0.5)).toBe(0);
    expect(outputVariation(Float64Array.from({ length: 600 }, (_, i) => (i % 2 ? 5 : 2)), 0.5)).toBeGreaterThan(0.3);
    expect(outputVariation(new Float64Array(30).fill(3), 0.5)).toBeNull();
  });
});

describe("form, track distances and the device", () => {
  const run = analyzeFit(decodeFit(syntheticActivity({ start: START, speed: (t) => (t >= 1200 && t < 1450 ? 4 : 3), dynamics: true })));

  it("reads running form from the session", () => {
    expect(run.form).toEqual({ stride_length_m: 1.18, ground_contact_ms: 242, vertical_oscillation_cm: 8.6, vertical_ratio_pct: 7.3 });
    expect(analyzeFit(decodeFit(syntheticActivity({ start: START }))).form).toBeUndefined();
  });

  it("times the track distances and archives heart-rate peaks", () => {
    expect(run.best_efforts.distance["200m"].time).toBe("0:50");
    expect(run.best_efforts.distance["800m"].time).toBe("3:20");
    expect(run.best_efforts.distance["1500m"]).toBeDefined();
    expect(run.best_efforts.distance["3k"]).toBeDefined();
    const kinds = new Set(run.archive.efforts.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["time_s", "hr_bpm"]));
    expect(run.archive.efforts.find((e) => e.effort === "5min_hr")).toEqual({ effort: "5min_hr", kind: "hr_bpm", value: 152 });
    expect(run.archive.efforts.find((e) => e.effort === "60min_hr")?.value).toBe(149);
  });

  it("records the device model, never a serial number", () => {
    expect(typeof run.archive.device).toBe("string");
    expect(run.archive.device).not.toMatch(/^\d+$/);
    const other = analyzeFit(decodeFit(syntheticActivity({ start: START, product: 65000 })));
    expect(other.archive.device).toBe("garmin-65000");
    expect(run.archive.avg_temp_c).toBeNull();
  });
});
