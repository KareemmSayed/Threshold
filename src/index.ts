/**
 * Threshold: a self-hosted MCP server for your own Garmin data, on Cloudflare Workers.
 *
 *   fetch      OAuth endpoints, consent page, landing page, and the MCP endpoint at /mcp
 *   scheduled  every 10 minutes: refresh recent days, backfill history, decode FIT files
 */
import { providerFor } from "./auth/provider";
import { runCron } from "./archive/sync";
import { getMeta, setMeta } from "./archive/store";
import { createContext } from "./context";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = env.PUBLIC_URL?.trim() ? new URL(env.PUBLIC_URL.trim()).origin : new URL(request.url).origin;
    return providerFor(origin).fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.GARMIN_API_KEY?.trim() || !env.DB) return;
    const app = await createContext(env, { mode: "cron" });
    await runCron(app);
    ctx.waitUntil(purgeOAuth(env, app.db, app.now));
  },
} satisfies ExportedHandler<Env>;

/** Once a day, sweep expired OAuth grants and tokens from KV in small batches. */
async function purgeOAuth(env: Env, db: D1Database, now: number): Promise<void> {
  try {
    const state = (await getMeta<{ at: number; cursor?: string }>(db, "oauth_purge")) ?? { at: 0 };
    if (!state.cursor && now - state.at < 24 * 3600_000) return;
    const origin = env.PUBLIC_URL?.trim() ? new URL(env.PUBLIC_URL.trim()).origin : "https://localhost";
    const result = await providerFor(origin).purgeExpiredData(env, { batchSize: 50, cursor: state.cursor });
    await setMeta(db, "oauth_purge", { at: now, cursor: result.cursor });
  } catch (err) {
    console.error("OAuth purge failed", err);
  }
}
