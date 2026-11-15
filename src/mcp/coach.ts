/**
 * The coaching tools: questions the model used to answer by guessing. Each one computes
 * its numbers in code from the archive: race predictions, a load forecast, training
 * status, correlations, like-for-like workout comparisons, and the race calendar.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compare, lineOf, matchFor, type Line } from "../analysis/compare";
import { correlate, MIN_PAIRS } from "../analysis/correlate";
import { forecast, solveScale, type ForecastPlan, type Scenario } from "../analysis/forecast";
import { activityLoad, formLabel, loadReport, loadWarmupStart, type LoadDay } from "../analysis/load";
import { criticalSpeed, powerModel, predictRaces, RACE_TARGETS, trainingPaces, type Anchor } from "../analysis/predict";
import { eventPhase } from "../analysis/readiness";
import { round } from "../analysis/stats";
import { loadFocus, trainingStatus, vo2Trend } from "../analysis/status";
import { fromActivities, METRICS, metricSeries } from "../analysis/trends";
import { addEvent, listEvents, nextEvent, removeEvent, updateEvent, type EventInput, type EventRow } from "../archive/events";
import { ACTIVITY_FIELDS, readActivities, readActivity, readDaily, type ActivityRow } from "../archive/store";
import { ensureActivities, FIT_ANALYSIS_VERSION, FIT_PENDING, importFit } from "../archive/sync";
import { loadProfile, type AppContext } from "../context";
import { EFFORT_METERS, formatDuration, pace, POWER_DURATIONS } from "../fit/analyze";
import { addDays, daysBetween, isIsoDate } from "../util/dates";
import { UserError } from "./format";
import { columnar, dateArg, ensureMetric, READ, resolveDate, run, type ToolDeps } from "./tools";

/* -------------------------------------------------------------------------- */
/* race_predictor                                                             */
/* -------------------------------------------------------------------------- */

async function pendingNote(ctx: AppContext, sport: string, start: string, end: string): Promise<string[]> {
  const row = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE sport = ? AND date BETWEEN ? AND ? AND ${FIT_PENDING}`).bind(sport, start, end).first<{ n: number }>();
  return row?.n ? [`${row.n} ${sport} activities in this period still wait for their FIT file to be analyzed, so the result may change as the background sync continues.`] : [];
}

export async function predictorData(ctx: AppContext, a: { sport: "running" | "cycling"; window_days: number; end_date?: string; target_km?: number }) {
  const end = resolveDate(ctx, a.end_date);
  const start = addDays(end, -(a.window_days - 1));
  const { facts } = await loadProfile(ctx);
  const notes = await pendingNote(ctx, a.sport, start, end);

  if (a.sport === "cycling") {
    const { results } = await ctx.db
      .prepare(`SELECT effort, MAX(value) AS value FROM best_efforts WHERE sport = 'cycling' AND kind = 'power_w' AND date BETWEEN ? AND ? GROUP BY effort`)
      .bind(start, end)
      .all<{ effort: string; value: number }>();
    if (!results.length) throw new UserError(`No cycling power between ${start} and ${end}. This needs rides with a power meter whose FIT files are imported; personal_records with import_missing imports them.`);
    const curve: Record<string, number> = {};
    for (const [label] of POWER_DURATIONS) {
      const best = results.find((r) => r.effort === label);
      if (best) curve[label] = best.value;
    }
    return {
      data: {
        sport: "cycling",
        from: start,
        to: end,
        best_power_w: curve,
        ...powerModel(curve),
        garmin_ftp_w: facts.ftp ?? null,
        method: "FTP estimate: 95% of the best 20 minutes, or the best 60 minutes when higher. Critical power and W' (kJ): the line through the 5, 10 and 20 minute bests. Zones: Coggan's seven, as shares of the estimate. All assume those bests were all-out.",
      },
      notes,
    };
  }

  const { results } = await ctx.db
    .prepare(`SELECT effort, MIN(value) AS value, date, activity_id FROM best_efforts WHERE sport = 'running' AND kind = 'time_s' AND date BETWEEN ? AND ? GROUP BY effort`)
    .bind(start, end)
    .all<{ effort: string; value: number; date: string; activity_id: number }>();
  const anchors: Anchor[] = results.filter((r) => EFFORT_METERS[r.effort]).map((r) => ({ effort: r.effort, meters: EFFORT_METERS[r.effort], time_s: r.value, date: r.date, activity_id: r.activity_id }));
  if (!anchors.length) throw new UserError(`No running best efforts between ${start} and ${end}. They come from imported FIT files: try a longer window_days, or personal_records with import_missing.`);

  const unit = facts.unit;
  const targets: Array<[string, number]> = [...RACE_TARGETS];
  if (a.target_km) targets.push([`${a.target_km} km`, a.target_km * 1000]);
  const model = predictRaces(anchors, targets);
  const best = new Map(anchors.map((x) => [x.effort, x]));
  const paces = model.vdot !== null ? trainingPaces(model.vdot) : null;
  const cs = criticalSpeed(anchors);
  const per = (speed: number, meters: number) => formatDuration(meters / speed);
  const vo2 = await ctx.db
    .prepare(`SELECT COALESCE(vo2max, fit_vo2max) AS v, date FROM activities WHERE sport = 'running' AND COALESCE(vo2max, fit_vo2max) IS NOT NULL AND date <= ? ORDER BY start_local DESC LIMIT 1`)
    .bind(end)
    .first<{ v: number; date: string }>();

  // The gap to the goal of the next race in the calendar.
  const event = await nextEvent(ctx.db, ctx.today);
  let eventOut: Record<string, unknown> | undefined;
  if (event?.distance_m && (!event.sport || event.sport === "running")) {
    const p = predictRaces(anchors, [[event.name, event.distance_m]]).predictions[0];
    if (p) {
      const goal = event.goal_time_s;
      eventOut = {
        name: event.name,
        date: event.date,
        days_to_go: daysBetween(ctx.today, event.date),
        distance_km: round(event.distance_m / 1000, 2),
        predicted: formatDuration(p.time_s),
        confidence: p.confidence,
        goal: goal !== null ? formatDuration(goal) : null,
        gap_to_goal: goal !== null ? `${formatDuration(Math.abs(p.time_s - goal))} ${p.time_s > goal ? "slower than" : "faster than"} the goal` : null,
      };
    }
  }

  return {
    data: {
      sport: "running",
      from: start,
      to: end,
      fitness: {
        vdot: model.vdot,
        based_on: model.basis ? { effort: model.basis.effort, time: formatDuration(model.basis.time_s), date: model.basis.date, activity_id: model.basis.activity_id } : null,
        garmin_vo2max: vo2 ? { value: vo2.v, date: vo2.date, note: "For context. VDOT is scored from an effort and is usually lower than a VO2 max estimate." } : null,
      },
      predictions: model.predictions.map((p) => ({
        distance: p.distance,
        time: formatDuration(p.time_s),
        pace: pace(p.meters / p.time_s, unit),
        range: p.low_s === p.high_s ? null : `${formatDuration(p.low_s)} to ${formatDuration(p.high_s)}`,
        confidence: p.confidence,
        best_in_window: best.has(p.distance) ? formatDuration(best.get(p.distance)!.time_s) : null,
      })),
      training_paces: paces
        ? {
            easy: `${pace(paces.easy[1], unit)?.split("/")[0]} to ${pace(paces.easy[0], unit)}`,
            marathon: pace(paces.marathon, unit),
            threshold: pace(paces.threshold, unit),
            interval: pace(paces.interval, unit),
            interval_per_400m: per(paces.interval, 400),
            repetition: pace(paces.repetition, unit),
            repetition_per_400m: per(paces.repetition, 400),
            repetition_per_200m: per(paces.repetition, 200),
          }
        : null,
      critical_speed: cs
        ? { pace: pace(cs.speed_mps, unit), d_prime_m: cs.d_prime_m, from_efforts: cs.efforts, meaning: "The pace that can be held for a long time, close to threshold; D' is the distance available above it." }
        : null,
      best_efforts_in_window: anchors.sort((x, y) => x.meters - y.meters).map((x) => ({ effort: x.effort, time: formatDuration(x.time_s), date: x.date, activity_id: x.activity_id })),
      next_event: eventOut,
      method:
        "VDOT (Daniels and Gilbert) from the best-scoring effort of 3.5 minutes or more in the window; each prediction is the time at that VDOT. range spans that and Riegel's formula (exponent 1.06) from the same effort. confidence falls as the target gets further from the effort's distance. Training paces: easy about 60 to 70% of VDOT, threshold 88%, interval 97.5%, repetition 107.5%. Critical speed: the line through near-maximal efforts of 2 to 30 minutes.",
      caveats: [
        "A best effort only predicts well if it was close to all-out. Efforts taken from inside training sessions give predictions slower than the athlete's real ability.",
        "Predictions for much longer races than the effort assume the endurance training for that distance has been done.",
      ],
    },
    notes: model.vdot === null ? [...notes, "No effort of 3.5 minutes or more in the window, so predictions use Riegel's formula from a short effort and are rough. Training paces need a longer effort."] : notes,
  };
}

/* -------------------------------------------------------------------------- */
/* load_forecast                                                              */
/* -------------------------------------------------------------------------- */

const MAX_FORECAST_DAYS = 180;

export async function forecastData(
  ctx: AppContext,
  a: { end_date?: string; days?: number; scenario?: Scenario; scale_pct: number; taper_days: number; taper_floor_pct: number; planned?: Array<{ date: string; load: number }>; target_tsb?: number },
) {
  const today = ctx.today;
  const event = await nextEvent(ctx.db, addDays(today, 1));
  let end: string;
  if (a.end_date) {
    if (!isIsoDate(a.end_date) || a.end_date <= today) throw new UserError(`end_date must be a date after today (${today}), as YYYY-MM-DD.`);
    end = a.end_date;
  } else if (a.days) end = addDays(today, a.days);
  else end = event && daysBetween(today, event.date) <= MAX_FORECAST_DAYS ? event.date : addDays(today, 14);
  const horizon = daysBetween(today, end);
  if (horizon > MAX_FORECAST_DAYS) throw new UserError(`The forecast reaches up to ${MAX_FORECAST_DAYS} days ahead; ${end} is ${horizon} days away.`);
  const forEvent = event && event.date === end ? event : null;
  const scenario = a.scenario ?? (forEvent ? "taper" : "maintain");

  const warmup = loadWarmupStart(today);
  await ensureActivities(ctx, warmup, today);
  const { facts } = await loadProfile(ctx);
  const loads = new Map<string, number>();
  for (const act of await readActivities(ctx.db, warmup, today)) if (act.date) loads.set(act.date, (loads.get(act.date) ?? 0) + activityLoad(act, facts).load);
  const planned = new Map<string, number>();
  for (const p of a.planned ?? []) {
    if (!isIsoDate(p.date) || p.date < today || p.date > end) throw new UserError(`Planned day ${p.date} is outside ${today} to ${end}.`);
    planned.set(p.date, (planned.get(p.date) ?? 0) + p.load);
  }
  const plan: ForecastPlan = { scenario, scalePct: a.scale_pct, taperDays: Math.min(a.taper_days, horizon), taperFloorPct: a.taper_floor_pct, planned };
  const main = forecast(loads, warmup, today, end, plan);
  const at = (d: LoadDay) => ({ fitness_ctl: round(d.ctl), fatigue_atl: round(d.atl), form_tsb: round(d.tsb), form: formLabel(d.tsb, d.ctl) });
  const plain = (s: Scenario) => at(forecast(loads, warmup, today, end, { ...plan, scenario: s, scalePct: 100, planned: new Map() }).end);

  // One row per day up to five weeks, then one per week.
  const weekly = main.days.length > 35;
  const rows: Array<Record<string, unknown>> = [];
  let sum = 0;
  main.days.forEach((d, i) => {
    sum += d.load;
    if (!weekly || i % 7 === 6 || i === main.days.length - 1) {
      rows.push({ date: d.date, [weekly ? "load_since_last_row" : "planned_load"]: Math.round(sum), fitness_ctl: round(d.ctl), fatigue_atl: round(d.atl), form_tsb: round(d.tsb) });
      sum = 0;
    }
  });
  const freshest = main.days.reduce((best, d) => (d.tsb > best.tsb ? d : best), main.days[0]);

  let target: Record<string, unknown> | undefined;
  if (a.target_tsb !== undefined) {
    if (scenario === "rest") target = { target_tsb: a.target_tsb, note: "The rest scenario has no load to scale. Use maintain or taper." };
    else {
      const s = solveScale(loads, warmup, today, end, plan, a.target_tsb);
      target = s.reachable
        ? { target_tsb: a.target_tsb, train_at_pct_of_usual: s.scale_pct, note: `Training at ${s.scale_pct}% of the usual load (${scenario}) from tomorrow gives a form of ${a.target_tsb} on ${end}.` }
        : { target_tsb: a.target_tsb, reachable: false, form_with_full_rest: round(s.highest_tsb), form_at_three_times_usual_load: round(s.lowest_tsb), note: "The target is outside what any load between rest and three times the usual can produce by that date." };
    }
  }

  return {
    data: {
      as_of: today,
      until: end,
      days_ahead: horizon,
      for_event: forEvent ? { name: forEvent.name, date: forEvent.date } : undefined,
      scenario,
      assumptions: {
        usual_weekly_load: Math.round(main.pattern.reduce((x, y) => x + y, 0)),
        usual_load_by_weekday_sun_to_sat: main.pattern.map((v) => Math.round(v)),
        scale_pct: scenario === "rest" ? undefined : a.scale_pct,
        taper: scenario === "taper" ? `load falls in a straight line to ${a.taper_floor_pct}% of usual over the last ${plan.taperDays} days` : undefined,
        planned_days: planned.size || undefined,
      },
      now: at(main.now),
      on_end_date: at(main.end),
      freshest_day: { date: freshest.date, form_tsb: round(freshest.tsb) },
      other_scenarios_on_end_date: { maintain: plain("maintain"), taper: plain("taper"), rest: plain("rest") },
      target,
      projection: { granularity: weekly ? "week" : "day", ...columnar(rows) },
      method:
        "Same arithmetic as training_load: CTL and ATL are 42- and 7-day exponentially weighted averages, and form (TSB) is fitness minus fatigue going into the day. Future days take the athlete's own weekday pattern of the last 28 days, scaled, tapered or set to rest; planned days override it. A form of about +5 to +25% of fitness suits a race.",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* training_status                                                            */
/* -------------------------------------------------------------------------- */

export async function statusData(ctx: AppContext, a: { end_date?: string }) {
  const end = resolveDate(ctx, a.end_date);
  const warmup = loadWarmupStart(end);
  await ensureActivities(ctx, warmup, end);
  const { facts } = await loadProfile(ctx);
  const acts = await readActivities(ctx.db, warmup, end);
  const start = addDays(end, -27);
  const load = loadReport(acts, facts, start, end, warmup);
  const vo2 = vo2Trend(acts, end);
  const last = [...acts].reverse().find((x) => x.date)?.date ?? null;
  const c = load.current;
  return {
    data: {
      as_of: end,
      ...trainingStatus(load, vo2, last),
      load: { fitness_ctl: c.fitness_ctl, fatigue_atl: c.fatigue_atl, form_tsb: c.form_tsb, form: c.form, acwr: c.acwr, ramp_rate_ctl_per_week: c.ramp_rate_ctl_per_week, load_last_7_days: c.load_last_7_days, load_last_28_days: c.load_last_28_days },
      vo2max: vo2 ?? "No VO2 max reading in the last six weeks.",
      load_focus_last_28_days: loadFocus(acts, facts, start, end),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* correlate                                                                  */
/* -------------------------------------------------------------------------- */

export async function correlateData(ctx: AppContext, a: { x: string; y: string; days: number; lag_days: number; end_date?: string }) {
  if (a.x === a.y && a.lag_days === 0) throw new UserError("x and y are the same metric. Choose two metrics, or a lag above zero.");
  const end = resolveDate(ctx, a.end_date);
  const start = addDays(end, -(a.days - 1));
  await ensureMetric(ctx, a.x, start, end);
  await ensureMetric(ctx, a.y, start, end);
  const { facts } = await loadProfile(ctx);
  const daily = !fromActivities(a.x) || !fromActivities(a.y);
  const byActivity = fromActivities(a.x) || fromActivities(a.y);
  const [rows, acts] = await Promise.all([daily ? readDaily(ctx.db, start, end) : [], byActivity ? readActivities(ctx.db, start, end) : []]);
  const xs = metricSeries(a.x, rows, acts, facts, start, end).map(([, v]) => v);
  const ys = metricSeries(a.y, rows, acts, facts, start, end).map(([, v]) => v);
  const result = correlate(xs, ys, a.lag_days);
  const describe = (name: string) => ({ metric: name, description: METRICS[name].description, unit: METRICS[name].unit });
  const later = a.lag_days === 0 ? "the same day" : `${a.lag_days} day${a.lag_days === 1 ? "" : "s"} later`;
  return {
    data: {
      x: describe(a.x),
      y: describe(a.y),
      period: { from: start, to: end, days: a.days },
      lag_days: a.lag_days,
      pairing: `${a.x} on a day against ${a.y} ${later}`,
      result,
      // The same pair at other lags, so one call shows where the link is strongest.
      other_lags: [0, 1, 2, 3].filter((lag) => lag !== a.lag_days).map((lag) => {
        const c = correlate(xs, ys, lag);
        return { lag_days: lag, n: c.n, pearson_r: c.pearson_r, strength: c.strength };
      }),
      how_to_read: [
        `r runs from -1 to +1; below 0.3 either way is weak. With fewer than ${MIN_PAIRS} paired days the result is reported as not enough data.`,
        "Correlation shows that two metrics move together, never that one causes the other. Scanning several lags or pairs will find some link by chance.",
      ],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* compare_workouts                                                           */
/* -------------------------------------------------------------------------- */

const COMPARABLE = "('running', 'cycling', 'swimming', 'walking', 'hiking', 'rowing_paddling', 'winter')";

export async function compareData(ctx: AppContext, a: { activity_id?: number; sport?: string; limit: number }) {
  let id = a.activity_id;
  if (!id) {
    await ensureActivities(ctx, addDays(ctx.today, -60), ctx.today);
    const latest = await ctx.db
      .prepare(`SELECT activity_id FROM activities WHERE ${a.sport ? "sport = ?" : `sport IN ${COMPARABLE}`} ORDER BY start_local DESC LIMIT 1`)
      .bind(...(a.sport ? [a.sport] : []))
      .first<{ activity_id: number }>();
    if (!latest) throw new UserError(`No ${a.sport ?? "endurance"} activities in the archive yet. Pass an activity_id from list_activities.`);
    id = latest.activity_id;
  }
  let ref = await readActivity(ctx.db, id);
  if (!ref) throw new UserError(`Activity ${id} is not in the archive. Use an id from list_activities.`);
  // The session type comes from the FIT file; read it now if this activity is still waiting.
  if (!(ref.fit_status === "done" && (ref.fit_version ?? 1) >= FIT_ANALYSIS_VERSION)) {
    await importFit(ctx, id);
    ref = (await readActivity(ctx.db, id)) ?? ref;
  }
  const match = matchFor(ref);
  if (!match) {
    throw new UserError(
      ref.workout_type
        ? `Activity ${id} is a ${ref.workout_type} session, which has no like-for-like sessions to compare with. Interval sessions and steady efforts can be compared.`
        : `Activity ${id} has no analyzed FIT file, so its session type is unknown. Run analyze_activity on it first.`,
    );
  }
  const { results } = await ctx.db
    .prepare(`SELECT ${ACTIVITY_FIELDS} FROM activities WHERE sport = ? AND activity_id != ? AND start_local < ? AND ${match.where} ORDER BY start_local DESC LIMIT ?`)
    .bind(ref.sport, id, ref.start_local ?? "9999", ...match.binds, a.limit)
    .all<ActivityRow>();
  const { facts } = await loadProfile(ctx);
  const foot = ref.sport === "running" || ref.sport === "walking" || ref.sport === "hiking";
  const swim = ref.sport === "swimming";
  const show = (l: Line) => ({
    date: l.date,
    activity_id: l.activity_id,
    workout: l.workout,
    ...(foot ? { pace: pace(l.speed_mps, facts.unit) } : swim ? { pace_per_100m: l.speed_mps ? formatDuration(100 / l.speed_mps) : null } : { speed_kmh: l.speed_mps !== null ? round(l.speed_mps * 3.6, 1) : null }),
    hr: l.hr,
    speed_per_beat: l.speed_per_beat,
    reps: l.rep_count,
    rest: l.rest_s !== null ? formatDuration(l.rest_s) : null,
    max_hr: l.max_hr,
    decoupling_pct: l.decoupling_pct,
    temp_c: l.temp_c,
    vo2max: l.vo2max,
  });
  const refLine = lineOf(ref);
  const others = results.map(lineOf);
  return {
    data: {
      reference: show(refLine),
      matched_on: match.basis,
      earlier_sessions: others.length ? columnar(others.map(show)) : [],
      comparison: compare(refLine, others),
      reading: "For an interval session, pace and hr describe the reps only; otherwise the whole session. speed_per_beat is meters per minute per heartbeat: higher means fitter at the same effort. Heat (temp_c) lowers it.",
    },
    notes: await pendingNote(ctx, ref.sport, "1900-01-01", ref.date ?? ctx.today),
  };
}

/* -------------------------------------------------------------------------- */
/* race_calendar                                                              */
/* -------------------------------------------------------------------------- */

const DISTANCES: Record<string, number> = {
  "800m": 800,
  "1500m": 1500,
  "1mi": 1609.344,
  "3k": 3000,
  "5k": 5000,
  "10k": 10000,
  "15k": 15000,
  "10mi": 16093.44,
  half: 21097.5,
  marathon: 42195,
  "50k": 50000,
  "100k": 100000,
};
const MAX_EVENTS = 200;

/** "42:30" or "3:29:59" as seconds. */
function clockSeconds(text: string): number | null {
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((p) => p !== undefined).map(Number);
  if (parts.slice(1).some((p) => p > 59)) return null;
  return parts.reduce((total, p) => total * 60 + p, 0);
}

function showEvent(e: EventRow, today: string) {
  const toGo = daysBetween(today, e.date);
  return {
    id: e.id,
    name: e.name,
    date: e.date,
    days_to_go: toGo,
    phase: toGo >= 0 ? eventPhase(toGo) : "past",
    sport: e.sport,
    distance_km: e.distance_m !== null ? round(e.distance_m / 1000, 2) : null,
    goal_time: e.goal_time_s !== null ? formatDuration(e.goal_time_s) : null,
    priority: e.priority,
    note: e.note,
  };
}

interface CalendarArgs {
  action: "list" | "add" | "update" | "remove";
  id?: number;
  date?: string;
  name?: string;
  sport?: string;
  distance?: string;
  distance_km?: number;
  goal_time?: string;
  priority?: string;
  note?: string;
}

export async function calendarData(ctx: AppContext, a: CalendarArgs) {
  const fields: Partial<EventInput> = {};
  if (a.date !== undefined) {
    if (!isIsoDate(a.date)) throw new UserError("date must be YYYY-MM-DD.");
    fields.date = a.date;
  }
  if (a.name !== undefined) fields.name = a.name.trim();
  if (a.sport !== undefined) fields.sport = a.sport;
  if (a.distance !== undefined) fields.distance_m = DISTANCES[a.distance];
  if (a.distance_km !== undefined) fields.distance_m = a.distance_km * 1000;
  if (a.goal_time !== undefined) {
    const seconds = clockSeconds(a.goal_time);
    if (seconds === null) throw new UserError("goal_time must be mm:ss or h:mm:ss, for example 42:30 or 3:29:59.");
    fields.goal_time_s = seconds;
  }
  if (a.priority !== undefined) fields.priority = a.priority;
  if (a.note !== undefined) fields.note = a.note.trim();

  let changed: EventRow | null = null;
  if (a.action === "add") {
    if (!fields.date || !fields.name) throw new UserError("To add an event, give its date and name.");
    if ((await listEvents(ctx.db)).length >= MAX_EVENTS) throw new UserError(`The calendar holds up to ${MAX_EVENTS} events. Remove old ones first.`);
    // The named distances (5k, half, marathon...) are running races unless a sport says otherwise.
    changed = await addEvent(ctx.db, { ...fields, date: fields.date, name: fields.name, sport: fields.sport ?? (a.distance ? "running" : null) }, ctx.now);
  } else if (a.action === "update" || a.action === "remove") {
    if (!a.id) throw new UserError(`To ${a.action} an event, give its id (see action "list").`);
    changed = a.action === "update" ? await updateEvent(ctx.db, a.id, fields) : await removeEvent(ctx.db, a.id);
    if (!changed) throw new UserError(`There is no event with id ${a.id}.`);
  }
  const events = await listEvents(ctx.db);
  return {
    data: {
      action: a.action,
      [a.action === "remove" ? "removed" : "event"]: changed ? showEvent(changed, ctx.today) : undefined,
      upcoming: events.filter((e) => e.date >= ctx.today).map((e) => showEvent(e, ctx.today)),
      past: events.filter((e) => e.date < ctx.today).map((e) => showEvent(e, ctx.today)).reverse().slice(0, 10),
      stored: "In this server's own archive only. Nothing is sent to Garmin.",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerCoachTools(server: McpServer, deps: ToolDeps): void {
  const metricNames = Object.keys(METRICS) as [string, ...string[]];

  server.registerTool(
    "race_predictor",
    {
      title: "Race predictor and training paces",
      description:
        "Race time predictions and training paces computed from the athlete's recent best efforts (Garmin's API returns no predictions). Running: VDOT, predicted times from 1500 m to the marathon with a range and confidence, easy/marathon/threshold/interval/repetition paces, critical speed, and the gap to the goal of the next race in the calendar. Cycling: FTP estimate, critical power, W' and power zones from the power curve. Use for 'what can I run for 10k?', 'what pace should my intervals be?', 'what is my FTP?'. Never estimate these yourself.",
      inputSchema: {
        sport: z.enum(["running", "cycling"]).default("running"),
        window_days: z.number().int().min(14).max(730).default(120).describe("Use the best efforts of this many days: recent enough to reflect current fitness"),
        end_date: dateArg.optional(),
        target_km: z.number().positive().max(200).optional().describe("Also predict this distance (running)"),
      },
      annotations: READ,
    },
    run(deps, predictorData),
  );

  server.registerTool(
    "load_forecast",
    {
      title: "Load forecast",
      description:
        "Projects fitness (CTL), fatigue (ATL) and form (TSB) forward for a plan: keep training as usual, taper, or rest, with optional planned loads per day. Reports form on the end date, the freshest day, how the three scenarios compare, and with target_tsb the share of usual load that lands on that form. Defaults to the next race in the calendar. Use for taper planning and 'what will my form be on race day if I...'. Do not project load by hand.",
      inputSchema: {
        end_date: z.string().optional().describe("YYYY-MM-DD after today, e.g. race day. Default: the next race in the calendar, else 14 days ahead"),
        days: z.number().int().min(1).max(MAX_FORECAST_DAYS).optional().describe("Days ahead, instead of end_date"),
        scenario: z.enum(["maintain", "taper", "rest"]).optional().describe("Default: taper when the end date is a calendar race, else maintain"),
        scale_pct: z.number().min(0).max(300).default(100).describe("Train at this percent of the usual load (the weekday pattern of the last 28 days)"),
        taper_days: z.number().int().min(3).max(28).default(14),
        taper_floor_pct: z.number().min(0).max(100).default(40).describe("Load left on the last day of the taper, as a percent of usual"),
        planned: z
          .array(z.object({ date: z.string(), load: z.number().min(0).max(2000) }))
          .max(MAX_FORECAST_DAYS)
          .optional()
          .describe("Loads planned for specific dates (same scale as training_load); they override the scenario on those days"),
        target_tsb: z.number().min(-100).max(100).optional().describe("Find the load scale that gives this form on the end date"),
      },
      annotations: READ,
    },
    run(deps, forecastData),
  );

  server.registerTool(
    "training_status",
    {
      title: "Training status and load focus",
      description:
        "One word for how training is going (productive, maintaining, peaking, recovery, unproductive, overreaching, detraining) from the load chart and the six-week VO2 max trend, with the reason. Plus load focus: how the last 28 days of load split between low aerobic, high aerobic and anaerobic work, and what is short. Threshold's own transparent rules; Garmin's Training Status and Load Focus are not in the API. Use for 'is my training working?', 'what kind of training am I missing?'.",
      inputSchema: { end_date: dateArg.optional() },
      annotations: READ,
    },
    run(deps, statusData),
  );

  server.registerTool(
    "correlate",
    {
      title: "Correlate two metrics",
      description: `How two daily metrics move together, with a lag: Pearson and Spearman correlation, a 95% interval, the mean of y on high-x and low-x days, and the same pair at lags 0 to 3. Use for 'does late training hurt my sleep?', 'does a hard day raise my overnight stress?', 'does sleep predict my resting HR?'. Sleep and HRV sit on the date the night ends, so "today's training against tonight's sleep" is lag_days 1. Metrics: ${metricNames.join(", ")}.`,
      inputSchema: {
        x: z.enum(metricNames).describe("The earlier metric (the possible driver)"),
        y: z.enum(metricNames).describe("The later metric (the possible outcome)"),
        days: z.number().int().min(30).max(730).default(180),
        lag_days: z.number().int().min(0).max(14).default(0).describe("Pair x on a day with y this many days later"),
        end_date: dateArg.optional(),
      },
      annotations: READ,
    },
    run(deps, correlateData),
  );

  server.registerTool(
    "compare_workouts",
    {
      title: "Compare similar workouts",
      description:
        "Lines up one workout with earlier sessions of the same kind: interval sessions with the same reps (e.g. every 10 x 1000 m), or steady efforts of about the same distance. Reports pace, heart rate and speed per heartbeat for each, the change against the previous one and against the average, and the trend. Use for 'am I faster at this workout than last time?', 'how does today's long run compare?'.",
      inputSchema: {
        activity_id: z.number().int().positive().optional().describe("From list_activities. Default: the latest endurance activity"),
        sport: z.enum(["running", "cycling", "swimming", "walking", "hiking"]).optional().describe("With no id: the latest activity of this sport"),
        limit: z.number().int().min(1).max(30).default(8).describe("Earlier sessions to compare with"),
      },
      annotations: READ,
    },
    run(deps, compareData),
  );

  server.registerTool(
    "race_calendar",
    {
      title: "Race calendar",
      description:
        "The athlete's target races and events, kept in this server's own archive (never sent to Garmin). daily_briefing counts down to the next one, race_predictor shows the gap to its goal, and load_forecast aims at its date. Actions: list, add (date and name; optional sport, distance, goal_time, priority A/B/C, note), update and remove (by id). Add an event when the athlete mentions a race they are training for.",
      inputSchema: {
        action: z.enum(["list", "add", "update", "remove"]).default("list"),
        id: z.number().int().positive().optional().describe("For update and remove"),
        date: z.string().optional().describe("YYYY-MM-DD"),
        name: z.string().min(1).max(80).optional(),
        sport: z.enum(["running", "cycling", "swimming", "triathlon", "hiking", "other"]).optional(),
        distance: z.enum(Object.keys(DISTANCES) as [string, ...string[]]).optional(),
        distance_km: z.number().positive().max(1000).optional().describe("For a distance not in the list"),
        goal_time: z.string().max(10).optional().describe("mm:ss or h:mm:ss, e.g. 42:30 or 3:29:59"),
        priority: z.enum(["A", "B", "C"]).optional(),
        note: z.string().max(300).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    run(deps, calendarData),
  );
}
