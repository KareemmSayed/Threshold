/** The view's HTML document: the MCP Apps resource, and the private link page around a stored spec. */
import { escapeHtml } from "../auth/pages";
import { VIEW_CSS, VIEW_JS } from "./assets";
import type { ViewSpec } from "./spec";

export const FONT_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const FONTS_CSS = "https://fonts.googleapis.com/css2?family=Doto:wght@600;700;800&family=Inter+Tight:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";

const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#000"/><g fill="#ff7a45"><rect x="5" y="5" width="4" height="4" rx="1.2"/><rect x="10" y="5" width="4" height="4" rx="1.2"/><rect x="15" y="5" width="4" height="4" rx="1.2"/><rect x="20" y="5" width="4" height="4" rx="1.2"/></g><g fill="#f4f3ef"><rect x="15" y="10" width="4" height="4" rx="1.2"/><rect x="15" y="15" width="4" height="4" rx="1.2"/><rect x="15" y="20" width="4" height="4" rx="1.2"/></g></svg>`;

/** JSON that is safe inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function head(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS_CSS}">
<style>${VIEW_CSS}</style>`;
}

/** The MCP Apps resource: an empty card that fills in when the host sends the tool result. */
export function appDocument(): string {
  return `<!doctype html>
<html lang="en">
<head>
${head("Threshold")}
</head>
<body class="app"><main id="root"></main>
<script>${VIEW_JS}</script>
</body>
</html>`;
}

/** The private link page. `nonce` must match the page's Content-Security-Policy. */
export function pageDocument(spec: ViewSpec, expiresAt: number, nonce: string): string {
  const expires = new Date(expiresAt).toISOString().replace("T", " ").slice(0, 16);
  return `<!doctype html>
<html lang="en">
<head>
${head(spec.title ? `${spec.title} · Threshold` : "Threshold")}
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
</head>
<body class="page">
<div class="page-wrap">
<header class="page-head"><span class="brand">${MARK}Threshold</span><span>Private link · expires ${escapeHtml(expires)} UTC</span></header>
<main id="root"></main>
</div>
<script type="application/json" id="threshold-view-data">${scriptJson(spec)}</script>
<script nonce="${nonce}">${VIEW_JS}</script>
</body>
</html>`;
}

export function pageHeaders(nonce: string): Headers {
  return new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
}
