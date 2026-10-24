/** Every MCP tool. Each handler builds its own context, so tool calls are independent. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ARCHIVED_DATASETS, type ArchivedDataset } from "../archive/flatten";
import { SCHEMA_GUIDE } from "../archive/schema";
import { runReadOnly } from "../archive/sql";
import { getMeta, readActivities, readActivity, readDaily, type ActivityRow } from "../archive/store";
import { backfillState, ensureActivities, ensureDaily, FIT_PENDING, importFit } from "../archive/sync";
import { loadChart, loadReport, loadWarmupStart } from "../analysis/load";
import { briefing } from "../analysis/readiness";
import { hrvReport, rhrReport, sleepReport } from "../analysis/recovery";
import { finite, round } from "../analysis/stats";
import { METRICS, metricTrend, type Granularity } from "../analysis/trends";
import { weeklyReport, type BestEffortRow } from "../analysis/weekly";
import { createContext, hrvBaselineFrom, keyExpiry, loadProfile, zoneFloorsFor, type AppContext } from "../context";
import { MIN_ACCESS_KEY_LENGTH, SERVER_VERSION, type Env } from "../env";
import { analyzeFit, formatDuration, pace } from "../fit/analyze";
import { decodeFit, extractFit } from "../fit/decode";
import { jwtClaims, type GarminClientOptions } from "../garmin/client";
import { compact } from "../garmin/compact";
import { DAY_ENDPOINTS, RANGE_DATASETS, downloadActivity, fetchRange, getActivity, getActivityWorkouts, getProfileSettings } from "../garmin/endpoints";
import { addDays, daysBetween, isIsoDate, weekStart } from "../util/dates";
import { fail, ok, UserError } from "./format";

export const dateArg = z
  .string()
  .refine((v) => v === "today" || v === "yesterday" || isIsoDate(v), "Use YYYY-MM-DD, 'today' or 'yesterday'")
  .describe("YYYY-MM-DD, 'today' or 'yesterday' (in the athlete's time zone)");

const READ = { readOnlyHint: true, openWorldHint: true } as const;

function resolveDate(ctx: AppContext, value: string | undefined, fallback = ctx.today): string {
  if (!value) return fallback;
  if (value === "today") return ctx.today;
  if (value === "yesterday") return addDays(ctx.today, -1);
  if (value > ctx.today) throw new UserError(`${value} is in the future; today is ${ctx.today} (${ctx.timeZone}).`);
  return value;
}

function resolveRange(ctx: AppContext, start: string | undefined, end: string | undefined, defaultDays: number, maxDays: number): [string, string] {
  const e = resolveDate(ctx, end);
  const s = start ? resolveDate(ctx, start) : addDays(e, -(defaultDays - 1));
  if (s > e) throw new UserError("start_date is after end_date.");
  if (daysBetween(s, e) + 1 > maxDays) throw new UserError(`That range is ${daysBetween(s, e) + 1} days; this tool accepts up to ${maxDays}. Use query_archive or metric_trend for longer spans.`);
  return [s, e];
}

const km = (m: number | null) => (finite(m) ? round(m / 1000, 2) : null);

function activitySummary(a: ActivityRow, unit: "km" | "mi") {
  const moving = a.moving_s ?? a.duration_s;
  const speed = a.avg_speed_mps ?? (a.distance_m && moving ? a.distance_m / moving : null);
  const footSport = a.sport === "running" || a.sport === "walking" || a.sport === "hiking";
  return {
    id: a.activity_id,
    date: a.date,
    start: a.start_local?.slice(11, 16),
    name: a.name,
    type: a.type,
    distance_km: km(a.distance_m),
    duration: a.duration_s ? formatDuration(a.duration_s) : null,
    pace: footSport ? pace(speed, unit) : undefined,
    speed_kmh: !footSport && finite(speed) && a.sport !== "strength" ? round(speed * 3.6, 1) : undefined,
    avg_hr: finite(a.avg_hr) ? Math.round(a.avg_hr) : null,
    max_hr: finite(a.max_hr) ? Math.round(a.max_hr) : null,
    avg_power_w: finite(a.avg_power_w) ? Math.round(a.avg_power_w) : null,
    elevation_m: finite(a.elevation_gain_m) ? Math.round(a.elevation_gain_m) : null,
    training_load: finite(a.garmin_load) ? Math.round(a.garmin_load) : null,
    aerobic_te: a.aerobic_te,
    anaerobic_te: a.anaerobic_te,
    effect: a.training_effect_label,
    vo2max: a.vo2max ?? a.fit_vo2max,
    decoupling_pct: a.decoupling_pct,
  };
}

type Handler<A> = (ctx: AppContext, args: A) => Promise<{ data: unknown; notes?: string[] }>;

export interface ToolDeps {
  env: Env;
  garminOptions?: GarminClientOptions;
}

/** Wrap a handler: build the context, run, format, and turn errors into readable tool errors. */
function run<A>(deps: ToolDeps, handler: Handler<A>) {
  return async (args: A) => {
    let ctx: AppContext | undefined;
    try {
      ctx = await createContext(deps.env, { mode: "tool", ...deps.garminOptions });
      const { data, notes = [] } = await handler(ctx, args);
      return ok(data, [...ctx.notes, ...notes]);
    } catch (err) {
      return fail(err);
    }
  };
}

const DAILY_FOR_METRIC: Record<string, ArchivedDataset> = {
  hrv: "hrv",
  sleep_hours: "sleep",
  sleep_score: "sleep",
  deep_sleep_min: "sleep",
  rem_sleep_min: "sleep",
  weight_kg: "weight",
  body_fat_pct: "weight",
};

// The analysis behind each tool, shared with show_view's presets so a view shows exactly what the tool computed.

export async function briefingData(ctx: AppContext, { date }: { date?: string }) {
  const day = resolveDate(ctx, date);
  const from = addDays(day, -67);
  await ensureDaily(ctx, ["daily_summaries", "sleep", "hrv"], from, day);
  const warmup = loadWarmupStart(day);
  await ensureActivities(ctx, warmup, day);
  const { facts } = await loadProfile(ctx);
  const [rows, acts] = await Promise.all([readDaily(ctx.db, from, day), readActivities(ctx.db, warmup, day)]);
  return { data: briefing(day, rows, acts, facts, warmup, { baselineFrom: hrvBaselineFrom(ctx.env) }) };
}

/** `withChart` adds the daily CTL/ATL/TSB series for views; the tool leaves it out to stay compact. */
export async function loadData(ctx: AppContext, { days, end_date }: { days: number; end_date?: string }, withChart = false) {
  const end = resolveDate(ctx, end_date);
  const start = addDays(end, -(days - 1));
  const warmup = loadWarmupStart(end);
  await ensureActivities(ctx, warmup, end);
  const { facts } = await loadProfile(ctx);
  const acts = await readActivities(ctx.db, warmup, end);
  return { data: loadReport(acts, facts, start, end, warmup), chart: withChart ? loadChart(acts, facts, start, end, warmup) : undefined };
}

export async function recoveryData(ctx: AppContext, { date }: { date?: string }) {
  const day = resolveDate(ctx, date);
  const from = addDays(day, -67);
  await ensureDaily(ctx, ["daily_summaries", "sleep", "hrv"], from, day);
  const rows = await readDaily(ctx.db, from, day);
  return { data: { date: day, hrv: hrvReport(rows, day, { baselineFrom: hrvBaselineFrom(ctx.env) }), resting_hr: rhrReport(rows, day), sleep: sleepReport(rows, day) } };
}

export async function weeklyData(ctx: AppContext, { weeks, end_date }: { weeks: number; end_date?: string }) {
  const end = resolveDate(ctx, end_date);
  const first = addDays(weekStart(end), -7 * weeks); // one extra week for the first comparison
  await ensureDaily(ctx, ARCHIVED_DATASETS, first, end);
  await ensureActivities(ctx, first, end);
  const { facts } = await loadProfile(ctx);
  const [rows, acts, efforts] = await Promise.all([
    readDaily(ctx.db, first, end),
    readActivities(ctx.db, first, end),
    ctx.db.prepare(`SELECT * FROM best_efforts WHERE date BETWEEN ? AND ?`).bind(first, end).all<BestEffortRow>(),
  ]);
  const report = weeklyReport(rows, acts, efforts.results, facts, first, end);
  report.weeks = report.weeks.slice(1);
  return { data: report };
}

export async function trendData(ctx: AppContext, a: { metric: string; days: number; end_date?: string; granularity?: Granularity; compare_previous: boolean }) {
  const end = resolveDate(ctx, a.end_date);
  const start = addDays(end, -(a.days - 1));
  const from = a.compare_previous ? addDays(start, -a.days) : start;
  const metric = METRICS[a.metric];
  const fromActivities = typeof metric.source !== "function";
  if (fromActivities) await ensureActivities(ctx, from, end);
  else await ensureDaily(ctx, [DAILY_FOR_METRIC[a.metric] ?? "daily_summaries"], from, end);
  const { facts } = await loadProfile(ctx);
  const [rows, acts] = await Promise.all([fromActivities ? [] : readDaily(ctx.db, from, end), fromActivities ? readActivities(ctx.db, from, end) : []]);
  const cur = (r: { date: string | null }) => (r.date ?? "") >= start;
  return {
    data: metricTrend(
      a.metric,
      rows.filter(cur),
      acts.filter(cur),
      facts,
      start,
      end,
      a.granularity,
      a.compare_previous ? rows.filter((r) => !cur(r)) : undefined,
      a.compare_previous ? acts.filter((r) => !cur(r)) : undefined,
    ),
  };
}

export async function activityData(ctx: AppContext, a: { activity_id?: number; sport?: string; samples: number; include_route: boolean; split_unit?: "km" | "mi"; include_raw_hidden: boolean }) {
  let id = a.activity_id;
  if (!id) {
    await ensureActivities(ctx, addDays(ctx.today, -60), ctx.today);
    const latest = await ctx.db
      .prepare(`SELECT activity_id FROM activities ${a.sport ? "WHERE sport = ?" : ""} ORDER BY start_local DESC LIMIT 1`)
      .bind(...(a.sport ? [a.sport] : []))
      .first<{ activity_id: number }>();
    if (!latest) throw new UserError(`No ${a.sport ?? ""} activities in the last 60 days. Pass an activity_id from list_activities.`.replace("  ", " "));
    id = latest.activity_id;
  }
  const { facts } = await loadProfile(ctx);
  const row = await readActivity(ctx.db, id);
  const unit = a.split_unit ?? facts.unit;
  const garmin = row ? activitySummary(row, unit) : undefined;
  const simple = !a.samples && !a.include_route && !a.include_raw_hidden && unit === facts.unit;
  if (simple && row?.fit_status === "done" && row.fit_json) {
    return { data: { activity: garmin, analysis: JSON.parse(row.fit_json), source: "archive (decoded FIT file)" } };
  }
  if (simple && row) {
    const imported = await importFit(ctx, id);
    if (imported.analysis) {
      const { archive: _archive, samples: _samples, ...analysis } = imported.analysis;
      return { data: { activity: garmin, analysis, source: "FIT file" } };
    }
    return { data: { activity: garmin, analysis: null }, notes: [`The FIT file could not be analyzed: ${imported.error ?? imported.status}`] };
  }
  const fit = decodeFit(await extractFit(await downloadActivity(ctx.garmin(), id)));
  const sport = String(fit.sessions[0]?.sport ?? "");
  const { archive: _archive, ...analysis } = analyzeFit(fit, {
    hrZoneFloors: zoneFloorsFor(facts, sport),
    ftp: facts.ftp,
    splitUnit: unit,
    samples: a.samples,
    route: a.include_route,
    rawHidden: a.include_raw_hidden,
  });
  return { data: { activity: garmin ?? { id }, analysis, source: "FIT file" } };
}

export async function recordsData(ctx: AppContext, a: { sport: string; start_date?: string; end_date?: string; top: number; import_missing: boolean }) {
  const start = a.start_date ? resolveDate(ctx, a.start_date) : "1900-01-01";
  const end = resolveDate(ctx, a.end_date);
  const notes: string[] = [];
  if (a.import_missing) {
    const { results } = await ctx.db
      .prepare(`SELECT activity_id FROM activities WHERE sport = ? AND ${FIT_PENDING} AND date BETWEEN ? AND ? ORDER BY start_local DESC LIMIT ?`)
      .bind(a.sport, start, end, ctx.limits.toolFitFiles)
      .all<{ activity_id: number }>();
    for (const { activity_id } of results) {
      if (ctx.budget.remaining < 2) break;
      await importFit(ctx, activity_id);
    }
  }
  const { results: efforts } = await ctx.db
    .prepare(
      `SELECT e.effort, e.kind, e.value, e.date, e.activity_id, a.name FROM best_efforts e LEFT JOIN activities a USING (activity_id) WHERE e.sport = ? AND e.date BETWEEN ? AND ?`,
    )
    .bind(a.sport, start, end)
    .all<{ effort: string; kind: string; value: number; date: string; activity_id: number; name: string | null }>();
  const byEffort = new Map<string, typeof efforts>();
  for (const e of efforts) byEffort.set(e.effort, [...(byEffort.get(e.effort) ?? []), e]);
  const records: Record<string, unknown> = {};
  for (const [effort, list] of byEffort) {
    const sorted = list.sort((x, y) => (x.kind === "power_w" ? y.value - x.value : x.value - y.value)).slice(0, a.top);
    records[effort] = sorted.map((e) => ({
      [e.kind === "power_w" ? "watts" : "time"]: e.kind === "power_w" ? e.value : formatDuration(e.value),
      date: e.date,
      activity_id: e.activity_id,
      name: e.name,
    }));
  }
  const extreme = async (column: string) =>
    ctx.db
      .prepare(`SELECT activity_id, date, name, ${column} AS value FROM activities WHERE sport = ? AND date BETWEEN ? AND ? AND ${column} IS NOT NULL ORDER BY ${column} DESC LIMIT 1`)
      .bind(a.sport, start, end)
      .first<{ activity_id: number; date: string; name: string; value: number }>();
  const [longest, longestTime, climb, coverage] = await Promise.all([
    extreme("distance_m"),
    extreme("duration_s"),
    extreme("elevation_gain_m"),
    ctx.db
      .prepare(`SELECT COUNT(*) AS total, SUM(fit_status = 'done') AS decoded, SUM(${FIT_PENDING}) AS pending FROM activities WHERE sport = ? AND date BETWEEN ? AND ?`)
      .bind(a.sport, start, end)
      .first<{ total: number; decoded: number | null; pending: number | null }>(),
  ]);
  if ((coverage?.pending ?? 0) > 0) {
    notes.push(`${coverage?.pending} ${a.sport} activities still wait for FIT import, so records may improve as the background sync continues.`);
  }
  return {
    data: {
      sport: a.sport,
      from: start === "1900-01-01" ? "all history" : start,
      to: end,
      best_efforts: records,
      longest_distance: longest ? { km: km(longest.value), date: longest.date, activity_id: longest.activity_id, name: longest.name } : null,
      longest_duration: longestTime ? { duration: formatDuration(longestTime.value), date: longestTime.date, activity_id: longestTime.activity_id, name: longestTime.name } : null,
      most_climbing: climb ? { meters: Math.round(climb.value), date: climb.date, activity_id: climb.activity_id, name: climb.name } : null,
      coverage: { activities: coverage?.total ?? 0, fit_decoded: coverage?.decoded ?? 0, fit_pending: coverage?.pending ?? 0 },
    },
    notes,
  };
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "daily_briefing",
    {
      title: "Daily briefing",
      description:
        "Start here for 'how am I today?', 'should I train hard?', 'am I recovered?'. Judges last night's HRV, resting HR, sleep, Body Battery, training form (TSB) and load ramp (ACWR) against the athlete's own 60-day baselines, and gives a green/amber/red call with the rule used. Numbers are computed by code; explain them, do not recompute.",
      inputSchema: { date: dateArg.optional().describe("Day to brief. Default: today") },
      annotations: READ,
    },
    run(deps, briefingData),
  );

  server.registerTool(
    "training_load",
    {
      title: "Training load",
      description:
        "Fitness (CTL), fatigue (ATL), form (TSB), acute:chronic workload ratio (ACWR), monotony and strain, weekly load, and load by sport. Use for 'am I overtraining?', 'is my fitness going up?', 'how hard was this block?', taper planning.",
      inputSchema: {
        days: z.number().int().min(7).max(365).default(90).describe("Days of history to report (the averages always warm up over the 485 days before end_date)"),
        end_date: dateArg.optional(),
      },
      annotations: READ,
    },
    run(deps, loadData),
  );

  server.registerTool(
    "recovery_analysis",
    {
      title: "Recovery analysis",
      description:
        "HRV against a personal 60-day baseline (ln of Garmin's overnight HRV average, 7-day rolling mean, normal band = baseline +/- 0.5 SD), resting HR drift, and sleep versus usual. Reports how many of the last 7 nights have HRV; with fewer than 5 the verdict is capped. Use for 'is my HRV trending down?', 'am I getting sick?', 'how is my recovery?'.",
      inputSchema: { date: dateArg.optional().describe("Last day of the 7-day window. Default: today") },
      annotations: READ,
    },
    run(deps, recoveryData),
  );

  server.registerTool(
    "weekly_report",
    {
      title: "Weekly report",
      description:
        "Week-by-week summary (Monday to Sunday): training volume and load by sport, intensity split from HR zones, longest session, sleep, HRV, resting HR, stress, steps, and change versus the previous week.",
      inputSchema: {
        weeks: z.number().int().min(1).max(26).default(4),
        end_date: dateArg.optional().describe("Any day in the last week to include. Default: today"),
      },
      annotations: READ,
    },
    run(deps, weeklyData),
  );

  const metricNames = Object.keys(METRICS) as [string, ...string[]];
  server.registerTool(
    "metric_trend",
    {
      title: "Metric trend",
      description: `Trend of one metric over a period: mean, median, min/max with dates, weekly slope and fit, first-vs-last change, comparison with the previous period of equal length, and a series by day/week/month. Metrics: ${metricNames.join(", ")}.`,
      inputSchema: {
        metric: z.enum(metricNames),
        days: z.number().int().min(7).max(730).default(90).describe("Length of the period ending at end_date"),
        end_date: dateArg.optional(),
        granularity: z.enum(["day", "week", "month"]).optional().describe("Default: day up to 35 days, week up to 120, else month"),
        compare_previous: z.boolean().default(true),
      },
      annotations: READ,
    },
    run(deps, trendData),
  );

  server.registerTool(
    "list_activities",
    {
      title: "List activities",
      description:
        "Activities in a date range, newest first, one compact line each (distance, duration, pace or speed, HR, power, elevation, Garmin load, training effect, VO2 max). Use the id with analyze_activity.",
      inputSchema: {
        start_date: dateArg.optional().describe("Default: 30 days before end_date"),
        end_date: dateArg.optional(),
        sport: z.enum(["running", "cycling", "swimming", "walking", "hiking", "strength", "rowing_paddling", "winter", "mind_body", "other"]).optional(),
        type: z.string().max(60).optional().describe("Exact Garmin type key, e.g. trail_running, indoor_cycling"),
        search: z.string().max(100).optional().describe("Text to find in the activity name"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    run(
      deps,
      async (ctx, a: { start_date?: string; end_date?: string; sport?: string; type?: string; search?: string; limit: number; offset: number }) => {
        const [start, end] = resolveRange(ctx, a.start_date, a.end_date, 30, 366 * 25);
        await ensureActivities(ctx, start, end);
        const { facts } = await loadProfile(ctx);
        const where = ["date BETWEEN ? AND ?"];
        const binds: unknown[] = [start, end];
        if (a.sport) {
          where.push("sport = ?");
          binds.push(a.sport);
        }
        if (a.type) {
          where.push("type = ?");
          binds.push(a.type);
        }
        if (a.search) {
          where.push("name LIKE ?");
          binds.push(`%${a.search}%`);
        }
        const clause = where.join(" AND ");
        const [{ results }, count] = await Promise.all([
          ctx.db
            .prepare(`SELECT * FROM activities WHERE ${clause} ORDER BY start_local DESC LIMIT ? OFFSET ?`)
            .bind(...binds, a.limit, a.offset)
            .all<ActivityRow>(),
          ctx.db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE ${clause}`).bind(...binds).first<{ n: number }>(),
        ]);
        const total = count?.n ?? 0;
        return {
          data: {
            from: start,
            to: end,
            total,
            returned: results.length,
            next_offset: a.offset + results.length < total ? a.offset + results.length : null,
            activities: results.map((r) => activitySummary(r, facts.unit)),
          },
        };
      },
    ),
  );

  server.registerTool(
    "analyze_activity",
    {
      title: "Analyze activity",
      description:
        "Deep analysis of one activity from its original FIT file: summary, splits, laps, HR zone time, best efforts (fastest 1k/5k/10k..., power curve 5s-60min), aerobic decoupling and cardiac drift, efficiency factor, NP/IF/TSS, and metrics Garmin hides from the API (VO2 max, performance condition). Omit activity_id for the latest activity.",
      inputSchema: {
        activity_id: z.number().int().positive().optional().describe("From list_activities. Default: the latest activity"),
        sport: z.enum(["running", "cycling", "swimming", "walking", "hiking", "strength", "other"]).optional().describe("With no id: the latest activity of this sport"),
        samples: z.number().int().min(0).max(1000).default(0).describe("Evenly spaced data points to include (time, distance, HR, speed, power, altitude)"),
        include_route: z.boolean().default(false).describe("Include GPS coordinates in samples. Off by default for privacy"),
        split_unit: z.enum(["km", "mi"]).optional().describe("Default: the Garmin profile's unit"),
        include_raw_hidden: z.boolean().default(false).describe("Return every field of Garmin's undocumented physiology message, for research"),
      },
      annotations: READ,
    },
    run(deps, activityData),
  );

  server.registerTool(
    "personal_records",
    {
      title: "Personal records",
      description:
        "Best efforts across history from decoded FIT files: fastest 400m to marathon (running), 10-100 km (cycling), swim distances, and best average power for 5s-60min. Also longest and biggest activities. Records cover activities whose FIT files are imported; the background sync imports them over time, and import_missing speeds that up.",
      inputSchema: {
        sport: z.enum(["running", "cycling", "swimming", "walking", "hiking"]).default("running"),
        start_date: dateArg.optional().describe("Default: all history"),
        end_date: dateArg.optional(),
        top: z.number().int().min(1).max(10).default(3),
        import_missing: z.boolean().default(false).describe("Import a few missing FIT files first (newest first)"),
      },
      annotations: READ,
    },
    run(deps, recordsData),
  );

  const datasetNames = Object.keys(RANGE_DATASETS) as [string, ...string[]];
  server.registerTool(
    "get_health_data",
    {
      title: "Get health data",
      description: `Garmin's own records for a date range, compacted (sample streams dropped unless asked). Long ranges are split to fit Garmin's limits. Datasets: ${datasetNames
        .map((d) => `${d} (${RANGE_DATASETS[d].description})`)
        .join("; ")}. Prefer daily_briefing, recovery_analysis or metric_trend for analysis.`,
      inputSchema: {
        dataset: z.enum(datasetNames),
        start_date: dateArg.optional().describe("Default: 7 days before end_date"),
        end_date: dateArg.optional(),
        include_samples: z.boolean().default(false).describe("Keep intraday sample arrays (large)"),
      },
      annotations: READ,
    },
    run(deps, async (ctx, a: { dataset: string; start_date?: string; end_date?: string; include_samples: boolean }) => {
      const [start, end] = resolveRange(ctx, a.start_date, a.end_date, 7, 92);
      const spec = RANGE_DATASETS[a.dataset];
      const result = await fetchRange(ctx.garmin(), spec, start, end);
      const days = [...result.byDay.entries()].map(([date, item]) => ({ date, ...(compact(item, { samples: a.include_samples }) as object) }));
      const notes = result.failed.map((f) => `No data for ${f.start}..${f.end}: ${f.error}`);
      return { data: { dataset: a.dataset, from: start, to: end, days }, notes };
    }),
  );

  const dayKinds = Object.keys(DAY_ENDPOINTS) as [string, ...string[]];
  server.registerTool(
    "get_day_detail",
    {
      title: "Get day detail",
      description: `One day of one Garmin dataset in full detail. Kinds: ${dayKinds.map((k) => `${k} (${DAY_ENDPOINTS[k].description})`).join("; ")}.`,
      inputSchema: {
        kind: z.enum(dayKinds),
        date: dateArg.optional().describe("Default: today. Sleep belongs to the date the night ends"),
        include_samples: z.boolean().default(false).describe("Keep intraday sample arrays (large)"),
      },
      annotations: READ,
    },
    run(deps, async (ctx, a: { kind: string; date?: string; include_samples: boolean }) => {
      const date = resolveDate(ctx, a.date);
      const raw = await DAY_ENDPOINTS[a.kind].fetch(ctx.garmin(), date, ctx.today);
      return { data: { kind: a.kind, date, detail: compact(raw, { samples: a.include_samples }) ?? null } };
    }),
  );

  server.registerTool(
    "get_activity",
    {
      title: "Get activity (Garmin JSON)",
      description: "Garmin's stored record of one activity (summary, splits, device, gear), compacted, plus the structured workout followed if any. analyze_activity gives the deeper FIT-based analysis.",
      inputSchema: {
        activity_id: z.number().int().positive(),
        include_workout: z.boolean().default(false),
        include_location: z.boolean().default(false).describe("Keep start/end coordinates and place names"),
      },
      annotations: READ,
    },
    run(deps, async (ctx, a: { activity_id: number; include_workout: boolean; include_location: boolean }) => {
      const garmin = ctx.garmin();
      const detail = await getActivity(garmin, a.activity_id);
      const workout = a.include_workout ? await getActivityWorkouts(garmin, a.activity_id).catch(() => null) : undefined;
      return { data: { activity: compact(detail, { location: a.include_location }), workout: workout ? compact(workout) : undefined } };
    }),
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get profile",
      description: "Athlete profile facts: units, time zone, age, VO2 max (running/cycling), lactate threshold, max and resting HR used for zones, FTP, and HR zone floors per sport.",
      inputSchema: { refresh: z.boolean().default(false).describe("Fetch from Garmin instead of the daily cache") },
      annotations: READ,
    },
    run(deps, async (ctx, a: { refresh: boolean }) => {
      const profile = await loadProfile(ctx, a.refresh ? 0 : 24);
      return { data: { facts: profile.facts, time_zone_in_use: ctx.timeZone, today: ctx.today } };
    }),
  );

  server.registerTool(
    "query_archive",
    {
      title: "Query archive (SQL)",
      description: `Read-only SQL over the athlete's local archive (fills in the background; see server_status). One SELECT or WITH statement; results capped at max_rows. Use for questions the other tools do not cover, e.g. "every run over 15 km in 2025 with average HR", "months with the most climbing", "sleep on days after hard workouts".\n${SCHEMA_GUIDE}`,
      inputSchema: {
        sql: z.string().min(6).max(8000),
        max_rows: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(deps, async (ctx, a: { sql: string; max_rows: number }) => {
      return { data: await runReadOnly(ctx.db, a.sql, a.max_rows) };
    }),
  );

  server.registerTool(
    "sync_now",
    {
      title: "Sync now",
      description:
        "Pull the latest days from Garmin into the archive right away (the background job does this hourly). Writes only to this server's own archive; Garmin data is never changed.",
      inputSchema: {
        days: z.number().int().min(1).max(60).default(7),
        include_fit: z.boolean().default(true).describe("Also decode FIT files of new activities"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(deps, async (ctx, a: { days: number; include_fit: boolean }) => {
      const start = addDays(ctx.today, -(a.days - 1));
      const daily = await ensureDaily(ctx, ARCHIVED_DATASETS, start, ctx.today);
      const acts = await ensureActivities(ctx, start, ctx.today);
      const imported: Array<{ id: number; status: string }> = [];
      if (a.include_fit) {
        const { results } = await ctx.db
          .prepare(`SELECT activity_id FROM activities WHERE ${FIT_PENDING} AND date >= ? ORDER BY start_local DESC LIMIT ?`)
          .bind(start, ctx.limits.toolFitFiles)
          .all<{ activity_id: number }>();
        for (const { activity_id } of results) {
          if (ctx.budget.remaining < 2) break;
          imported.push({ id: activity_id, status: (await importFit(ctx, activity_id)).status });
        }
      }
      return { data: { from: start, to: ctx.today, daily_complete: daily.complete, activities_complete: acts.complete, fit_imported: imported, garmin_requests: ctx.budget.used } };
    }),
  );

  server.registerTool(
    "server_status",
    {
      title: "Server status",
      description: "Health check and archive coverage: configuration, Garmin key and token, key expiry, what the archive holds per dataset, backfill progress, the last background run. Use when data looks missing or a tool fails.",
      inputSchema: { check_garmin: z.boolean().default(true).describe("Make one live call to Garmin to verify the key") },
      annotations: READ,
    },
    run(deps, async (ctx, a: { check_garmin: boolean }) => {
      const env = ctx.env;
      const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
      checks.push({ check: "GARMIN_API_KEY secret", ok: Boolean(env.GARMIN_API_KEY?.trim()), detail: env.GARMIN_API_KEY?.trim() ? "set" : "missing: npx wrangler secret put GARMIN_API_KEY" });
      const accessOk = (env.ACCESS_KEY?.trim().length ?? 0) >= MIN_ACCESS_KEY_LENGTH;
      checks.push({ check: "ACCESS_KEY secret", ok: accessOk, detail: accessOk ? "set" : `missing or shorter than ${MIN_ACCESS_KEY_LENGTH} characters` });
      const expiry = keyExpiry(env, ctx.today);
      checks.push({
        check: "Key expiry",
        ok: !expiry || expiry.daysLeft > 7,
        detail: expiry ? expiry.message : "unknown: set GARMIN_KEY_EXPIRES (YYYY-MM-DD) in wrangler.jsonc vars to get warnings",
      });
      if (a.check_garmin && env.GARMIN_API_KEY?.trim()) {
        try {
          const garmin = ctx.garmin();
          const token = await garmin.token();
          const claims = jwtClaims(token.accessToken);
          await getProfileSettings(garmin);
          const scopes = claims.scope ?? claims.scopes ?? claims.authorities;
          checks.push({
            check: "Garmin connection",
            ok: true,
            detail: `connected; the 24-hour bearer token renews itself (current one valid until ${new Date(token.expiresAt * 1000).toISOString()}). This is not the API key's expiry${scopes ? `; scopes: ${JSON.stringify(scopes)}` : ""}`,
          });
        } catch (err) {
          checks.push({ check: "Garmin connection", ok: false, detail: err instanceof Error ? err.message : String(err) });
        }
      }
      const coverage = await ctx.db
        .prepare(`SELECT dataset, COUNT(*) AS days_with_data, MIN(date) AS first, MAX(date) AS last FROM raw_daily WHERE json IS NOT NULL GROUP BY dataset`)
        .all<{ dataset: string; days_with_data: number; first: string; last: string }>();
      const acts = await ctx.db
        .prepare(
          `SELECT COUNT(*) AS total, MIN(date) AS first, MAX(date) AS last, SUM(fit_status = 'done') AS fit_done, SUM(${FIT_PENDING}) AS fit_pending, SUM(fit_status IN ('error', 'missing') OR (fit_status IS NULL AND NOT (${FIT_PENDING}))) AS fit_failed FROM activities`,
        )
        .first();
      const vo2 = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE fit_vo2max IS NOT NULL`).first<{ n: number }>();
      const [backfill, lastCron, backoff] = await Promise.all([backfillState(ctx.db), getMeta(ctx.db, "last_cron"), getMeta<number>(ctx.db, "backoff_until")]);
      return {
        data: {
          version: SERVER_VERSION,
          today: ctx.today,
          time_zone: ctx.timeZone,
          plan: env.PLAN?.trim() || "free",
          checks,
          archive: { daily: coverage.results, activities: acts, fit_files_with_hidden_vo2max: vo2?.n ?? 0 },
          backfill: backfill ?? "not started (runs every 10 minutes)",
          last_background_run: lastCron ?? "none yet",
          rate_limited_until: backoff && backoff > ctx.now ? new Date(backoff).toISOString() : undefined,
        },
      };
    }),
  );

  server.registerTool(
    "garmin_api_get",
    {
      title: "Garmin API GET (advanced)",
      description:
        "GET any Garmin Personal API path that the other tools do not cover, e.g. an endpoint Garmin adds later. Read-only. Responses are compacted; sample arrays are dropped unless include_samples is set.",
      inputSchema: {
        path: z.string().regex(/^\/[A-Za-z0-9\-_/.]+$/, "An absolute API path, e.g. /hrv-service/hrv/2026-10-20").max(300),
        query: z.record(z.string(), z.string()).optional(),
        include_samples: z.boolean().default(false),
      },
      annotations: READ,
    },
    run(deps, async (ctx, a: { path: string; query?: Record<string, string>; include_samples: boolean }) => {
      const raw = await ctx.garmin().get(a.path, a.query);
      return { data: { path: a.path, response: compact(raw, { samples: a.include_samples }) ?? null } };
    }),
  );
}
