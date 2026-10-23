/**
 * Keeps the D1 archive filled.
 *
 * Reads go through the archive: a tool asks for a date range, missing or stale
 * days are fetched from Garmin in as few requests as the range limits allow,
 * stored, and then read back. The cron job does the same for recent days and
 * walks backwards through history a little at a time, so every invocation stays
 * inside the Workers subrequest and CPU limits.
 */
import type { AppContext } from "../context";
import { loadProfile, zoneFloorsFor } from "../context";
import { analyzeFit } from "../fit/analyze";
import { decodeFit, extractFit } from "../fit/decode";
import { BudgetExhaustedError, GarminAuthError, GarminError, GarminRateLimitError } from "../garmin/client";
import { ACTIVITY_PAGE_SIZE, RANGE_DATASETS, downloadActivity, fetchRange, searchActivities } from "../garmin/endpoints";
import { addDays, daysBetween, eachDate, isIsoDate, runs } from "../util/dates";
import { ARCHIVED_DATASETS, type ArchivedDataset } from "./flatten";
import { activityStatement, dailyStatements, fetchedDates, getMeta, runBatched, setMeta, setMetaStmt } from "./store";

const RECENT_DAYS = 3; // the watch may sync these late, so they are re-checked
const TODAY_MAX_AGE_MS = 15 * 60_000;
const RECENT_MAX_AGE_MS = 3 * 3600_000;
const OLDEST_DATE = "2006-01-01";
const MAX_FIT_ATTEMPTS = 3;
/** SQL condition for activities whose FIT file still needs importing. */
export const FIT_PENDING = `fit_status IS NULL AND COALESCE(fit_attempts, 0) < ${MAX_FIT_ATTEMPTS}`;

export interface SyncOutcome {
  /** True when everything asked for is now in the archive. */
  complete: boolean;
}

function handleStop(ctx: AppContext, err: unknown, what: string): void {
  if (err instanceof BudgetExhaustedError) {
    ctx.notes.push(`Fetched part of ${what}; the rest arrives with the next background sync (Workers request limit for one call).`);
    return;
  }
  if (err instanceof GarminRateLimitError) {
    ctx.rateLimitedFor = err.retryAfterSeconds;
    ctx.notes.push(`Garmin is rate limiting the key, so ${what} may be incomplete. ${err.message}`);
    return;
  }
  throw err;
}

/** Make sure the archive holds `datasets` for every date in the range. */
export async function ensureDaily(ctx: AppContext, datasets: ArchivedDataset[], start: string, end: string): Promise<SyncOutcome> {
  if (end > ctx.today) end = ctx.today;
  if (start > end) return { complete: true };
  const recentFrom = addDays(ctx.today, -(RECENT_DAYS - 1));
  let complete = true;
  for (const dataset of datasets) {
    if (ctx.rateLimitedFor) return { complete: false };
    const fetched = await fetchedDates(ctx.db, dataset, start, end);
    const stale = eachDate(start, end).filter((d) => {
      const at = fetched.get(d);
      if (at === undefined) return true;
      if (d === ctx.today) return ctx.now - at > TODAY_MAX_AGE_MS;
      if (d >= recentFrom) return ctx.now - at > RECENT_MAX_AGE_MS;
      return false;
    });
    if (!stale.length) continue;
    const spec = RANGE_DATASETS[dataset];
    // Newest first: recent data matters most when the budget runs short.
    const chunks = runs(stale, Math.min(spec.maxDays, ctx.limits.windowDays)).reverse();
    try {
      for (const [s, e] of chunks) {
        const result = await fetchRange(ctx.garmin(), spec, s, e);
        const statements: D1PreparedStatement[] = [];
        for (const [ws, we] of result.fetched) for (const d of eachDate(ws, we)) statements.push(...dailyStatements(ctx.db, dataset, d, result.byDay.get(d), ctx.now));
        for (const f of result.failed) for (const d of eachDate(f.start, f.end)) statements.push(...dailyStatements(ctx.db, dataset, d, undefined, ctx.now));
        await runBatched(ctx.db, statements);
      }
    } catch (err) {
      complete = false;
      handleStop(ctx, err, `${dataset} data`);
      break;
    }
  }
  return { complete };
}

type Interval = [string, string];

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && addDays(last[1], 1) >= s) {
      if (e > last[1]) last[1] = e;
    } else out.push([s, e]);
  }
  return out;
}

function subtractIntervals(want: Interval, have: Interval[]): Interval[] {
  let pieces: Interval[] = [want];
  for (const [hs, he] of have) {
    const next: Interval[] = [];
    for (const [s, e] of pieces) {
      if (he < s || hs > e) {
        next.push([s, e]);
        continue;
      }
      if (hs > s) next.push([s, addDays(hs, -1)]);
      if (he < e) next.push([addDays(he, 1), e]);
    }
    pieces = next;
  }
  return pieces;
}

interface ActivitySyncState {
  coverage: Interval[];
  recentAt: number;
}

/** Fetch every activity list page for a date range into the archive. */
async function pullActivities(ctx: AppContext, start: string, end: string): Promise<number> {
  let offset = 0;
  let total = 0;
  for (;;) {
    const page = await searchActivities(ctx.garmin(), { start: offset, limit: ACTIVITY_PAGE_SIZE, startDate: start, endDate: end });
    const items = Array.isArray(page) ? page : [];
    const statements = items.map((a) => activityStatement(ctx.db, a, ctx.now)).filter((s): s is D1PreparedStatement => s !== null);
    await runBatched(ctx.db, statements);
    total += items.length;
    if (items.length < ACTIVITY_PAGE_SIZE) return total;
    offset += items.length;
  }
}

/** Make sure the archive holds every activity in the range. */
export async function ensureActivities(ctx: AppContext, start: string, end: string): Promise<SyncOutcome> {
  if (end > ctx.today) end = ctx.today;
  if (start > end) return { complete: true };
  if (ctx.rateLimitedFor) return { complete: false };
  const state = (await getMeta<ActivitySyncState>(ctx.db, "activity_sync")) ?? { coverage: [], recentAt: 0 };
  const recentFrom = addDays(ctx.today, -(RECENT_DAYS - 1));
  // Recent days are trusted for a few minutes only; new activities appear there.
  const trusted = state.coverage
    .map(([s, e]): Interval => [s, ctx.now - state.recentAt > TODAY_MAX_AGE_MS && e >= recentFrom ? addDays(recentFrom, -1) : e])
    .filter(([s, e]) => s <= e);
  const missing = subtractIntervals([start, end], trusted).reverse();
  if (!missing.length) return { complete: true };
  try {
    for (const [s, e] of missing) {
      await pullActivities(ctx, s, e);
      state.coverage = mergeIntervals([...state.coverage, [s, e]]);
      if (e >= recentFrom) state.recentAt = ctx.now;
      await setMeta(ctx.db, "activity_sync", state);
    }
    return { complete: true };
  } catch (err) {
    handleStop(ctx, err, "the activity list");
    return { complete: false };
  }
}

export interface FitImportResult {
  status: "done" | "missing" | "error";
  analysis?: ReturnType<typeof analyzeFit>;
  error?: string;
}

/** Download, decode and analyze one activity's FIT file, and store the results. */
export async function importFit(ctx: AppContext, activityId: number): Promise<FitImportResult> {
  let result: FitImportResult;
  // Counted before the work: a run killed by the CPU limit must not retry the same file forever.
  await ctx.db.prepare(`UPDATE activities SET fit_attempts = COALESCE(fit_attempts, 0) + 1 WHERE activity_id = ?`).bind(activityId).run();
  try {
    const zip = await downloadActivity(ctx.garmin(), activityId);
    const fit = decodeFit(await extractFit(zip));
    const { facts } = await loadProfile(ctx);
    const sport = String(fit.sessions[0]?.sport ?? "");
    const analysis = analyzeFit(fit, { hrZoneFloors: zoneFloorsFor(facts, sport), ftp: facts.ftp, splitUnit: facts.unit });
    result = { status: "done", analysis };
  } catch (err) {
    if (err instanceof BudgetExhaustedError || err instanceof GarminRateLimitError || err instanceof GarminAuthError) {
      // Not this file's fault: give the attempt back.
      await ctx.db.prepare(`UPDATE activities SET fit_attempts = fit_attempts - 1 WHERE activity_id = ? AND fit_attempts > 0`).bind(activityId).run();
      throw err;
    }
    const missing = err instanceof GarminError && err.status === 404;
    result = { status: missing ? "missing" : "error", error: err instanceof Error ? err.message : String(err) };
  }
  await storeFitResult(ctx, activityId, result);
  return result;
}

async function storeFitResult(ctx: AppContext, activityId: number, result: FitImportResult): Promise<void> {
  const a = result.analysis;
  const statements: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `UPDATE activities SET fit_status = ?, fit_vo2max = ?, fit_recovery_min = ?, fit_performance_condition = ?, decoupling_pct = ?, efficiency_factor = ?, fit_np_w = ?, fit_json = ?, updated_at = ? WHERE activity_id = ?`,
      )
      .bind(
        result.status,
        a?.archive.vo2max ?? null,
        a?.archive.recovery ?? null,
        a?.archive.performance_condition ?? null,
        a?.archive.decoupling_pct ?? null,
        a?.archive.efficiency_factor ?? null,
        a?.archive.np ?? null,
        a ? JSON.stringify({ ...a, samples: undefined, archive: undefined }) : result.error ? JSON.stringify({ error: result.error }) : null,
        ctx.now,
        activityId,
      ),
  ];
  if (a) {
    statements.push(ctx.db.prepare(`DELETE FROM best_efforts WHERE activity_id = ?`).bind(activityId));
    const row = await ctx.db.prepare(`SELECT date, sport FROM activities WHERE activity_id = ?`).bind(activityId).first<{ date: string; sport: string }>();
    if (row?.date) {
      for (const e of a.archive.efforts) {
        statements.push(
          ctx.db
            .prepare(`INSERT INTO best_efforts (activity_id, date, sport, effort, kind, value) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(activityId, row.date, row.sport ?? a.archive.sport, e.effort, e.kind, e.value),
        );
      }
    }
  }
  await runBatched(ctx.db, statements);
}

interface BackfillState {
  /** Oldest date the daily datasets are archived back to. */
  dailyCursor?: string;
  dailyEmptyDays: number;
  dailyDone: boolean;
  /** Oldest date the activity list is archived back to. */
  activityCursor?: string;
  activityEmptyWindows: number;
  activityDone: boolean;
}

export interface CronReport {
  at: string;
  requests: number;
  steps: string[];
  error?: string;
}

const ACTIVITY_STEP_DAYS = 365;
const EMPTY_DAYS_TO_STOP = 180;
const EMPTY_WINDOWS_TO_STOP = 2;

/** One cron run: refresh recent data, then extend the archive backwards. */
export async function runCron(ctx: AppContext): Promise<CronReport> {
  const report: CronReport = { at: new Date(ctx.now).toISOString(), requests: 0, steps: [] };
  try {
    const backoff = await getMeta<number>(ctx.db, "backoff_until");
    if (backoff && backoff > ctx.now) {
      report.steps.push(`waiting for Garmin rate limit until ${new Date(backoff).toISOString()}`);
      return report;
    }

    await loadProfile(ctx);
    const lastIncremental = (await getMeta<number>(ctx.db, "last_incremental_at")) ?? 0;
    if (ctx.now - lastIncremental > 55 * 60_000) {
      const from = addDays(ctx.today, -(RECENT_DAYS - 1));
      const daily = await ensureDaily(ctx, ARCHIVED_DATASETS, from, ctx.today);
      const acts = await ensureActivities(ctx, from, ctx.today);
      if (daily.complete && acts.complete) await setMeta(ctx.db, "last_incremental_at", ctx.now);
      report.steps.push("refreshed recent days");
    }

    const floor = ctx.env.BACKFILL_FROM && isIsoDate(ctx.env.BACKFILL_FROM) ? ctx.env.BACKFILL_FROM : OLDEST_DATE;
    const state = (await getMeta<BackfillState>(ctx.db, "backfill")) ?? { dailyEmptyDays: 0, dailyDone: false, activityEmptyWindows: 0, activityDone: false };

    // Activity list first: training load and records depend on it. A year per step.
    while (!state.activityDone && ctx.budget.remaining >= 3) {
      const end = state.activityCursor ? addDays(state.activityCursor, -1) : ctx.today;
      if (end < floor) {
        state.activityDone = true;
        break;
      }
      const start = addDays(end, -(ACTIVITY_STEP_DAYS - 1)) < floor ? floor : addDays(end, -(ACTIVITY_STEP_DAYS - 1));
      const outcome = await ensureActivities(ctx, start, end);
      if (!outcome.complete) break;
      const { found } = (await ctx.db
        .prepare(`SELECT COUNT(*) AS found FROM activities WHERE date BETWEEN ? AND ?`)
        .bind(start, end)
        .first<{ found: number }>()) ?? { found: 0 };
      state.activityEmptyWindows = found ? 0 : state.activityEmptyWindows + 1;
      state.activityCursor = start;
      if (state.activityEmptyWindows >= EMPTY_WINDOWS_TO_STOP) state.activityDone = true;
      await setMeta(ctx.db, "backfill", state);
      report.steps.push(`archived activities back to ${start}`);
    }

    // Daily datasets: one window per dataset per step, oldest edge moving back.
    const stepDays = ctx.limits.windowDays;
    const perStep = ARCHIVED_DATASETS.reduce((n, d) => n + Math.ceil(stepDays / Math.min(stepDays, RANGE_DATASETS[d].maxDays)), 0);
    while (!state.dailyDone && ctx.budget.remaining >= perStep + 1) {
      const end = state.dailyCursor ? addDays(state.dailyCursor, -1) : ctx.today;
      if (end < floor) {
        state.dailyDone = true;
        break;
      }
      const start = addDays(end, -(stepDays - 1)) < floor ? floor : addDays(end, -(stepDays - 1));
      const outcome = await ensureDaily(ctx, ARCHIVED_DATASETS, start, end);
      if (!outcome.complete) break;
      const { found } = (await ctx.db
        .prepare(`SELECT COUNT(*) AS found FROM raw_daily WHERE date BETWEEN ? AND ? AND json IS NOT NULL`)
        .bind(start, end)
        .first<{ found: number }>()) ?? { found: 0 };
      state.dailyEmptyDays = found ? 0 : state.dailyEmptyDays + daysBetween(start, end) + 1;
      state.dailyCursor = start;
      if (state.dailyEmptyDays >= EMPTY_DAYS_TO_STOP) state.dailyDone = true;
      await setMeta(ctx.db, "backfill", state);
      report.steps.push(`archived daily data back to ${start}`);
    }

    // FIT files, newest first.
    if (!ctx.rateLimitedFor && ctx.env.SYNC_FIT_FILES?.trim().toLowerCase() !== "false") {
      const { results } = await ctx.db
        .prepare(`SELECT activity_id FROM activities WHERE ${FIT_PENDING} ORDER BY start_local DESC LIMIT ?`)
        .bind(ctx.limits.cronFitFiles)
        .all<{ activity_id: number }>();
      for (const { activity_id } of results) {
        if (ctx.budget.remaining < 2) break;
        const r = await importFit(ctx, activity_id);
        report.steps.push(`FIT ${activity_id}: ${r.status}`);
      }
    }
  } catch (err) {
    if (err instanceof GarminRateLimitError) {
      await setMeta(ctx.db, "backoff_until", ctx.now + Math.max(15 * 60, err.retryAfterSeconds) * 1000);
      report.error = err.message;
    } else if (err instanceof BudgetExhaustedError) {
      report.steps.push("stopped at the per-run request budget");
    } else {
      report.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (ctx.rateLimitedFor && !report.error) {
      await setMeta(ctx.db, "backoff_until", ctx.now + Math.max(15 * 60, ctx.rateLimitedFor) * 1000).catch(() => {});
      report.error = "Garmin rate limited this run; pausing background sync.";
    }
    report.requests = ctx.budget.used;
    report.steps.push(...ctx.notes.filter((n) => !/expire/.test(n)));
    await ctx.db.batch([setMetaStmt(ctx.db, "last_cron", report)]).catch(() => {});
  }
  return report;
}

export async function backfillState(db: D1Database): Promise<BackfillState | null> {
  return getMeta<BackfillState>(db, "backfill");
}
