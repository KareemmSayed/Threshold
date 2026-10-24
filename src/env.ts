import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** Set by the OAuth provider for the default handler. */
  OAUTH_PROVIDER?: OAuthHelpers;

  /** Secret. Garmin Personal API key. */
  GARMIN_API_KEY?: string;
  /** Secret. Unlocks the server: bearer token for header-capable clients, password on the OAuth page. */
  ACCESS_KEY?: string;

  /** Optional. IANA time zone for "today". Defaults to the Garmin profile, then UTC. */
  TIMEZONE?: string;
  /** Optional. `free` (default) keeps each run inside the Workers Free limits; `paid` does more per run. */
  PLAN?: string;
  /** Optional. Date the Garmin key expires (YYYY-MM-DD). Enables expiry warnings. */
  GARMIN_KEY_EXPIRES?: string;
  /** Optional. Oldest date the archive backfills to (YYYY-MM-DD). Default: as far back as Garmin answers. */
  BACKFILL_FROM?: string;
  /** Optional. First night (YYYY-MM-DD) the HRV baseline may use. Set it when you change watch: HRV from different devices is not comparable. */
  HRV_BASELINE_FROM?: string;
  /** Optional. `false` stops the cron job from downloading FIT files. */
  SYNC_FIT_FILES?: string;
  /** Optional. Overrides the Garmin API host (tests, proxies). */
  GARMIN_API_BASE_URL?: string;
  /** Optional. Canonical public origin, e.g. https://threshold.example.com. Defaults to the request origin. */
  PUBLIC_URL?: string;
  /** Optional. Hours a show_view private link stays open (default 24, max 720). `0` turns links off. */
  VIEW_LINK_HOURS?: string;
}

export interface Limits {
  /** Garmin requests one MCP tool call may make. */
  toolRequests: number;
  /** Garmin requests one cron run may make. */
  cronRequests: number;
  /** FIT files one cron run may decode. */
  cronFitFiles: number;
  /** FIT files one tool call may import in bulk (sync_now, personal_records). */
  toolFitFiles: number;
  /** Longest window a range request asks Garmin for in one go. */
  windowDays: number;
}

export const FREE_LIMITS: Limits = { toolRequests: 30, cronRequests: 12, cronFitFiles: 1, toolFitFiles: 1, windowDays: 60 };
export const PAID_LIMITS: Limits = { toolRequests: 300, cronRequests: 60, cronFitFiles: 20, toolFitFiles: 15, windowDays: 180 };

export function limitsFor(env: Env): Limits {
  return env.PLAN?.trim().toLowerCase() === "paid" ? PAID_LIMITS : FREE_LIMITS;
}

export const MIN_ACCESS_KEY_LENGTH = 16;
export const SERVER_NAME = "threshold";
export const SERVER_VERSION = "0.1.1";
export const REPO_URL = "https://github.com/KareemmSayed/Threshold";
