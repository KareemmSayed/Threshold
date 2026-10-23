import React, { useRef } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { useFrame, useRest } from '../lib/rest';
import { type Cam, Layer, per, useLayoutKind } from '../lib/camera';
import { clamp, easeInOut, mix, ms } from '../lib/time';
import { Type } from '../lib/type';
import { center } from '../site/AsciiCanvas';
import { useAnchors } from '../site/anchors';
import { rise } from '../site/anim';
import { FACTS, FlowDiagram, FLOW_COLS, headColumn, headRow } from '../site/Flow';
import { camKeys, fitBox } from './MathScene';

/* Scene 8: the ASCII architecture diagram; one request travels AI → Worker → Garmin and back while
   the camera rides along. */

const PULSE_AT = 30;
const CELLS_PER_FRAME = 50 / 168;

export const FlowScene: React.FC = () => {
  const frame = useFrame();
  const rest = useRest();
  const layout = useLayoutKind();
  const wide = layout === 'wide';
  const { width: W, height: H } = useVideoConfig();
  const root = useRef<HTMLDivElement>(null);
  const A = useAnchors(root, { head: '.head', flow: '.flow', pre: '.ascii-flow', facts: '.facts' });

  const headAt = (f: number) => (f - PULSE_AT) * CELLS_PER_FRAME;
  // The site's draw(): head = (time / 75) % 50 cells, cron = (time / 140) % 6.
  const head = rest ? (rest.flowT / 75) % 50 : headAt(frame);
  const cron = ((rest ? rest.flowT : ms(frame)) / 140) % 6;

  const camAt = (f: number): Cam => {
    if (!A) return { x: W / 2, y: H / 2, z: 1 };
    const intro = fitBox({ x: A.flow.x, y: A.head.y, w: A.flow.w, h: A.flow.y + A.flow.h - A.head.y }, W, H, 0.9, 0.8, per(layout, { wide: 1.3, tall: 1.05 }));
    const cw = A.pre.w / FLOW_COLS;
    const rowH = A.pre.h / 7;
    const h = clamp(headAt(f), 0, 50);
    const px = A.pre.x + headColumn(h) * cw;
    const py = A.pre.y + (headRow(h) + 0.5) * rowH;
    const zf = per(layout, { wide: (0.8 * W) / A.pre.w, tall: (1.55 * W) / A.pre.w });
    const lean = per(layout, { wide: 0.14, tall: 0.88 });
    const c = center(A.pre);
    const follow = { x: mix(c.x, px, lean), y: mix(c.y, py, 0.35), z: zf * (1 + 0.06 * easeInOut(clamp((f - PULSE_AT) / 170, 0, 1))) };
    const settle = camKeys(f, [
      [0, { ...intro, z: intro.z * 1.04 }],
      [10, intro],
    ]);
    if (f < 10) return settle;
    const k = easeInOut(clamp((f - 10) / 26, 0, 1));
    return { x: mix(intro.x, follow.x, k), y: mix(intro.y, follow.y, k), z: mix(intro.z, follow.z, k) };
  };
  const cam = rest ? { x: W / 2, y: H / 2, z: 1 } : camAt(frame);
  const prev = rest ? undefined : camAt(frame - 1);

  // Each box's main label brightens while the request is inside it.
  const near = (a: number, b: number) => {
    const d = head < a ? a - head : head > b ? head - b : 0;
    return Math.max(0, 1 - d / 3);
  };
  const label = (s: string): React.CSSProperties | undefined => {
    if (rest) return undefined;
    const k = s.includes('/mcp') ? Math.max(near(9, 12), near(33, 36)) : s.includes('Personal API') ? near(21, 24) : s.includes('How am I') ? near(45, 50) : 0;
    return k ? { color: '#fff', textShadow: `0 0 ${12 * k}px rgba(244, 243, 239, ${0.6 * k})` } : undefined;
  };

  return (
    <AbsoluteFill className={wide ? '' : 'v-stack'}>
      <Layer cam={cam} prev={prev} id="cam-flow">
        <div ref={root} style={{ position: 'relative', width: W, paddingTop: rest ? 0 : per(layout, { wide: 120, tall: 520, feed: 220 }) }}>
          <section className="section" id="how" style={rest ? undefined : { paddingTop: 0 }}>
            <div className="wrap">
              <div className="head">
                <p className="eyebrow" style={rise(frame - 1, 1.5)}>Under the hood</p>
                <Type as="h2" className="dot dot-lg" text="HOW IT" at={2} slow={1.1} />
                <Type as="h2" className="dot dot-lg dim" text="WORKS." at={14} slow={1.1} />
              </div>
              <div className="flow" style={rise(frame - 6, 2, 0.7)}>
                <FlowDiagram head={head} cron={cron} glow={rest ? 0 : 1} label={label} />
              </div>
              <div className="facts">
                {FACTS.map(([n, h, p], i) => (
                  <div className="fact" key={n} style={rise(frame - (24 + i * 5), 2)}>
                    <span className="dot dot-sm">{n}</span>
                    <h3>{h}</h3>
                    <p>{p}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </Layer>
    </AbsoluteFill>
  );
};
