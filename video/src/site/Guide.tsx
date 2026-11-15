import React from 'react';
import { FPS } from '../lib/time';
import { fadein, flash, pop, press, spin } from './anim';

/*
 * The setup guide's Claude path (SCENES and CLIENTS.claude in site.js) as six frame-scripted beats.
 * Each beat renders the same mock-screen markup the site injects, as a function of the beat's frame,
 * and lists where the cursor goes and when it clicks. Elements a cursor has visited stay mounted
 * (hidden once gone) so their positions can always be measured.
 */

export const HOST = 'threshold.you.workers.dev';
export const MCP = `https://${HOST}/mcp`;
const DOTS = (n: number) => '•'.repeat(n);

export type Move = { k: string; at: number; dur: number; dx?: number; dy?: number };
export type Beat = {
  name: string;
  url: string;
  cap: React.ReactNode;
  dur: number;
  moves: Move[];
  clicks: { k: string; at: number }[];
  hideAt?: number;
  toasts: [number, string][];
  render: (f: number) => React.ReactNode;
};

/** Typed text: `n` of `text` at frame f, one character every `per` frames from `at`. */
const typed = (text: string, f: number, at: number, per: number) => text.slice(0, Math.max(0, Math.min(text.length, Math.floor((f - at) / per) + 1)));
const isTyping = (text: string, f: number, at: number, per: number) => f >= at && f < at + text.length * per;
const blink = (f: number) => ({ ['--blink' as string]: (f / FPS) % 1 < 0.5 ? '1' : '0' }) as React.CSSProperties;
const AMP = 2.2;

const TpIcon: React.FC = () => (
  <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="currentColor" opacity=".12" />
    <path d="M5 20h5l3-9 4 14 3-9 2 4h5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const TpFoot: React.FC = () => (
  <footer>
    Threshold 0.1.1 · self-hosted · <a>source</a>
  </footer>
);

const ConsentPage: React.FC<{ f: number; keyAt: number; focus: boolean }> = ({ f, keyAt, focus }) => {
  const key = DOTS(24);
  return (
    <div className="tp">
      <div className="tp-zoom">
        <main>
          <header>
            <TpIcon />
            <span>Threshold</span>
          </header>
          <h1>
            Allow <strong>Claude</strong> to read your Garmin data?
          </h1>
          <p>
            Published by <strong>claude.ai</strong>.
          </p>
          <p>
            Access will be sent to <strong>claude.ai</strong>. It is read-only: the app can read your health and activity data through this server, and
            cannot change anything on Garmin.
          </p>
          <label>Access key</label>
          <div className={`pw${focus ? ' focus' : ''}${isTyping(key, f, keyAt, 0.6) ? ' typed' : ''}`} data-k="key" style={blink(f)}>
            {f >= keyAt ? typed(key, f, keyAt, 0.6) : ''}
          </div>
          <div className="row">
            <button>Deny</button>
            <button className="primary" data-k="allow" style={press(f - 49)}>
              Allow
            </button>
          </div>
          <TpFoot />
        </main>
      </div>
    </div>
  );
};

const ClaudeSettings: React.FC<{ row?: React.ReactNode; f: number; addPress?: number }> = ({ row, f, addPress = -99 }) => (
  <div className="cl">
    <div className="cl-rail">
      <i />
      <i />
      <i />
      <i />
    </div>
    <div className="cl-main">
      <h4>Settings</h4>
      <div className="cl-tabs">
        <span>General</span>
        <span>Account</span>
        <span>Privacy</span>
        <span>Billing</span>
        <span>Capabilities</span>
        <span className="on">Connectors</span>
      </div>
      <div className="cl-head">
        <div>
          <b>Connectors</b>
          <p>Allow Claude to reference other apps and services for more context.</p>
        </div>
        <button className="cl-btn" data-k="add" style={press(f - addPress)}>
          Add custom connector
        </button>
      </div>
      <div className="cl-list" data-k="list">
        {row ?? (
          <div className="cl-row" data-k="empty">
            <span className="ic">+</span>
            <span className="nm">
              No custom connectors yet<small>Add a remote MCP server by URL</small>
            </span>
          </div>
        )}
      </div>
    </div>
  </div>
);

const ClaudeRow: React.FC<{ state?: 'new' | 'on'; f?: number; newAt?: number; pressAt?: number }> = ({ state, f = 0, newAt = 0, pressAt = -99 }) => (
  <div className="cl-row" style={state === 'new' ? flash(f - newAt, 1.2) : undefined}>
    <span className="ic t">T</span>
    <span className="nm">
      Threshold<small>{HOST}</small>
    </span>
    {state === 'on' ? (
      <span className="cl-ok">Connected · 16 tools</span>
    ) : (
      <button className="cl-btn pri" data-k="connect" style={press(f - pressAt)}>
        Connect
      </button>
    )}
  </div>
);

const ANSWER = {
  b: 'Amber today: keep it easy.',
  a: 'Your 7-day HRV is 49 ms, just under your normal 51–63 ms, and your load ramp is high (ACWR 1.34). Sleep (7 h 24, score 82) and Body Battery (71) look good. Do easy aerobic work and move the intervals to tomorrow.',
};
const SIGROW: [string, string][] = [
  ['amber', 'HRV'],
  ['green', 'Resting HR'],
  ['green', 'Sleep'],
  ['green', 'Body Battery'],
  ['blue', 'Form'],
  ['amber', 'Load ramp'],
];

export const BEATS: Beat[] = [
  {
    name: 'garmin',
    url: 'connect.garmin.com/app/settings/personalApiToken',
    cap: (
      <>
        Garmin Connect → <b>Personal API</b> → <b>Create</b>. Copy the key: Garmin shows it only once.
      </>
    ),
    dur: 72,
    moves: [
      { k: 'create', at: 4, dur: 14 },
      { k: 'copy', at: 44, dur: 10 },
    ],
    clicks: [
      { k: 'create', at: 19 },
      { k: 'copy', at: 55 },
    ],
    toasts: [[57, 'Garmin key copied']],
    render: (f) => {
      const key = 'Q9mL2xR7vK4pT8nW3cY6bH1d';
      return (
        <div className="gm" data-k="root">
          <div className="gm-top">
            <b>Garmin Connect</b>
            <span />
          </div>
          <div className="gm-body">
            <div className="gm-side">
              <span>Account</span>
              <span>Profile &amp; Privacy</span>
              <span>Display Preferences</span>
              <span className="on">Personal API</span>
              <span>Connected Apps</span>
            </div>
            <div className="gm-main">
              <h4>Personal API</h4>
              <p>Create a key to read your own Garmin data with your own tools.</p>
              <div className="gm-card">
                <div className="gm-row h">
                  <span>Key</span>
                  <span>Created</span>
                  <span />
                </div>
                <div className="gm-empty" data-k="empty">
                  No keys yet
                </div>
              </div>
              <button className="gm-btn" data-k="create" style={press(f - 19)}>
                Create
              </button>
            </div>
          </div>
          {f >= 23 ? (
            <div className="gm-modal" data-k="modal" style={fadein(f - 23, 0.25)}>
              <div className="gm-dialog" style={pop(f - 23, AMP, 0.3)}>
                <h5>Your new key</h5>
                <div className={`gm-key${isTyping(key, f, 26, 0.75) ? ' typed' : ''}`} data-k="key" style={blink(f)}>
                  {typed(key, f, 26, 0.75)}
                </div>
                <p className="gm-warn">Copy it now. Garmin shows it only once.</p>
                <button className="gm-btn" data-k="copy" style={press(f - 55)}>
                  {f >= 57 ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      );
    },
  },
  {
    name: 'deploy',
    url: 'dash.cloudflare.com/?to=/:account/workers-and-pages/create/deploy-to-workers',
    cap: (
      <>
        <b>Deploy to Cloudflare</b> asks for two secrets: your Garmin key, and an access key you make up (20+ characters).
      </>
    ),
    dur: 84,
    moves: [
      { k: 'g', at: 4, dur: 12 },
      { k: 'a', at: 28, dur: 10 },
      { k: 'go', at: 54, dur: 10 },
    ],
    clicks: [
      { k: 'g', at: 17 },
      { k: 'a', at: 39 },
      { k: 'go', at: 65 },
    ],
    toasts: [[19, '⌘V  Garmin key pasted']],
    render: (f) => {
      const focus = f >= 17 && f < 39 ? 'g' : f >= 39 && f < 54 ? 'a' : null;
      const access = DOTS(26);
      return (
        <div className="cf" data-k="root">
          <div className="cf-top">
            <b>Cloudflare</b>
            <span>Workers &amp; Pages</span>
          </div>
          <div className="cf-main">
            <h4>
              Deploy a Worker<small>From github.com/KareemmSayed/Threshold</small>
            </h4>
            <div className="cf-grid">
              <div className="cf-f">
                Git repository<span className="cf-in">you/threshold</span>
              </div>
              <div className="cf-f">
                Worker name<span className="cf-in">threshold</span>
              </div>
            </div>
            <div className="cf-res">
              <span>
                D1 database: threshold<em>New</em>
              </span>
              <span>
                KV namespace: OAUTH_KV<em>New</em>
              </span>
            </div>
            <div className="cf-sec">
              <div>
                <code>GARMIN_API_KEY</code>
                <small>Your Garmin Personal API key.</small>
              </div>
              <span className={`cf-in pw${focus === 'g' ? ' focus' : ''}`} data-k="g" style={flash(f - 19)}>
                {f >= 19 ? DOTS(24) : ''}
              </span>
            </div>
            <div className="cf-sec">
              <div>
                <code>ACCESS_KEY</code>
                <small>A password you make up, 20+ characters.</small>
              </div>
              <span className={`cf-in pw${focus === 'a' ? ' focus' : ''}${isTyping(access, f, 41, 0.5) ? ' typed' : ''}`} data-k="a" style={blink(f)}>
                {f >= 41 ? typed(access, f, 41, 0.5) : ''}
              </span>
            </div>
            <button className="cf-btn" data-k="go" style={press(f - 65)}>
              {f >= 66 ? (
                <>
                  <i className="spin" style={spin(f)} />
                  Deploying…
                </>
              ) : (
                'Create and deploy'
              )}
            </button>
          </div>
          {f >= 76 ? (
            <div className="cf-done" style={fadein(f - 76, 0.35)}>
              <span className="ok">✓</span>
              <h5>Success! Your Worker is live.</h5>
              <p>Database and KV created, secrets saved.</p>
              <span className="cf-in">{HOST}</span>
            </div>
          ) : null}
        </div>
      );
    },
  },
  {
    name: 'ready',
    url: HOST,
    cap: (
      <>
        Your server’s page says <b>Ready</b> and shows your MCP URL. Copy it. (If a key is missing, it says which and suggests one.)
      </>
    ),
    dur: 56,
    moves: [{ k: 'url', at: 4, dur: 14, dx: 0.4 }],
    clicks: [{ k: 'url', at: 19 }],
    toasts: [[25, '⌘C  MCP URL copied']],
    render: (f) => (
      <div className="tp">
        <div className="tp-zoom">
          <main>
            <header>
              <TpIcon />
              <span>Threshold</span>
            </header>
            <h1>
              <span className="ok">●</span> Ready
            </h1>
            <p>Your private Garmin MCP server is set up. Connect your AI with this URL:</p>
            <p>
              <code className={`pick${f >= 20 ? ' sel' : ''}`} data-k="url">
                {MCP}
              </code>
            </p>
            <p>
              <strong>Claude</strong> (web, desktop, mobile): Settings → Connectors → Add custom connector → paste the URL → enter your access key.
            </p>
            <p>
              <strong>ChatGPT</strong>: Settings → Apps &amp; Connectors → Advanced → Developer mode on → Create → paste the URL → OAuth → enter your access
              key.
            </p>
            <p>
              <strong>Claude Code</strong>:<br />
              <code className="pick">claude mcp add --transport http threshold {MCP} --header "Authorization: Bearer YOUR_ACCESS_KEY"</code>
            </p>
            <p>
              Cursor, VS Code, Codex, Gemini CLI, Windsurf and others: <a>setup guide</a>.
            </p>
            <p>
              Then ask: <em>"How am I today?"</em>
            </p>
            <TpFoot />
          </main>
        </div>
      </div>
    ),
  },
  {
    name: 'claudeAdd',
    url: 'claude.ai/settings/connectors',
    cap: (
      <>
        Claude → <b>Settings</b> → <b>Connectors</b> → <b>Add custom connector</b>. Name it, paste the URL, then <b>Connect</b>.
      </>
    ),
    dur: 86,
    moves: [
      { k: 'add', at: 4, dur: 12 },
      { k: 'name', at: 24, dur: 9 },
      { k: 'url', at: 45, dur: 8 },
      { k: 'ok', at: 60, dur: 8 },
      { k: 'connect', at: 73, dur: 8 },
    ],
    clicks: [
      { k: 'add', at: 17 },
      { k: 'name', at: 34 },
      { k: 'url', at: 54 },
      { k: 'ok', at: 69 },
      { k: 'connect', at: 82 },
    ],
    toasts: [[55, '⌘V  URL pasted']],
    render: (f) => {
      const focus = f >= 34 && f < 54 ? 'name' : f >= 54 && f < 60 ? 'url' : null;
      const gone = f >= 70;
      return (
        <div data-k="root" style={{ height: '100%', position: 'relative' }}>
          <ClaudeSettings f={f} addPress={17} row={f >= 70 ? <ClaudeRow state="new" f={f} newAt={70} pressAt={82} /> : undefined} />
          {f >= 19 ? (
            <div className="cl-modal" data-k="modal" style={gone ? { visibility: 'hidden' } : fadein(f - 19, 0.25)}>
              <div className="cl-dialog" style={gone ? undefined : pop(f - 19, AMP, 0.3)}>
                <h5>
                  Add custom connector <em>BETA</em>
                </h5>
                <div className="cl-f">
                  Name
                  <span className={`cl-in${focus === 'name' ? ' focus' : ''}${isTyping('Threshold', f, 35, 1) ? ' typed' : ''}`} data-k="name" style={blink(f)}>
                    {f >= 35 ? typed('Threshold', f, 35, 1) : ''}
                  </span>
                </div>
                <div className="cl-f">
                  Remote MCP server URL
                  <span className={`cl-in${focus === 'url' ? ' focus' : ''}`} data-k="url" style={flash(f - 55)}>
                    {f >= 55 ? MCP : ''}
                  </span>
                </div>
                <div className="cl-adv">Advanced settings ›</div>
                <div className="cl-actions">
                  <button className="cl-btn">Cancel</button>
                  <button className="cl-btn pri" data-k="ok" style={press(f - 69)}>
                    Add
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      );
    },
  },
  {
    name: 'claudeApprove',
    url: 'claude.ai/settings/connectors',
    cap: (
      <>
        Your server’s own consent page opens. Type your <b>access key</b> and click <b>Allow</b>. It is read-only.
      </>
    ),
    dur: 68,
    moves: [
      { k: 'key', at: 6, dur: 12 },
      { k: 'allow', at: 38, dur: 10 },
    ],
    clicks: [
      { k: 'key', at: 19 },
      { k: 'allow', at: 49 },
    ],
    toasts: [[56, 'Threshold connected']],
    render: (f) => {
      const done = f >= 56;
      const out = f >= 49 ? Math.min(1, (f - 49) / (0.35 * FPS)) : 0;
      const inK = Math.min(1, f / (0.45 * FPS));
      const popStyle: React.CSSProperties =
        out > 0
          ? { opacity: 1 - out, transform: `translate(-50%, ${10 * out}px) scale(${1 - 0.04 * out})`, visibility: out >= 1 ? 'hidden' : undefined }
          : inK < 1
            ? { opacity: inK, transform: `translate(-50%, ${16 * (1 - inK) * 2}px) scale(${1 - 0.04 * (1 - inK) * 2})` }
            : {};
      return (
        <>
          <div className={done ? '' : 'popup-bg'} data-k="bg" style={done ? { height: '100%' } : undefined}>
            <ClaudeSettings f={f} row={<ClaudeRow state={done ? 'on' : undefined} f={f} />} />
          </div>
          <div className="popup" data-k="pop" style={popStyle}>
            <div className="popup-bar">
              <span className="lights">
                <i />
                <i />
                <i />
              </span>
              <span>{HOST}/authorize</span>
            </div>
            <ConsentPage f={f} keyAt={21} focus={f >= 19 && f < 38} />
          </div>
        </>
      );
    },
  },
  {
    name: 'claudeAsk',
    url: 'claude.ai/new',
    cap: (
      <>
        Ask. Claude calls <b>daily_briefing</b>; the numbers come from code, not the model. Same on the Claude phone apps.
      </>
    ),
    dur: 92,
    moves: [
      { k: 'txt', at: 4, dur: 10, dx: 0.1 },
      { k: 'send', at: 32, dur: 8 },
    ],
    clicks: [
      { k: 'txt', at: 15 },
      { k: 'send', at: 41 },
    ],
    hideAt: 43,
    toasts: [],
    render: (f) => {
      const q = 'How am I today?';
      const sent = f >= 43;
      const words = ANSWER.a.split(' ');
      const nWords = Math.max(0, Math.min(words.length, Math.floor((f - 64) / 0.6) + 1));
      return (
        <div className="cl">
          <div className="cl-rail">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="cl-chat">
            <div className="cl-thread" data-k="thread">
              {!sent ? (
                <div className="cl-hello" data-k="hello">
                  <div>
                    <span>✻</span> Good morning
                  </div>
                </div>
              ) : (
                <>
                  <div className="cl-user m" style={pop(f - 43, AMP)}>
                    {q}
                  </div>
                  {f >= 49 ? (
                    <div className="cl-tool m" style={pop(f - 49, AMP)}>
                      {f < 62 ? <i className="spin" style={spin(f)} /> : <span className="ok">✓</span>}Threshold · daily_briefing
                    </div>
                  ) : null}
                  {f >= 63 ? (
                    <div className="cl-ans m" style={pop(f - 63, AMP)}>
                      <b>{ANSWER.b}</b> <span>{words.slice(0, nWords).map((w) => w + ' ').join('')}</span>
                    </div>
                  ) : null}
                  {f >= 88 ? (
                    <div className="sigrow m" style={pop(f - 88, AMP)}>
                      {SIGROW.map(([k, n]) => (
                        <span key={n}>
                          <i className={`sig ${k}`} />
                          {n}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div className="cl-box">
              <div className={`txt${isTyping(q, f, 16, 1) ? ' typed' : ''}`} data-k="txt" style={blink(f)}>
                {f >= 16 && !sent ? typed(q, f, 16, 1) : ''}
              </div>
              <div className="bot">
                <span className="tools">⚙ Threshold</span>
                <span className="send" data-k="send" style={press(f - 41)}>
                  ↑
                </span>
              </div>
            </div>
          </div>
        </div>
      );
    },
  },
];

export const STEPS: [string, string][] = [
  ['Create a Garmin key', 'Garmin Connect → Personal API → Create. Copy it; Garmin shows it once.'],
  ['Deploy with both keys', 'Click Deploy to Cloudflare. Paste your Garmin key and make up an access key.'],
  ['Open your server', 'It says Ready and shows your MCP URL. Copy it.'],
  ['Add a custom connector', 'Settings → Connectors → Add custom connector. Paste the URL.'],
  ['Approve with your access key', 'Threshold’s own page opens. Type your access key, click Allow.'],
  ['Ask', '“How am I today?” Works on web, desktop and phone.'],
];
