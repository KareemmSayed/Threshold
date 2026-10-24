/** GET /v/<token>: the private link page for clients that cannot show MCP Apps. */
import { ensureSchema } from "../archive/schema";
import { messagePage } from "../auth/pages";
import type { Env } from "../env";
import { pageDocument, pageHeaders } from "./html";
import { loadView } from "./store";

function notFound(): Response {
  return new Response(messagePage("Link expired", "This view has expired or never existed. Ask your assistant to show it again."), {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

export async function serveView(request: Request, env: Env, token: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  if (!env.DB) return notFound();
  await ensureSchema(env.DB);
  const found = await loadView(env, token, Date.now());
  if (!found) return notFound();
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response(request.method === "HEAD" ? null : pageDocument(found.spec, found.expiresAt, nonce), { headers: pageHeaders(nonce) });
}
