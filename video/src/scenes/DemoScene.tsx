import React, { useRef } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { useFrame, useRest } from '../lib/rest';
import { type Cam, Layer, per, useLayoutKind } from '../lib/camera';
import { easeOut, prog } from '../lib/time';
import { Type } from '../lib/type';
import { center } from '../site/AsciiCanvas';
import { useAnchors } from '../site/anchors';
import { pop, rise } from '../site/anim';
import { camKeys, fitBox, HEAD_TEXT, withEyebrow, zFloor } from './MathScene';

/* Scene 6: the real run (#demo). The 5K stats type in, the split bars grow, then the PB table fills
   in oldest to newest and today's 17:21 lights up. */

const SPLITS: [string, number, string, boolean][] = [
  ['km 1', 0.62, '3:22', false],
  ['km 2', 0.74, '3:26', false],
  ['km 3', 0.82, '3:29', false],
  ['km 4', 1, '3:36', true],
  ['km 5', 0.8, '3:28', false],
];
const PBS: [string, string, number, string, string][] = [
  ['10 May 2024', '18:20', 1100, '3:40', '184 / 194'],
  ['30 Aug 2025', '18:59', 1139, '3:46', '182 / 196'],
  ['3 Mar 2026', '18:21', 1101, '3:40', '185 / 191'],
  ['26 Mar 2026', '18:53', 1133, '3:46', '180 / 186'],
  ['17 Apr 2026*', '18:41', 1121, '3:37', '191 / 198'],
  ['17 Jul 2026', '18:16', 1096, '3:39', '190 / 197'],
  ['10 Oct 2026', '17:54', 1074, '3:34', '190 / 198'],
  ['23 Oct 2026', '17:21', 1041, '3:28', '189 / 199'],
];

export const DemoScene: React.FC = () => {
  const frame = useFrame();
  const rest = useRest();
  const layout = useLayoutKind();
  const wide = layout === 'wide';
  const { width: W, height: H } = useVideoConfig();
  const root = useRef<HTMLDivElement>(null);
  const A = useAnchors(root, {
    text: HEAD_TEXT,
    ask1: '.turn:nth-child(1) .ask',
    stats: '.turn:nth-child(1) .stats',
    pacing: '.turn:nth-child(1) .r-block:nth-child(1)',
    reply1: '.turn:nth-child(1) .reply',
    ask2: '.turn:nth-child(2) .ask',
    headline: '.turn:nth-child(2) .headline',
    pbs: '.pbs',
    today: '.pbs .pb:last-child',
  });

  // Turn 1
  const T1 = { ask: 26, used: 38, reply: 46, stats: 54, splits: 84 };
  // Turn 2
  const T2 = { ask: 168, used: 180, reply: 188, headline: 196, rows: 206, today: 262 };

  const camAt = (f: number): Cam => {
    if (!A) return { x: W / 2, y: H / 2, z: 1 };
    const zf = zFloor(layout);
    const head = fitBox(withEyebrow(A.text), W, H, 0.78, 0.5, per(layout, { wide: 1.45, tall: 1.9 }), zf);
    const top1 = fitBox(
      { x: A.reply1.x, y: A.ask1.y, w: A.reply1.w, h: A.pacing.y + A.pacing.h - A.ask1.y },
      W,
      H,
      0.92,
      0.9,
      per(layout, { wide: 1.3, tall: 1.4, feed: 1.2 }),
      zf,
    );
    const stats = fitBox(A.stats, W, H, 0.86, 0.6, per(layout, { wide: 1.6, tall: 1.4 }), zf);
    const pacing = fitBox(A.pacing, W, H, 0.6, 0.7, per(layout, { wide: 1.75, tall: 1.55 }), zf);
    const t2 = fitBox(
      { x: A.pbs.x, y: A.ask2.y, w: A.pbs.w, h: A.pbs.y + A.pbs.h - A.ask2.y },
      W,
      H,
      0.92,
      0.92,
      per(layout, { wide: 1.32, tall: 1.4, feed: 1.2 }),
      zf,
    );
    const today = fitBox(
      { x: A.today.x, y: A.today.y - A.today.h * 2.5, w: A.today.w, h: A.today.h * 4 },
      W,
      H,
      0.84,
      0.8,
      per(layout, { wide: 1.7, tall: 1.6 }),
      zf,
    );
    const mid =
      layout === 'wide'
        ? { x: (stats.x + pacing.x) / 2, y: (stats.y + pacing.y) / 2, z: Math.min(stats.z, pacing.z) }
        : { x: center(A.reply1).x, y: (stats.y + pacing.y) / 2, z: zf * 1.04 };
    return camKeys(f, [
      [0, { ...head, z: head.z * 1.04 }],
      [14, head],
      [52, top1],
      [100, mid],
      [150, { ...mid, z: mid.z * 1.04 }],
      [206, t2],
      [256, t2],
      [296, today],
      [360, { ...today, z: today.z * 1.05 }],
    ]);
  };
  const cam = rest ? { x: W / 2, y: H / 2, z: 1 } : camAt(frame);
  const prev = rest ? undefined : camAt(frame - 1);

  const stat = (text: string, small: string, i: number) => (
    <div style={pop(frame - (T1.stats + i * 6), 3, 0.45)}>
      <Type className="dot dot-md" text={text} at={T1.stats + 4 + i * 6} slow={1.6} />
      <small>{small}</small>
    </div>
  );

  return (
    <AbsoluteFill className={wide ? '' : 'v-stack'}>
      <Layer cam={cam} prev={prev} id="cam-demo">
        <div ref={root} style={{ position: 'relative', width: W, paddingTop: rest ? 0 : 80 }}>
          <section className="section" id="demo" style={rest ? undefined : { paddingTop: 0 }}>
            <div className="wrap">
              <div className="head">
                <p className="eyebrow" style={rise(frame - 1, 1.5)}>A real conversation</p>
                <Type as="h2" className="dot dot-lg" text="ONE RUN." at={2} slow={1.1} />
                <Type as="h2" className="dot dot-lg dim" text="EVERY 5K." at={14} slow={1.1} />
                <p className="sub" style={rise(frame - 12, 1.5)}>
                  Two questions after a track session, in Claude. Every number below came from Threshold’s tools, not from the model.
                </p>
              </div>
              <div className="convo">
                <div className="turn">
                  <p className="ask" style={pop(frame - T1.ask, 4, 0.5)}>
                    Using Threshold, give me some insights about my most recent run.
                  </p>
                  <span className="used" style={pop(frame - T1.used, 3, 0.4)}>
                    <i className="ok">✓</i>Used analyze_activity
                  </span>
                  <div className="reply aura aura-flame" style={rise(frame - T1.reply, 2.5, 0.7)}>
                    <div className="stats">
                      {stat('5.01', 'km', 0)}
                      {stat('17:21', 'time', 1)}
                      {stat('3:28', '/km', 2)}
                      {stat('60.5', 'VO2 max', 3)}
                    </div>
                    <div className="r-grid">
                      <div className="r-block">
                        <h3>Pacing</h3>
                        <ul className="splits" aria-label="Kilometre splits">
                          {SPLITS.map(([km, w, t, slow], i) => {
                            const g = prog(frame, T1.splits + i * 7, 34, easeOut);
                            return (
                              <li key={km} className={slow ? 'slow' : undefined} style={{ ['--w' as string]: String(w * g) }}>
                                <span>{km}</span>
                                <i />
                                <b style={{ opacity: prog(frame, T1.splits + i * 7 + 16, 12) }}>{t}</b>
                              </li>
                            );
                          })}
                        </ul>
                        <p>You started too fast: km 1 was 3:22, and km 4 was the slowest at 3:36, a 14 s spread. You recovered in km 5 for a good finish.</p>
                      </div>
                      <div className="r-block">
                        <h3>Heart rate</h3>
                        <div className="kv">
                          <span>Average</span>
                          <b>189 bpm</b>
                        </div>
                        <div className="kv">
                          <span>Max</span>
                          <b>199 bpm</b>
                        </div>
                        <div className="kv">
                          <span>Zone 5</span>
                          <b>15:02 · 87%</b>
                        </div>
                        <p>HR rose from 176 in km 1 to 196 in km 5 while the pace dropped: cardiac drift under a hard load.</p>
                      </div>
                      <div className="r-block">
                        <h3>Form</h3>
                        <div className="kv">
                          <span>Cadence</span>
                          <b>172 → 157 spm</b>
                        </div>
                        <p>Fatigue shortened your stride rhythm. The cadence drop matches the pace fade in km 4.</p>
                      </div>
                      <div className="r-block">
                        <h3>Load and effect</h3>
                        <div className="kv">
                          <span>Training load</span>
                          <b>158</b>
                        </div>
                        <div className="kv">
                          <span>Aerobic / anaerobic</span>
                          <b>3.4 / 2.4</b>
                        </div>
                        <div className="kv">
                          <span>Performance condition</span>
                          <b>6 → 1</b>
                        </div>
                        <p>Garmin labels it a VO2 max session. At 25–27 °C, the heat added to the drift.</p>
                      </div>
                    </div>
                    <div className="todo">
                      <h3>What to do next</h3>
                      <ul>
                        <li>Start at 3:28/km, not 3:22. Even splits can save about 5–10 s over 5 km.</li>
                        <li>Run easy or rest tomorrow. Garmin’s recovery estimate is about 29 hours (unverified field).</li>
                        <li>Keep your cadence near 170 in the late laps.</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div className="turn">
                  <p className="ask" style={pop(frame - T2.ask, 4, 0.5)}>
                    Yes, compare it with every 5K I’ve done.
                  </p>
                  <span className="used" style={pop(frame - T2.used, 3, 0.4)}>
                    <i className="ok">✓</i>Used 8 tools · list_activities, personal_records, analyze_activity…
                  </span>
                  <div className="reply aura aura-violet" style={rise(frame - T2.reply, 2.5, 0.7)}>
                    <p className="headline" style={rise(frame - T2.headline, 1.5, 0.5)}>
                      <Type className="dot dot-md hot" text="PB −33 s." at={T2.headline + 2} slow={1.6} /> Today is your best 5K, 33 s faster than your previous best.
                    </p>
                    <div className="pbs" role="table" aria-label="Every 5K effort">
                      <div className="pb pb-h" role="row">
                        <span role="columnheader">Date</span>
                        <span role="columnheader">Time</span>
                        <span role="columnheader" className="bar-col" />
                        <span role="columnheader">Pace</span>
                        <span role="columnheader">HR avg / max</span>
                      </div>
                      {PBS.map(([d, t, tsec, pace, hr], i) => {
                        const today = i === PBS.length - 1;
                        const f = frame - (today ? T2.today : T2.rows + i * 6);
                        const g = prog(f, 4, 30, easeOut);
                        const lit = today ? prog(f, 18, 26, easeOut) : 1;
                        return (
                          <div
                            key={d}
                            className={`pb${today && lit > 0 ? ' today' : ''}`}
                            role="row"
                            style={{
                              ['--t' as string]: String(1180 - (1180 - tsec) * g),
                              ...(f < 0 ? { opacity: 0 } : pop(f, 3, 0.4)),
                              ...(today && lit < 1 ? { background: `rgba(255, 122, 69, ${0.1 * lit})` } : {}),
                            }}
                          >
                            <span role="cell">{d}</span>
                            <b
                              role="cell"
                              style={
                                today && lit > 0 && lit < 1
                                  ? { display: 'inline-block', transform: `scale(${1 + Math.sin(lit * Math.PI) * 0.35})`, textShadow: `0 0 ${18 * Math.sin(lit * Math.PI)}px rgba(255, 122, 69, 0.8)` }
                                  : undefined
                              }
                            >
                              {t}
                            </b>
                            <i role="cell" />
                            <span role="cell">{pace}</span>
                            <span role="cell">{hr}</span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="foot-note" style={rise(frame - (T2.today + 20), 1)}>
                      * That run was 5.17 km.
                    </p>
                    <div className="r-grid">
                      <div className="r-block">
                        <h3>Insights</h3>
                        <ul className="plain">
                          <li>59 s faster than your first 5K in May 2024, and 33 s gained in 13 days.</li>
                          <li>HR stayed near 190 in the last four efforts, so the same effort now gives a faster pace: a fitness gain. Your March efforts had a lower HR (180–185).</li>
                          <li>Your best 4K pace is 3:21 (18 Jun). Your 5K pace is now close to it.</li>
                        </ul>
                      </div>
                      <div className="r-block">
                        <h3>Fair test</h3>
                        <ul className="plain">
                          <li>Today was on a flat track at 25 °C.</li>
                          <li>10 Oct was outdoors at 29 °C with 12 m of climb; 17 Jul was at 33 °C.</li>
                          <li>Conditions explain part of the gain.</li>
                        </ul>
                      </div>
                      <div className="r-block">
                        <h3>Next target</h3>
                        <div className="big">
                          <span className="dot dot-md">17:00</span>
                          <small>needs 3:24/km</small>
                        </div>
                        <p>Hold even splits, and don’t start at 3:22.</p>
                      </div>
                      <div className="r-block">
                        <h3>Limits</h3>
                        <p>
                          Only 6 runs have full FIT data, so splits can’t be compared for older efforts. Only runs of about 5 km are counted; a 5K inside a longer run
                          is not included.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </Layer>
    </AbsoluteFill>
  );
};
