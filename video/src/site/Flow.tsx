import React from 'react';
import { RAMP } from '../lib/ascii';

/*
 * How it works: the README diagram with a request travelling through it (initFlow in site.js).
 * `head` is the pulse position along one round trip (0..50 cells), `cron` the cron arrow's phase;
 * the site derives both from time, the video from the frame. `glow` adds a bloom to lit cells.
 */

const W1 = 21;
const G = 9;
const W2 = 35;
const W3 = 16;
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length));
type Piece = { s: string; c?: string };
const P = (s: string, c?: string): Piece => ({ s, c });
const V = P('│');
const sp = (n: number) => P(' '.repeat(n));
const top = (n: number) => P('┌' + '─'.repeat(n) + '┐');
const bot = (n: number) => P('└' + '─'.repeat(n) + '┘');

const ROWS: Piece[][] = [
  [P(pad(' YOUR AI', W1 + 2), 'hd'), sp(G), P(pad(' YOUR CLOUDFLARE ACCOUNT · FREE', W2 + 2), 'hd'), sp(G), P(pad(' GARMIN', W3 + 2), 'hd')],
  [top(W1), sp(G), top(W2), sp(G), top(W3)],
  [V, P(pad(' "How am I today?"', W1), 'tx'), V, P(pad('  OAuth', G), 'lb'), V, P(' /mcp', 'tx'), P(pad('   16 tools · 4 prompts', W2 - 5), 'lb'), V, P(pad(' API key', G), 'lb'), V, P(pad(' Personal API', W3), 'tx'), V],
  [V, sp(W1), V, P('────────▶', 'req1'), V, P('  ├─ ', 'lb'), P('analysis', 'tx'), P(pad('  load · HRV · ready', W2 - 13), 'lb'), V, P('────────▶', 'req2'), V, P(pad(' read-only', W3), 'lb'), V],
  [V, P(pad(' Claude · ChatGPT', W1), 'lb'), V, P('◀────────', 'res1'), V, P('  ├─ ', 'lb'), P('FIT decoder', 'tx'), P(pad('  VO2 max · PRs', W2 - 16), 'lb'), V, P('◀────────', 'res2'), V, sp(W3), V],
  [V, P(pad(' Cursor · Codex · …', W1), 'lb'), V, P(pad(' numbers', G), 'lb'), V, P('  └─ ', 'lb'), P('D1 archive', 'tx'), P(' '), P('◀──', 'cron'), P(pad(' cron /10 min', W2 - 19), 'lb'), V, P(pad('  data', G), 'lb'), V, P(pad(' 24 h token', W3), 'lb'), V],
  [bot(W1), sp(G), bot(W2), sp(G), bot(W3)],
];
const FLOW = new Set(['req1', 'req2', 'res1', 'res2', 'cron']);

const hexRgb = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const DIM = [61, 64, 69];
const HOT = hexRgb(RAMP[4]);
const COOL = hexRgb(RAMP[0]);
const mixRgb = (a: number[], b: number[], k: number) => `rgb(${a.map((v, n) => Math.round(v + (b[n] - v) * k)).join(',')})`;

/** Position of an arrow cell along the round trip: AI → Worker → Garmin → Worker → AI. */
const posOf = (c: string, i: number) => (c === 'req1' ? i : c === 'req2' ? 12 + i : c === 'res2' ? 24 + (8 - i) : c === 'res1' ? 36 + (8 - i) : -1);

/** Column of the pulse head in the 96-column diagram, for a camera to follow. */
export const FLOW_COLS = 96;
export const headColumn = (h: number) => {
  const ks: [number, number][] = [
    [0, 23], [9, 32], [12, 69], [21, 78], [24, 78], [33, 69], [36, 32], [45, 23], [50, 23],
  ];
  if (h <= 0) return 23;
  for (let i = 1; i < ks.length; i++) if (h <= ks[i][0]) return ks[i - 1][1] + ((ks[i][1] - ks[i - 1][1]) * (h - ks[i - 1][0])) / (ks[i][0] - ks[i - 1][0]);
  return 23;
};
export const headRow = (h: number) => (h < 22.5 ? 3 : 4);

export const FlowDiagram: React.FC<{ head: number; cron: number; glow?: number; label?: (s: string) => React.CSSProperties | undefined }> = ({
  head,
  cron,
  glow = 0,
  label,
}) => (
  <pre className="ascii-flow" id="flow" aria-label="Your AI app connects to /mcp on your Cloudflare Worker with OAuth or a bearer key. The Worker analyzes data from its D1 archive, which a cron job fills every 10 minutes from Garmin's read-only Personal API.">
    {ROWS.map((row, r) => (
      <React.Fragment key={r}>
        {row.map(({ s, c }, n) => {
          if (c && FLOW.has(c)) {
            return [...s].map((ch, i) => {
              let k: number;
              if (c === 'cron') {
                const d = cron - (2 - i);
                k = d >= 0 && d < 3 ? 1 - d / 3 : 0;
              } else {
                const d = head - posOf(c, i);
                k = d >= 0 && d < 6 ? 1 - d / 6 : 0;
              }
              const target = c.startsWith('res') || c === 'cron' ? COOL : HOT;
              const style: React.CSSProperties | undefined = k
                ? { color: mixRgb(DIM, target, k), textShadow: glow ? `0 0 ${(glow * 10 * k).toFixed(1)}px rgba(${target.join(',')}, ${(0.85 * k).toFixed(2)})` : undefined }
                : undefined;
              return (
                <span key={`${n}-${i}`} className="f" data-c={c} data-i={i} style={style}>
                  {ch}
                </span>
              );
            });
          }
          return c ? (
            <span key={n} className={c} style={label?.(s)}>
              {s}
            </span>
          ) : (
            <React.Fragment key={n}>{s}</React.Fragment>
          );
        })}
        {r < ROWS.length - 1 ? '\n' : null}
      </React.Fragment>
    ))}
  </pre>
);

export const FACTS: [string, string, string][] = [
  ['01', 'Archive first', 'Tools read a D1 archive and fetch only missing or recent days. Recent days are re-checked, because watches sync late.'],
  ['02', 'Background sync', 'Every 10 minutes a cron job refreshes recent days and walks back through your history, inside the Workers limits.'],
  ['03', 'Fast FIT decoder', 'Reads a one-hour activity in about a millisecond, 20× faster than Garmin’s JavaScript SDK.'],
  ['04', 'Hidden metrics', 'VO2 max = field 7 × 3.5 / 65536 from message 140. Anything less certain is labelled experimental.'],
];
