/**
 * Garmin Personal API client for Workers.
 *
 * The API key never leaves the Worker: it is exchanged for a 24-hour bearer token,
 * which is cached in memory and in KV and refreshed when less than an hour remains.
 * All endpoints are read-only GETs.
 */
import type { Env } from "../env";

export const DEFAULT_BASE_URL = "https://personal.connectapi.garmin.com";
export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
export const KEY_SETTINGS_URL = "https://connect.garmin.com/app/settings/personalApiToken";
const REFRESH_WINDOW_S = 60 * 60;
const TIMEOUT_MS = 25_000;
const TOKEN_KV_PREFIX = "threshold:garmin-token:";

export class GarminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "GarminError";
  }
}

/** The key is missing, invalid, or expired. Nothing works until the owner fixes it. */
export class GarminAuthError extends GarminError {
  override name = "GarminAuthError";
}

/** Garmin is rate limiting this key. */
export class GarminRateLimitError extends GarminError {
  override name = "GarminRateLimitError";
  constructor(
    path: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`Garmin is rate limiting this key. Try again in about ${Math.ceil(retryAfterSeconds / 60)} min.`, 429, path);
  }
}

/** This invocation used its share of Garmin requests (Workers subrequest limits). */
export class BudgetExhaustedError extends Error {
  override name = "BudgetExhaustedError";
}

/** Counts Garmin requests so one invocation stays inside the Workers subrequest limit. */
export class Budget {
  used = 0;
  constructor(readonly limit: number) {}
  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
  take(): void {
    if (this.used >= this.limit) throw new BudgetExhaustedError(`Request budget of ${this.limit} Garmin calls used up for this run.`);
    this.used++;
  }
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

// Plain data, safe to share across requests in one isolate. Promises are not shared:
// Workers forbids awaiting I/O started by another request.
const memoryTokens = new Map<string, CachedToken>();

export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("Garmin's token endpoint did not return a JWT.");
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(atob(b64)) as Record<string, unknown>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface GarminClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class GarminClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly kv: KVNamespace;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private fingerprint?: Promise<string>;
  private inflight?: Promise<CachedToken>;

  constructor(
    env: Env,
    readonly budget: Budget,
    opts: GarminClientOptions = {},
  ) {
    const key = env.GARMIN_API_KEY?.trim();
    if (!key) {
      throw new GarminAuthError(
        `GARMIN_API_KEY is not set. Create a key at ${KEY_SETTINGS_URL}, then run: npx wrangler secret put GARMIN_API_KEY`,
        0,
        TOKEN_PATH,
      );
    }
    this.apiKey = key;
    this.kv = env.OAUTH_KV;
    this.baseUrl = (env.GARMIN_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now() / 1000);
  }

  private async cacheKey(): Promise<string> {
    // Cached tokens belong to one key and host. The key itself is never stored.
    this.fingerprint ??= sha256Hex(`${this.baseUrl}\0${this.apiKey}`);
    return TOKEN_KV_PREFIX + (await this.fingerprint);
  }

  /** A valid bearer token, from memory, KV, or a fresh key exchange. */
  async token(forceRefresh = false): Promise<CachedToken> {
    const key = await this.cacheKey();
    if (!forceRefresh) {
      const fresh = (t: CachedToken | null | undefined) => t && t.expiresAt - this.now() > REFRESH_WINDOW_S;
      const mem = memoryTokens.get(key);
      if (fresh(mem)) return mem!;
      const stored = await this.kv.get<CachedToken>(key, "json").catch(() => null);
      if (fresh(stored)) {
        memoryTokens.set(key, stored!);
        return stored!;
      }
    }
    this.inflight ??= this.exchange(key).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async exchange(key: string): Promise<CachedToken> {
    this.budget.take();
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + TOKEN_PATH, {
        method: "POST",
        headers: { Accept: "*/*", Authorization: `ApiKey ${this.apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GarminError(`Could not reach Garmin's token service: ${errorText(err)}`, 0, TOKEN_PATH);
    }
    if (res.status === 429) throw new GarminRateLimitError(TOKEN_PATH, retryAfter(res));
    if (!res.ok) {
      const body = await safeText(res);
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new GarminAuthError(
          `Garmin rejected the API key (HTTP ${res.status}). It may be expired or revoked. ` +
            `Create a new key at ${KEY_SETTINGS_URL}, then run: npx wrangler secret put GARMIN_API_KEY`,
          res.status,
          TOKEN_PATH,
        );
      }
      throw new GarminError(`Garmin's token service answered HTTP ${res.status}${body ? `: ${body}` : ""}`, res.status, TOKEN_PATH);
    }
    const accessToken = (await res.text()).trim();
    const exp = jwtClaims(accessToken).exp;
    if (typeof exp !== "number") throw new GarminError("Garmin's token has no expiry claim.", res.status, TOKEN_PATH);
    const token = { accessToken, expiresAt: exp };
    memoryTokens.set(key, token);
    const ttl = Math.floor(exp - this.now());
    if (ttl >= 60) await this.kv.put(key, JSON.stringify(token), { expirationTtl: ttl }).catch(() => {});
    return token;
  }

  /** GET a Personal API path and decode JSON. Empty bodies return null. */
  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    const res = await this.request(path, query, "application/json");
    const text = await res.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /** GET raw bytes (activity downloads are ZIP archives). */
  async getBytes(path: string): Promise<Uint8Array> {
    const res = await this.request(path, undefined, "application/zip, application/octet-stream, */*");
    return new Uint8Array(await res.arrayBuffer());
  }

  private async request(path: string, query: Query | undefined, accept: string, attempt = 0): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
      throw new GarminError("Paths must be absolute Personal API paths, like /sleep-service/sleep/dailySleep.", 400, path);
    }
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const { accessToken } = await this.token(attempt > 0);
    this.budget.take();
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        headers: { Accept: accept, Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GarminError(`Could not reach Garmin: ${errorText(err)}`, 0, path);
    }
    if (res.status === 401 && attempt === 0) {
      // Revoked or expired early: exchange the key once more.
      await res.body?.cancel();
      return this.request(path, query, accept, 1);
    }
    if (res.status === 429) {
      await res.body?.cancel();
      throw new GarminRateLimitError(path, retryAfter(res));
    }
    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < 2 && this.budget.remaining > 0) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return this.request(path, query, accept, attempt + 1);
    }
    if (!res.ok) {
      const body = await safeText(res);
      if (res.status === 401 || res.status === 403) {
        throw new GarminAuthError(`Garmin refused access to ${path} (HTTP ${res.status}). Check that the API key is still valid.`, res.status, path);
      }
      throw new GarminError(`Garmin answered HTTP ${res.status} for ${path}${body ? `: ${body}` : ""}`, res.status, path);
    }
    return res;
  }
}

function retryAfter(res: Response): number {
  const header = res.headers.get("Retry-After");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const date = header ? Date.parse(header) : NaN;
  if (Number.isFinite(date)) return Math.max(1, (date - Date.now()) / 1000);
  return 15 * 60;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
