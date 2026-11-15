/** Per-invocation state shared by tools and the cron job. */
import { ensureSchema } from "./archive/schema";
import { getMeta, setMeta } from "./archive/store";
import { limitsFor, type Env, type Limits } from "./env";
import { Budget, GarminClient, type GarminClientOptions } from "./garmin/client";
import { getHeartRateZones, getProfileSettings } from "./garmin/endpoints";
import { addDays, daysBetween, isIsoDate, isValidTimeZone, todayIn } from "./util/dates";

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
  /** Where a value came from when Garmin's profile did not supply it. */
  sources?: Record<string, string>;
}

/** Facts read from the archive, to fill what Garmin's profile leaves out and to check the zones. */
export interface ArchiveFacts {
  at: number;
  /** Mean resting HR of the last 30 days (at least 7 days of data). */
  restingHr?: number;
  weightKg?: number;
  /** Highest heart rate in the last 12 months, from activity files with sensor spikes removed. */
  observedMaxHr?: { bpm: number; date: string; activity_id: number; activities: number };
  /** Highest 20- and 60-minute average heart rates in the last 12 months. */
  best20MinHr?: { bpm: number; date: string };
  best60MinHr?: { bpm: number; date: string };
}

interface CachedProfile {
  fetchedAt: number;
  settings: unknown;
  zones: unknown;
  facts: ProfileFacts;
  derived?: ArchiveFacts;
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

const HOUR_MS = 3600_000;

/** What the archive itself knows about the athlete. Four small indexed reads in one round trip. */
async function archiveFacts(ctx: AppContext): Promise<ArchiveFacts> {
  const yearAgo = addDays(ctx.today, -365);
  const [rhr, weight, maxHr, maxCount, hr20, hr60] = await ctx.db.batch<Record<string, number | string | null>>([
    ctx.db.prepare(`SELECT AVG(resting_hr) AS v, COUNT(resting_hr) AS n FROM daily WHERE date >= ?`).bind(addDays(ctx.today, -30)),
    ctx.db.prepare(`SELECT weight_kg AS v FROM daily WHERE weight_kg IS NOT NULL AND date >= ? ORDER BY date DESC LIMIT 1`).bind(addDays(ctx.today, -180)),
    ctx.db.prepare(`SELECT fit_max_hr AS v, date, activity_id FROM activities WHERE fit_max_hr IS NOT NULL AND date >= ? ORDER BY fit_max_hr DESC LIMIT 1`).bind(yearAgo),
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE fit_max_hr IS NOT NULL AND date >= ?`).bind(yearAgo),
    ctx.db.prepare(`SELECT value AS v, date FROM best_efforts WHERE effort = '20min_hr' AND date >= ? ORDER BY value DESC LIMIT 1`).bind(yearAgo),
    ctx.db.prepare(`SELECT value AS v, date FROM best_efforts WHERE effort = '60min_hr' AND date >= ? ORDER BY value DESC LIMIT 1`).bind(yearAgo),
  ]);
  const one = (r: D1Result<Record<string, number | string | null>>) => r.results[0];
  const out: ArchiveFacts = { at: ctx.now };
  const r = one(rhr);
  if (r && typeof r.v === "number" && Number(r.n) >= 7) out.restingHr = Math.round(r.v);
  const w = one(weight);
  if (w && typeof w.v === "number") out.weightKg = w.v;
  const m = one(maxHr);
  if (m && typeof m.v === "number") out.observedMaxHr = { bpm: Math.round(m.v), date: String(m.date), activity_id: Number(m.activity_id), activities: Number(one(maxCount)?.n ?? 0) };
  const a = one(hr20);
  if (a && typeof a.v === "number") out.best20MinHr = { bpm: Math.round(a.v), date: String(a.date) };
  const b = one(hr60);
  if (b && typeof b.v === "number") out.best60MinHr = { bpm: Math.round(b.v), date: String(b.date) };
  return out;
}

/** Garmin's facts, with the gaps filled from the archive and each filled value's source named. */
function withFallbacks(facts: ProfileFacts, derived: ArchiveFacts | undefined): ProfileFacts {
  if (!derived) return facts;
  const out: ProfileFacts = { ...facts };
  const sources: Record<string, string> = {};
  if (!out.restingHr && derived.restingHr) {
    out.restingHr = derived.restingHr;
    sources.restingHr = "archive: mean resting HR of the last 30 days";
  }
  if (!out.weightKg && derived.weightKg) {
    out.weightKg = derived.weightKg;
    sources.weightKg = "archive: latest weigh-in";
  }
  if (!out.maxHr && derived.observedMaxHr) {
    out.maxHr = derived.observedMaxHr.bpm;
    sources.maxHr = "archive: highest heart rate recorded in the last 12 months";
  }
  if (Object.keys(sources).length) out.sources = sources;
  return out;
}

/**
 * Profile settings and HR zones, cached for a day, plus what the archive adds (also refreshed
 * daily). Never fails: returns defaults when Garmin is unreachable.
 */
export async function loadProfile(ctx: AppContext, maxAgeHours = 24): Promise<{ facts: ProfileFacts; settings: unknown; zones: unknown; derived?: ArchiveFacts }> {
  const cached = await getMeta<CachedProfile>(ctx.db, "profile").catch(() => null);
  let profile = cached && ctx.now - cached.fetchedAt < maxAgeHours * HOUR_MS ? cached : null;
  let changed = false;
  if (!profile) {
    try {
      if (ctx.budget.remaining < 3) throw new Error("budget");
      const garmin = ctx.garmin();
      const settings = await getProfileSettings(garmin);
      const zones = await getHeartRateZones(garmin).catch(() => null);
      profile = { fetchedAt: ctx.now, settings, zones, facts: profileFacts(settings, zones, ctx.today), derived: cached?.derived };
      changed = true;
    } catch {
      if (!cached) return { facts: { unit: "km", hrZoneFloors: {} }, settings: null, zones: null };
      profile = cached;
    }
  }
  // Retry hourly until the archive holds enough days for a resting HR, then daily.
  const derivedAge = profile.derived ? ctx.now - profile.derived.at : Infinity;
  if (maxAgeHours === 0 || derivedAge > (profile.derived?.restingHr ? 24 : 1) * HOUR_MS) {
    const derived = await archiveFacts(ctx).catch(() => null);
    if (derived) {
      profile = { ...profile, derived };
      changed = true;
    }
  }
  if (changed) await setMeta(ctx.db, "profile", profile).catch(() => {});
  return { ...profile, facts: withFallbacks(profile.facts, profile.derived) };
}

export interface ZoneCheck {
  profile_max_hr: number | null;
  observed_max_hr: ArchiveFacts["observedMaxHr"] | null;
  profile_lactate_threshold_hr: number | null;
  best_20min_hr: ArchiveFacts["best20MinHr"] | null;
  best_60min_hr: ArchiveFacts["best60MinHr"] | null;
  findings: string[];
}

/**
 * Do the heart-rate settings fit what the activity files show? Zones, intensity splits and
 * TRIMP all rest on them. Only one-sided conclusions are drawn: a heart rate that was
 * recorded proves a setting too low; a setting never reached only hints that it is too high.
 */
export function zoneCheck(garminFacts: ProfileFacts, derived: ArchiveFacts | undefined): ZoneCheck {
  const findings: string[] = [];
  const max = garminFacts.sources?.maxHr ? null : (garminFacts.maxHr ?? null);
  const observed = derived?.observedMaxHr ?? null;
  const lthr = garminFacts.lactateThresholdHr ?? null;
  if (max !== null && observed) {
    if (observed.bpm > max + 2) findings.push(`Max HR is set to ${max} bpm, but ${observed.bpm} bpm was recorded on ${observed.date}. The setting is too low, which shifts every zone down: raise it in Garmin Connect.`);
    else if (observed.bpm < max - 12 && observed.activities >= 30) findings.push(`Max HR is set to ${max} bpm; the highest recorded in 12 months is ${observed.bpm} bpm (${observed.activities} activities). If those included all-out efforts, the setting may be too high, which makes hard work look easier than it was.`);
    else if (observed.bpm < max - 12) findings.push(`Max HR is set to ${max} bpm; the highest recorded so far is ${observed.bpm} bpm, from ${observed.activities} analyzed activit${observed.activities === 1 ? "y" : "ies"}: too few to judge the setting.`);
    else findings.push(`Max HR setting (${max} bpm) fits the highest recorded value (${observed.bpm} bpm).`);
  } else if (!observed) findings.push("No activity files analyzed yet, so the max HR setting cannot be checked.");
  if (lthr !== null && derived?.best60MinHr && derived.best60MinHr.bpm > lthr + 3) {
    findings.push(`Lactate threshold HR is set to ${lthr} bpm, but ${derived.best60MinHr.bpm} bpm was held for 60 minutes on ${derived.best60MinHr.date}. A heart rate held for an hour is at or below threshold, so the setting is too low.`);
  }
  return {
    profile_max_hr: max,
    observed_max_hr: observed,
    profile_lactate_threshold_hr: lthr,
    best_20min_hr: derived?.best20MinHr ?? null,
    best_60min_hr: derived?.best60MinHr ?? null,
    findings,
  };
}

interface DeviceChange {
  checkedAt: number;
  /** The first day on the watch in use now, when it replaced another one. */
  date?: string;
  from?: string;
  to?: string;
}

const DEVICE_CHECK_MS = 6 * HOUR_MS;
const DEVICE_LOOKBACK_DAYS = 150;

/**
 * Notice a change of watch from the activity files. HRV from two devices is not comparable,
 * so the HRV baseline restarts on the first day of the new one. Rides are ignored (a bike
 * computer is not what records the night), and the new watch must have three activities.
 */
export async function detectDeviceChange(ctx: AppContext): Promise<DeviceChange> {
  const cached = await getMeta<DeviceChange>(ctx.db, "device_change").catch(() => null);
  if (cached && ctx.now - cached.checkedAt < DEVICE_CHECK_MS) return cached;
  const { results } = await ctx.db
    .prepare(`SELECT date, device FROM activities WHERE device IS NOT NULL AND sport != 'cycling' AND date >= ? ORDER BY start_local`)
    .bind(addDays(ctx.today, -DEVICE_LOOKBACK_DAYS))
    .all<{ date: string; device: string }>();
  const out: DeviceChange = { checkedAt: ctx.now };
  const current = results[results.length - 1]?.device;
  if (current) {
    let first = results.length - 1;
    while (first > 0 && results[first - 1].device === current) first--;
    if (first > 0 && results.length - first >= 3) {
      out.date = results[first].date;
      out.from = results[first - 1].device;
      out.to = current;
    }
  }
  await setMeta(ctx.db, "device_change", out).catch(() => {});
  return out;
}

/** Where the HRV baseline starts: the owner's HRV_BASELINE_FROM, else a watch change found in the files. */
export async function resolveHrvBaseline(ctx: AppContext): Promise<{ baselineFrom?: string; baselineReason?: string }> {
  const configured = hrvBaselineFrom(ctx.env);
  if (configured) return { baselineFrom: configured, baselineReason: "HRV_BASELINE_FROM setting" };
  const change = await detectDeviceChange(ctx).catch(() => null);
  if (change?.date) return { baselineFrom: change.date, baselineReason: `watch changed from ${change.from} to ${change.to} on ${change.date} (found in the activity files)` };
  return {};
}

export function zoneFloorsFor(facts: ProfileFacts, sport: string): number[] | undefined {
  return facts.hrZoneFloors[sport] ?? facts.hrZoneFloors.default ?? Object.values(facts.hrZoneFloors)[0];
}
