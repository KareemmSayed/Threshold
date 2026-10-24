/**
 * The view spec: what show_view renders. A view is a card (aura, eyebrow, title) holding
 * blocks. Every block maps to one piece of the website's design, so any model that fills
 * these fields gets the same look. The renderer (client/view.js) inserts every string as
 * text, never as markup.
 */
import { z } from "zod";

export const AURAS = ["flame", "violet", "moss", "azure", "ember", "graphite"] as const;
export type Aura = (typeof AURAS)[number];

/** Accent colours from the site's palette: the effort ramp (blue → hot) plus the signal colours. */
export const TONES = ["ink", "hot", "blue", "indigo", "violet", "pink", "green", "amber", "red", "muted"] as const;
export const STATUSES = ["green", "amber", "red", "blue", "neutral"] as const;

// Field meanings shared by every block are explained once, in show_view's description, to keep the schema small.
const value = z.union([z.string().max(60), z.number()]).nullable();

const base = {
  title: z.string().max(80).optional(),
  note: z.string().max(600).optional(),
  width: z.enum(["full", "half"]).optional(),
};

const stats = z.object({
  type: z.literal("stats"),
  items: z
    .array(z.object({ value, label: z.string().max(40).describe("Caption under the number, e.g. 'km', '/km', 'VO2 max'") }))
    .min(1)
    .max(6),
  ...base,
});

const headline = z.object({
  type: z.literal("headline"),
  value: z.string().max(24).describe("e.g. 'PB −33 s.'"),
  text: z.string().max(240).optional(),
  tone: z.enum(TONES).optional(),
  ...base,
});

const hero = z.object({
  type: z.literal("hero"),
  value,
  unit: z.string().max(40).optional(),
  ...base,
});

const bars = z.object({
  type: z.literal("bars"),
  rows: z
    .array(
      z.object({
        label: z.string().max(24),
        value,
        amount: z.number().nullable().describe("Sets the bar length, e.g. seconds per km"),
        highlight: z.boolean().optional(),
        tone: z.enum(TONES).optional(),
      }),
    )
    .min(1)
    .max(60),
  baseline: z.enum(["zero", "min"]).optional().describe("'min' stretches small differences, for paces"),
  ...base,
});

const kv = z.object({
  type: z.literal("kv"),
  rows: z
    .array(z.object({ label: z.string().max(60), value }))
    .min(1)
    .max(20),
  ...base,
});

const signals = z.object({
  type: z.literal("signals"),
  rows: z
    .array(
      z.object({
        label: z.string().max(40),
        value: z.string().max(60),
        status: z.enum(STATUSES),
      }),
    )
    .min(1)
    .max(12),
  ...base,
});

const table = z.object({
  type: z.literal("table"),
  columns: z.array(z.string().max(30)).min(1).max(8),
  rows: z
    .array(
      z.object({
        cells: z.array(value).max(8),
        highlight: z.boolean().optional(),
        bar: z.number().nullable().optional(),
      }),
    )
    .min(1)
    .max(60),
  bar_after: z.number().int().min(0).max(7).optional(),
  bar_longer: z.enum(["higher", "lower"]).optional(),
  strong_column: z.number().int().min(-1).max(7).optional(),
  ...base,
});

const chart = z.object({
  type: z.literal("chart"),
  kind: z.enum(["line", "columns"]).optional(),
  series: z
    .array(
      z.object({
        label: z.string().max(40),
        values: z.array(z.number().nullable()).min(1).max(400),
        tone: z.enum(TONES).optional(),
      }),
    )
    .min(1)
    .max(4),
  x_labels: z.array(z.string().max(16)).max(400).optional(),
  fill_between: z.boolean().optional(),
  ...base,
});

const list = z.object({
  type: z.literal("list"),
  items: z.array(z.string().max(300)).min(1).max(12),
  style: z.enum(["plain", "next"]).optional(),
  ...base,
});

const text = z.object({
  type: z.literal("text"),
  body: z.string().max(1200),
  ...base,
});

const sql = z.object({
  type: z.literal("sql"),
  sql: z.string().max(4000),
  ...base,
});

export const blockSchema = z.discriminatedUnion("type", [stats, headline, hero, bars, kv, signals, table, chart, list, text, sql]);
export type Block = z.infer<typeof blockSchema>;

export interface ViewLink {
  url: string;
  expires_at: string;
}

/** What the renderer receives: tool structuredContent, and the JSON stored for the private link. */
export interface ViewSpec {
  version: 1;
  eyebrow?: string;
  title?: string;
  aura: Aura;
  blocks: Block[];
  /** Footer text, e.g. who computed the numbers. */
  source?: string;
  link?: ViewLink;
}
