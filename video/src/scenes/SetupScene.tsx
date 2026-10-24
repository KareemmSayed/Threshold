import React, { useLayoutEffect, useRef, useState } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { useFrame, useRest } from '../lib/rest';
import { type Cam, Layer, per, useLayoutKind } from '../lib/camera';
import { clamp, easeCursor, easeInOut, FPS, mix, prog } from '../lib/time';
import { Type } from '../lib/type';
import { type Box } from '../site/AsciiCanvas';
import { useAnchors } from '../site/anchors';
import { fadein, pop, ripple, rise } from '../site/anim';
import { BEATS, STEPS } from '../site/Guide';
import { camKeys, fitBox, HEAD_TEXT, withEyebrow, zFloor } from './MathScene';

/* Scene 7: setup in six fast beats. The guide replays its screens with a bigger cursor, and the camera
   leans toward wherever the cursor is about to click. */

export const INTRO = 30;
export const BEAT_AT = BEATS.map((_, i) => INTRO + BEATS.slice(0, i).reduce((s, b) => s + b.dur, 0));
export const SETUP_DUR = BEAT_AT[BEATS.length - 1] + BEATS[BEATS.length - 1].dur;

const CURSOR_SCALE = 1.7;
/** Frames the next screen takes to fade in over the last one. */
const XFADE = 12;

export const SetupScene: React.FC = () => {
  const frame = useFrame();
  const rest = useRest();
  const layout = useLayoutKind();
  const wide = layout === 'wide';
  const { width: W, height: H } = useVideoConfig();
  const root = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const A = useAnchors(root, { head: '.head', text: HEAD_TEXT, guide: '.guide', wrap: '.stage-wrap', stage: '.stage', steps: '.steps' });

  // Rest mode shows the guide as the site does just after it starts: step 1, before the cursor moves.
  let bi = 0;
  while (!rest && bi < BEATS.length - 1 && frame >= BEAT_AT[bi + 1]) bi++;
  const beat = BEATS[bi];
  const lf = rest ? 0 : frame - BEAT_AT[bi];

  // Where each [data-k] target is inside the stage right now, rebuilt every frame from the DOM alone.
  const [targets, setTargets] = useState<{ beat: string; boxes: Record<string, Box> }>({ beat: '', boxes: {} });
  // The camera's transform is taken off while measuring, so the result depends only on this frame's
  // layout (never on the camera, which depends on the result) and the update settles in one pass.
  useLayoutEffect(() => {
    const st = stageRef.current;
    if (!st) return;
    const cam = st.closest<HTMLElement>('[data-camera]');
    const saved = cam?.style.transform ?? '';
    if (cam) cam.style.transform = 'none';
    const sr = st.getBoundingClientRect();
    const boxes: Record<string, Box> = {};
    st.querySelectorAll<HTMLElement>('.screen:not(.prev) [data-k]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const q = (v: number) => Math.round(v * 8) / 8;
      boxes[el.dataset.k!] = { x: q(r.left - sr.left), y: q(r.top - sr.top), w: q(r.width), h: q(r.height) };
    });
    if (cam) cam.style.transform = saved;
    const next = { beat: beat.name, boxes };
    if (JSON.stringify(next) !== JSON.stringify(targets)) setTargets(next);
  });
  const boxes = targets.beat === beat.name ? targets.boxes : {};

  // Portrait: the steps are one row that scrolls to keep the current step in view (renderList()).
  const stepsRef = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const ol = stepsRef.current;
    if (!ol || wide) return;
    const items = [...ol.children] as HTMLElement[];
    const max = ol.scrollWidth - ol.clientWidth;
    const at = (i: number) => clamp(items[i].offsetLeft - items[0].offsetLeft - 16, 0, max);
    const k = easeInOut(clamp(lf / 20, 0, 1));
    ol.scrollLeft = Math.round(mix(at(Math.max(0, bi - 1)), at(bi), bi === 0 ? 1 : k));
  });

  const stageW = A?.stage.w ?? 800;
  const stageH = A?.stage.h ?? 500;
  /** The cursor inside the stage at beat frame f (transform: translate in site.js point()). */
  const cursorAt = (f: number) => {
    let from = { x: stageW * 0.55, y: stageH * 0.62 };
    let pos = from;
    for (const m of beat.moves) {
      if (f < m.at) break;
      const b = boxes[m.k];
      const to = b ? { x: b.x + b.w * (m.dx ?? 0.5), y: b.y + b.h * (m.dy ?? 0.55) } : from;
      const k = easeCursor(clamp((f - m.at) / m.dur, 0, 1));
      pos = { x: mix(from.x, to.x, k), y: mix(from.y, to.y, k) };
      from = to;
    }
    return pos;
  };
  const shownAt = beat.moves[0]?.at ?? Infinity;
  const show = rest ? 0 : lf < shownAt ? 0 : beat.hideAt !== undefined && lf >= beat.hideAt ? 1 - prog(lf, beat.hideAt, 18) : prog(lf, shownAt, 18);
  const cur = cursorAt(lf);
  const lastClick = [...beat.clicks].reverse().find((c) => c.at <= lf);
  const sinceClick = lastClick ? lf - lastClick.at : 999;

  const camAt = (f: number): Cam => {
    if (!A) return { x: W / 2, y: H / 2, z: 1 };
    const zf = zFloor(layout);
    const head = fitBox(withEyebrow(A.text), W, H, 0.78, 0.5, per(layout, { wide: 1.4, tall: 1.9 }), zf);
    const base = wide ? fitBox(A.guide, W, H, 0.94, 0.86, 1.5) : fitBox(A.wrap, W, H, 0.98, 0.6, 1.32, zf);
    const intro = camKeys(f, [
      [0, { ...head, z: head.z * 1.04 }],
      [8, head],
      [INTRO + 8, base],
    ]);
    if (f < INTRO + 8) return intro;
    // Lean toward the cursor (averaged over a few frames, so it trails like a camera operator).
    let b = 0;
    while (b < BEATS.length - 1 && f >= BEAT_AT[b + 1]) b++;
    if (b !== bi) return base;
    let sx = 0;
    let sy = 0;
    const N = 10;
    for (let i = 0; i < N; i++) {
      const p = cursorAt(f - BEAT_AT[b] - i);
      sx += p.x;
      sy += p.y;
    }
    const p = { x: A.stage.x + sx / N, y: A.stage.y + sy / N };
    const lf2 = f - BEAT_AT[b];
    // Ease in from the intro move's end so the hand-over has no jump.
    const hand = easeInOut(clamp((f - (INTRO + 8)) / 18, 0, 1));
    const active = beat.moves.length
      ? hand * easeInOut(clamp((lf2 - beat.moves[0].at + 4) / 16, 0, 1)) * (1 - easeInOut(clamp((lf2 - (beat.dur - 14)) / 14, 0, 1)))
      : 0;
    const click = beat.clicks.reduce((m, c) => {
      const d = lf2 - c.at;
      const bump = d < -10 ? 0 : d < 0 ? easeInOut((d + 10) / 10) : Math.max(0, 1 - d / 26);
      return Math.max(m, bump * hand);
    }, 0);
    const lean = per(layout, { wide: 0.42, tall: 0.12 }) * active;
    return {
      x: mix(base.x, p.x, lean),
      y: mix(base.y, p.y, lean),
      z: base.z * (1 + per(layout, { wide: 0.2, tall: 0.07 }) * active + per(layout, { wide: 0.07, tall: 0.05 }) * click),
    };
  };
  const cam = rest ? { x: W / 2, y: H / 2, z: 1 } : camAt(frame);
  const prev = rest ? undefined : camAt(frame - 1);

  const toast = [...beat.toasts].reverse().find(([at]) => at <= lf && lf < at + 1.7 * FPS);

  return (
    <AbsoluteFill className={wide ? '' : 'v-stack'}>
      <Layer cam={cam} prev={prev} id="cam-setup">
        <div ref={root} style={rest ? { position: 'relative', width: W } : { position: 'relative', width: W, height: H, paddingTop: per(layout, { wide: 40, tall: 360, feed: 120 }) }}>
          <section className="section setup" id="setup" style={rest ? undefined : { paddingTop: 0, height: '100%' }}>
            {/* .setup-glow is left out: on the site it sits at z-index -1 under the body's black
                background and never shows, so showing it here would not match. */}
            <div className="wrap">
              <div className="head">
                <p className="eyebrow" style={rise(frame - 1, 1.5)}>Set up · 5 minutes</p>
                <Type as="h2" className="dot dot-lg" text="SIX STEPS." at={2} slow={1.1} />
                <Type as="h2" className="dot dot-lg dim" text="WATCH THEM." at={14} slow={1.1} />
                <p className="sub" style={rise(frame - 10, 1.5)}>
                  You need a free <a>Cloudflare account</a> and a Garmin watch that syncs to Garmin Connect. Pick your app:
                </p>
              </div>
              <div className="seg" role="tablist" aria-label="Your AI app" style={rise(frame - 12, 1.5)}>
                <button role="tab" aria-selected="true">
                  Claude
                </button>
                <button role="tab" aria-selected="false">
                  ChatGPT
                </button>
                <button role="tab" aria-selected="false">
                  Claude Code
                </button>
              </div>
              <div className="guide">
                <ol className="steps" ref={stepsRef}>
                  {STEPS.map(([t, d], i) => {
                    const on = i === bi;
                    const p = i < bi ? 1 : on ? (rest ? rest.guideP : Math.min(0.96, lf / beat.dur)) : 0;
                    return (
                      <li key={t} className={on ? 'on' : i < bi ? 'done' : undefined} style={rise(frame - (14 + i * 3), 1.2)}>
                        <button type="button">
                          <span className="n dot">{String(i + 1).padStart(2, '0')}</span>
                          <span className="t">
                            <b>{t}</b>
                            <span>{d}</span>
                          </span>
                          <i className="bar" style={{ ['--p' as string]: p.toFixed(3) }} />
                        </button>
                      </li>
                    );
                  })}
                </ol>
                <div className="stage-wrap glass" style={rise(frame - 10, 2, 0.8)}>
                  <div className="stage" ref={stageRef} aria-hidden="true">
                    <div className="chrome">
                      <span className="lights">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="url">
                        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                          <path
                            fill="currentColor"
                            d="M3.5 5V3.6a2.5 2.5 0 015 0V5h.5a1 1 0 011 1v4a1 1 0 01-1 1h-6a1 1 0 01-1-1V6a1 1 0 011-1zm1 0h3V3.6a1.5 1.5 0 00-3 0z"
                          />
                        </svg>
                        <span>{beat.url}</span>
                      </span>
                    </div>
                    {/* The last screen stays underneath while the next fades in, so a light screen never cuts to black. */}
                    {!rest && bi > 0 && lf < XFADE ? (
                      <div className="screen prev" key={`prev-${BEATS[bi - 1].name}`} aria-hidden="true">
                        {BEATS[bi - 1].render(BEATS[bi - 1].dur)}
                      </div>
                    ) : null}
                    <div className="screen" key={beat.name} style={rest ? undefined : { opacity: easeInOut(clamp(lf / XFADE, 0, 1)) }}>
                      {beat.render(lf)}
                      {/* The site's pop keyframes end on transform: none, which drops .toast's translateX(-50%); so does this. */}
                      {toast ? (
                        <div className="toast" style={pop(lf - toast[0], 2.5, 0.3)}>
                          {toast[1]}
                        </div>
                      ) : null}
                    </div>
                    <div className="cursor show" style={{ transform: `translate(${cur.x}px, ${cur.y}px)`, opacity: show }}>
                      <svg
                        viewBox="0 0 20 24"
                        width="20"
                        height="24"
                        style={{ transformOrigin: '2px 2px', transform: `scale(${CURSOR_SCALE * (sinceClick < 17 ? 0.88 : 1)})` }}
                      >
                        <path d="M2 1.5v18.2l4.6-4.4 3 6.6 3.1-1.4-3-6.5h6.4z" fill="#fff" stroke="#000" strokeWidth="1.4" strokeLinejoin="round" />
                      </svg>
                      <i style={ripple(sinceClick, CURSOR_SCALE)} />
                    </div>
                  </div>
                  <div className="stage-foot">
                    <p id="stage-caption" key={beat.name} style={rest ? undefined : fadein(lf, 0.3)}>
                      {beat.cap}
                    </p>
                    <div className="ctrls">
                      <button type="button">‹</button>
                      <button type="button" id="g-play">
                        ❚❚
                      </button>
                      <button type="button">›</button>
                    </div>
                  </div>
                </div>
              </div>
              <details className="later">
                <summary>Add or change a key later</summary>
              </details>
            </div>
          </section>
        </div>
      </Layer>
    </AbsoluteFill>
  );
};

