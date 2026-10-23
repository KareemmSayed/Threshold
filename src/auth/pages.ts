/** Small server-rendered pages: landing, consent, errors. No scripts, no external assets. */
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { REPO_URL, SERVER_VERSION } from "../env";

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const ICON = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor" opacity=".12"/><path d="M5 20h5l3-9 4 14 3-9 2 4h5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#14171c;--muted:#5b6472;--line:#e3e6eb;--accent:#0b7a5c;--accent-text:#fff;--warn-bg:#fff6e0;--warn:#7a5200;--err-bg:#fdecec;--err:#9b1c1c;--code:#f0f2f5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b21;--text:#e8ebef;--muted:#9aa4b2;--line:#2a3039;--accent:#3ccf9f;--accent-text:#06221a;--warn-bg:#2d2410;--warn:#f2c46b;--err-bg:#3a1717;--err:#ff9b9b;--code:#20262e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px 16px}
main{width:100%;max-width:520px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
header{display:flex;align-items:center;gap:10px;color:var(--accent);margin-bottom:18px}
header span{font-weight:650;letter-spacing:.2px;color:var(--text)}
h1{font-size:22px;line-height:1.3;margin:0 0 12px}
p{margin:0 0 14px;color:var(--muted)}
strong{color:var(--text)}
code{background:var(--code);padding:2px 6px;border-radius:6px;font-size:14px;word-break:break-all}
.box{padding:12px 14px;border-radius:10px;margin:0 0 16px;font-size:15px}
.warn{background:var(--warn-bg);color:var(--warn)}
.err{background:var(--err-bg);color:var(--err)}
label{display:block;font-weight:600;margin:6px 0 6px}
input[type=password]{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:16px}
.row{display:flex;gap:10px;margin-top:18px}
button{flex:1;padding:12px 16px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--text);font-size:16px;font-weight:600;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
ul{margin:0 0 14px;padding-left:20px;color:var(--muted)}
li{margin:4px 0}
footer{margin-top:20px;font-size:13px;color:var(--muted)}
a{color:var(--accent)}
</style>
</head>
<body><main><header>${ICON}<span>Threshold</span></header>${body}<footer>Threshold ${SERVER_VERSION} · self-hosted · <a href="${REPO_URL}">source</a></footer></main></body>
</html>`;
}

export function consentPage(details: ConsentDescription, handle: string, error?: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `<p>Published by <strong>${escapeHtml(details.clientDomain)}</strong>.</p>`
    : `<p>This app registered itself, so its name is not verified.</p>`;
  const loopback = details.redirectIsLoopback
    ? `<div class="box warn">Access goes to an app on this computer (${escapeHtml(details.redirectHost)}). Continue only if you just started connecting from it.</div>`
    : "";
  return layout(
    `Connect ${details.clientName}`,
    `<h1>Allow <strong>${name}</strong> to read your Garmin data?</h1>
${origin}
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>. It is read-only: the app can read your health and activity data through this server, and cannot change anything on Garmin.</p>
${loopback}
${error ? `<div class="box err">${escapeHtml(error)}</div>` : ""}
<form method="post" autocomplete="on">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="client_name" value="${name}">
<input type="hidden" name="client_domain" value="${escapeHtml(details.clientDomain ?? "")}">
<input type="hidden" name="redirect_host" value="${escapeHtml(details.redirectHost)}">
<input type="hidden" name="loopback" value="${details.redirectIsLoopback ? "1" : ""}">
<input type="text" name="username" value="threshold" autocomplete="username" hidden>
<label for="key">Access key</label>
<input id="key" type="password" name="access_key" autocomplete="current-password" required autofocus placeholder="The ACCESS_KEY secret you set">
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve">Allow</button></div>
</form>`,
  );
}

/** Re-render after a wrong key, from the display fields the form carried (the request itself stays server-side). */
export function consentRetryPage(form: FormData, handle: string, error: string): string {
  const field = (k: string) => String(form.get(k) ?? "");
  const details: ConsentDescription = {
    clientId: "",
    clientName: field("client_name").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))),
    clientDomain: field("client_domain") || undefined,
    redirectUri: "",
    redirectHost: field("redirect_host"),
    redirectIsLoopback: field("loopback") === "1",
    scope: [],
  };
  return consentPage(details, handle, error);
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function landingPage(origin: string, problems: string[]): string {
  const mcp = `${origin}/mcp`;
  const setup = problems.length
    ? `<div class="box warn"><strong>Setup incomplete.</strong><ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>`
    : "";
  return layout(
    "Threshold",
    `<h1>Your Garmin data, analyzed.</h1>
<p>This is a private, single-user MCP server. Connect an AI assistant to the endpoint below.</p>
${setup}
<p>MCP endpoint:<br><code>${escapeHtml(mcp)}</code></p>
<ul>
<li><strong>Claude, ChatGPT</strong> (web, desktop, mobile): add a custom connector with this URL, then sign in with your access key.</li>
<li><strong>Claude Code, Cursor, VS Code, Codex, Gemini CLI, Windsurf</strong>: use the URL with header <code>Authorization: Bearer &lt;ACCESS_KEY&gt;</code>, or sign in with OAuth.</li>
</ul>
<p>Setup guides for every client: <a href="${REPO_URL}#connect-your-ai">README</a>.</p>`,
  );
}
