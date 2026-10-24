/**
 * show_view: results as a card in the website's design. Hosts that support MCP Apps render
 * the ui:// resource inline and pass it the tool result; every other client gets a private
 * link to the same card, served by this Worker.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createContext } from "../context";
import { fail, UserError } from "../mcp/format";
import type { ToolDeps } from "../mcp/tools";
import { appDocument, FONT_ORIGINS } from "./html";
import { buildPreset, presetSchema, shortDate, type Preset } from "./presets";
import { AURAS, blockSchema, type Aura, type Block, type ViewSpec } from "./spec";
import { saveView } from "./store";

export const VIEW_URI = "ui://threshold/view.html";
/** MCP Apps (io.modelcontextprotocol/ui, spec 2026-01-26). */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const UI_META = { csp: { resourceDomains: FONT_ORIGINS }, prefersBorder: false };

const DESCRIPTION = `Show results as a visual card in Threshold's design. Apps that support MCP Apps (Claude, ChatGPT, VS Code, Goose) display it in the chat; every other client gets a private link to the same card.
When: after an analysis tool, if the answer has several numbers or the user asks to see, visualize, compare or get a report. For one number or a yes/no, answer in text and do not call this.
Fill it in one of two ways (or both):
1. preset: the server builds the card from its own analysis, so every number is exact. Pick the preset for the analysis you ran (activity = analyze_activity, readiness = daily_briefing, training_load, records = personal_records, trend = metric_trend, recovery = recovery_analysis, weekly = weekly_report). List only the sections the user asked about. Add notes: one short sentence of interpretation per section.
2. blocks: for anything no preset covers (comparisons, mixed questions, query_archive results). Copy every number exactly from tool results, with its unit. Types: stats (2-4 big numbers), headline (short dot-matrix phrase plus a sentence), hero (one big number), bars (labelled bars, e.g. splits), kv (label/value rows), signals (status dots), table, chart (line or columns), list, text, sql.
Block fields: every block takes optional title (small heading), note (1-2 plain sentences under it) and width ("half" blocks pair up side by side; default full for stats, headline, table, chart, signals and next lists, half otherwise). Values are text with units ("189 bpm", "3:28") or numbers; null shows a dash. bars: amount sets the length, highlight paints a bar hot, baseline "min" stretches small differences (paces). signals: status green good, amber caution, red warning, blue info. table: one cell per column; optional per-row bar, bar_after (column index, default 1), bar_longer "lower" when smaller is better, strong_column (default 1), highlight a row. chart: kind line (series over time) or columns (one value per bucket), x_labels one per value, fill_between shades the first two lines. list: style "next" is the highlighted advice box.
Preset fields: activity takes activity_id or sport (default: latest activity); notes are keyed by section name, e.g. {"pacing": "You started too fast."}, and should interpret, not repeat, the numbers.
next_steps adds a "What to do next" box. Never put GPS coordinates, place names or activity names on the card unless the user asked. After calling, reply in 2-4 sentences: do not repeat the card as a table, and never write HTML yourself.`;

const inputSchema = {
  preset: presetSchema.optional().describe("Build the card from one analysis, with only the requested sections"),
  blocks: z.array(blockSchema).max(24).optional().describe("Custom blocks, shown after the preset's"),
  next_steps: z.array(z.string().max(300)).min(1).max(5).optional().describe("Advice for the 'What to do next' box"),
  title: z.string().max(120).optional().describe("Card title. Default: from the preset"),
  eyebrow: z.string().max(40).optional().describe("Small label above the title, e.g. the tool used"),
  aura: z
    .enum(AURAS)
    .optional()
    .describe("Card glow: flame (a workout, load), violet (records, comparisons), moss (readiness, recovery), azure (trends, SQL), ember (warnings), graphite (neutral)"),
};

interface ViewArgs {
  preset?: Preset;
  blocks?: Block[];
  next_steps?: string[];
  title?: string;
  eyebrow?: string;
  aura?: Aura;
}

const sectionName = (b: Block) => b.title ?? b.type;

export function registerView(server: McpServer, deps: ToolDeps, origin: string): void {
  server.registerResource(
    "threshold_view",
    VIEW_URI,
    { title: "Threshold view", description: "The card show_view renders.", mimeType: RESOURCE_MIME_TYPE, _meta: { ui: UI_META } },
    async () => ({ contents: [{ uri: VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: appDocument(), _meta: { ui: UI_META } }] }),
  );

  server.registerTool(
    "show_view",
    {
      title: "Show view",
      description: DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: VIEW_URI }, "ui/resourceUri": VIEW_URI },
    },
    async (args: ViewArgs): Promise<CallToolResult> => {
      try {
        if (!args.preset && !args.blocks?.length) throw new UserError("Pass a preset, blocks, or both.");
        const ctx = await createContext(deps.env, { mode: "tool", ...deps.garminOptions });
        const built = args.preset ? await buildPreset(ctx, args.preset) : null;
        const blocks: Block[] = [...(built?.blocks ?? []), ...(args.blocks ?? [])];
        if (args.next_steps?.length) blocks.push({ type: "list", style: "next", title: "What to do next", items: args.next_steps });
        if (!blocks.length) throw new UserError(`Nothing to show: ${built?.notes.join(" ") || "no data for those sections."}`);

        const spec: ViewSpec = {
          version: 1,
          eyebrow: args.eyebrow ?? built?.eyebrow,
          title: args.title ?? built?.title,
          aura: args.aura ?? built?.aura ?? "graphite",
          blocks,
          source: `${built ? "Computed by Threshold from your Garmin data" : "Threshold"} · ${shortDate(ctx.today)}`,
        };
        const link = await saveView(deps.env, origin, spec, ctx.now).catch((err) => {
          console.error("show_view: could not store the link", err instanceof Error ? err.message : err);
          return null;
        });
        if (link) spec.link = link;

        const notes = [...new Set([...ctx.notes, ...(built?.notes ?? [])])];
        const summary = {
          shown: `Card "${spec.title ?? spec.eyebrow ?? "Threshold"}" with ${blocks.map(sectionName).join(", ")}.`,
          link: link?.url ?? null,
          link_expires: link?.expires_at ?? null,
          how_to_reply: link
            ? "The card is shown in apps that support MCP Apps. If the user cannot see it (for example in a terminal), give them the link: it is private and expires. Do not rebuild the card as text or HTML."
            : "The card is shown in apps that support MCP Apps. Private links are turned off (VIEW_LINK_HOURS=0).",
          view: { title: spec.title, blocks },
          notes: notes.length ? notes : undefined,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary) }], structuredContent: spec as unknown as Record<string, unknown> };
      } catch (err) {
        return fail(err);
      }
    },
  );
}
