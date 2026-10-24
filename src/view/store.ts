/**
 * Private links for clients that cannot show MCP Apps (terminals, some IDEs). The link is
 * the only key: a random 192-bit token whose SHA-256 is stored, so the table alone cannot
 * rebuild a link. Links expire (VIEW_LINK_HOURS, default 24) and stop working when the
 * access key changes.
 */
import type { Env } from "../env";
import type { ViewLink, ViewSpec } from "./spec";

const DEFAULT_HOURS = 24;
const MAX_HOURS = 720;

export function linkHours(env: Env): number {
  const raw = env.VIEW_LINK_HOURS?.trim();
  if (!raw) return DEFAULT_HOURS;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 0 ? Math.min(hours, MAX_HOURS) : DEFAULT_HOURS;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Changes when the access key is rotated, which retires every link made before. */
async function epoch(env: Env): Promise<string> {
  return (await sha256Hex(`threshold-view:${env.ACCESS_KEY?.trim() ?? ""}`)).slice(0, 16);
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** Store a view and return its link, or null when links are turned off. */
export async function saveView(env: Env, origin: string, spec: ViewSpec, now: number): Promise<ViewLink | null> {
  const hours = linkHours(env);
  if (hours <= 0) return null;
  const token = newToken();
  const expires = now + hours * 3600_000;
  const { link: _link, ...stored } = spec;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM views WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`INSERT INTO views (id, spec, epoch, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`).bind(await sha256Hex(token), JSON.stringify(stored), await epoch(env), now, expires),
  ]);
  return { url: `${origin}/v/${token}`, expires_at: new Date(expires).toISOString() };
}

export async function loadView(env: Env, token: string, now: number): Promise<{ spec: ViewSpec; expiresAt: number } | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await env.DB.prepare(`SELECT spec, epoch, expires_at FROM views WHERE id = ?`)
    .bind(await sha256Hex(token))
    .first<{ spec: string; epoch: string; expires_at: number }>();
  if (!row || row.expires_at < now || row.epoch !== (await epoch(env))) return null;
  return { spec: JSON.parse(row.spec) as ViewSpec, expiresAt: row.expires_at };
}
