import React, { useRef } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { useFrame, useRest } from '../lib/rest';
import { Blur, type Cam, Layer, per, useLayoutKind } from '../lib/camera';
import { easeOut, prog } from '../lib/time';
import { Type } from '../lib/type';
import { center } from '../site/AsciiCanvas';
import { useAnchors } from '../site/anchors';
import { pop, rise } from '../site/anim';
import { AuraIgnite, DotChart, loadCell, powerCell } from '../site/Bento';
import { camKeys, fitBox, HEAD_TEXT, withEyebrow, zFloor } from './MathScene';

/* Scene 5: the feature bento. Cards fly in one by one and their aura glow ignites; the dot charts
   light up; the camera ends inside the VO2 card as 58.4 types in. */

const SIGNALS: [string, string, string][] = [
  ['amber', 'HRV', '49 ms · slightly low'],
  ['green', 'Resting HR', '47 bpm · +1'],
  ['green', 'Sleep', '7 h 24 · score 82'],
  ['green', 'Body Battery', 'charged to 71'],
  ['blue', 'Training form', 'TSB −12'],
  ['amber', 'Load ramp', 'ACWR 1.34'],
];
const CLIENTS = ['Claude', 'ChatGPT', 'Claude Code', 'Cursor', 'VS Code', 'Codex', 'Gemini CLI', 'Windsurf', 'any MCP client'];

const FLY = 30;

export const BentoScene: React.FC = () => {
  const frame = useFrame();
  const rest = useRest();
  const layout = useLayoutKind();
  const wide = layout === 'wide';
  const { width: W, height: H } = useVideoConfig();
  const root = useRef<HTMLDivElement>(null);
  const A = useAnchors(root, {
    head: '.head',
    text: HEAD_TEXT,
    bento: '.bento',
    ready: '.b-ready',
    vo2: '.b-vo2',
    load: '.b-load',
    sql: '.b-sql',
    num: ['.b-vo2 .dot-hero', '.b-vo2 .big small'],
  });

  const at = wide
    ? { ready: 44, vo2: 56, load: 68, fit: 80, sql: 92, all: 104 }
    : { ready: 44, vo2: 56, load: 98, fit: 110, sql: 122, all: 134 };
  const VO2 = wide ? 186 : 214;

  const camAt = (f: number): Cam => {
    if (!A) return { x: W / 2, y: H / 2, z: 1 };
    const zf = zFloor(layout);
    const head = fitBox(withEyebrow(A.text), W, H, 0.78, 0.5, per(layout, { wide: 1.45, tall: 1.9 }), zf);
    const all = fitBox(
      { x: A.bento.x, y: A.head.y, w: A.bento.w, h: A.bento.y + A.bento.h - A.head.y },
      W,
      H,
      0.96,
      0.96,
      per(layout, { wide: 1.02, tall: 1.25 }),
      zf,
    );
    const top = fitBox({ x: A.ready.x, y: A.head.y, w: A.ready.w, h: A.vo2.y + A.vo2.h - A.head.y }, W, H, 0.94, 0.9, 1.3, zf);
    const low = fitBox({ x: A.load.x, y: A.load.y, w: A.bento.w, h: A.bento.y + A.bento.h - A.load.y }, W, H, 0.94, 0.9, 1.3, zf);
    const vo2 = wide ? fitBox(A.vo2, W, H, 0.84, 0.84, 2.0) : fitBox(A.num, W, H, 0.7, 0.4, 2.0, zf);
    const num = { ...center(A.num), z: vo2.z * 1.08 };
    const vo2Late = { x: vo2.x * 0.6 + num.x * 0.4, y: vo2.y * 0.6 + num.y * 0.4, z: num.z };
    return wide
      ? camKeys(f, [
          [0, { ...head, z: head.z * 1.05 }],
          [40, head],
          [96, all],
          [VO2 - 44, all],
          [VO2 + 4, vo2],
          [350, vo2Late],
        ])
      : camKeys(f, [
          [0, { ...head, z: head.z * 1.05 }],
          [40, head],
          [88, top],
          [104, top],
          [146, low],
          [VO2 - 40, low],
          [VO2 + 8, vo2],
          [350, vo2Late],
        ]);
  };
  const cam = rest ? { x: W / 2, y: H / 2, z: 1 } : camAt(frame);
  const prev = rest ? undefined : camAt(frame - 1);

  /** A card flying in from below with its glow igniting as it lands. */
  const card = (key: keyof typeof at, aura: string, className: string, children: React.ReactNode) => {
    const f = frame - at[key];
    const y = (g: number) => (1 - easeOut(Math.min(1, Math.max(0, g / FLY)))) * 220;
    const k = prog(f, 0, FLY, easeOut);
    const ign = prog(f, FLY * 0.45, 40, easeOut);
    return (
      <Blur
        as="article"
        id={`fly-${key}`}
        vx={0}
        vy={y(f) - y(f - 1)}
        className={`aura aura-${aura} ${className}`}
        style={{
          opacity: f < 0 ? 0 : Math.min(1, k * 2),
          transform: k < 1 ? `translateY(${y(f)}px) scale(${0.9 + 0.1 * k})` : undefined,
          backgroundImage: ign < 1 ? 'none' : undefined,
          // A soft light passes over each card once it has landed (.aura::after follows --mx/--my).
          ['--mx' as string]: f > FLY && !rest ? `${-200 + (f - FLY) * 22}px` : '-999px',
          ['--my' as string]: '30%',
        }}
      >
        <AuraIgnite aura={aura} k={f < 0 ? 0 : ign} />
        {children}
      </Blur>
    );
  };

  const sig = (i: number) => pop(frame - (at.ready + 22 + i * 5), 3, 0.4);

  return (
    <AbsoluteFill className={wide ? '' : 'v-stack'}>
      <Layer cam={cam} prev={prev} id="cam-bento">
        <div ref={root} style={{ position: 'relative', width: W, paddingTop: rest ? 0 : per(layout, { wide: 60, tall: 120, feed: 80 }) }}>
          <section className="section" id="features" style={rest ? undefined : { paddingTop: 0 }}>
            <div className="wrap">
              <div className="head">
                <p className="eyebrow" style={rise(frame - 4, 1.5)}>What it does</p>
                <Type as="h2" className="dot dot-lg" text="16 TOOLS." at={8} slow={1.5} />
                <Type as="h2" className="dot dot-lg dim" text="ZERO GUESSES." at={26} slow={1.5} />
              </div>
              <div className="bento">
                {card(
                  'ready',
                  'moss',
                  'b-ready',
                  <>
                    <p className="eyebrow">daily_briefing</p>
                    <h3>Daily readiness</h3>
                    <p>HRV, resting heart rate, sleep, Body Battery, training form and load ramp against your own 60-day baselines, with a green, amber or red call.</p>
                    <ul className="signals">
                      {SIGNALS.map(([k, n, v], i) => (
                        <li key={n} style={sig(i)}>
                          <i className={`sig ${k}`} />
                          {n}
                          <span>{v}</span>
                        </li>
                      ))}
                    </ul>
                  </>,
                )}
                {card(
                  'vo2',
                  'ember',
                  'b-vo2',
                  <>
                    <p className="eyebrow">Hidden VO2 max</p>
                    <div className="big">
                      <Type className="dot dot-hero" text="58.4" at={VO2} slow={2.2} />
                      <small style={rise(frame - VO2 - 20, 1)}>ml/kg/min</small>
                    </div>
                    <p>Decoded from the FIT file’s undocumented message 140, where Garmin keeps VO2 max and performance condition but leaves them out of the API.</p>
                  </>,
                )}
                {card(
                  'load',
                  'flame',
                  'b-load',
                  <>
                    <p className="eyebrow">training_load</p>
                    <h3>Training load</h3>
                    <DotChart id="chart-load" rows={12} cell={loadCell} lit={prog(frame, at.load + 18, 56, (x) => x)} />
                    <div className="legend">
                      <span>
                        <i style={{ background: '#ff7a45' }} />
                        Fatigue ATL 70
                      </span>
                      <span>
                        <i style={{ background: '#f4f3ef' }} />
                        Fitness CTL 58
                      </span>
                      <span>Form −12</span>
                    </div>
                    <p>CTL, ATL, TSB, acute:chronic ratio, monotony and strain, by week and by sport.</p>
                  </>,
                )}
                {card(
                  'fit',
                  'violet',
                  'b-fit',
                  <>
                    <p className="eyebrow">analyze_activity</p>
                    <h3>FIT file analysis</h3>
                    <DotChart id="chart-power" rows={12} cell={powerCell} lit={prog(frame, at.fit + 18, 56, (x) => x)} />
                    <div className="legend">
                      <span>5 s</span>
                      <span>1 min</span>
                      <span>5 min</span>
                      <span>20 min</span>
                      <span>60 min</span>
                    </div>
                    <p>Splits, HR zones, best efforts, power curve, aerobic decoupling and drift, NP, IF and TSS.</p>
                  </>,
                )}
                {card(
                  'sql',
                  'azure',
                  'b-sql',
                  <>
                    <p className="eyebrow">query_archive</p>
                    <h3>Full history + SQL</h3>
                    <pre className="sql">
                      <code>
                        <b>SELECT</b> strftime(<s>'%Y-%m'</s>, date) <b>AS</b> month,{'\n'}
                        {'       '}
                        <b>SUM</b>(elevation_gain_m) <b>AS</b> climb_m{'\n'}
                        <b>FROM</b> activities{'\n'}
                        <b>GROUP BY</b> month <b>ORDER BY</b> climb_m <b>DESC</b>
                        {'\n'}
                        <b>LIMIT</b> 3;
                      </code>
                    </pre>
                    <p>A private D1 archive of every day and activity. Read-only SQL for any question.</p>
                  </>,
                )}
                {card(
                  'all',
                  'graphite',
                  'b-all',
                  <>
                    <div>
                      <p className="eyebrow">Works everywhere</p>
                      <h3>Web, desktop, phone, terminal</h3>
                    </div>
                    <ul className="clients">
                      {CLIENTS.map((c, i) => (
                        <li key={c} style={pop(frame - (at.all + 14 + i * 3), 3, 0.35)}>
                          {c}
                        </li>
                      ))}
                    </ul>
                  </>,
                )}
              </div>
            </div>
          </section>
        </div>
      </Layer>
    </AbsoluteFill>
  );
};
