import { Decoder, Stream } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { analyzeFit, bestAverages, bestDistanceEfforts, normalizedPower, pace } from "../../src/fit/analyze";
import { decodeFit, extractFit, FitDecodeError } from "../../src/fit/decode";
import { syntheticActivity, zipped } from "../helpers/fit-writer";

const START = Date.parse("2026-10-20T05:15:00Z") / 1000;
const run = syntheticActivity({ start: START, speed: (t) => (t >= 1200 && t < 1450 ? 4 : 3) });

describe("decodeFit", () => {
  it("matches Garmin's SDK record for record", () => {
    // Garmin's JS SDK does not support compressed timestamps, so compare on a file without them.
    const plain = syntheticActivity({ start: START, speed: (t) => (t >= 1200 && t < 1450 ? 4 : 3), compressed: false });
    const ours = decodeFit(plain);
    const sdk = new Decoder(Stream.fromByteArray(plain)).read({ mergeHeartRates: false }).messages as Record<string, Array<Record<string, unknown>>>;
    const records = sdk.recordMesgs;
    expect(ours.records.length).toBe(records.length);
    expect(ours.records.length).toBe(3600);
    for (const i of [0, 1, 2, 1799, 1800, 3599]) {
      const r = records[i];
      expect(ours.records.time[i]).toBe((r.timestamp as Date).getTime() / 1000);
      expect(ours.records.hr[i]).toBe(r.heartRate);
      expect(ours.records.distance[i]).toBeCloseTo(r.distance as number, 6);
      expect(ours.records.speed[i]).toBeCloseTo(r.enhancedSpeed as number, 6);
      expect(ours.records.altitude[i]).toBeCloseTo(r.enhancedAltitude as number, 6);
    }
    const session = sdk.sessionMesgs[0];
    expect(ours.sessions[0].sport).toBe("running");
    expect(ours.sessions[0].totalDistance).toBeCloseTo(session.totalDistance as number, 2);
    expect(ours.sessions[0].sportProfileName).toBe("Run");
    expect(ours.sessions[0].startTime).toBe((session.startTime as Date).toISOString());
    expect(ours.zonesTarget?.functionalThresholdPower).toBe(250);
    expect(ours.timeInZone[0].referenceMesg).toBe("session");
    expect(ours.physiology).toHaveLength(1);
    expect(ours.warnings).toEqual([]);
  });

  it("decodes compressed timestamps in order", () => {
    const { records } = decodeFit(run);
    for (let i = 1; i < records.length; i++) expect(records.time[i] - records.time[i - 1]).toBe(1);
  });

  it("can skip records for a fast summary pass", () => {
    const fit = decodeFit(run, { records: false });
    expect(fit.records.length).toBe(0);
    expect(fit.sessions).toHaveLength(1);
  });

  it("rejects files that are not FIT", () => {
    expect(() => decodeFit(new TextEncoder().encode("hello world, not a fit file"))).toThrow(FitDecodeError);
  });

  it("survives a truncated file", () => {
    const fit = decodeFit(run.slice(0, Math.floor(run.length / 2)));
    expect(fit.records.length).toBeGreaterThan(1000);
    expect(fit.warnings.length).toBeGreaterThan(0);
  });

  it("unzips Garmin's download and accepts bare FIT", async () => {
    expect(await extractFit(await zipped(run))).toEqual(run);
    expect(await extractFit(run)).toBe(run);
    await expect(extractFit(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).rejects.toThrow(FitDecodeError);
  });

  it("is fast enough for the Workers Free CPU budget", () => {
    const long = syntheticActivity({ start: START, seconds: 4 * 3600 });
    decodeFit(long);
    const t = performance.now();
    const fit = decodeFit(long);
    analyzeFit(fit);
    // Workers' clock only advances on I/O, so this measures nothing there; it guards regressions in Node-like runs.
    expect(performance.now() - t).toBeLessThan(250);
    expect(fit.records.length).toBe(4 * 3600);
  });
});

describe("analyzeFit", () => {
  const analysis = analyzeFit(decodeFit(run), { splitUnit: "km" });

  it("finds the fast kilometre", () => {
    const one = bestDistanceEfforts(decodeFit(run).records, [["1k", 1000]]);
    expect(one["1k"].time_s).toBe(250);
    expect(one["1k"].start_offset_s).toBe(1199);
    expect(analysis.best_efforts.distance["1k"]).toEqual({ time: "4:10", pace: "4:10/km", starts_at: "19:59" });
    expect(analysis.best_efforts.distance["5k"].time).toBeDefined();
    expect(analysis.best_efforts.distance["half"]).toBeUndefined(); // only ~11 km
  });

  it("reports aerobic decoupling and cardiac drift", () => {
    const d = analysis.durability!;
    expect(d.output).toBe("speed");
    expect(d.cardiac_drift_pct).toBeGreaterThan(3);
    expect(d.decoupling_pct).toBeGreaterThan(5);
    expect(d.verdict).toMatch(/5-10%/);
  });

  it("decodes Garmin's hidden metrics", () => {
    expect(analysis.hidden.vo2max).toBe(52.3);
    expect(analysis.hidden.experimental?.recovery_time.value).toBe(1260);
    expect(analysis.hidden.performance_condition).toEqual({ first: 2, final: -1, min: -1, max: 2 });
    expect(analysis.archive.vo2max).toBe(52.3);
  });

  it("explains when the hidden data is absent", () => {
    const plain = analyzeFit(decodeFit(syntheticActivity({ start: START, withPhysiology: false })));
    expect(plain.hidden.vo2max).toBeUndefined();
    expect(plain.hidden.performance_condition).toBeDefined();
  });

  it("uses device HR zones and builds splits", () => {
    const zones = analysis.hr_zones as { source: string; zones: Array<{ zone: number; time: string; pct: number }> };
    expect(zones.source).toBe("device");
    expect(zones.zones[2]).toMatchObject({ zone: 3, time: "40:00" });
    expect(analysis.splits!.length).toBe(11);
    expect(analysis.splits![0]).toMatchObject({ split: 1, distance_km: 1, pace: "5:33/km" });
    expect(analysis.summary).toMatchObject({ sport: "running", avg_hr: 148, aerobic_te: 3.1, anaerobic_te: 1.2 });
  });

  it("hides GPS unless asked", () => {
    const withSamples = analyzeFit(decodeFit(run), { samples: 10 });
    expect(withSamples.samples!.length).toBeLessThanOrEqual(10);
    expect(withSamples.samples![0]).not.toHaveProperty("lat");
    const withRoute = analyzeFit(decodeFit(run), { samples: 10, route: true });
    expect(withRoute.samples![0]).toHaveProperty("lat");
  });

  it("computes a power curve and NP for rides", () => {
    const ride = analyzeFit(decodeFit(syntheticActivity({ start: START, sport: 2, speed: () => 8, power: (t) => (t % 60 < 10 ? 350 : 200) })));
    expect(ride.best_efforts.power_w["5s"]).toBe(350);
    expect(ride.best_efforts.power_w["60min"]).toBe(225);
    expect(ride.summary.normalized_power_w).toBeGreaterThan(225);
    expect(ride.summary.training_stress_score).toBeGreaterThan(0);
    expect(ride.durability?.output).toBe("power");
  });
});

describe("helpers", () => {
  it("bestAverages skips windows with gaps", () => {
    const s = Float64Array.from([100, 100, NaN, NaN, 300, 300, 300]);
    expect(bestAverages(s, [["3s", 3]])).toEqual({ "3s": 300 });
  });
  it("normalizedPower needs a minute of data", () => {
    expect(normalizedPower(new Float64Array(30).fill(200))).toBeNull();
    expect(normalizedPower(new Float64Array(600).fill(200))).toBe(200);
  });
  it("pace formats per km and mile", () => {
    expect(pace(3.333333, "km")).toBe("5:00/km");
    expect(pace(3.333333, "mi")).toBe("8:03/mi");
    expect(pace(0)).toBeNull();
  });
});
