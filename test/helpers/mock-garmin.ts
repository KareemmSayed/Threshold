/**
 * A fake Garmin Personal API with deterministic data for any date, Garmin's
 * payload shapes, and Garmin's range limits (400 when a range is too long).
 */
import { INTENSITY, syntheticActivity, TRIGGER, zipped, type LapSpec } from "./fit-writer";

const DAY_MS = 86_400_000;
const LIMITS: Record<string, number> = { dailysummaries: 180, sleep: 28, hrv: 180, stress: 7, steps: 7, bodyBattery: 28, weight: 31, hydration: 28 };

export interface MockOptions {
  /** Oldest date with any data. */
  historyStart?: string;
  /** Answer 429 to every data request. */
  rateLimited?: boolean;
  /** Reject the API key. */
  badKey?: boolean;
  /** A date with no sleep and no HRV record: the watch has not synced that night yet. */
  nightNotSynced?: string;
  /** A date with an extra track session of 6 x 600 m, run as a structured workout. */
  intervalSession?: string;
  /** A date with an extra strength session. */
  strengthSession?: string;
}

/** Ids of the extra sessions: far from the dated ids, and from each other. */
export const intervalSessionId = (date: string) => 30_000_000_000 + Math.round(Date.parse(date) / DAY_MS);
export const strengthSessionId = (date: string) => 40_000_000_000 + Math.round(Date.parse(date) / DAY_MS);

const REP_S = 158; // 600 m at 3.8 m/s
const REST_S = 90;
const WARMUP_S = 600;
const COOLDOWN_S = 300;
const REPS = 6;

/**
 * A structured track workout as Garmin records it: a warm-up, six 600 m reps that the watch
 * auto-laps at 400 m, 90 s rests, and a cool-down. Slower than the steady runs' best efforts,
 * so it never changes the records the other tests check.
 */
export function intervalFit(start: number): Uint8Array {
  const repStart = (i: number) => WARMUP_S + i * (REP_S + REST_S);
  const total = repStart(REPS - 1) + REP_S + COOLDOWN_S;
  const phase = (t: number): { kind: "warmup" | "rep" | "rest" | "cooldown"; into: number } => {
    if (t < WARMUP_S) return { kind: "warmup", into: t };
    const since = t - WARMUP_S;
    const i = Math.floor(since / (REP_S + REST_S));
    const into = since - i * (REP_S + REST_S);
    if (i >= REPS || (i === REPS - 1 && into >= REP_S)) return { kind: "cooldown", into: t - (repStart(REPS - 1) + REP_S) };
    return into < REP_S ? { kind: "rep", into } : { kind: "rest", into: into - REP_S };
  };
  const laps: LapSpec[] = [{ from: 0, to: WARMUP_S, intensity: INTENSITY.warmup, trigger: TRIGGER.manual, step: 0 }];
  for (let i = 0; i < REPS; i++) {
    const s = repStart(i);
    // 400 m takes 105 s at 3.8 m/s; the watch laps there, inside the same workout step.
    laps.push({ from: s, to: s + 105, intensity: INTENSITY.active, trigger: TRIGGER.distance, step: 1 });
    laps.push({ from: s + 105, to: s + REP_S, intensity: INTENSITY.active, trigger: TRIGGER.distance, step: 1 });
    if (i < REPS - 1) laps.push({ from: s + REP_S, to: s + REP_S + REST_S, intensity: INTENSITY.rest, trigger: TRIGGER.manual, step: 2 });
  }
  laps.push({ from: total - COOLDOWN_S, to: total, intensity: INTENSITY.cooldown, trigger: TRIGGER.sessionEnd, step: 3 });
  return syntheticActivity({
    start,
    seconds: total,
    speed: (t) => ({ warmup: 2.8, rep: 3.8, rest: 1.2, cooldown: 2.6 })[phase(t).kind],
    hr: (t) => {
      const p = phase(t);
      if (p.kind === "rep") return 140 + (35 * p.into) / REP_S;
      if (p.kind === "rest") return 175 - (35 * p.into) / REST_S;
      return p.kind === "warmup" ? 130 + (10 * p.into) / WARMUP_S : 175 - Math.min(45, p.into / 2);
    },
    laps,
    ascent: 0,
    altitude: () => 100,
  });
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
    eventType: { typeId: 9, typeKey: "uncategorized" },
    // Running dynamics as Garmin lists them: stride and oscillation in centimetres.
    ...(running ? { averageRunningCadenceInStepsPerMinute: 172, avgStrideLength: 118.4, avgGroundContactTime: 245, avgVerticalOscillation: 8.9, avgVerticalRatio: 7.5 } : {}),
  };
}

function intervalActivity(date: string) {
  return {
    activityId: intervalSessionId(date),
    activityName: "Track Running",
    startTimeLocal: `${date} 18:00:00`,
    startTimeGMT: `${date} 16:00:00`,
    activityType: { typeKey: "track_running", typeId: 8 },
    eventType: { typeId: 9, typeKey: "uncategorized" },
    distance: 5900,
    duration: 2298,
    movingDuration: 2200,
    elapsedDuration: 2298,
    elevationGain: 0,
    averageSpeed: 2.57,
    averageHR: 150,
    maxHR: 176,
    calories: 380,
    aerobicTrainingEffect: 3.4,
    anaerobicTrainingEffect: 2.6,
    activityTrainingLoad: 150,
    hrTimeInZone_1: 400,
    hrTimeInZone_2: 500,
    hrTimeInZone_3: 500,
    hrTimeInZone_4: 600,
    hrTimeInZone_5: 200,
    trainingEffectLabel: "VO2MAX",
    lapCount: 19,
  };
}

function strengthActivity(date: string) {
  return {
    activityId: strengthSessionId(date),
    activityName: "Strength",
    startTimeLocal: `${date} 12:00:00`,
    startTimeGMT: `${date} 10:00:00`,
    activityType: { typeKey: "strength_training", typeId: 13 },
    eventType: { typeId: 9, typeKey: "uncategorized" },
    distance: 0,
    duration: 2400,
    movingDuration: 1500,
    averageSpeed: 0,
    averageHR: 105,
    maxHR: 140,
    calories: 210,
    activityTrainingLoad: 25,
    totalSets: 6,
    activeSets: 5,
    totalReps: 62,
    // Garmin stores weights in grams.
    summarizedExerciseSets: [
      { category: "SQUAT", reps: 30, volume: 1_800_000, duration: 240000, sets: 3, maxWeight: 60000 },
      { category: "PUSH_UP", reps: 32, volume: 0, duration: 180000, sets: 2, maxWeight: 0 },
    ],
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
        avgSleepStress: Math.round(15 + rand(d, 14) * 6),
        // Bedtime between 21:40 and 22:20 the evening before.
        sleepStartTimestampLocal: Date.parse(`${d}T00:00:00Z`) - 2 * 3600_000 + Math.round((rand(d, 15) - 0.5) * 40) * 60_000,
        sleepEndTimestampLocal: Date.parse(`${d}T06:30:00Z`),
      }));
      return r instanceof Response ? r : json(r.filter((n) => (n as { calendarDate: string }).calendarDate !== opts.nightNotSynced));
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
      return r instanceof Response ? r : json({ hrvSummaries: r.filter((n) => (n as { calendarDate: string }).calendarDate !== opts.nightNotSynced), userProfilePk: 1 });
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
      const all: unknown[] = dates(s < historyStart ? historyStart : s, e)
        .reverse()
        .flatMap((d) => [
          ...(d === opts.intervalSession ? [intervalActivity(d)] : []),
          ...(d === opts.strengthSession ? [strengthActivity(d)] : []),
          ...(Math.round(Date.parse(d) / DAY_MS) % 2 === 0 ? [activity(d)] : []),
        ]);
      return json(all.slice(start, start + limit));
    }
    if ((m = path.match(/^\/download-service\/files\/activity\/(\d+)$/)) && Number(m[1]) >= 40_000_000_000) {
      return new Response("no file", { status: 404 });
    }
    if ((m = path.match(/^\/download-service\/files\/activity\/(\d+)$/)) && Number(m[1]) >= 30_000_000_000) {
      const date = iso((Number(m[1]) - 30_000_000_000) * DAY_MS);
      return new Response(await zipped(intervalFit(Date.parse(`${date}T16:00:00Z`) / 1000), `${m[1]}_ACTIVITY.fit`), { headers: { "Content-Type": "application/zip" } });
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
