import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { ensureSchema, MIGRATIONS } from "../../src/archive/schema";
import { FIT_ANALYSIS_VERSION, FIT_PENDING } from "../../src/archive/sync";
import { createContext, detectDeviceChange } from "../../src/context";
import { effortRecords, effortsWithHistory } from "../../src/mcp/tools";
import { addDays, todayIn } from "../../src/util/dates";
import { createMockGarmin, intervalSessionId, strengthSessionId, type MockGarmin, type MockOptions } from "../helpers/mock-garmin";

const ORIGIN = "https://threshold.example.workers.dev";
const ACCESS_KEY = "test-access-key-0123456789";
const today = () => todayIn("Europe/Berlin");
const realFetch = globalThis.fetch;
let garmin: MockGarmin;

function useGarmin(opts: MockOptions = {}) {
  garmin = createMockGarmin({ historyStart: addDays(today(), -150), ...opts });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith("https://garmin.mock") ? garmin.fetch(input, init) : realFetch(input, init);
  });
}

async function call(path: string, init: RequestInit = {}, workerEnv: typeof env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let rpcId = 0;
async function rpc(method: string, params: unknown = {}, token = ACCESS_KEY, workerEnv: typeof env = env) {
  const res = await call(
    "/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    },
    workerEnv,
  );
  return { status: res.status, body: (await res.json()) as { result?: any; error?: any } };
}

async function tool(name: string, args: Record<string, unknown> = {}, workerEnv: typeof env = env) {
  const { body } = await rpc("tools/call", { name, arguments: args }, ACCESS_KEY, workerEnv);
  const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
  const text = result.content[0].text;
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: Boolean(result.isError), data, text };
}

beforeAll(async () => {
  await ensureSchema(env.DB);
});
beforeEach(() => useGarmin());
afterEach(() => vi.restoreAllMocks());

describe("public pages", () => {
  it("serves a landing page and health check", async () => {
    const home = await call("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain(`${ORIGIN}/mcp`);
    expect(await (await call("/health")).json()).toMatchObject({ ok: true });
    expect((await call("/nope")).status).toBe(404);
  });

  it("guides the owner through missing keys", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/`), { ...env, GARMIN_API_KEY: "", ACCESS_KEY: "" }, ctx);
    const html = await res.text();
    expect(html).toContain("Almost ready");
    expect(html).toContain("GARMIN_API_KEY");
    expect(html).toContain("Variables and secrets");
    const suggestion = html.match(/class="pick">([A-Za-z0-9]{32})</)?.[1];
    expect(suggestion).toHaveLength(32);
    const ready = await (await call("/")).text();
    expect(ready).toContain("Ready");
    expect(ready).not.toContain("Almost ready");
  });

  it("publishes OAuth discovery metadata", async () => {
    const resource = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(resource.resource).toBe(`${ORIGIN}/mcp`);
    expect(resource.authorization_servers).toEqual([ORIGIN]);
    const as = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(as.code_challenge_methods_supported).toContain("S256");
    expect(as.client_id_metadata_document_supported).toBe(true);
  });

  it("challenges unauthenticated and wrong-key MCP requests", async () => {
    const res = await call("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    expect((await rpc("tools/list", {}, "wrong-key-wrong-key-wrong")).status).toBe(401);
  });
});

describe("MCP over a bearer access key", () => {
  it("initializes with today's date in the instructions", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(body.result.serverInfo.name).toBe("threshold");
    expect(body.result.instructions).toContain(`Today is ${today()}`);
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.capabilities.prompts).toBeDefined();
  });

  it("lists every tool with read-only hints", async () => {
    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      [
        "analyze_activity",
        "compare_workouts",
        "correlate",
        "daily_briefing",
        "garmin_api_get",
        "get_activity",
        "get_day_detail",
        "get_health_data",
        "get_profile",
        "list_activities",
        "load_forecast",
        "metric_trend",
        "personal_records",
        "query_archive",
        "race_calendar",
        "race_predictor",
        "recovery_analysis",
        "server_status",
        "show_view",
        "sync_now",
        "training_load",
        "training_status",
        "weekly_report",
      ].sort(),
    );
    // Everything reads only, except the two tools that write to this server's own archive.
    const writers = body.result.tools.filter((t: { annotations?: { readOnlyHint?: boolean } }) => !t.annotations?.readOnlyHint).map((t: { name: string }) => t.name);
    expect(writers.sort()).toEqual(["race_calendar", "sync_now"]);
    const prompts = await rpc("prompts/list");
    expect(prompts.body.result.prompts.map((p: { name: string }) => p.name).sort()).toEqual(["analyze_last_workout", "morning_check_in", "race_readiness", "weekly_review", "workout_progress"]);
  });

  it("builds a daily briefing from Garmin data, exchanging the key once", async () => {
    const { isError, data } = await tool("daily_briefing");
    expect(isError).toBe(false);
    expect(["green", "amber", "red"]).toContain(data.overall.status);
    expect(data.signals.map((s: { signal: string }) => s.signal)).toEqual(expect.arrayContaining(["HRV", "Resting HR", "Sleep"]));
    expect(data.training.last_activity.id).toBeGreaterThan(0);
    expect(garmin.tokenExchanges).toBe(1);
    // A second call is served from the archive: recent days only.
    const before = garmin.calls.length;
    await tool("daily_briefing");
    expect(garmin.calls.length - before).toBeLessThan(6);
  });

  it("answers the analysis tools", async () => {
    const load = await tool("training_load", { days: 42 });
    expect(load.isError).toBe(false);
    expect(load.data.current.fitness_ctl).toBeGreaterThan(0);
    expect(load.data.load_sources.garmin).toBeGreaterThan(0);

    const recovery = await tool("recovery_analysis", { date: "yesterday" });
    expect(recovery.data.hrv.baseline_ms).toBeGreaterThan(0);
    expect(recovery.data.hrv.nights_in_7d).toBe(7);
    expect(recovery.data.hrv.baseline_from).toBeUndefined(); // the formatter drops null fields
    expect(recovery.data.date).toBe(addDays(today(), -1));

    const weekly = await tool("weekly_report", { weeks: 3 });
    expect(weekly.data.weeks).toHaveLength(3);

    const trend = await tool("metric_trend", { metric: "hrv", days: 30 });
    expect(trend.data.period.days_with_data).toBeGreaterThan(20);
    expect(trend.data.previous_period).toBeDefined();

    const runningKm = await tool("metric_trend", { metric: "running_km", days: 28, granularity: "week" });
    expect(runningKm.data.summary.total).toBeGreaterThan(0);
  });

  it("restarts the HRV baseline from HRV_BASELINE_FROM", async () => {
    const from = addDays(today(), -3);
    const withReset = Object.assign(Object.create(env), { HRV_BASELINE_FROM: from }) as typeof env;
    const reset = await tool("recovery_analysis", { date: "yesterday" }, withReset);
    expect(reset.data.hrv.baseline_from).toBe(from);
    expect(reset.data.hrv.baseline_ms).toBeUndefined();
    expect(reset.data.hrv.status_7d).toBe("no data");
    const briefing = await tool("daily_briefing", {}, withReset);
    expect(briefing.data.signals.map((s: { signal: string }) => s.signal)).not.toContain("HRV");
    const bad = Object.assign(Object.create(env), { HRV_BASELINE_FROM: "soon" }) as typeof env;
    const ignored = await tool("recovery_analysis", { date: "yesterday" }, bad);
    expect(ignored.data.hrv.baseline_ms).toBeGreaterThan(0);
    expect(JSON.stringify(ignored.data)).toMatch(/HRV_BASELINE_FROM is not a valid/);
  });

  it("lists and deeply analyzes activities, decoding the FIT file", async () => {
    const list = await tool("list_activities", { sport: "running", limit: 5 });
    expect(list.data.activities.length).toBeGreaterThan(0);
    expect(list.data.activities[0].pace).toMatch(/\/km$/);
    const id = list.data.activities[0].id;

    const first = await tool("analyze_activity", { activity_id: id });
    expect(first.isError).toBe(false);
    expect(first.data.analysis.hidden.vo2max).toBe(52.3);
    expect(first.data.analysis.best_efforts.distance["1k"].time).toBe("4:10");
    expect(first.data.source).toBe("FIT file");

    const again = await tool("analyze_activity", { activity_id: id });
    expect(again.data.source).toBe("archive (decoded FIT file)");

    const samples = await tool("analyze_activity", { activity_id: id, samples: 20 });
    expect(samples.data.analysis.samples.length).toBeLessThanOrEqual(20);
    expect(samples.data.analysis.samples[0].lat).toBeUndefined();

    const latest = await tool("analyze_activity", { sport: "cycling" });
    expect(latest.data.analysis.best_efforts.power_w["5s"]).toBe(350);
  });

  it("keeps personal records from decoded files", async () => {
    const pr = await tool("personal_records", { sport: "running", import_missing: true });
    expect(pr.isError).toBe(false);
    expect(pr.data.coverage.fit_decoded).toBeGreaterThan(0);
    expect(pr.data.best_efforts["1k"][0].time).toBe("4:10");
  });

  it("runs read-only SQL and refuses writes", async () => {
    await tool("sync_now", { days: 14, include_fit: false });
    const q = await tool("query_archive", { sql: "SELECT COUNT(*) AS n, AVG(resting_hr) AS rhr FROM daily WHERE resting_hr IS NOT NULL" });
    expect(q.data.columns).toEqual(["n", "rhr"]);
    expect(q.data.rows[0][0]).toBeGreaterThan(10);
    const del = await tool("query_archive", { sql: "DELETE FROM daily" });
    expect(del.isError).toBe(true);
    expect(del.text).toMatch(/read-only/);
    const meta = await tool("query_archive", { sql: "select * from meta" });
    expect(meta.isError).toBe(true);
  });

  it("returns Garmin's raw records compacted", async () => {
    const stress = await tool("get_health_data", { dataset: "stress", start_date: addDays(today(), -9), end_date: today() });
    expect(stress.data.days).toHaveLength(10); // two windows, Garmin allows 7 days
    const hr = await tool("get_day_detail", { kind: "heart_rate", date: "today" });
    expect(hr.data.detail.heartRateValues).toEqual({ omittedSamples: 300 });
    const act = await tool("get_activity", { activity_id: 1 });
    expect(act.data.activity.locationName).toBeUndefined();
    expect(act.data.activity.summaryDTO.startLatitude).toBeUndefined();
    const raw = await tool("garmin_api_get", { path: "/userprofile-service/userprofile/settings" });
    expect(raw.data.response.displayName).toBeUndefined();
    const profile = await tool("get_profile");
    expect(profile.data.facts).toMatchObject({ unit: "km", vo2maxRunning: 52, maxHr: 190 });
  });

  it("rejects bad input with readable errors", async () => {
    const future = await tool("daily_briefing", { date: addDays(today(), 3) });
    expect(future.isError).toBe(true);
    expect(future.text).toMatch(/in the future/);
    const long = await tool("get_health_data", { dataset: "sleep", start_date: "2020-01-01", end_date: today() });
    expect(long.isError).toBe(true);
    const bad = await tool("garmin_api_get", { path: "https://evil.example/x" });
    expect(bad.isError).toBe(true);
  });

  it("reports status and health checks", async () => {
    await tool("sync_now", { days: 3, include_fit: false });
    const s = await tool("server_status");
    expect(s.data.checks.find((c: { check: string }) => c.check === "Garmin connection").ok).toBe(true);
    expect(s.data.archive.daily.length).toBeGreaterThan(0);
    expect(s.data.time_zone).toBe("Europe/Berlin");
  });
});

async function view(args: Record<string, unknown>, e: typeof env = env) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${ACCESS_KEY}`, "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "show_view", arguments: args } }),
    }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const result = ((await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: any } }).result;
  let summary: any;
  try {
    summary = JSON.parse(result.content[0].text);
  } catch {
    summary = result.content[0].text;
  }
  return { isError: Boolean(result.isError), spec: result.structuredContent, summary };
}

const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

describe("show_view (MCP Apps and private links)", () => {
  it("declares the ui:// resource on the tool and serves it as an MCP App", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body.result.capabilities.resources).toBeDefined();
    expect(init.body.result.instructions).toContain("show_view");

    const { body } = await rpc("tools/list");
    const tool = body.result.tools.find((t: { name: string }) => t.name === "show_view");
    expect(tool._meta.ui.resourceUri).toBe("ui://threshold/view.html");
    expect(tool._meta["ui/resourceUri"]).toBe("ui://threshold/view.html");

    const listed = await rpc("resources/list");
    expect(listed.body.result.resources.map((r: { uri: string }) => r.uri)).toContain("ui://threshold/view.html");
    const read = await rpc("resources/read", { uri: "ui://threshold/view.html" });
    const content = read.body.result.contents[0];
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content._meta.ui.csp.resourceDomains).toEqual(["https://fonts.googleapis.com", "https://fonts.gstatic.com"]);
    expect(content.text).toContain('id="root"');
    expect(content.text).toContain("ui/initialize");
  });

  it("builds an activity card from the server's own analysis, with only the requested sections", async () => {
    const analyzed = await tool("analyze_activity", { sport: "running" });
    const { isError, spec, summary } = await view({
      preset: { name: "activity", sport: "running", sections: ["summary", "pacing", "heart_rate"], notes: { pacing: "Even splits throughout." } },
      next_steps: ["Run easy tomorrow."],
    });
    expect(isError).toBe(false);
    expect(spec.eyebrow).toBe("analyze_activity");
    expect(spec.aura).toBe("flame");
    expect(spec.blocks.map((b: { type: string; title?: string }) => b.title ?? b.type)).toEqual(["stats", "Pacing", "Heart rate", "What to do next"]);
    expect(spec.blocks[0].items[0].value).toBe(String(analyzed.data.analysis.summary.distance_km));
    expect(spec.blocks[1].note).toBe("Even splits throughout.");
    const n = analyzed.data.analysis.splits.rows.length;
    expect(spec.blocks[1].rows.length).toBe(Math.ceil(n / Math.ceil(n / 12)));
    expect(spec.blocks[3]).toMatchObject({ type: "list", style: "next", items: ["Run easy tomorrow."] });
    // No activity names or coordinates on the card: they often name places.
    expect(JSON.stringify(spec)).not.toContain("Morning Run");
    expect(JSON.stringify(spec)).not.toMatch(/latitude|longitude|"lat"/i);
    expect(summary.view.blocks).toHaveLength(4);
    expect(spec.link.url).toMatch(new RegExp(`^${ORIGIN}/v/[A-Za-z0-9_-]{32}$`));
    expect(summary.link).toBe(spec.link.url);
  });

  it("builds every preset", async () => {
    const presets = [
      { name: "readiness", sections: ["verdict", "signals", "training", "sleep"] },
      { name: "training_load", days: 42, sections: ["summary", "chart", "form", "weekly", "by_sport"] },
      { name: "records", sport: "running" },
      { name: "trend", metric: "resting_hr", days: 30, sections: ["summary", "chart", "trend"] },
      { name: "recovery" },
      { name: "weekly", weeks: 3, sections: ["summary", "table", "chart"] },
    ];
    await tool("personal_records", { sport: "running", import_missing: true });
    for (const preset of presets) {
      const { isError, spec, summary } = await view({ preset });
      expect(isError, `${preset.name}: ${JSON.stringify(summary)}`).toBe(false);
      expect(spec.blocks.length, preset.name).toBeGreaterThan(0);
    }
    const load = await view({ preset: { name: "training_load", days: 42, sections: ["chart"] } });
    expect(load.spec.blocks[0].series[0].values).toHaveLength(42);
    const brief = await view({ preset: { name: "readiness", sections: ["signals"] } });
    expect(brief.spec.blocks[0].rows.every((r: { value: string }) => r.value.length < 40)).toBe(true);
  });

  it("renders custom blocks, and rejects malformed ones", async () => {
    const custom = await view({
      title: "Every 5K",
      aura: "violet",
      blocks: [
        { type: "headline", value: "PB -33 s.", text: "Today is your best 5K." },
        { type: "table", columns: ["Date", "Time", "Pace"], rows: [{ cells: ["10 May 2024", "18:20", "3:40"], bar: 1100 }, { cells: ["23 Oct 2026", "17:21", "3:28"], bar: 1041, highlight: true }], bar_longer: "lower" },
      ],
    });
    expect(custom.isError).toBe(false);
    expect(custom.spec).toMatchObject({ title: "Every 5K", aura: "violet" });
    expect(custom.spec.blocks).toHaveLength(2);

    expect((await view({})).isError).toBe(true);
    expect((await view({ blocks: [{ type: "marquee", text: "hi" }] })).isError).toBe(true);
    expect((await view({ blocks: [{ type: "stats", items: [] }] })).isError).toBe(true);
  });

  it("serves the private link page, escaped and locked down", async () => {
    const { spec } = await view({ title: "Escaping", blocks: [{ type: "text", body: "</script><script>alert(1)</script>" }] });
    const page = await call(`/v/${tokenOf(spec.link.url)}`);
    expect(page.status).toBe(200);
    const csp = page.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers.get("X-Robots-Tag")).toContain("noindex");
    const html = await page.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('id="threshold-view-data"');
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");

    expect((await call("/v/not-a-token")).status).toBe(404);
    expect((await call(`/v/${"A".repeat(32)}`)).status).toBe(404);
  });

  it("retires links when they expire or the access key changes, and can turn them off", async () => {
    const first = await view({ blocks: [{ type: "text", body: "one" }] });
    const token = tokenOf(first.spec.link.url);
    const rotated = { ...env, ACCESS_KEY: "a-brand-new-access-key-987654" };
    const ctx = createExecutionContext();
    expect((await worker.fetch(new Request(`${ORIGIN}/v/${token}`), rotated, ctx)).status).toBe(404);
    expect((await call(`/v/${token}`)).status).toBe(200);

    await env.DB.prepare(`UPDATE views SET expires_at = ?`).bind(Date.now() - 1000).run();
    expect((await call(`/v/${token}`)).status).toBe(404);

    const off = await view({ blocks: [{ type: "text", body: "no link" }] }, { ...env, VIEW_LINK_HOURS: "0" });
    expect(off.isError).toBe(false);
    expect(off.spec.link).toBeUndefined();
    expect(off.summary.link).toBeNull();
  });
});

describe("Garmin failures", () => {
  it("explains an expired or revoked key", async () => {
    useGarmin({ badKey: true });
    const r = await tool("get_profile", { refresh: true });
    // The profile tool falls back to defaults; the status tool names the problem.
    expect(r.isError).toBe(false);
    const s = await tool("server_status");
    const check = s.data.checks.find((c: { check: string }) => c.check === "Garmin connection");
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/personalApiToken/);
  });

  it("surfaces rate limiting instead of failing silently", async () => {
    useGarmin({ rateLimited: true });
    const r = await tool("get_day_detail", { kind: "sleep" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rate limiting/);
  });
});

describe("OAuth for Claude and ChatGPT", () => {
  async function pkce() {
    const verifier = "v".repeat(20) + crypto.randomUUID() + crypto.randomUUID();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { verifier, challenge };
  }

  it("registers a client, asks for the access key, and issues working tokens", async () => {
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const reg = await call("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude <script>", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = await pkce();
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "garmin:read", resource: `${ORIGIN}/mcp` });

    const page = await call(`/authorize?${query}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("claude.ai");
    expect(html).not.toContain("<script>");
    const handle = html.match(/name="handle" value="([^"]+)"/)![1];
    const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    const post = (key: string) =>
      call(`/authorize?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
        body: new URLSearchParams({ handle, decision: "approve", access_key: key, client_name: "Claude", redirect_host: "claude.ai" }),
        redirect: "manual",
      });
    const wrong = await post("not-the-key");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("not right");

    const approved = await post(ACCESS_KEY);
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(redirect);
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code")!;

    const tokenRes = await call("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.scope).toContain("garmin:read");

    const list = await rpc("tools/list", {}, tokens.access_token);
    expect(list.status).toBe(200);
    expect(list.body.result.tools.length).toBe(23);

    // Rotating the access key revokes every OAuth token issued before.
    const rotated = { ...env, ACCESS_KEY: "a-brand-new-access-key-987654" };
    const ctx = createExecutionContext();
    const afterRotation = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tokens.access_token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      rotated,
      ctx,
    );
    expect(afterRotation.status).toBe(401);

    const refreshed = await call("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }),
    });
    expect(refreshed.status).toBe(200);
  });

  it("lets the owner deny", async () => {
    const redirect = "http://localhost:6274/callback";
    const reg = await call("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Inspector", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    });
    const client = (await reg.json()) as { client_id: string };
    const { challenge } = await pkce();
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
    const page = await call(`/authorize?${query}`);
    const html = await page.text();
    expect(html).toContain("app on this computer");
    const handle = html.match(/name="handle" value="([^"]+)"/)![1];
    const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const denied = await call(`/authorize?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ handle, decision: "deny" }),
      redirect: "manual",
    });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });
});

describe("background sync", () => {
  it("refreshes recent days, then walks back through history", async () => {
    const run = async () => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ cron: "*/10 * * * *" }), env, ctx);
      await waitOnExecutionContext(ctx);
    };
    for (let i = 0; i < 12; i++) await run();
    const last = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'last_cron'`).first<{ value: string }>();
    const report = JSON.parse(last!.value);
    expect(report.error).toBeUndefined();
    expect(report.requests).toBeLessThanOrEqual(12);
    const backfill = JSON.parse((await env.DB.prepare(`SELECT value FROM meta WHERE key = 'backfill'`).first<{ value: string }>())!.value);
    expect(backfill.activityCursor).toBeDefined();
    expect(backfill.dailyCursor < addDays(today(), -100)).toBe(true);
    const fit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM activities WHERE fit_status = 'done'`).first<{ n: number }>();
    expect(fit!.n).toBeGreaterThan(0);
  });

  it("backs off when Garmin rate limits", async () => {
    useGarmin({ rateLimited: true });
    // No FIT files pending and recent days due: the range sync itself must notice the rate limit.
    await env.DB.prepare(`UPDATE activities SET fit_status = 'done', fit_version = ?`).bind(FIT_ANALYSIS_VERSION).run();
    await env.DB.prepare(`DELETE FROM meta WHERE key = 'last_incremental_at'`).run();
    await env.DB.prepare(`DELETE FROM raw_daily WHERE date >= ?`).bind(addDays(today(), -2)).run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/10 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const backoff = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'backoff_until'`).first<{ value: string }>();
    expect(Number(backoff!.value)).toBeGreaterThan(Date.now());
    // While backing off, the next run makes no Garmin calls at all.
    const before = garmin.calls.length;
    const ctx2 = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/10 * * * *" }), env, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(garmin.calls.length).toBe(before);
  });
});

describe("archive repairs", () => {
  it("queues activities with impossible efforts for a fresh decode", async () => {
    const [glitched, sane] = [9_000_000_001, 9_000_000_002];
    const activity = (id: number) =>
      env.DB.prepare(`INSERT INTO activities (activity_id, sport, date, fit_status, fit_version, fit_attempts, fit_vo2max, fit_json) VALUES (?, 'running', '2026-07-17', 'done', ?, 1, 50, '{}')`).bind(id, FIT_ANALYSIS_VERSION);
    const effort = (id: number, name: string, kind: string, value: number) =>
      env.DB.prepare(`INSERT INTO best_efforts (activity_id, date, sport, effort, kind, value) VALUES (?, '2026-07-17', 'running', ?, ?, ?)`).bind(id, name, kind, value);
    await env.DB.batch([
      activity(glitched),
      activity(sane),
      effort(glitched, "400m", "time_s", 1),
      effort(glitched, "5k", "time_s", 2393),
      effort(glitched, "5min", "power_w", 300),
      effort(sane, "1k", "time_s", 250),
    ]);
    await env.DB.batch(MIGRATIONS[2].map((sql) => env.DB.prepare(sql)));

    const { results } = await env.DB.prepare(
      `SELECT activity_id, fit_status, fit_attempts, fit_json, fit_vo2max, ${FIT_PENDING} AS pending FROM activities WHERE activity_id IN (?, ?) ORDER BY activity_id`,
    )
      .bind(glitched, sane)
      .all();
    expect(results).toEqual([
      { activity_id: glitched, fit_status: null, fit_attempts: 0, fit_json: null, fit_vo2max: 50, pending: 1 },
      { activity_id: sane, fit_status: "done", fit_attempts: 1, fit_json: "{}", fit_vo2max: 50, pending: 0 },
    ]);
    const efforts = await env.DB.prepare(`SELECT activity_id, effort FROM best_efforts WHERE activity_id IN (?, ?) ORDER BY activity_id`).bind(glitched, sane).all();
    expect(efforts.results).toEqual([
      { activity_id: glitched, effort: "5min" },
      { activity_id: sane, effort: "1k" },
    ]);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM activities WHERE activity_id IN (?, ?)`).bind(glitched, sane),
      env.DB.prepare(`DELETE FROM best_efforts WHERE activity_id IN (?, ?)`).bind(glitched, sane),
    ]);
  });

  it("fills the new columns of archived activities and queues old analyses again", async () => {
    const id = 9_300_000_001;
    const raw = { avgStrideLength: 121.8, avgGroundContactTime: 245, eventType: { typeKey: "race" }, totalSets: 0, poolLength: 2500 };
    // An activity as version 0.1 left it: decoded, three attempts used, no analysis version.
    await env.DB.prepare(`INSERT INTO activities (activity_id, sport, date, raw_json, fit_status, fit_attempts, fit_json) VALUES (?, 'running', '2026-07-17', ?, 'done', 3, '{}')`)
      .bind(id, JSON.stringify(raw))
      .run();
    // The data statements of migration 4; its ALTER TABLEs ran when the schema was created.
    await env.DB.batch(MIGRATIONS[3].filter((sql) => sql.startsWith("UPDATE")).map((sql) => env.DB.prepare(sql)));
    const row = await env.DB.prepare(`SELECT event_type, stride_length_m, ground_contact_ms, total_sets, pool_length_m, fit_status, fit_attempts, ${FIT_PENDING} AS pending FROM activities WHERE activity_id = ?`)
      .bind(id)
      .first();
    expect(row).toEqual({ event_type: "race", stride_length_m: 1.22, ground_contact_ms: 245, total_sets: null, pool_length_m: 25, fit_status: "done", fit_attempts: 0, pending: 1 });
    // The schema holds every column the archive writes.
    const columns = (await env.DB.prepare(`SELECT name FROM pragma_table_info('activities')`).all<{ name: string }>()).results.map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["event_type", "swolf", "fit_version", "workout_type", "workout_structure", "rep_distance_m", "fit_max_hr", "device"]));
    await env.DB.prepare(`DELETE FROM activities WHERE activity_id = ?`).bind(id).run();
  });
});

describe("version 1.0: workouts", () => {
  /** Forget which days the activity list covers, so the next sync asks the fake Garmin again. */
  const resync = async (days: number) => {
    await env.DB.prepare(`DELETE FROM meta WHERE key = 'activity_sync'`).run();
    await tool("sync_now", { days, include_fit: false });
  };

  it("reports an interval session as reps and files its structure", async () => {
    const date = addDays(today(), -20);
    const id = intervalSessionId(date);
    useGarmin({ intervalSession: date });
    await resync(30);

    const a = await tool("analyze_activity", { activity_id: id });
    expect(a.isError).toBe(false);
    expect(a.data.activity.workout).toBe("6 x 600 m");
    expect(a.data.analysis.workout).toEqual({ type: "intervals", structure: "6 x 600 m" });
    expect(a.data.analysis.intervals.reps.columns).toEqual(expect.arrayContaining(["rep", "distance_m", "time", "pace", "avg_hr", "rest", "hr_drop_bpm"]));
    expect(a.data.analysis.intervals.reps.rows).toHaveLength(6);
    expect(a.data.analysis.intervals.work.avg_pace).toBe("4:23/km");
    // Kilometre splits and laps would mix reps with rests, so they wait to be asked for.
    expect(a.data.analysis.splits).toBeUndefined();
    expect(a.data.analysis.laps).toBeUndefined();
    expect(a.data.analysis.durability).toBeUndefined();
    expect(a.data.analysis.durability_note).toMatch(/interval session/);
    expect(a.data.notes.join(" ")).toMatch(/laps \(19\), splits/);

    const laps = await tool("analyze_activity", { activity_id: id, sections: ["laps"] });
    expect(Object.keys(laps.data.analysis).sort()).toEqual(["laps", "workout"]);
    expect(laps.data.analysis.laps.rows).toHaveLength(19);
    expect(laps.data.source).toBe("archive (decoded FIT file)");

    const row = await env.DB.prepare(`SELECT workout_type, workout_structure, rep_count, rep_distance_m, rest_s, fit_version, fit_attempts, decoupling_pct, efficiency_factor, fit_max_hr FROM activities WHERE activity_id = ?`)
      .bind(id)
      .first<Record<string, number | string | null>>();
    expect(row).toMatchObject({ workout_type: "intervals", workout_structure: "6 x 600 m", rep_count: 6, rep_distance_m: 600, rest_s: 90, fit_version: FIT_ANALYSIS_VERSION, fit_attempts: 0, decoupling_pct: null, efficiency_factor: null });
    expect(row!.fit_max_hr).toBeGreaterThan(170);

    const list = await tool("list_activities", { workout: "intervals", start_date: addDays(today(), -40) });
    expect(list.data.activities.map((x: { id: number }) => x.id)).toEqual([id]);
    expect(list.data.activities[0].workout).toBe("6 x 600 m");

    // The card shows the reps instead of pacing bars.
    const card = await view({ preset: { name: "activity", activity_id: id } });
    expect(card.isError).toBe(false);
    expect(card.spec.blocks.map((b: { type: string; title?: string }) => b.title ?? b.type)).toEqual(["stats", "6 x 600 m", "Heart rate", "Load and effect"]);
    expect(card.spec.blocks[1].rows).toHaveLength(6);
    expect(card.spec.blocks[1].rows[0].cells.slice(0, 3)).toEqual([1, "2:38", "4:23"]);
    expect(card.spec.blocks[1].note).toMatch(/Even reps/);
  });

  it("analyzes an old analysis again instead of serving it", async () => {
    const list = await tool("list_activities", { sport: "running", limit: 1 });
    const id = list.data.activities[0].id;
    await tool("analyze_activity", { activity_id: id });
    // As version 0.1 stored it: no version, and none of today's sections.
    await env.DB.prepare(`UPDATE activities SET fit_version = NULL, fit_json = '{"summary":{}}', workout_type = NULL WHERE activity_id = ?`).bind(id).run();
    const status = await tool("server_status", { check_garmin: false });
    expect(status.data.fit_analysis_version).toBe(FIT_ANALYSIS_VERSION);
    expect(status.data.archive.activities.fit_reanalysis_pending).toBeGreaterThanOrEqual(1);
    const again = await tool("analyze_activity", { activity_id: id });
    expect(again.data.source).toBe("FIT file");
    expect(again.data.analysis.workout).toEqual({ type: "steady" });
    expect(again.data.activity.workout).toBe("steady");
    expect(again.data.analysis.splits.columns).toEqual(["split", "distance_km", "time", "pace", "avg_hr", "elevation_gain_m"]);
  });

  it("shows the sets of a strength session", async () => {
    const date = addDays(today(), -9);
    const id = strengthSessionId(date);
    useGarmin({ strengthSession: date });
    await resync(14);
    const s = await tool("analyze_activity", { activity_id: id });
    expect(s.isError).toBe(false);
    expect(s.data.activity).toMatchObject({ type: "strength_training", sets: 5, reps: 62 });
    expect(s.data.strength.exercises).toEqual([
      { exercise: "squat", sets: 3, reps: 30, max_weight_kg: 60, volume_kg: 1800 },
      { exercise: "push_up", sets: 2, reps: 32 },
    ]);
    const sets = await tool("metric_trend", { metric: "strength_sets", days: 14 });
    expect(sets.data.summary.total).toBe(5);
  });

  it("ranks best efforts against history, in one activity and in the week", async () => {
    // Four rows of 1 km efforts in a sport nothing else in the archive uses.
    const [a, b, c, d] = [9_200_000_001, 9_200_000_002, 9_200_000_003, 9_200_000_004];
    const effort = (id: number, date: string, value: number) =>
      env.DB.prepare(`INSERT INTO best_efforts (activity_id, date, sport, effort, kind, value) VALUES (?, ?, 'rowing_paddling', '1k', 'time_s', ?)`).bind(id, date, value);
    await env.DB.batch([effort(d, "2025-07-01", 270), effort(c, "2026-03-01", 260), effort(b, "2026-06-01", 250), effort(a, "2026-07-17", 240)]);
    const ctx = await createContext(env, { mode: "tool" });

    expect(await effortRecords(ctx, a, "km")).toEqual([{ effort: "1k", time: "4:00", pace: "4:00/km", all_time_rank: 1, rank_12_months: undefined, other_best: "4:10", other_best_date: "2026-06-01" }]);
    expect((await effortRecords(ctx, b, "km"))![0]).toMatchObject({ all_time_rank: 2, other_best: "4:00" });
    expect(await effortRecords(ctx, d, "km")).toBeUndefined(); // fourth of four

    const history = await effortsWithHistory(ctx, "2026-07-13", "2026-07-19");
    expect(history.filter((e) => e.sport === "rowing_paddling")).toEqual([
      { activity_id: a, date: "2026-07-17", sport: "rowing_paddling", effort: "1k", kind: "time_s", value: 240, prior: 3, best_before: 250, prior_12mo: 2, best_before_12mo: 250 },
    ]);
    const week = await tool("weekly_report", { weeks: 1, end_date: "2026-07-19" });
    expect(week.data.weeks[0].training.records).toContainEqual({ effort: "1k", sport: "rowing_paddling", record: "all-time", time: "4:00", previous: "4:10", date: "2026-07-17", activity_id: a });
    await env.DB.prepare(`DELETE FROM best_efforts WHERE sport = 'rowing_paddling'`).run();
  });

  it("keeps the track distances and heart-rate peaks as records", async () => {
    const pr = await tool("personal_records", { sport: "running", import_missing: true });
    expect(pr.data.best_efforts["800m"][0].time).toBe("3:20");
    expect(pr.data.best_efforts["200m"][0].time).toBe("0:50");
    // Heart-rate peaks are listed apart from the records; the track session above holds the highest.
    expect(pr.data.peak_heart_rate["5min"][0].bpm).toBeGreaterThanOrEqual(152);
    expect(pr.data.peak_heart_rate["5min"][0].activity_id).toBeGreaterThan(0);
    expect(pr.data.best_efforts["5min_hr"]).toBeUndefined();
  });
});

describe("version 1.0: recovery and the briefing", () => {
  it("does not judge a night the watch has not synced", async () => {
    const forget = () =>
      env.DB.batch([
        env.DB.prepare(`DELETE FROM raw_daily WHERE dataset IN ('sleep', 'hrv') AND date = ?`).bind(today()),
        env.DB.prepare(`UPDATE daily SET sleep_seconds = NULL, sleep_score = NULL, hrv_ms = NULL WHERE date = ?`).bind(today()),
      ]);
    await forget();
    useGarmin({ nightNotSynced: today() });
    const b = await tool("daily_briefing");
    expect(b.isError).toBe(false);
    expect(b.data.data_freshness.last_night_synced).toBe(false);
    expect(b.data.data_freshness.note).toMatch(/sync_now/);
    expect(b.data.last_night).toBeUndefined();
    expect(b.data.latest_night.date).toBe(addDays(today(), -1));
    expect(b.data.signals.find((s: { signal: string }) => s.signal === "Body Battery")).toMatchObject({ stale: true, level: "ok" });
    expect(b.data.signals.find((s: { signal: string }) => s.signal === "Sleep").stale).toBe(true);

    const card = await view({ preset: { name: "readiness", sections: ["signals", "sleep"] } });
    expect(card.spec.blocks[0].rows.find((r: { label: string }) => r.label === "Body Battery").status).toBe("neutral");
    expect(card.spec.blocks[0].note).toMatch(/not synced/);
    expect(card.spec.blocks[1].title).toMatch(/^Latest night/);

    // Once the night arrives, the briefing is fresh again.
    await forget();
    useGarmin();
    const fresh = await tool("daily_briefing");
    expect(fresh.data.data_freshness).toEqual({ last_night_synced: true, latest_night: today() });
    expect(fresh.data.last_night.date).toBe(today());
    expect(fresh.data.signals.some((s: { stale?: boolean }) => s.stale)).toBe(false);
  });

  it("adds overnight stress, sleep breathing rate, the illness watch and sleep regularity", async () => {
    const r = await tool("recovery_analysis", { date: "yesterday" });
    expect(r.data.overnight_stress).toMatchObject({ status: "normal", nights_in_7d: 7 });
    expect(r.data.overnight_stress.baseline).toBeGreaterThan(14);
    expect(r.data.sleep_respiration).toMatchObject({ status: "normal", baseline: 13.5 });
    expect(r.data.illness_watch).toMatchObject({ level: "clear", signals: [] });
    expect(r.data.sleep.consistency).toMatchObject({ avg_wake: "06:30", regularity: "very regular" });
    expect(r.data.sleep.consistency.avg_bedtime).toMatch(/^2[12]:\d\d$/);
    expect(r.data.sleep.sleep_debt_7d_hours).toBeGreaterThanOrEqual(0);
    const b = await tool("daily_briefing", { date: "yesterday" });
    expect(b.data.signals.map((s: { signal: string }) => s.signal)).toEqual(expect.arrayContaining(["Overnight stress", "Sleep breathing"]));
    expect(b.data.illness_watch.level).toBe("clear");
    expect(b.data.data_freshness).toBeUndefined(); // only today can be waiting for a sync

    const card = await view({ preset: { name: "recovery", date: "yesterday" } });
    expect(card.spec.blocks[0].rows.map((x: { label: string }) => x.label)).toEqual(["HRV", "Resting HR", "Sleep", "Overnight stress", "Sleep breathing"]);
    const trend = await tool("metric_trend", { metric: "bedtime", days: 14 });
    expect(trend.data.summary.mean).toBeGreaterThan(9.5);
    expect(trend.data.summary.mean).toBeLessThan(10.5);
  });

  it("notices a change of watch and restarts the HRV baseline there", async () => {
    const changed = addDays(today(), -3);
    const ids = [9_400_000_001, 9_400_000_002, 9_400_000_003, 9_400_000_004, 9_400_000_005];
    const walk = (id: number, date: string, device: string) =>
      env.DB.prepare(`INSERT INTO activities (activity_id, sport, date, start_local, device) VALUES (?, 'walking', ?, ?, ?)`).bind(id, date, `${date} 23:59:00`, device);
    await env.DB.batch([
      // Only these walks say which watch recorded them.
      env.DB.prepare(`UPDATE activities SET device = NULL`),
      env.DB.prepare(`DELETE FROM meta WHERE key = 'device_change'`),
      walk(ids[0], addDays(today(), -30), "fr255"),
      walk(ids[1], addDays(today(), -28), "fr255"),
      walk(ids[2], changed, "fr965"),
      walk(ids[3], addDays(today(), -2), "fr965"),
      walk(ids[4], addDays(today(), -1), "fr965"),
    ]);
    const ctx = await createContext(env, { mode: "tool" });
    expect(await detectDeviceChange(ctx)).toMatchObject({ date: changed, from: "fr255", to: "fr965" });

    const r = await tool("recovery_analysis", { date: "yesterday" });
    expect(r.data.hrv.baseline_from).toBe(changed);
    expect(r.data.hrv.baseline_reset).toBe(`watch changed from fr255 to fr965 on ${changed} (found in the activity files)`);
    expect(r.data.hrv.status_7d).toBe("no data"); // three nights on the new watch are no baseline yet
    // The owner's own setting wins.
    const set = Object.assign(Object.create(env), { HRV_BASELINE_FROM: addDays(today(), -40) }) as typeof env;
    expect((await tool("recovery_analysis", { date: "yesterday" }, set)).data.hrv.baseline_reset).toBe("HRV_BASELINE_FROM setting");

    // Two activities on a new watch are not a change yet.
    await env.DB.batch([env.DB.prepare(`DELETE FROM activities WHERE activity_id = ?`).bind(ids[2]), env.DB.prepare(`DELETE FROM meta WHERE key = 'device_change'`)]);
    expect((await detectDeviceChange(await createContext(env, { mode: "tool" }))).date).toBeUndefined();
    await env.DB.batch([env.DB.prepare(`DELETE FROM activities WHERE activity_id BETWEEN ? AND ?`).bind(ids[0], ids[4]), env.DB.prepare(`DELETE FROM meta WHERE key = 'device_change'`)]);
  });

  it("fills profile gaps from the archive and checks the heart-rate settings", async () => {
    await tool("analyze_activity", { sport: "running" });
    const p = await tool("get_profile", { refresh: true });
    expect(p.data.facts).toMatchObject({ maxHr: 190, restingHr: 48 }); // Garmin's own values win
    expect(p.data.facts.sources).toBeUndefined();
    expect(p.data.zone_check.profile_max_hr).toBe(190);
    expect(p.data.zone_check.observed_max_hr.bpm).toBeGreaterThan(140);
    expect(p.data.zone_check.findings[0]).toMatch(/too few to judge|may be too high/);
    expect(p.data.zone_check.best_20min_hr.bpm).toBeGreaterThan(140);
  });
});

describe("version 1.0: coaching tools", () => {
  it("predicts races and training paces from best efforts", async () => {
    await tool("analyze_activity", { sport: "running" });
    await tool("analyze_activity", { sport: "cycling" });
    const run = await tool("race_predictor");
    expect(run.isError).toBe(false);
    expect(run.data.fitness.vdot).toBeGreaterThan(25);
    expect(run.data.fitness.based_on.activity_id).toBeGreaterThan(0);
    expect(run.data.predictions.map((p: { distance: string }) => p.distance)).toEqual(["1500m", "1mi", "3k", "5k", "10k", "half", "marathon"]);
    const tenK = run.data.predictions.find((p: { distance: string }) => p.distance === "10k");
    expect(tenK.time).toMatch(/^\d+:\d\d$/);
    expect(tenK.pace).toMatch(/\/km$/);
    expect(tenK.best_in_window).toBe("54:10");
    expect(run.data.training_paces.threshold).toMatch(/^\d:\d\d\/km$/);
    expect(run.data.training_paces.easy).toMatch(/^\d:\d\d to \d:\d\d\/km$/);
    expect(run.data.caveats.length).toBeGreaterThan(0);
    const custom = await tool("race_predictor", { target_km: 15 });
    expect(custom.data.predictions.at(-1).distance).toBe("15 km");

    // The fake rides hold 225 W for an hour, which beats 95% of the best 20 minutes.
    const ride = await tool("race_predictor", { sport: "cycling" });
    expect(ride.data).toMatchObject({ sport: "cycling", ftp_estimate_w: 225 });
    expect(ride.data.ftp_basis).toMatch(/best 60 min/);
    expect(ride.data.zones).toHaveLength(7);
    expect(ride.data.best_power_w["5s"]).toBe(350);
  });

  it("forecasts form for a plan", async () => {
    const f = await tool("load_forecast", { days: 14 });
    expect(f.isError).toBe(false);
    expect(f.data).toMatchObject({ as_of: today(), until: addDays(today(), 14), days_ahead: 14, scenario: "maintain" });
    expect(f.data.projection.columns).toEqual(["date", "planned_load", "fitness_ctl", "fatigue_atl", "form_tsb"]);
    expect(f.data.projection.rows).toHaveLength(14);
    expect(f.data.assumptions.usual_weekly_load).toBeGreaterThan(100);
    const others = f.data.other_scenarios_on_end_date;
    expect(others.rest.form_tsb).toBeGreaterThan(others.taper.form_tsb);
    expect(others.taper.form_tsb).toBeGreaterThan(others.maintain.form_tsb);
    expect(f.data.on_end_date.form_tsb).toBe(others.maintain.form_tsb);

    const target = await tool("load_forecast", { days: 14, target_tsb: others.taper.form_tsb });
    expect(target.data.target.train_at_pct_of_usual).toBeGreaterThan(0);
    expect(target.data.target.train_at_pct_of_usual).toBeLessThan(100);
    const long = await tool("load_forecast", { days: 70, planned: [{ date: addDays(today(), 3), load: 250 }] });
    expect(long.data.projection.granularity).toBe("week");
    expect(long.data.projection.rows).toHaveLength(10);
    expect(long.data.assumptions.planned_days).toBe(1);

    expect((await tool("load_forecast", { end_date: today() })).text).toMatch(/after today/);
    expect((await tool("load_forecast", { days: 3, planned: [{ date: addDays(today(), 9), load: 50 }] })).isError).toBe(true);
  });

  it("names the training status and where the load went", async () => {
    const s = await tool("training_status");
    expect(s.isError).toBe(false);
    expect(["productive", "maintaining", "unproductive", "building", "easing", "recovery", "peaking", "overreaching"]).toContain(s.data.status);
    expect(s.data.reason).toMatch(/ACWR/);
    expect(s.data.load.fitness_ctl).toBeGreaterThan(0);
    const focus = s.data.load_focus_last_28_days;
    expect(focus.low_aerobic.pct + focus.high_aerobic.pct + focus.anaerobic.pct).toBeGreaterThan(98);
    expect(focus.rule).toMatch(/not Garmin's/);
  });

  it("correlates two metrics with a lag", async () => {
    const c = await tool("correlate", { x: "training_load", y: "sleep_hours", lag_days: 1, days: 60 });
    expect(c.isError).toBe(false);
    expect(c.data.result.n).toBeGreaterThan(50);
    expect(c.data.result.pearson_r).toBeGreaterThanOrEqual(-1);
    expect(c.data.pairing).toBe("training_load on a day against sleep_hours 1 day later");
    expect(c.data.other_lags.map((l: { lag_days: number }) => l.lag_days)).toEqual([0, 2, 3]);
    expect(c.data.y.unit).toBe("h");
    expect((await tool("correlate", { x: "steps", y: "steps" })).text).toMatch(/same metric/);
  });

  it("compares a workout with earlier ones of its kind", async () => {
    const c = await tool("compare_workouts", { sport: "running" });
    expect(c.isError).toBe(false);
    expect(c.data.reference).toMatchObject({ workout: "steady" });
    expect(c.data.reference.pace).toMatch(/\/km$/);
    expect(c.data.matched_on).toMatch(/steady sessions of/);
    expect(c.data.comparison.verdict).toEqual(expect.any(String));
    expect((await tool("compare_workouts", { activity_id: 123 })).text).toMatch(/not in the archive/);
  });

  it("keeps a race calendar that the briefing, predictor and forecast use", async () => {
    const raceDay = addDays(today(), 10);
    const added = await tool("race_calendar", { action: "add", date: raceDay, name: "City 10k", distance: "10k", goal_time: "42:30", priority: "A" });
    expect(added.isError).toBe(false);
    expect(added.data.event).toMatchObject({ name: "City 10k", date: raceDay, days_to_go: 10, phase: "taper", sport: "running", distance_km: 10, goal_time: "42:30", priority: "A" });
    const id = added.data.event.id;

    const brief = await tool("daily_briefing");
    expect(brief.data.next_event).toMatchObject({ id, name: "City 10k", days_to_go: 10, phase: "taper" });
    await tool("analyze_activity", { sport: "running" });
    const predicted = await tool("race_predictor");
    expect(predicted.data.next_event).toMatchObject({ name: "City 10k", goal: "42:30", distance_km: 10 });
    expect(predicted.data.next_event.gap_to_goal).toMatch(/slower than the goal$/);
    const plan = await tool("load_forecast");
    expect(plan.data).toMatchObject({ until: raceDay, scenario: "taper", for_event: { name: "City 10k" } });

    const changed = await tool("race_calendar", { action: "update", id, goal_time: "41:00", note: "flat course" });
    expect(changed.data.event).toMatchObject({ goal_time: "41:00", note: "flat course", name: "City 10k" });
    const sql = await tool("query_archive", { sql: "SELECT name, distance_m, goal_time_s FROM events" });
    expect(sql.data.rows).toContainEqual(["City 10k", 10000, 2460]);

    const removed = await tool("race_calendar", { action: "remove", id });
    expect(removed.data.removed.id).toBe(id);
    expect((await tool("race_calendar")).data.upcoming).toEqual([]);
    expect((await tool("daily_briefing")).data.next_event).toBeUndefined();

    expect((await tool("race_calendar", { action: "add", name: "No date" })).text).toMatch(/date and name/);
    expect((await tool("race_calendar", { action: "add", date: raceDay, name: "Bad goal", goal_time: "fast" })).text).toMatch(/mm:ss/);
    expect((await tool("race_calendar", { action: "remove", id: 987654 })).text).toMatch(/no event with id/);
  });
});
