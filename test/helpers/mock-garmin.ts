/**
 * A fake Garmin Personal API with deterministic data for any date, Garmin's
 * payload shapes, and Garmin's range limits (400 when a range is too long).
 */
import { syntheticActivity, zipped } from "./fit-writer";

const DAY_MS = 86_400_000;
const LIMITS: Record<string, number> = { dailysummaries: 180, sleep: 28, hrv: 180, stress: 7, steps: 7, bodyBattery: 28, weight: 31, hydration: 28 };

export interface MockOptions {
  /** Oldest date with any data. */
  historyStart?: string;
  /** Answer 429 to every data request. */
  rateLimited?: boolean;
  /** Reject the API key. */
  badKey?: boolean;
}

export interface MockGarmin {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: string[];
  tokenExchanges: number;
}

function jwt(exp: number): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64({ exp, scope: ["fitness_read", "wellness_read"] })}.sig`;
}

// Deterministic pseudo-random in [0, 1) per date and salt.
function rand(date: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (const c of date) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function dates(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += DAY_MS) out.push(iso(t));
  return out;
}
const span = (s: string, e: string) => Math.round((Date.parse(e) - Date.parse(s)) / DAY_MS) + 1;

export function activityId(date: string): number {
  return 20_000_000_000 + Math.round(Date.parse(date) / DAY_MS);
}

function activity(date: string) {
  const day = Math.round(Date.parse(date) / DAY_MS);
  const running = day % 4 === 0;
  const distance = running ? 8000 + rand(date, 9) * 8000 : 30000 + rand(date, 9) * 20000;
  const speed = running ? 2.9 + rand(date, 10) * 0.6 : 7 + rand(date, 10) * 2;
  return {
    activityId: activityId(date),
    activityName: running ? "Morning Run" : "Afternoon Ride",
    startTimeLocal: `${date} 07:15:00`,
    startTimeGMT: `${date} 05:15:00`,
    activityType: { typeKey: running ? "running" : "road_biking", typeId: running ? 1 : 10 },
    distance,
    duration: distance / speed,
    movingDuration: distance / speed - 30,
    elapsedDuration: distance / speed + 60,
    elevationGain: 50 + rand(date, 11) * 150,
    averageSpeed: speed,
    averageHR: 140 + rand(date, 12) * 15,
    maxHR: 170,
    calories: 600,
    aerobicTrainingEffect: 3.1,
    anaerobicTrainingEffect: 0.8,
    activityTrainingLoad: 60 + rand(date, 13) * 80,
    vO2MaxValue: running ? 52 : null,
    hrTimeInZone_1: 300,
    hrTimeInZone_2: 1500,
    hrTimeInZone_3: 900,
    hrTimeInZone_4: 200,
    hrTimeInZone_5: 0,
    trainingEffectLabel: "AEROBIC_BASE",
    ownerFullName: "Should Be Stripped",
  };
}

export function createMockGarmin(opts: MockOptions = {}): MockGarmin {
  const historyStart = opts.historyStart ?? "2026-06-01";
  const state: MockGarmin = { calls: [], tokenExchanges: 0, fetch: async () => new Response() };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const has = (d: string) => d >= historyStart;

  state.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname;
    const q = url.searchParams;
    state.calls.push(`${init?.method ?? "GET"} ${path}${url.search}`);
    const auth = new Headers(init?.headers).get("Authorization") ?? "";

    if (path === "/personalapitoken-service/personal-api/personal-api-key/token") {
      state.tokenExchanges++;
      if (opts.badKey || auth !== "ApiKey test-garmin-key") return new Response("invalid key", { status: 401 });
      return new Response(jwt(Math.floor(Date.now() / 1000) + 24 * 3600));
    }
    if (!auth.startsWith("Bearer ") || opts.badKey) return new Response("no token", { status: 401 });
    if (opts.rateLimited) return new Response("slow down", { status: 429, headers: { "Retry-After": "120" } });

    const range = (limitKey: string, s: string, e: string, make: (d: string) => unknown) => {
      if (span(s, e) > LIMITS[limitKey]) return new Response("", { status: 400 });
      return dates(s, e).filter(has).map(make);
    };
    let m: RegExpMatchArray | null;

    if (path === "/usersummary-service/v2/dailysummaries") {
      const r = range("dailysummaries", q.get("startDate")!, q.get("endDate")!, (d) => ({
        calendarDate: d,
        source: "DEVICE",
        movement: { steps: { value: Math.round(6000 + rand(d, 1) * 8000), goal: 10000, distanceInMeters: 7000 }, floorsAscended: { value: 9 } },
        heartRate: { restingValue: Math.round(48 + rand(d, 2) * 6), minValue: 44, maxValue: 165 },
        stress: { avgLevel: Math.round(20 + rand(d, 3) * 20), maxLevel: 90 },
        bodyBattery: { maxValue: Math.round(60 + rand(d, 4) * 40), minValue: 15, chargedValue: 60, drainedValue: 58 },
        calories: { burnedTotal: 2700, burnedActive: 700 },
        intensityMinutes: { moderate: 20, vigorous: 15 },
        respiration: { avgValue: 14.2 },
      }));
      return r instanceof Response ? r : json({ data: r });
    }
    if (path === "/sleep-service/sleep/dailySleepSummariesByDate") {
      const r = range("sleep", q.get("startDate")!, q.get("endDate")!, (d) => ({
        calendarDate: d,
        sleepTimeSeconds: Math.round(6.5 * 3600 + rand(d, 5) * 3600),
        deepSleepSeconds: 5400,
        lightSleepSeconds: 14000,
        remSleepSeconds: 6000,
        awakeSleepSeconds: 900,
        sleepScores: { overall: { value: Math.round(70 + rand(d, 6) * 20) } },
        avgHeartRate: 50,
        averageRespirationValue: 13.5,
        sleepStartTimestampLocal: Date.parse(`${d}T00:00:00Z`) - 2 * 3600_000,
        sleepEndTimestampLocal: Date.parse(`${d}T06:30:00Z`),
      }));
      return r instanceof Response ? r : json(r);
    }
    if ((m = path.match(/^\/hrv-service\/hrv\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/))) {
      const r = range("hrv", m[1], m[2], (d) => ({
        calendarDate: d,
        lastNightAvg: Math.round(55 + rand(d, 7) * 20),
        weeklyAvg: 63,
        lastNight5MinHigh: 90,
        baseline: { balancedLow: 55, balancedUpper: 72 },
        status: "BALANCED",
      }));
      return r instanceof Response ? r : json({ hrvSummaries: r, userProfilePk: 1 });
    }
    if ((m = path.match(/^\/weight-service\/weight\/range\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/))) {
      const r = range("weight", m[1], m[2], (d) => ({ summaryDate: d, latestWeight: { weight: 72000 + Math.round(rand(d, 8) * 1000), bmi: 22.1, bodyFat: 14.5 } }));
      return r instanceof Response ? r : json({ dailyWeightSummaries: r.filter((_, i) => i % 3 === 0) });
    }
    if ((m = path.match(/^\/usersummary-service\/stats\/stress\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/))) {
      const r = range("stress", m[1], m[2], (d) => ({ calendarDate: d, values: { overallStressLevel: 30, restStressDuration: 30000 } }));
      return r instanceof Response ? r : json(r);
    }
    if (path === "/activitylist-service/activities/search/activities") {
      const start = Number(q.get("start") ?? 0);
      const limit = Number(q.get("limit") ?? 20);
      if (limit > 60) return new Response("", { status: 500 });
      const s = q.get("startDate") ?? historyStart;
      const e = q.get("endDate") ?? iso(Date.now());
      const all = dates(s < historyStart ? historyStart : s, e)
        .filter((d) => Math.round(Date.parse(d) / DAY_MS) % 2 === 0)
        .reverse()
        .map(activity);
      return json(all.slice(start, start + limit));
    }
    if ((m = path.match(/^\/download-service\/files\/activity\/(\d+)$/))) {
      const day = Number(m[1]) - 20_000_000_000;
      const date = iso(day * DAY_MS);
      const running = day % 4 === 0;
      const fit = syntheticActivity({
        start: Date.parse(`${date}T05:15:00Z`) / 1000,
        sport: running ? 1 : 2,
        speed: running ? (t) => (t >= 1200 && t < 1450 ? 4 : 3) : () => 8,
        power: running ? () => null : (t) => 200 + (t % 60 < 10 ? 150 : 0),
      });
      return new Response(await zipped(fit, `${m[1]}_ACTIVITY.fit`), { headers: { "Content-Type": "application/zip" } });
    }
    if ((m = path.match(/^\/activity-service\/activity\/(\d+)$/))) {
      return json({ activityId: Number(m[1]), activityName: "Morning Run", summaryDTO: { distance: 10000, startLatitude: 52.5, startLongitude: 13.4 }, locationName: "Berlin" });
    }
    if (path === "/userprofile-service/userprofile/settings") {
      return json({
        id: 1,
        userData: { gender: "MALE", birthDate: "1990-05-01", measurementSystem: "metric", vo2MaxRunning: 52, lactateThresholdHeartRate: 168, weight: 72000 },
        timeZone: "Europe/Berlin",
        displayName: "secret-name",
      });
    }
    if (path === "/biometric-service/heartRateZones/v2") {
      return json([{ sport: "DEFAULT", trainingMethod: "HR_RESERVE", zone1Floor: 110, zone2Floor: 128, zone3Floor: 146, zone4Floor: 164, zone5Floor: 178, maxHeartRateUsed: 190, restingHeartRateUsed: 48 }]);
    }
    if (path === "/sleep-service/sleep/dailySleep") {
      return json({ dailySleepDTO: { calendarDate: q.get("date"), sleepTimeSeconds: 27000 }, sleepMovement: Array.from({ length: 400 }, (_, i) => ({ startGMT: i, activityLevel: 1 })) });
    }
    if (path === "/wellness-service/wellness/dailyHeartRate") {
      return json({ calendarDate: q.get("date"), restingHeartRate: 49, heartRateValues: Array.from({ length: 300 }, (_, i) => [i * 120000, 60]) });
    }
    return new Response("not found", { status: 404 });
  };
  return state;
}
