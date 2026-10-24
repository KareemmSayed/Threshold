/** Per-invocation state shared by tools and the cron job. */
import { ensureSchema } from "./archive/schema";
import { getMeta, setMeta } from "./archive/store";
import { limitsFor, type Env, type Limits } from "./env";
import { Budget, GarminClient, type GarminClientOptions } from "./garmin/client";
import { getHeartRateZones, getProfileSettings } from "./garmin/endpoints";
import { daysBetween, isIsoDate, isValidTimeZone, todayIn } from "./util/dates";

export interface AppContext {
  env: Env;
  db: D1Database;
  limits: Limits;
  budget: Budget;
  garmin(): GarminClient;
  timeZone: string;
  today: string;
  now: number;
  /** Notes the caller should see: partial data, rate limits, key expiry. */
  notes: string[];
  /** Set when Garmin rate limited this invocation: seconds to wait. */
  rateLimitedFor?: number;
}

export interface ContextOptions extends GarminClientOptions {
  mode: "tool" | "cron";
  now?: () => number;
}

export async function createContext(env: Env, opts: ContextOptions): Promise<AppContext> {
  if (!env.DB) throw new Error("The D1 binding DB is missing. Check wrangler.jsonc.");
  await ensureSchema(env.DB);
  const limits = limitsFor(env);
  const budget = new Budget(opts.mode === "cron" ? limits.cronRequests : limits.toolRequests);
  let client: GarminClient | undefined;
  const nowMs = opts.now?.() ?? Date.now();

  let timeZone = env.TIMEZONE?.trim() ?? "";
  if (!timeZone || !isValidTimeZone(timeZone)) {
    const profile = await getMeta<CachedProfile>(env.DB, "profile").catch(() => null);
    timeZone = profile?.facts.timeZone && isValidTimeZone(profile.facts.timeZone) ? profile.facts.timeZone : "UTC";
  }
  const today = todayIn(timeZone, new Date(nowMs));
  const ctx: AppContext = {
    env,
    db: env.DB,
    limits,
    budget,
    garmin: () => (client ??= new GarminClient(env, budget, { fetchImpl: opts.fetchImpl, now: opts.now ? () => opts.now!() / 1000 : undefined })),
    timeZone,
    today,
    now: nowMs,
    notes: [],
  };
  const expiry = keyExpiry(env, today);
  if (expiry && expiry.daysLeft <= 14) ctx.notes.push(expiry.message);
  if (env.HRV_BASELINE_FROM?.trim() && !hrvBaselineFrom(env)) ctx.notes.push("HRV_BASELINE_FROM is not a valid YYYY-MM-DD date, so it is ignored.");
  return ctx;
}

/** The date the HRV baseline restarts from (a new watch), or undefined when unset or invalid. */
export function hrvBaselineFrom(env: Env): string | undefined {
  const date = env.HRV_BASELINE_FROM?.trim();
  return date && isIsoDate(date) ? date : undefined;
}

export function keyExpiry(env: Env, today: string): { daysLeft: number; message: string } | null {
  const date = env.GARMIN_KEY_EXPIRES?.trim();
  if (!date || !isIsoDate(date)) return null;
  const daysLeft = daysBetween(today, date);
  const message =
    daysLeft < 0
      ? `The Garmin API key expired on ${date}. Create a new one at https://connect.garmin.com/app/settings/personalApiToken, then run: npx wrangler secret put GARMIN_API_KEY`
      : `The Garmin API key expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${date}). Create a new one and run: npx wrangler secret put GARMIN_API_KEY`;
  return { daysLeft, message };
}

export interface ProfileFacts {
  timeZone?: string;
  unit: "km" | "mi";
  gender?: "male" | "female";
  age?: number;
  vo2maxRunning?: number;
  vo2maxCycling?: number;
  lactateThresholdHr?: number;
  lactateThresholdPace?: string;
  maxHr?: number;
  restingHr?: number;
  ftp?: number;
  weightKg?: number;
  /** Zone floors (zones 1..5) per sport key: default, running, cycling, ... */
  hrZoneFloors: Record<string, number[]>;
}

interface CachedProfile {
  fetchedAt: number;
  settings: unknown;
  zones: unknown;
  facts: ProfileFacts;
}

function findKey(obj: unknown, test: (key: string, value: unknown) => boolean, depth = 0): unknown {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (test(k, v)) return v;
    const nested = findKey(v, test, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

const numKey = (obj: unknown, ...names: string[]): number | undefined => {
  const lower = names.map((n) => n.toLowerCase());
  const v = findKey(obj, (k, val) => lower.includes(k.toLowerCase()) && typeof val === "number" && Number.isFinite(val) && val > 0);
  return v as number | undefined;
};

export function profileFacts(settings: unknown, zones: unknown, today: string): ProfileFacts {
  const tz = findKey(settings, (k, v) => /time_?zone/i.test(k) && typeof v === "string" && isValidTimeZone(v)) as string | undefined;
  const system = findKey(settings, (k, v) => /measurementSystem/i.test(k) && typeof v === "string") as string | undefined;
  const gender = findKey(settings, (k, v) => k.toLowerCase() === "gender" && typeof v === "string") as string | undefined;
  const birth = findKey(settings, (k, v) => /birth_?date/i.test(k) && typeof v === "string") as string | undefined;
  const ltSpeed = numKey(settings, "lactateThresholdSpeed");
  const weight = numKey(settings, "weight");
  const facts: ProfileFacts = {
    timeZone: tz,
    unit: system && /statute|imperial/i.test(system) ? "mi" : "km",
    gender: gender ? (/^f/i.test(gender) ? "female" : /^m/i.test(gender) ? "male" : undefined) : undefined,
    age: birth && isIsoDate(birth.slice(0, 10)) ? Math.floor(daysBetween(birth.slice(0, 10), today) / 365.25) : undefined,
    vo2maxRunning: numKey(settings, "vo2MaxRunning"),
    vo2maxCycling: numKey(settings, "vo2MaxCycling"),
    lactateThresholdHr: numKey(settings, "lactateThresholdHeartRate"),
    // Garmin stores lactate threshold speed in m/s scaled by 10 in some payloads; accept plausible values only.
    lactateThresholdPace: ltSpeed ? paceString(ltSpeed < 1 ? ltSpeed * 10 : ltSpeed) : undefined,
    ftp: numKey(settings, "functionalThresholdPower", "ftp"),
    weightKg: weight ? Math.round((weight > 1000 ? weight / 1000 : weight) * 10) / 10 : undefined,
    hrZoneFloors: {},
  };
  const zoneList = Array.isArray(zones) ? zones : zones && typeof zones === "object" ? (Object.values(zones).find(Array.isArray) as unknown[] | undefined) : undefined;
  for (const z of zoneList ?? []) {
    if (!z || typeof z !== "object") continue;
    const rec = z as Record<string, unknown>;
    const floors = [1, 2, 3, 4, 5].map((i) => rec[`zone${i}Floor`]);
    if (!floors.every((f) => typeof f === "number" && f > 0)) continue;
    const sport = String(rec.sport ?? "DEFAULT").toLowerCase();
    facts.hrZoneFloors[sport] = floors as number[];
    if (typeof rec.maxHeartRateUsed === "number" && (!facts.maxHr || sport === "default")) facts.maxHr = rec.maxHeartRateUsed;
    if (typeof rec.restingHeartRateUsed === "number" && rec.restingHeartRateUsed > 0 && (!facts.restingHr || sport === "default")) facts.restingHr = rec.restingHeartRateUsed;
    if (!facts.lactateThresholdHr && typeof rec.lactateThresholdHeartRateUsed === "number" && rec.lactateThresholdHeartRateUsed > 0) facts.lactateThresholdHr = rec.lactateThresholdHeartRateUsed;
  }
  if (!facts.maxHr && facts.age) facts.maxHr = Math.round(208 - 0.7 * facts.age); // Tanaka
  return facts;
}

function paceString(speed: number): string | undefined {
  if (!(speed > 0.5 && speed < 10)) return undefined;
  const s = Math.round(1000 / speed);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`;
}

/** Profile settings and HR zones, cached for a day. Never fails: returns defaults when Garmin is unreachable. */
export async function loadProfile(ctx: AppContext, maxAgeHours = 24): Promise<{ facts: ProfileFacts; settings: unknown; zones: unknown }> {
  const cached = await getMeta<CachedProfile>(ctx.db, "profile").catch(() => null);
  if (cached && ctx.now - cached.fetchedAt < maxAgeHours * 3600_000) return cached;
  try {
    if (ctx.budget.remaining < 3) throw new Error("budget");
    const garmin = ctx.garmin();
    const settings = await getProfileSettings(garmin);
    const zones = await getHeartRateZones(garmin).catch(() => null);
    const facts = profileFacts(settings, zones, ctx.today);
    const fresh: CachedProfile = { fetchedAt: ctx.now, settings, zones, facts };
    await setMeta(ctx.db, "profile", fresh);
    return fresh;
  } catch {
    return cached ?? { facts: { unit: "km", hrZoneFloors: {} }, settings: null, zones: null };
  }
}

export function zoneFloorsFor(facts: ProfileFacts, sport: string): number[] | undefined {
  return facts.hrZoneFloors[sport] ?? facts.hrZoneFloors.default ?? Object.values(facts.hrZoneFloors)[0];
}
