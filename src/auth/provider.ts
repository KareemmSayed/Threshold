/**
 * Authentication.
 *
 * Two ways in, both unlocked by the owner's ACCESS_KEY secret:
 *  - OAuth 2.1 (dynamic client registration, Client ID Metadata Documents, PKCE)
 *    for Claude and ChatGPT on web, desktop and mobile. The consent page asks for
 *    the access key, so only the owner can approve a client.
 *  - `Authorization: Bearer <ACCESS_KEY>` for clients that send headers
 *    (Claude Code, Cursor, VS Code, Codex, Gemini CLI, mcp-remote).
 *
 * This is a single-user server, as Garmin's Personal API terms require.
 */
import { AuthorizationError, CimdFetchError, OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { MIN_ACCESS_KEY_LENGTH, SERVER_VERSION, type Env } from "../env";
import { handleMcp } from "../mcp/server";
import { serveView } from "../view/page";
import { consentPage, consentRetryPage, landingPage, messagePage, type SetupStatus } from "./pages";

export const SCOPE = "garmin:read";
const OWNER = "owner";

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** Constant-time comparison of a presented secret with the configured access key. */
export async function matchesAccessKey(env: Env, presented: string | null | undefined): Promise<boolean> {
  const expected = env.ACCESS_KEY?.trim();
  if (!expected || expected.length < MIN_ACCESS_KEY_LENGTH || !presented) return false;
  const [a, b] = await Promise.all([digest(presented.trim()), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * A short fingerprint of the current access key, stored in every grant. Rotating the
 * key changes it, which invalidates every OAuth token issued before the rotation.
 */
export async function keyEpoch(env: Env): Promise<string> {
  const bytes = new Uint8Array(await digest(`threshold-epoch:${env.ACCESS_KEY?.trim() ?? ""}`));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the landing page checks. */
export function setupStatus(env: Env): SetupStatus {
  const access = env.ACCESS_KEY?.trim() ?? "";
  return {
    garminKey: Boolean(env.GARMIN_API_KEY?.trim()),
    accessKey: !access ? "missing" : access.length < MIN_ACCESS_KEY_LENGTH ? "short" : "ok",
    bindings: [env.DB ? "" : "DB (D1 database)", env.OAUTH_KV ? "" : "OAUTH_KV (KV namespace)"].filter(Boolean),
  };
}

/** Problems that stop the server from working, shown on the landing page and /mcp. */
export function setupProblems(env: Env): string[] {
  const out: string[] = [];
  if (!env.GARMIN_API_KEY?.trim()) out.push("GARMIN_API_KEY is not set.");
  if (!env.ACCESS_KEY?.trim()) out.push("ACCESS_KEY is not set.");
  else if (env.ACCESS_KEY.trim().length < MIN_ACCESS_KEY_LENGTH) out.push(`ACCESS_KEY is shorter than ${MIN_ACCESS_KEY_LENGTH} characters; choose a longer one.`);
  if (!env.OAUTH_KV) out.push("The OAUTH_KV binding is missing.");
  if (!env.DB) out.push("The DB (D1) binding is missing.");
  return out;
}

async function rememberSecret(env: Env): Promise<string> {
  // Derived from the access key: changing the key forgets every remembered approval.
  const bytes = new Uint8Array(await digest(`threshold-consent:${env.ACCESS_KEY?.trim() ?? ""}`));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const html = (body: string, status = 200, headers?: Headers) => {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("X-Frame-Options", "DENY");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'");
  return new Response(body, { status, headers: h });
};

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER as OAuthHelpers;
  try {
    if (request.method === "GET") {
      if (setupProblems(env).length) return html(messagePage("Server not ready", setupProblems(env).join(" ")), 503);
      const authRequest = await oauth.parseAuthRequest(request);
      const remember = { secret: await rememberSecret(env), subject: OWNER };
      if (await oauth.isConsentRemembered(request, authRequest, remember)) {
        const { redirectTo } = await oauth.completeAuthorization({
          request: authRequest,
          userId: OWNER,
          metadata: { via: "remembered consent" },
          scope: [SCOPE],
          props: { owner: true, keyEpoch: await keyEpoch(env) },
        });
        return Response.redirect(redirectTo, 302);
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return html(consentPage(details, consent.handle), 200, consent.headers);
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (!(await matchesAccessKey(env, String(form.get("access_key") ?? "")))) {
        // The handle is not consumed, so the owner can try again on the same page.
        await new Promise((r) => setTimeout(r, 750));
        return html(consentRetryPage(form, handle, "That access key is not right."), 401);
      }
      const approved = await oauth.approveConsent(request, handle, {
        scope: [SCOPE],
        remember: { secret: await rememberSecret(env), subject: OWNER },
      });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: OWNER,
        metadata: { via: "consent page" },
        scope: [SCOPE],
        props: { owner: true, keyEpoch: await keyEpoch(env) },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
    if (err instanceof AuthorizationError) return html(messagePage("Cannot connect", `${err.description} Start connecting again from your app.`), 400);
    if (err instanceof CimdFetchError) return html(messagePage("Cannot connect", "This app could not be verified (its client metadata could not be fetched)."), 400);
    throw err;
  }
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v/")) return serveView(request, env, url.pathname.slice(3));
    switch (url.pathname) {
      case "/":
        return html(landingPage(url.origin, setupStatus(env)));
      case "/authorize":
        return authorize(request, env);
      case "/health":
        return Response.json({ ok: setupProblems(env).length === 0, version: SERVER_VERSION }, { headers: { "Cache-Control": "no-store" } });
      case "/favicon.ico":
      case "/favicon.svg":
        return new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0b7a5c"/><path d="M5 20h5l3-9 4 14 3-9 2 4h5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
          { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } },
        );
      default:
        return new Response("Not found", { status: 404 });
    }
  },
};

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = ctx.props as { keyEpoch?: string } | undefined;
    if (props?.keyEpoch !== (await keyEpoch(env))) {
      // Issued before the access key was rotated.
      return new Response("The access key changed; connect again.", {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer error="invalid_token", error_description="The access key changed; connect again."` },
      });
    }
    const problems = setupProblems(env).filter((p) => !p.startsWith("ACCESS_KEY"));
    if (problems.length) return Response.json({ error: "server_not_configured", problems }, { status: 503 });
    return handleMcp(request, env);
  },
};

// One provider per public origin: the token audience is this origin's /mcp URL.
const providers = new Map<string, OAuthProvider<Env>>();

export function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    const resource = `${origin}/mcp`;
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: { resource, authorization_servers: [origin], resource_name: "Threshold (Garmin data)" },
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 60 * 60,
      refreshTokenTTL: 90 * 24 * 3600,
      refreshTokenIdleTTL: 30 * 24 * 3600,
      resolveExternalToken: async ({ token, env }) =>
        (await matchesAccessKey(env, token)) ? { props: { owner: true, via: "access key", keyEpoch: await keyEpoch(env) }, audience: resource } : null,
    });
    providers.set(origin, provider);
  }
  return provider;
}
