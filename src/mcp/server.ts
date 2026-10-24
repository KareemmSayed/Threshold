/**
 * Stateless Streamable HTTP MCP endpoint: a fresh server and transport per
 * request, JSON responses, no sessions. Nothing has to survive between calls,
 * which suits Workers and every MCP client that speaks Streamable HTTP.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getMeta } from "../archive/store";
import { ensureSchema } from "../archive/schema";
import type { ProfileFacts } from "../context";
import { REPO_URL, SERVER_NAME, SERVER_VERSION, type Env } from "../env";
import type { GarminClientOptions } from "../garmin/client";
import { isValidTimeZone, todayIn } from "../util/dates";
import { registerView } from "../view/tool";
import { registerPrompts } from "./prompts";
import { registerTools } from "./tools";

async function instructions(env: Env): Promise<string> {
  let tz = env.TIMEZONE?.trim();
  if (!tz || !isValidTimeZone(tz)) {
    await ensureSchema(env.DB).catch(() => {});
    const profile = await getMeta<{ facts: ProfileFacts }>(env.DB, "profile").catch(() => null);
    tz = profile?.facts.timeZone && isValidTimeZone(profile.facts.timeZone) ? profile.facts.timeZone : "UTC";
  }
  return [
    `Threshold serves the user's own Garmin data and analysis of it. Today is ${todayIn(tz)} in the athlete's time zone (${tz}); date arguments also accept 'today' and 'yesterday'.`,
    "Pick the analysis tools first: daily_briefing (readiness today), recovery_analysis (HRV, resting HR, sleep vs baseline), training_load (CTL/ATL/TSB, ACWR), weekly_report, metric_trend (any metric over time), analyze_activity (one workout from its FIT file), personal_records (best efforts).",
    "Use list_activities to find activity ids, get_health_data / get_day_detail for Garmin's raw records, and query_archive for custom SQL over the archive.",
    "To show results visually, call show_view after the analysis tool: the matching preset with only the sections the user asked about, or custom blocks for anything else. Answer a single number in text without a card.",
    "The server computes every number. Quote and explain them; do not recompute. Missing data is null, never zero. This is training guidance from wearable data, not medical advice.",
  ].join("\n");
}

/** `origin` is the public origin, for show_view's private links. */
export function buildServer(env: Env, instructionsText: string | undefined, origin: string, garminOptions?: GarminClientOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "Threshold: Garmin data, analyzed", version: SERVER_VERSION, websiteUrl: REPO_URL },
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: instructionsText },
  );
  registerTools(server, { env, garminOptions });
  registerView(server, { env, garminOptions }, origin);
  registerPrompts(server);
  return server;
}

async function isInitialize(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body = (await request.clone().json()) as { method?: string } | Array<{ method?: string }>;
    return Array.isArray(body) ? body.some((m) => m?.method === "initialize") : body?.method === "initialize";
  } catch {
    return false;
  }
}

export async function handleMcp(request: Request, env: Env, garminOptions?: GarminClientOptions): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // Stateless server: no standalone SSE stream and no sessions to end.
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. POST JSON-RPC messages to this endpoint." }, id: null }), {
      status: 405,
      headers: { Allow: "POST, OPTIONS", "Content-Type": "application/json" },
    });
  }
  const text = (await isInitialize(request)) ? await instructions(env) : undefined;
  const origin = env.PUBLIC_URL?.trim() ? new URL(env.PUBLIC_URL.trim()).origin : new URL(request.url).origin;
  const server = buildServer(env, text, origin, garminOptions);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}
