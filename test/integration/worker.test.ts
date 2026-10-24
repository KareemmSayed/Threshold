import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { ensureSchema } from "../../src/archive/schema";
import { addDays, todayIn } from "../../src/util/dates";
import { createMockGarmin, type MockGarmin, type MockOptions } from "../helpers/mock-garmin";

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
        "daily_briefing",
        "garmin_api_get",
        "get_activity",
        "get_day_detail",
        "get_health_data",
        "get_profile",
        "list_activities",
        "metric_trend",
        "personal_records",
        "query_archive",
        "recovery_analysis",
        "server_status",
        "show_view",
        "sync_now",
        "training_load",
        "weekly_report",
      ].sort(),
    );
    const readOnly = body.result.tools.filter((t: { annotations?: { readOnlyHint?: boolean } }) => t.annotations?.readOnlyHint).length;
    expect(readOnly).toBe(16);
    const prompts = await rpc("prompts/list");
    expect(prompts.body.result.prompts.map((p: { name: string }) => p.name)).toContain("morning_check_in");
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
    const n = analyzed.data.analysis.splits.length;
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
    expect(list.body.result.tools.length).toBe(17);

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
    await env.DB.prepare(`UPDATE activities SET fit_status = 'done'`).run();
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
