import React, { useRef } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { useFrame, useRest } from '../lib/rest';
import { type Cam, Layer, type Layout, per, useLayoutKind } from '../lib/camera';
import { easeInOut, easeOut, FPS, keys, prog } from '../lib/time';
import { Type } from '../lib/type';
import { type Box, center } from '../site/AsciiCanvas';
import { useAnchors } from '../site/anchors';
import { pop, rise } from '../site/anim';
import { RawJson, READOUT, Verdict } from '../site/Why';

/* Scene 4: CODE DOES THE MATH. Raw JSON blurs away; the computed readout and the AMBER verdict snap in. */

/** Frame box `b` so it fills `fillW` of the width or `fillH` of the height, zoom kept in [zmin, zmax]. */
export const fitBox = (b: Box, W: number, H: number, fillW: number, fillH: number, zmax: number, zmin = 1): Cam => ({
  ...center(b),
  z: Math.max(zmin, Math.min(zmax, (fillW * W) / b.w, (fillH * H) / b.h)),
});

/** The camera's resting zoom: 1 for the wide cut, 1.25 for the portrait cuts' 864 px page. */
export const zFloor = (l: Layout) => (l === 'wide' ? 1 : 1.25);

/** A headline's text: its inline spans hug the words, where the h2 blocks are full width. */
export const HEAD_TEXT = '.head h2 > span';
/** Grow a headline's box upward to take in its eyebrow. */
export const withEyebrow = (b: Box): Box => ({ x: b.x, y: b.y - 30, w: b.w, h: b.h + 30 });
export const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export const camKeys = (f: number, ks: [number, Cam][]): Cam => ({
  x: keys(f, ks.map(([k, c]) => [k, c.x]), easeInOut),
  y: keys(f, ks.map(([k, c]) => [k, c.y]), easeInOut),
  z: keys(f, ks.map(([k, c]) => [k, c.z]), easeInOut),
});

export const MathScene: React.FC = () => {
  const frame = useFrame();
  const rest = useRest();
  const layout = useLayoutKind();
  const wide = layout === 'wide';
  // The 4:5 cut swaps the two cards in one slot; 16:9 and 9:16 have room for both.
  const shared = layout === 'feed';
  const { width: W, height: H } = useVideoConfig();
  const root = useRef<HTMLDivElement>(null);
  const A = useAnchors(root, { head: '.head', text: HEAD_TEXT, versus: '.versus', calc: '.vs-calc', raw: '.vs-raw', verdict: '.verdict' });

  const T = { eyebrow: 6, l1: 12, l2: 33, sub: 58, raw: 36, calc: 46, blur: 128, rows: 142, verdict: 196, foot: 232 };

  const camAt = (f: number): Cam => {
    if (!A) return { x: W / 2, y: H / 2, z: 1 };
    const zf = zFloor(layout);
    const head = fitBox(withEyebrow(A.text), W, H, 0.78, 0.5, per(layout, { wide: 1.5, tall: 1.9 }), zf);
    const overview = fitBox(union(A.head, wide || shared ? A.versus : A.raw), W, H, 0.94, 0.92, per(layout, { wide: 1.08, tall: 1.3 }), zf);
    const calc = fitBox(A.calc, W, H, 0.9, 0.82, per(layout, { wide: 1.62, tall: 1.32 }), zf);
    const verdict = { ...center(A.verdict), z: calc.z * 1.06 };
    const late = { x: calc.x * 0.7 + verdict.x * 0.3, y: calc.y * 0.7 + verdict.y * 0.3, z: verdict.z };
    return camKeys(f, [
      [0, { ...head, z: head.z * 1.05 }],
      [56, head],
      [104, overview],
      [126, overview],
      [186, calc],
      [300, late],
    ]);
  };
  const cam = rest ? { x: W / 2, y: H / 2, z: 1 } : camAt(frame);
  const prev = rest ? undefined : camAt(frame - 1);

  const blur = rest ? 0 : prog(frame, T.blur, 34, easeOut);
  const rawStyle: React.CSSProperties = {
    ...(blur > 0
      ? {
          filter: `blur(${blur * 14}px)`,
          opacity: 1 - blur * (shared ? 1 : 0.72),
          transform: `scale(${1 - blur * 0.04}) translateX(${wide ? -blur * 24 : 0}px)`,
        }
      : rise(frame - T.raw, 2.5, 0.8)),
    ...(shared ? { gridArea: '1 / 1' } : {}),
  };
  const calcStyle: React.CSSProperties = shared ? { ...pop(frame - (T.blur + 4), 4, 0.5), gridArea: '1 / 1' } : rise(frame - T.calc, 2.5, 0.8);

  return (
    <AbsoluteFill className={wide ? '' : 'v-stack'}>
      <Layer cam={cam} prev={prev} id="cam-math">
        <div ref={root} style={{ position: 'relative', width: W, paddingTop: rest ? 0 : per(layout, { wide: 60, tall: 200, feed: 120 }) }}>
          <section className="section" id="why" style={rest ? undefined : { paddingTop: 0 }}>
            <div className="wrap">
              <div className="head">
                <p className="eyebrow" style={rise(frame - T.eyebrow, 1.5)}>Why Threshold</p>
                <Type as="h2" className="dot dot-lg" text="CODE DOES" at={T.l1} slow={1.5} />
                <Type as="h2" className="dot dot-lg dim" text="THE MATH." at={T.l2} slow={1.5} />
                <p className="sub" style={rise(frame - T.sub, 1.5)}>
                  Other Garmin MCP servers hand the model raw JSON and hope. Threshold computes every number and shows the rule behind it.
                </p>
              </div>
              <div className="versus">
                <div className="vs-card vs-raw" style={rawStyle}>
                  <div className="vs-head">
                    <span>Typical Garmin MCP</span>
                    <span className="chip chip-danger">model guesses</span>
                  </div>
                  <div className="raw-scroll" aria-hidden="true">
                    <RawJson t={rest ? 0 : frame / FPS} speed={7} />
                  </div>
                  <p className="vs-foot">100 fields per item. The model does arithmetic in its head.</p>
                </div>
                {!shared ? (
                  <div
                    className="vs-arrow"
                    aria-hidden="true"
                    style={{
                      ...rise(frame - T.calc, 2, 0.6),
                      transform: `${wide ? '' : 'rotate(90deg) '}translateX(${Math.sin(Math.min(1, prog(frame, T.blur, 40, (x) => x)) * Math.PI) * 14}px)`,
                    }}
                  >
                    →
                  </div>
                ) : null}
                <div className="vs-card vs-calc aura aura-moss" style={calcStyle}>
                  <div className="vs-head">
                    <span>Threshold · daily_briefing</span>
                    <span className="chip chip-ok">computed in code</span>
                  </div>
                  <table className="readout">
                    <tbody>
                      {READOUT.map(([th, v, ref, sig, note], i) => {
                        const f = frame - (T.rows + i * 8);
                        const k = prog(f, 0, 12, easeOut);
                        const flash = f >= 0 && f < 24 ? 1 - f / 24 : 0;
                        return (
                          <tr key={th} style={{ opacity: f < 0 ? 0 : k, transform: k < 1 ? `translateX(${(1 - k) * -18}px)` : undefined }}>
                            <th>{th}</th>
                            <td>{v}</td>
                            <td>{ref}</td>
                            <td>
                              <i className={`sig ${sig}`} style={flash ? { transform: `scale(${1 + flash * 0.9})` } : undefined} />
                              {note}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <Verdict
                    at={T.verdict + 4}
                    style={{
                      ...pop(frame - T.verdict, 4, 0.45),
                      ...(frame >= T.verdict && frame < T.verdict + 40
                        ? { boxShadow: `0 0 0 ${(1 - (frame - T.verdict) / 40) * 6}px rgba(255, 178, 36, ${0.25 * (1 - (frame - T.verdict) / 40)})` }
                        : {}),
                    }}
                  />
                  <p className="vs-foot" style={rise(frame - T.foot, 1)}>
                    Rule: amber = 1 warning or 2+ cautions.
                  </p>
                </div>
              </div>
              <Compare />
            </div>
          </section>
        </div>
      </Layer>
    </AbsoluteFill>
  );
};

const ROWS: [string, string, string][] = [
  ['Readiness, training load (CTL/ATL/TSB, ACWR), HRV baseline', 'model guesses from raw JSON', 'computed in code, rules shown'],
  ['Aerobic decoupling, cardiac drift, best efforts, power curve', 'no', 'from the original FIT file'],
  ['VO2 max and performance condition hidden from the API', 'no', 'decoded from the FIT file'],
  ['Full-history archive with SQL', 'no', 'D1 archive, read-only SQL tool'],
  ['Works on your phone (Claude / ChatGPT mobile)', 'rarely', 'OAuth built in'],
  ['Hosting', 'your laptop must stay on', 'Cloudflare free tier, one click'],
  ['Privacy', 'GPS and names in every response', 'GPS and identifiers removed by default'],
];

/** .compare: the table under the two cards. */
const Compare: React.FC = () => (
  <div className="compare" role="table" aria-label="Typical Garmin MCP compared with Threshold">
    <div className="cmp-row cmp-h" role="row">
      <span role="columnheader" />
      <span role="columnheader">Typical Garmin MCP</span>
      <span role="columnheader">Threshold</span>
    </div>
    {ROWS.map(([h, no, yes]) => (
      <div className="cmp-row" role="row" key={h}>
        <span role="rowheader">{h}</span>
        <span className="no" role="cell">
          {no}
        </span>
        <span className="yes" role="cell">
          {yes}
        </span>
      </div>
    ))}
  </div>
);
