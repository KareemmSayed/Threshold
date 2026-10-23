/**
 * Catalog of Garmin Personal API endpoints.
 *
 * Paths follow Garmin's own client (github.com/garmin/connect-personal-api-python).
 * Range limits are the smallest values reported by Garmin's docs or observed in
 * October 2026; Garmin answers 400/500 with no message when a range is too long,
 * so long ranges are split, and a window that still fails is halved and retried.
 */
import { addDays, daysBetween, datePart, windows } from "../util/dates";
import { GarminError, type GarminClient } from "./client";

export interface RangeDataset {
  id: string;
  description: string;
  maxDays: number;
  fetch(client: GarminClient, start: string, end: string): Promise<unknown>;
  /** The list of per-day items inside a response. */
  items(raw: unknown): unknown[];
  /** The local calendar date of one item. */
  day(item: unknown): string | null;
}

const field = (key: string) => (item: unknown) =>
  item && typeof item === "object" ? datePart((item as Record<string, unknown>)[key]) : null;

/** Find the item list: the response itself, a named key, or its only array. */
const listAt = (key?: string) => (raw: unknown): unknown[] => {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  if (key && Array.isArray(obj[key])) return obj[key] as unknown[];
  const arrays = Object.values(obj).filter(Array.isArray);
  return arrays.length === 1 ? (arrays[0] as unknown[]) : [];
};

export const RANGE_DATASETS: Record<string, RangeDataset> = {
  daily_summaries: {
    id: "daily_summaries",
    description: "Daily totals: steps, distance, floors, resting/min/max HR, stress, Body Battery, calories, intensity minutes, respiration.",
    maxDays: 180,
    fetch: (c, s, e) => c.get("/usersummary-service/v2/dailysummaries", { startDate: s, endDate: e }),
    items: listAt("data"),
    day: field("calendarDate"),
  },
  sleep: {
    id: "sleep",
    description: "Nightly sleep summaries: duration, stages, score, overnight HR and respiration.",
    maxDays: 28,
    fetch: (c, s, e) => c.get("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: s, endDate: e }),
    items: listAt("dailySleepSummaries"),
    day: field("calendarDate"),
  },
  hrv: {
    id: "hrv",
    description: "Nightly HRV: last-night average, 7-day average, Garmin baseline band and status.",
    maxDays: 180,
    fetch: (c, s, e) => c.get(`/hrv-service/hrv/daily/${s}/${e}`),
    items: listAt("hrvSummaries"),
    day: field("calendarDate"),
  },
  body_battery: {
    id: "body_battery",
    description: "Body Battery per day: charged, drained, and the events behind them.",
    maxDays: 28,
    fetch: (c, s, e) => c.get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: s, endDate: e }),
    items: listAt(),
    day: (item) => field("date")(item) ?? field("calendarDate")(item),
  },
  stress: {
    id: "stress",
    description: "Daily stress level and time in each stress band.",
    maxDays: 7,
    fetch: (c, s, e) => c.get(`/usersummary-service/stats/stress/daily/${s}/${e}`),
    items: listAt(),
    day: field("calendarDate"),
  },
  steps: {
    id: "steps",
    description: "Daily steps, distance and step goal.",
    maxDays: 7,
    fetch: (c, s, e) => c.get(`/usersummary-service/stats/steps/daily/${s}/${e}`),
    items: listAt(),
    day: field("calendarDate"),
  },
  hydration: {
    id: "hydration",
    description: "Daily fluid intake, goal and sweat loss.",
    maxDays: 28,
    fetch: (c, s, e) => c.get(`/usersummary-service/stats/hydration/daily/${s}/${e}`),
    items: listAt(),
    day: field("calendarDate"),
  },
  weight: {
    id: "weight",
    description: "Weigh-ins and body composition (weights in grams, as Garmin stores them).",
    maxDays: 31,
    fetch: (c, s, e) => c.get(`/weight-service/weight/range/${s}/${e}`, { includeAll: true }),
    items: listAt("dailyWeightSummaries"),
    day: (item) => field("summaryDate")(item) ?? field("calendarDate")(item),
  },
  wellness_activities: {
    id: "wellness_activities",
    description: "All-day wellness activity summaries with time in zones.",
    maxDays: 28,
    fetch: (c, s, e) => c.get(`/wellnessactivity-service/activity/summary/range/${s}/${e}`),
    items: listAt(),
    day: (item) => field("calendarDate")(item) ?? field("startTimeLocal")(item),
  },
};

export interface DayEndpoint {
  id: string;
  description: string;
  fetch(client: GarminClient, date: string, today: string): Promise<unknown>;
}

export const DAY_ENDPOINTS: Record<string, DayEndpoint> = {
  sleep: {
    id: "sleep",
    description: "One night in full: stages, score and its factors, overnight HR, respiration, SpO2, HRV, stress.",
    fetch: (c, d) => c.get("/sleep-service/sleep/dailySleep", { date: d }),
  },
  hrv: {
    id: "hrv",
    description: "One night of HRV with every 5-minute reading.",
    fetch: (c, d) => c.get(`/hrv-service/hrv/${d}`),
  },
  heart_rate: {
    id: "heart_rate",
    description: "Resting, min and max HR, 7-day resting average, abnormal HR alerts.",
    fetch: (c, d) => c.get("/wellness-service/wellness/dailyHeartRate", { date: d }),
  },
  spo2: {
    id: "spo2",
    description: "Pulse ox averages, lowest value, altitude acclimation.",
    fetch: (c, d) => c.get(`/wellness-service/wellness/daily/spo2acclimation/${d}`),
  },
  food_log: {
    id: "food_log",
    description: "Garmin Connect nutrition log: meals, foods, nutrients, goals.",
    fetch: (c, d) => c.get(`/nutrition-service/food/logs/${d}`, { includeGoals: true, includeNutrition: true }),
  },
  fitness_age: {
    id: "fitness_age",
    description: "Fitness age, achievable fitness age, and the inputs behind them.",
    fetch: (c, d) => c.get(`/fitnessage-service/fitnessage/v2/${d}`),
  },
  menstrual_cycle: {
    id: "menstrual_cycle",
    description: "Cycle summary (phase, day, predictions) plus the day view (logged symptoms, flow).",
    fetch: async (c, d, today) => ({
      summary: await c.get(`/periodichealth-service/menstrualcycle/summary/${d}`),
      day: await c.get(`/periodichealth-service/menstrualcycle/dayview/${d}`, { todayDate: today }),
    }),
  },
};

export const ACTIVITY_PAGE_SIZE = 50;

export interface ActivitySearch {
  start?: number;
  limit?: number;
  startDate?: string;
  endDate?: string;
  activityType?: string;
  search?: string;
}

export function searchActivities(client: GarminClient, p: ActivitySearch): Promise<unknown> {
  return client.get("/activitylist-service/activities/search/activities", {
    start: p.start ?? 0,
    limit: Math.min(p.limit ?? 20, ACTIVITY_PAGE_SIZE),
    startDate: p.startDate,
    endDate: p.endDate,
    activityType: p.activityType,
    search: p.search,
  });
}

export const getActivity = (c: GarminClient, id: number | string) => c.get(`/activity-service/activity/${id}`);
export const getActivityWorkouts = (c: GarminClient, id: number | string) => c.get(`/activity-service/activity/${id}/workouts`);
export const downloadActivity = (c: GarminClient, id: number | string) => c.getBytes(`/download-service/files/activity/${id}`);
export const getProfileSettings = (c: GarminClient) => c.get("/userprofile-service/userprofile/settings");
export const getHeartRateZones = (c: GarminClient) => c.get("/biometric-service/heartRateZones/v2");

export interface RangeResult {
  /** Items keyed by local date, in date order. */
  byDay: Map<string, unknown>;
  /** Every window that answered, so callers can mark whole windows as fetched. */
  fetched: Array<[string, string]>;
  /** Windows Garmin refused even at one day. */
  failed: Array<{ start: string; end: string; error: string }>;
}

/**
 * Fetch an inclusive range in windows no longer than the dataset allows.
 * A window Garmin rejects with 400/500 is halved until it answers.
 */
export async function fetchRange(
  client: GarminClient,
  dataset: RangeDataset,
  start: string,
  end: string,
  windowDays = dataset.maxDays,
): Promise<RangeResult> {
  const result: RangeResult = { byDay: new Map(), fetched: [], failed: [] };
  const queue = windows(start, end, Math.max(1, Math.min(windowDays, dataset.maxDays)));
  while (queue.length) {
    const [s, e] = queue.shift()!;
    try {
      const raw = await dataset.fetch(client, s, e);
      for (const item of dataset.items(raw)) {
        const day = dataset.day(item);
        if (day && day >= s && day <= e) result.byDay.set(day, item);
      }
      result.fetched.push([s, e]);
    } catch (err) {
      const span = daysBetween(s, e) + 1;
      if (err instanceof GarminError && (err.status === 400 || err.status === 500) && span > 1) {
        const half = Math.floor(span / 2);
        queue.unshift([s, addDays(s, half - 1)], [addDays(s, half), e]);
        continue;
      }
      if (err instanceof GarminError && (err.status === 400 || err.status === 404 || err.status === 500)) {
        result.failed.push({ start: s, end: e, error: err.message });
        continue;
      }
      throw err;
    }
  }
  result.byDay = new Map([...result.byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  return result;
}
