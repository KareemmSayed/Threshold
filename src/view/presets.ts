/**
 * Presets: views built from the same analysis the tools run, so every number on the card
 * comes from the server. The model picks a preset and the sections the user asked about,
 * and may add one sentence per section; it never supplies the numbers. No preset shows
 * activity names (they often contain place names) or GPS data.
 */
import { z } from "zod";
import { METRICS } from "../analysis/trends";
import type { AppContext } from "../context";
import { formatDuration, hoursMinutes } from "../fit/analyze";
import { activityData, briefingData, loadData, recordsData, recoveryData, trendData, weeklyData } from "../mcp/tools";
import { addDays } from "../util/dates";
import type { Aura, Block } from "./spec";

export const PRESET_SECTIONS = {
  activity: ["summary", "pacing", "heart_rate", "zones", "durability", "load", "form", "efforts", "laps"],
  readiness: ["verdict", "signals", "training", "sleep"],
  training_load: ["summary", "chart", "form", "weekly", "by_sport"],
  records: ["efforts", "longest", "coverage"],
  trend: ["summary", "chart", "trend"],
  recovery: ["status", "hrv", "resting_hr", "sleep"],
  weekly: ["summary", "table", "chart"],
} as const;

type PresetName = keyof typeof PRESET_SECTIONS;
type Section<P extends PresetName> = (typeof PRESET_SECTIONS)[P][number];

const DEFAULT_SECTIONS: { [P in PresetName]: Array<Section<P>> } = {
  activity: ["summary", "pacing", "heart_rate", "durability", "load"],
  readiness: ["verdict", "signals"],
  training_load: ["summary", "chart", "form"],
  records: ["efforts", "longest"],
  trend: ["summary", "chart"],
  recovery: ["status", "hrv", "resting_hr", "sleep"],
  weekly: ["summary", "table"],
};

const sections = <P extends PresetName>(name: P) =>
  z
    .array(z.enum(PRESET_SECTIONS[name]))
    .min(1)
    .optional()
    .describe(`Default: ${DEFAULT_SECTIONS[name].join(", ")}`);

/** Keyed by section name; explained in show_view's description. */
const notes = z.record(z.string(), z.string().max(400)).optional();
const date = z.string().refine((v) => v === "today" || v === "yesterday" || /^\d{4}-\d{2}-\d{2}$/.test(v), "Use YYYY-MM-DD, 'today' or 'yesterday'");

const metricNames = Object.keys(METRICS) as [string, ...string[]];

export const presetSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("activity"),
    activity_id: z.number().int().positive().optional(),
    sport: z.enum(["running", "cycling", "swimming", "walking", "hiking", "strength", "other"]).optional(),
    sections: sections("activity"),
    notes,
  }),
  z.object({ name: z.literal("readiness"), date: date.optional(), sections: sections("readiness"), notes }),
  z.object({
    name: z.literal("training_load"),
    days: z.number().int().min(14).max(365).default(42),
    end_date: date.optional(),
    sections: sections("training_load"),
    notes,
  }),
  z.object({
    name: z.literal("records"),
    sport: z.enum(["running", "cycling", "swimming", "walking", "hiking"]).default("running"),
    start_date: date.optional(),
    end_date: date.optional(),
    sections: sections("records"),
    notes,
  }),
  z.object({
    name: z.literal("trend"),
    metric: z.enum(metricNames),
    days: z.number().int().min(7).max(730).default(90),
    end_date: date.optional(),
    granularity: z.enum(["day", "week", "month"]).optional(),
    sections: sections("trend"),
    notes,
  }),
  z.object({ name: z.literal("recovery"), date: date.optional(), sections: sections("recovery"), notes }),
  z.object({
    name: z.literal("weekly"),
    weeks: z.number().int().min(1).max(26).default(6),
    end_date: date.optional(),
    sections: sections("weekly"),
    notes,
  }),
]);
export type Preset = z.infer<typeof presetSchema>;

export interface BuiltPreset {
  eyebrow: string;
  title: string;
  aura: Aura;
  blocks: Block[];
  /** For the model: sections left out for lack of data, and the tool's own notes. */
  notes: string[];
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-23" -> "23 Oct 2026" (or "23 Oct"); "2026-10" -> "Oct 2026". */
export function shortDate(iso: unknown, withYear = true): string {
  const s = str(iso) ?? "";
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (day) return `${Number(day[3])} ${MONTHS[Number(day[2]) - 1]}${withYear ? ` ${day[1]}` : ""}`;
  const month = /^(\d{4})-(\d{2})$/.exec(s);
  return month ? `${MONTHS[Number(month[2]) - 1]} ${month[1]}` : s;
}

/** "1:06:02", "3:22" or "3:22/km" -> seconds. */
function clock(v: unknown): number | null {
  const s = str(v)?.split("/")[0];
  if (!s || !/^\d+(:\d{1,2}){1,2}$/.test(s)) return null;
  return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

function fixed(v: number | null, digits = 1): string | null {
  if (v === null) return null;
  const f = Number(v.toFixed(digits));
  return String(f);
}

const signed = (v: number | null, digits = 1, suffix = "") => (v === null ? null : `${v > 0 ? "+" : ""}${fixed(v, digits)}${suffix}`);
const withUnit = (v: number | null, unit: string, digits = 1) => (v === null ? null : `${fixed(v, digits)} ${unit}`);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "AEROBIC_BASE" or "track_running" -> "Aerobic base" / "Track running". */
const humanize = (s: string) => capitalize(s.replace(/_/g, " ").toLowerCase());

/** A metric value in its unit; paces in decimal minutes become m:ss. */
function metricValue(v: number | null, unit: string): string | null {
  if (v === null) return null;
  if (unit === "min/km" || unit === "min/mi") return formatDuration(v * 60);
  return fixed(v, Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
}

function keep<T>(rows: Array<T | null | false | undefined | 0 | "">): T[] {
  return rows.filter((r): r is T => Boolean(r));
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

type Builders<P extends PresetName> = { [S in Section<P>]: () => Block[] | null };

/** Run the requested sections in order, attach the model's notes, and record sections without data. */
function assemble<P extends PresetName>(name: P, requested: Array<Section<P>> | undefined, builders: Builders<P>, modelNotes: Record<string, string> | undefined, out: string[]): Block[] {
  const blocks: Block[] = [];
  for (const section of requested?.length ? [...new Set(requested)] : DEFAULT_SECTIONS[name]) {
    const built = builders[section]();
    if (!built?.length) {
      out.push(`No data for the "${section}" section, so it is left out.`);
      continue;
    }
    const note = modelNotes?.[section]?.trim();
    if (note) built[built.length - 1] = { ...built[built.length - 1], note };
    blocks.push(...built);
  }
  return blocks;
}

export async function buildPreset(ctx: AppContext, preset: Preset): Promise<BuiltPreset> {
  switch (preset.name) {
    case "activity":
      return activityPreset(ctx, preset);
    case "readiness":
      return readinessPreset(ctx, preset);
    case "training_load":
      return loadPreset(ctx, preset);
    case "records":
      return recordsPreset(ctx, preset);
    case "trend":
      return trendPreset(ctx, preset);
    case "recovery":
      return recoveryPreset(ctx, preset);
    case "weekly":
      return weeklyPreset(ctx, preset);
  }
}

/* -------------------------------------------------------------------------- */
/* activity                                                                   */
/* -------------------------------------------------------------------------- */

const FOOT = new Set(["running", "walking", "hiking"]);
const ZONE_TONES = ["blue", "indigo", "violet", "pink", "hot"] as const;
const EFFORT_LABELS: Record<string, string> = {
  "400m": "400 m",
  "1k": "1 km",
  "1mi": "1 mile",
  "5k": "5 km",
  "10k": "10 km",
  half: "Half marathon",
  marathon: "Marathon",
  "100m_swim": "100 m",
  "400m_swim": "400 m",
  "1500m_swim": "1500 m",
};
const effortLabel = (key: string) => EFFORT_LABELS[key] ?? key.replace(/_bike$|_swim$/, "").replace(/^(\d+)k$/, "$1 km").replace(/^(\d+)(s|min)$/, "$1 $2");

async function activityPreset(ctx: AppContext, p: Extract<Preset, { name: "activity" }>): Promise<BuiltPreset> {
  const res = await activityData(ctx, { activity_id: p.activity_id, sport: p.sport, samples: 0, include_route: false, include_raw_hidden: false });
  const out = [...("notes" in res && res.notes ? res.notes : [])];
  const act = obj(res.data.activity);
  const an = obj(res.data.analysis);
  const sum = obj(an.summary);
  const hidden = obj(an.hidden);
  const sport = str(sum.sport) ?? (str(act.type)?.includes("running") ? "running" : str(act.type)?.includes("cycling") ? "cycling" : "other");
  const foot = FOOT.has(sport);
  const avgPace = str(sum.avg_pace) ?? str(act.pace);
  const unit = avgPace?.endsWith("/mi") ? "mi" : "km";
  const splits = arr(an.splits).map(obj);
  const full = (s: Obj) => (num(s.distance_km) ?? 0) >= (unit === "km" ? 0.5 : 0.8);
  const avgHr = num(sum.avg_hr) ?? num(act.avg_hr);
  const zones = arr(obj(an.hr_zones).zones).map(obj);

  const builders: Builders<"activity"> = {
    summary: () => {
      const speed = num(sum.avg_speed_kmh) ?? num(act.speed_kmh);
      const vo2 = num(hidden.vo2max) ?? num(act.vo2max);
      return [
        {
          type: "stats",
          items: [
            { value: fixed(num(sum.distance_km) ?? num(act.distance_km), 2), label: "km" },
            { value: str(sum.duration) ?? str(act.duration), label: "time" },
            foot ? { value: avgPace?.split("/")[0] ?? null, label: `/${unit}` } : { value: fixed(speed, 1), label: "km/h" },
            vo2 !== null ? { value: fixed(vo2, 1), label: "VO2 max" } : { value: avgHr !== null ? Math.round(avgHr) : null, label: "bpm avg" },
          ],
        },
      ];
    },
    pacing: () => {
      if (splits.length < 2) return null;
      // Group long activities so the panel stays beside its neighbour (at most 12 rows).
      const size = Math.ceil(splits.length / 12);
      const rows: Array<{ label: string; value: string | null; amount: number | null; full: boolean }> = [];
      for (let i = 0; i < splits.length; i += size) {
        const group = splits.slice(i, i + size);
        const km = group.reduce((a, s) => a + (num(s.distance_km) ?? 0), 0);
        const secs = group.reduce((a, s) => a + (clock(s.time) ?? 0), 0);
        const first = num(group[0].split) ?? i + 1;
        const last = num(group[group.length - 1].split) ?? i + group.length;
        const perUnit = km > 0 ? secs / (unit === "km" ? km : km / 1.609344) : null;
        const kmh = secs > 0 ? km / (secs / 3600) : null;
        rows.push({
          label: size > 1 ? `${unit} ${first}–${last}` : `${unit} ${first}`,
          value: foot ? (perUnit !== null ? formatDuration(perUnit) : null) : fixed(kmh, 1),
          amount: foot ? perUnit : kmh,
          full: group.every(full) || (group.length > 1 && group.slice(0, -1).every(full)),
        });
      }
      const ranked = rows.filter((r) => r.full && r.amount !== null).sort((a, b) => a.amount! - b.amount!);
      const slow = foot ? ranked[ranked.length - 1] : ranked[0];
      const fast = foot ? ranked[0] : ranked[ranked.length - 1];
      // Name a split only when it is the only one at that value.
      const only = (r: (typeof rows)[number] | undefined) => (r && rows.filter((x) => x.value === r.value).length === 1 ? r : undefined);
      const at = (r: (typeof rows)[number]) => `${only(r) ? `${r.label} ` : ""}at ${r.value}${foot ? "" : " km/h"}`;
      const note =
        fast && slow && fast.value !== slow.value
          ? `Fastest ${at(fast)}, slowest ${at(slow)}${foot ? `: a ${Math.round(slow.amount! - fast.amount!)} s spread` : ""}.`
          : undefined;
      return [
        {
          type: "bars",
          title: foot ? "Pacing" : "Speed",
          width: "half",
          baseline: "min",
          rows: rows.map((r) => ({ label: r.label, value: r.value, amount: r.amount, highlight: r === only(slow) })),
          note,
        },
      ];
    },
    heart_rate: () => {
      const top = zones.reduce<Obj | null>((best, z) => ((num(z.pct) ?? 0) > (num(best?.pct) ?? -1) ? z : best), null);
      const splitHr = splits.filter(full).map((s) => num(s.avg_hr)).filter((v): v is number => v !== null);
      const rows = keep([
        avgHr !== null && { label: "Average", value: `${Math.round(avgHr)} bpm` },
        num(sum.max_hr ?? act.max_hr) !== null && { label: "Max", value: `${Math.round(num(sum.max_hr ?? act.max_hr)!)} bpm` },
        top && num(top.pct) && { label: `Zone ${top.zone}`, value: `${str(top.time) ?? "?"} · ${Math.round(num(top.pct)!)}%` },
        splitHr.length >= 2 && { label: `First → last ${unit}`, value: `${splitHr[0]} → ${splitHr[splitHr.length - 1]} bpm` },
      ]);
      return rows.length ? [{ type: "kv", title: "Heart rate", width: "half", rows }] : null;
    },
    zones: () => {
      if (!zones.length || !zones.some((z) => num(z.pct))) return null;
      const floors = zones.map((z) => num(z.from_bpm)).filter((v): v is number => v !== null);
      return [
        {
          type: "bars",
          title: "HR zones",
          width: "half",
          rows: zones.map((z, i) => ({ label: `Z${z.zone}`, value: `${str(z.time) ?? "0:00"} · ${Math.round(num(z.pct) ?? 0)}%`, amount: num(z.pct) ?? 0, tone: ZONE_TONES[i] ?? "hot" })),
          note: floors.length === 5 ? `Zones start at ${floors.join(" / ")} bpm.` : undefined,
        },
      ];
    },
    durability: () => {
      const d = obj(an.durability);
      const ef = num(an.efficiency_factor);
      const rows = keep([
        num(d.decoupling_pct) !== null && { label: "Aerobic decoupling", value: `${fixed(num(d.decoupling_pct), 1)}%` },
        num(d.cardiac_drift_pct) !== null && { label: "Cardiac drift", value: `${fixed(num(d.cardiac_drift_pct), 1)}%` },
        num(obj(d.first_half).avg_hr) !== null &&
          num(obj(d.second_half).avg_hr) !== null && { label: "HR, first → second half", value: `${Math.round(num(obj(d.first_half).avg_hr)!)} → ${Math.round(num(obj(d.second_half).avg_hr)!)} bpm` },
        ef !== null && { label: "Efficiency factor", value: fixed(ef, 2) },
      ]);
      const caveats = arr(d.caveats).map(str).filter(Boolean);
      return rows.length ? [{ type: "kv", title: "Durability", width: "half", rows, note: [str(d.verdict), ...caveats].filter(Boolean).join(" ") || undefined }] : null;
    },
    load: () => {
      const pc = obj(hidden.performance_condition);
      const recovery = num(obj(obj(hidden.experimental).recovery_time).value);
      const ate = num(sum.aerobic_te) ?? num(act.aerobic_te);
      const ante = num(sum.anaerobic_te) ?? num(act.anaerobic_te);
      const rows = keep([
        num(sum.exercise_load ?? act.training_load) !== null && { label: "Training load", value: Math.round(num(sum.exercise_load ?? act.training_load)!) },
        (ate !== null || ante !== null) && { label: "Aerobic / anaerobic", value: `${fixed(ate, 1) ?? "—"} / ${fixed(ante, 1) ?? "—"}` },
        str(act.effect) && { label: "Effect", value: humanize(str(act.effect)!) },
        num(pc.first) !== null && num(pc.final) !== null && { label: "Performance condition", value: `${signed(num(pc.first), 0)} → ${signed(num(pc.final), 0)}` },
        num(sum.normalized_power_w) !== null && { label: "Normalized power", value: `${Math.round(num(sum.normalized_power_w)!)} W` },
        num(sum.intensity_factor) !== null && { label: "IF / TSS", value: `${fixed(num(sum.intensity_factor), 2)} / ${num(sum.training_stress_score) ?? "—"}` },
        recovery !== null && { label: "Recovery (unverified)", value: `${Math.round(recovery / 60)} h` },
      ]);
      return rows.length ? [{ type: "kv", title: "Load and effect", width: "half", rows }] : null;
    },
    form: () => {
      const rows = keep([
        num(sum.avg_cadence) !== null && { label: "Cadence", value: `${Math.round(num(sum.avg_cadence)!)} ${foot ? "spm" : "rpm"}` },
        str(sum.avg_gap_pace) && { label: "Grade-adjusted pace", value: str(sum.avg_gap_pace) },
        num(sum.avg_power_w) !== null && { label: "Average power", value: `${Math.round(num(sum.avg_power_w)!)} W` },
        num(sum.ascent_m) !== null && { label: "Ascent", value: `${Math.round(num(sum.ascent_m)!)} m` },
        num(sum.avg_temperature_c) !== null && { label: "Temperature", value: `${Math.round(num(sum.avg_temperature_c)!)} °C` },
        num(sum.avg_respiration) !== null && { label: "Respiration", value: `${Math.round(num(sum.avg_respiration)!)} brpm` },
      ]);
      return rows.length ? [{ type: "kv", title: "Form and conditions", width: "half", rows }] : null;
    },
    efforts: () => {
      const be = obj(an.best_efforts);
      const rows: Array<{ cells: Array<string | number | null> }> = [];
      for (const [key, e] of Object.entries(obj(be.distance))) rows.push({ cells: [effortLabel(key), str(obj(e).time), str(obj(e).pace)] });
      for (const [key, w] of Object.entries(obj(be.power_w))) rows.push({ cells: [`${effortLabel(key)} power`, num(w) !== null ? `${Math.round(num(w)!)} W` : null, null] });
      for (const [key, bpm] of Object.entries(obj(be.hr_bpm))) rows.push({ cells: [`${effortLabel(key)} HR`, num(bpm) !== null ? `${Math.round(num(bpm)!)} bpm` : null, null] });
      return rows.length ? [{ type: "table", title: "Best efforts in this session", columns: ["Effort", "Best", "Pace"], rows }] : null;
    },
    laps: () => {
      const laps = arr(an.laps).map(obj);
      if (laps.length < 2) return null;
      return [
        {
          type: "table",
          title: "Laps",
          columns: ["Lap", "Distance", "Time", foot ? "Pace" : "Speed", "Avg HR"],
          bar_after: 3,
          rows: laps.slice(0, 30).map((l, i) => ({
            cells: [
              i + 1,
              withUnit(num(l.distance_km), "km", 2),
              str(l.duration),
              foot ? (str(l.avg_pace)?.split("/")[0] ?? null) : withUnit(num(l.avg_speed_kmh), "km/h"),
              num(l.avg_hr) !== null ? `${Math.round(num(l.avg_hr)!)} bpm` : null,
            ],
            bar: num(l.avg_speed_kmh),
          })),
        },
      ];
    },
  };

  const type = str(act.type) ?? sport;
  return {
    eyebrow: "analyze_activity",
    title: `${humanize(type)} · ${shortDate(act.date ?? str(sum.start)?.slice(0, 10))}`,
    aura: "flame",
    blocks: assemble("activity", p.sections, builders, p.notes, out),
    notes: out,
  };
}

/* -------------------------------------------------------------------------- */
/* readiness                                                                  */
/* -------------------------------------------------------------------------- */

const LEVEL_STATUS = { good: "green", ok: "blue", caution: "amber", warning: "red" } as const;

async function readinessPreset(ctx: AppContext, p: Extract<Preset, { name: "readiness" }>): Promise<BuiltPreset> {
  const { data } = await briefingData(ctx, { date: p.date });
  const out: string[] = [];
  const status = data.overall.status;
  const tone = status === "green" ? "green" : status === "amber" ? "amber" : status === "red" ? "red" : "muted";
  const t = data.training;
  const night = data.last_night;

  const builders: Builders<"readiness"> = {
    verdict: () => [{ type: "headline", value: `${status.toUpperCase()}.`, text: data.overall.suggestion, tone }],
    signals: () =>
      data.signals.length ? [{ type: "signals", rows: data.signals.map((s) => ({ label: s.signal, value: s.reading, status: LEVEL_STATUS[s.level] })) }] : null,
    training: () =>
      t.fitness_ctl === null
        ? null
        : [
            {
              type: "stats",
              items: [
                { value: fixed(t.fitness_ctl, 1), label: "fitness CTL" },
                { value: fixed(t.fatigue_atl, 1), label: "fatigue ATL" },
                { value: signed(t.form_tsb, 1), label: "form TSB" },
                { value: fixed(t.acwr, 2), label: "ACWR" },
              ],
            },
          ],
    sleep: () => {
      if (!night) return null;
      const hours = num(night.hours);
      const rows = keep([
        hours !== null && { label: "Slept", value: hoursMinutes(hours * 3600) },
        num(night.score) !== null && { label: "Score", value: num(night.score) },
        num(night.deep_min) !== null && { label: "Deep", value: `${num(night.deep_min)} min` },
        num(night.rem_min) !== null && { label: "REM", value: `${num(night.rem_min)} min` },
        num(night.light_min) !== null && { label: "Light", value: `${num(night.light_min)} min` },
        num(night.awake_min) !== null && { label: "Awake", value: `${num(night.awake_min)} min` },
      ]);
      return rows.length ? [{ type: "kv", title: "Last night", rows }] : null;
    },
  };

  return {
    eyebrow: "daily_briefing",
    title: `Readiness · ${shortDate(data.date)}`,
    aura: status === "red" ? "ember" : status === "amber" ? "flame" : status === "green" ? "moss" : "graphite",
    blocks: assemble("readiness", p.sections, builders, p.notes, out),
    notes: out,
  };
}

/* -------------------------------------------------------------------------- */
/* training_load                                                              */
/* -------------------------------------------------------------------------- */

async function loadPreset(ctx: AppContext, p: Extract<Preset, { name: "training_load" }>): Promise<BuiltPreset> {
  const { data: r, chart } = await loadData(ctx, { days: p.days, end_date: p.end_date }, true);
  const out: string[] = [];
  const c = r.current;
  const builders: Builders<"training_load"> = {
    summary: () => [
      {
        type: "stats",
        items: [
          { value: fixed(c.fitness_ctl, 1), label: "fitness CTL" },
          { value: fixed(c.fatigue_atl, 1), label: "fatigue ATL" },
          { value: signed(c.form_tsb, 1), label: "form TSB" },
          { value: fixed(c.acwr, 2), label: "ACWR" },
        ],
      },
    ],
    chart: () =>
      chart && chart.length > 1
        ? [
            {
              type: "chart",
              title: `Last ${chart.length} days`,
              kind: "line",
              fill_between: true,
              series: [
                { label: `Fatigue ATL ${fixed(c.fatigue_atl, 0) ?? "—"}`, values: chart.map((d) => Number(d.atl.toFixed(1))), tone: "hot" },
                { label: `Fitness CTL ${fixed(c.fitness_ctl, 0) ?? "—"}`, values: chart.map((d) => Number(d.ctl.toFixed(1))), tone: "ink" },
              ],
              x_labels: chart.map((d) => shortDate(d.date, false)),
            },
          ]
        : null,
    form: () => [
      {
        type: "kv",
        title: "Form and ramp",
        rows: keep([
          { label: "Form (TSB)", value: signed(c.form_tsb, 1) },
          { label: "ACWR", value: c.acwr !== null ? `${fixed(c.acwr, 2)} · ${(c.acwr_zone.split(":")[1] ?? c.acwr_zone).split("(")[0].trim()}` : null },
          c.ramp_rate_ctl_per_week !== null && { label: "CTL ramp", value: `${signed(c.ramp_rate_ctl_per_week, 1)} / week` },
          c.monotony !== null && { label: "Monotony", value: fixed(c.monotony, 2) },
          c.strain !== null && { label: "Strain", value: c.strain },
          { label: "Load, 7 / 28 days", value: `${c.load_last_7_days} / ${c.load_last_28_days}` },
        ]),
        note: c.form !== "no data" ? `${capitalize(c.form)}.` : undefined,
      },
    ],
    weekly: () =>
      r.weekly.length
        ? [
            {
              type: "table",
              title: "By week",
              columns: ["Week of", "Load", "Hours", "CTL", "TSB"],
              bar_after: 1,
              rows: r.weekly.map((w, i) => ({
                cells: [shortDate(w.week_of, false), w.load, `${w.hours} h`, fixed(w.ctl_end, 1), signed(w.tsb_end, 1)],
                bar: w.load,
                highlight: i === r.weekly.length - 1,
              })),
            },
          ]
        : null,
    by_sport: () => {
      const sports = Object.entries(r.by_sport_last_28_days).sort((a, b) => b[1].load - a[1].load);
      return sports.length
        ? [
            {
              type: "table",
              title: "Last 28 days by sport",
              columns: ["Sport", "Load", "Activities", "Hours"],
              bar_after: 1,
              rows: sports.map(([sport, s]) => ({ cells: [humanize(sport), s.load, s.activities, `${s.hours} h`], bar: s.load })),
            },
          ]
        : null;
    },
  };
  return {
    eyebrow: "training_load",
    title: `Training load · ${shortDate(r.as_of)}`,
    aura: "flame",
    blocks: assemble("training_load", p.sections, builders, p.notes, out),
    notes: out,
  };
}

/* -------------------------------------------------------------------------- */
/* records                                                                    */
/* -------------------------------------------------------------------------- */

const EFFORT_ORDER = ["400m", "1k", "1mi", "5k", "10k", "half", "marathon", "100m_swim", "400m_swim", "1500m_swim", "5s", "15s", "30s", "1min", "5min", "10min", "20min", "30min", "60min"];
const effortRank = (k: string) => {
  const i = EFFORT_ORDER.indexOf(k);
  const km = /^(\d+)k_bike$/.exec(k);
  return i >= 0 ? i : km ? 7 + Number(km[1]) / 1000 : 100;
};

async function recordsPreset(ctx: AppContext, p: Extract<Preset, { name: "records" }>): Promise<BuiltPreset> {
  const res = await recordsData(ctx, { sport: p.sport, start_date: p.start_date, end_date: p.end_date, top: 2, import_missing: false });
  const d = res.data;
  const out = [...(res.notes ?? [])];
  const recent = addDays(ctx.today, -14);
  const entry = (e: Obj | undefined) => (e ? (str(e.time) ?? (num(e.watts) !== null ? `${num(e.watts)} W` : null)) : null);

  const builders: Builders<"records"> = {
    efforts: () => {
      const efforts = Object.entries(d.best_efforts).sort((a, b) => effortRank(a[0]) - effortRank(b[0]));
      if (!efforts.length) return null;
      const rows = efforts.map(([key, list]) => {
        const [best, next] = arr(list).map(obj);
        const isPower = num(best?.watts) !== null;
        return {
          cells: [isPower ? `${effortLabel(key)} power` : effortLabel(key), entry(best), shortDate(best?.date), entry(next)],
          highlight: (str(best?.date) ?? "") >= recent,
        };
      });
      return [
        {
          type: "table",
          columns: ["Effort", "Best", "Date", "Next best"],
          rows,
          note: rows.some((r) => r.highlight) ? "Highlighted rows were set in the last 14 days." : undefined,
        },
      ];
    },
    longest: () => {
      const rows = keep([
        d.longest_distance && { label: "Longest distance", value: `${d.longest_distance.km} km · ${shortDate(d.longest_distance.date)}` },
        d.longest_duration && { label: "Longest time", value: `${d.longest_duration.duration} · ${shortDate(d.longest_duration.date)}` },
        d.most_climbing && { label: "Most climbing", value: `${d.most_climbing.meters} m · ${shortDate(d.most_climbing.date)}` },
      ]);
      return rows.length ? [{ type: "kv", title: "Biggest sessions", rows }] : null;
    },
    coverage: () => {
      const c = d.coverage;
      if (!c.activities) return null;
      return [
        {
          type: "text",
          title: "Coverage",
          body: `${c.fit_decoded} of ${c.activities} ${p.sport} activities have a decoded FIT file${c.fit_pending ? `; ${c.fit_pending} still wait for import, so records may improve` : ""}.`,
        },
      ];
    },
  };
  return {
    eyebrow: "personal_records",
    title: `${humanize(p.sport)} records${d.from === "all history" ? "" : ` since ${shortDate(d.from)}`}`,
    aura: "violet",
    blocks: assemble("records", p.sections, builders, p.notes, out),
    notes: out,
  };
}

/* -------------------------------------------------------------------------- */
/* trend                                                                      */
/* -------------------------------------------------------------------------- */

async function trendPreset(ctx: AppContext, p: Extract<Preset, { name: "trend" }>): Promise<BuiltPreset> {
  const { data: t } = await trendData(ctx, { metric: p.metric, days: p.days, end_date: p.end_date, granularity: p.granularity, compare_previous: true });
  const out: string[] = [];
  const unit = t.unit;
  const s = t.summary;
  const sumMetric = METRICS[p.metric]?.combine === "sum";
  const builders: Builders<"trend"> = {
    summary: () => [
      {
        type: "stats",
        // Totals for summed metrics (km, load, hours); a daily minimum of 0 would say nothing.
        items: keep([
          sumMetric && s.total !== undefined && s.total !== null && { value: metricValue(s.total, unit), label: `${unit} total` },
          { value: metricValue(s.mean, unit), label: `${unit} avg${sumMetric ? " / day" : ""}` },
          !sumMetric && { value: metricValue(s.min?.value ?? null, unit), label: s.min ? `min · ${shortDate(s.min.date, false)}` : "min" },
          { value: metricValue(s.max?.value ?? null, unit), label: s.max ? `${sumMetric ? "best day" : "max"} · ${shortDate(s.max.date, false)}` : "max" },
          t.previous_period && { value: signed(num(obj(t.previous_period).change_pct), 1, "%"), label: `vs previous ${t.period.days} d` },
        ]),
      },
    ],
    chart: () =>
      t.series.length > 1
        ? [
            {
              type: "chart",
              title: `${capitalize(t.granularity === "day" ? "daily" : `${t.granularity}ly`)} · ${shortDate(t.period.from, false)} – ${shortDate(t.period.to, false)}`,
              kind: sumMetric ? "columns" : "line",
              series: [{ label: `${t.description} (${unit})`, values: t.series.map((x) => num(obj(x).value)), tone: "blue" }],
              x_labels: t.series.map((x) => shortDate(obj(x).period, false)),
            },
          ]
        : null,
    trend: () => {
      const tr = t.trend;
      if (!tr) return null;
      const fl = tr.first_vs_last;
      return [
        {
          type: "kv",
          title: "Trend",
          rows: keep([
            { label: "Direction", value: `${tr.direction}${tr.judgement ? ` · ${tr.judgement}` : ""}` },
            tr.per_week !== null && { label: "Slope", value: `${signed(tr.per_week, 2)} ${unit} / week` },
            tr.r2 !== null && { label: "Fit (R²)", value: fixed(tr.r2, 2) },
            fl.first_days_avg !== null &&
              fl.last_days_avg !== null && { label: `First → last ${fl.days} days`, value: `${metricValue(fl.first_days_avg, unit)} → ${metricValue(fl.last_days_avg, unit)}` },
            t.previous_period && { label: "Previous period avg", value: metricValue(num(obj(t.previous_period).mean), unit) },
          ]),
        },
      ];
    },
  };
  return {
    eyebrow: "metric_trend",
    title: t.description,
    aura: "azure",
    blocks: assemble("trend", p.sections, builders, p.notes, out),
    notes: out,
  };
}

/* -------------------------------------------------------------------------- */
/* recovery                                                                   */
/* -------------------------------------------------------------------------- */

async function recoveryPreset(ctx: AppContext, p: Extract<Preset, { name: "recovery" }>): Promise<BuiltPreset> {
  const { data } = await recoveryData(ctx, { date: p.date });
  const out: string[] = [];
  const hrv = obj(data.hrv);
  const rhr = obj(data.resting_hr);
  const sleep = obj(data.sleep);
  const night = obj(sleep.last_night);
  const hrvStatus = str(hrv.status_7d) ?? "no data";
  const range = arr(hrv.normal_range_ms).map(num);

  const builders: Builders<"recovery"> = {
    status: () => [
      {
        type: "signals",
        rows: [
          {
            label: "HRV",
            value: hrvStatus === "no data" ? "no data" : `${num(hrv.rolling_7d_ms) ?? "?"} ms · ${hrvStatus}`,
            status: hrvStatus === "no data" ? "neutral" : hrvStatus === "normal" ? "green" : hrvStatus.includes("low") ? (hrvStatus === "low" ? "red" : "amber") : "blue",
          },
          {
            label: "Resting HR",
            value: num(rhr.rolling_7d_bpm) !== null ? `${num(rhr.rolling_7d_bpm)} bpm · ${signed(num(rhr.delta_bpm), 1) ?? "?"}` : "no data",
            status: rhr.status === "elevated" ? "amber" : rhr.status === "normal" ? "green" : "neutral",
          },
          {
            label: "Sleep",
            value: num(sleep.avg_7d_hours) !== null ? `${num(sleep.avg_7d_hours)} h avg · ${signed(num(sleep.delta_hours), 1) ?? "?"} h` : "no data",
            status: sleep.status === "low" ? "amber" : sleep.status === "normal" ? "green" : "neutral",
          },
        ],
      },
    ],
    hrv: () => {
      const rows = keep([
        num(hrv.last_night_ms) !== null && { label: "Last night", value: `${num(hrv.last_night_ms)} ms` },
        num(hrv.rolling_7d_ms) !== null && { label: "7-day average", value: `${num(hrv.rolling_7d_ms)} ms` },
        num(hrv.nights_in_7d) !== null && { label: "Nights with HRV", value: `${num(hrv.nights_in_7d)} of 7${hrv.confidence === "low" ? " · low confidence" : ""}` },
        num(hrv.baseline_ms) !== null && { label: "Baseline", value: `${num(hrv.baseline_ms)} ms` },
        range.length === 2 && range[0] !== null && { label: "Normal range", value: `${range[0]}–${range[1]} ms` },
        num(hrv.trend_30d_ms_per_week) !== null && { label: "30-day trend", value: `${signed(num(hrv.trend_30d_ms_per_week), 2)} ms / week` },
      ]);
      const interpretation = str(hrv.interpretation) ?? undefined;
      if (!rows.length) return interpretation ? [{ type: "text", title: "HRV", width: "half", body: interpretation }] : null;
      return [{ type: "kv", title: "HRV", width: "half", rows, note: interpretation }];
    },
    resting_hr: () => {
      const rows = keep([
        num(rhr.latest_bpm) !== null && { label: `Latest · ${shortDate(rhr.latest_date, false)}`, value: `${num(rhr.latest_bpm)} bpm` },
        num(rhr.rolling_7d_bpm) !== null && { label: "7-day average", value: `${num(rhr.rolling_7d_bpm)} bpm` },
        num(rhr.baseline_bpm) !== null && { label: "Baseline", value: `${num(rhr.baseline_bpm)} bpm` },
        num(rhr.delta_bpm) !== null && { label: "Change", value: `${signed(num(rhr.delta_bpm), 1)} bpm` },
      ]);
      return rows.length ? [{ type: "kv", title: "Resting HR", width: "half", rows }] : null;
    },
    sleep: () => {
      const hours = num(night.hours);
      const rows = keep([
        hours !== null && { label: "Last night", value: `${hoursMinutes(hours * 3600)}${num(night.score) !== null ? ` · score ${num(night.score)}` : ""}` },
        num(sleep.avg_7d_hours) !== null && { label: "7-day average", value: `${num(sleep.avg_7d_hours)} h` },
        num(sleep.baseline_hours) !== null && { label: "Usual", value: `${num(sleep.baseline_hours)} h` },
        num(sleep.avg_7d_score) !== null && { label: "Score, 7 days vs usual", value: `${num(sleep.avg_7d_score)} vs ${num(sleep.baseline_score) ?? "—"}` },
        num(sleep.short_nights_last_7) !== null && { label: "Short nights", value: `${num(sleep.short_nights_last_7)} of 7` },
      ]);
      return rows.length ? [{ type: "kv", title: "Sleep", width: "half", rows }] : null;
    },
  };
  return {
    eyebrow: "recovery_analysis",
    title: `Recovery · ${shortDate(data.date)}`,
    aura: "moss",
    blocks: assemble("recovery", p.sections, builders, p.notes, out),
    notes: out,
  };
}

/* -------------------------------------------------------------------------- */
/* weekly                                                                     */
/* -------------------------------------------------------------------------- */

async function weeklyPreset(ctx: AppContext, p: Extract<Preset, { name: "weekly" }>): Promise<BuiltPreset> {
  const { data } = await weeklyData(ctx, { weeks: p.weeks, end_date: p.end_date });
  const out: string[] = [];
  const weeks = data.weeks.map(obj);
  const training = (w: Obj) => obj(w.training);
  const recovery = (w: Obj) => obj(w.recovery);
  const label = (w: Obj) => shortDate(w.from, false);
  const last = weeks[weeks.length - 1];

  const builders: Builders<"weekly"> = {
    summary: () => {
      if (!last) return null;
      const t = training(last);
      const vs = obj(last.vs_previous_week);
      return [
        {
          type: "stats",
          items: [
            { value: fixed(num(t.hours), 1), label: "hours" },
            { value: fixed(num(t.km), 1), label: "km" },
            { value: num(t.load), label: "load" },
            { value: signed(num(vs.load_pct), 0, "%"), label: "load vs last week" },
          ],
          note: str(last.to)?.includes("partial") ? "This week is not over yet." : undefined,
        },
      ];
    },
    table: () =>
      weeks.length
        ? [
            {
              type: "table",
              columns: ["Week of", "Load", "Hours", "km", "Easy", "Sleep", "RHR"],
              bar_after: 1,
              rows: weeks.map((w, i) => {
                const t = training(w);
                const r = recovery(w);
                const easy = num(obj(t.intensity).easy_z1_z2_pct);
                return {
                  cells: [
                    label(w),
                    num(t.load),
                    fixed(num(t.hours), 1),
                    fixed(num(t.km), 1),
                    easy !== null ? `${easy}%` : null,
                    withUnit(num(r.sleep_hours), "h"),
                    num(r.resting_hr) !== null ? fixed(num(r.resting_hr), 0) : null,
                  ],
                  bar: num(t.load),
                  highlight: i === weeks.length - 1,
                };
              }),
            },
          ]
        : null,
    chart: () =>
      weeks.length > 1
        ? [{ type: "chart", title: "Weekly load", kind: "columns", series: [{ label: "Load", values: weeks.map((w) => num(training(w).load)), tone: "violet" }], x_labels: weeks.map(label) }]
        : null,
  };
  return {
    eyebrow: "weekly_report",
    title: `Last ${weeks.length} week${weeks.length === 1 ? "" : "s"}`,
    aura: "graphite",
    blocks: assemble("weekly", p.sections, builders, p.notes, out),
    notes: out,
  };
}
