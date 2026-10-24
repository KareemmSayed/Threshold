import React, { useRef } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { useFrame, useRest } from '../lib/rest';
import { drawHero, session, type Rect } from '../lib/ascii';
import { type Cam, Layer, per, useLayoutKind } from '../lib/camera';
import { clamp, easeInOut, keys, mix, ms, prog } from '../lib/time';
import { AsciiCanvas, type Box, center } from '../site/AsciiCanvas';
import { useAnchors } from '../site/anchors';
import { pop } from '../site/anim';
import { HeroChat, HeroCopy, Marquee, Nav } from '../site/Hero';
import { HERO } from '../timeline';

/*
 * Scenes 1–3 in one continuous shot of the site's hero section:
 * 1. the dot field fades in, the threshold line draws, the heart-rate trace sweeps in and crosses it;
 * 2. YOUR GARMIN, types in and the second line cycles IN CLAUDE. → IN CHATGPT. → IN CURSOR.;
 * 3. the camera moves to the liquid-glass chat card and the conversation plays.
 */

const BG_DEPTH = 0.62;

/** Keep the view inside the frame-sized hero so the canvas edge never shows. */
const clampCam = (c: Cam, W: number, H: number): Cam => {
  const z = Math.max(1, c.z);
  const hx = W / (2 * z);
  const hy = H / (2 * z);
  return { z, x: clamp(c.x, hx, W - hx), y: clamp(c.y, hy, H - hy) };
};

/** Zoom that makes `b` take `fill` of the frame, capped. */
const fit = (b: Box, W: number, H: number, fill: number, zmax: number): Cam => ({
  ...center(b),
  z: Math.min(zmax, (fill * W) / b.w, (fill * H) / b.h),
});

export const HeroScene: React.FC = () => {
  const frame = useFrame();
  const rest = useRest();
  const layout = useLayoutKind();
  const { width: W, height: H } = useVideoConfig();
  const root = useRef<HTMLDivElement>(null);
  const A = useAnchors(root, { copy: '.hero-copy', title: '.hero-title .dot-xl > span', chat: '.hero-chat', grid: '.hero-grid' });

  const S2 = HERO.headline;
  const S3 = HERO.chat;

  const camAt = (f: number): Cam => {
    if (!A) return { x: W / 2, y: H / 2, z: 1 };
    const title = fit(A.title, W, H, per(layout, { wide: 0.62, tall: 0.86 }), per(layout, { wide: 1.55, tall: 1.85 }));
    const chat = fit(A.chat, W, H, per(layout, { wide: 0.8, tall: 0.88, feed: 0.84 }), per(layout, { wide: 1.62, tall: 1.9, feed: 1.75 }));
    const all = layout === 'wide' ? { x: W / 2, y: H / 2, z: 1 } : { ...center(A.grid), z: 1.25 };
    // Scene 1 looks at the trace where it crosses the threshold, lower right.
    const trace = per(layout, {
      wide: { x: W * 0.64, y: H * 0.6, z: 1.42 },
      feed: { x: W * 0.55, y: H * 0.66, z: 1.45 },
      tall: { x: W * 0.55, y: H * 0.62, z: 1.5 },
    });
    const traceOut = { x: mix(trace.x, all.x, 0.35), y: mix(trace.y, all.y, 0.35), z: 1.18 };
    const kf = (pick: (c: Cam) => number) =>
      keys(
        f,
        [
          [0, pick(trace)],
          [S2 - 10, pick(traceOut)],
          [S2 + 50, pick(title)],
          [S2 + 175, pick({ ...title, z: title.z * 1.06 })],
          [S3 - 30, pick(all)],
          [S3 + 20, pick(all)],
          [S3 + 75, pick(chat)],
          [S3 + 320, pick({ ...chat, z: chat.z * 1.05 })],
        ],
        easeInOut,
      );
    return clampCam({ x: kf((c) => c.x), y: kf((c) => c.y), z: kf((c) => c.z) }, W, H);
  };
  const cam = rest ? { x: W / 2, y: H / 2, z: 1 } : camAt(frame);
  const prev = rest ? undefined : camAt(frame - 1);

  // Parallax: the canvas and veil sit deeper than the copy. Counter-transform them inside the layer.
  const zd = 1 + (cam.z - 1) * BG_DEPTH;
  const fdx = W / 2 + (cam.x - W / 2) * BG_DEPTH;
  const fdy = H / 2 + (cam.y - H / 2) * BG_DEPTH;
  const s = zd / cam.z;
  const back: React.CSSProperties = {
    transformOrigin: '0 0',
    transform: `translate(${cam.x - s * fdx}px, ${cam.y - s * fdy}px) scale(${s})`,
  };
  // The copy's box in canvas coordinates, for the fade behind the headline (measureHole()).
  const toCanvas = (x: number, y: number) => ({ x: fdx + (cam.z / zd) * (x - cam.x), y: fdy + (cam.z / zd) * (y - cam.y) });
  let hole: Rect | null = null;
  if (A) {
    const p = toCanvas(A.copy.x, A.copy.y);
    const q = toCanvas(A.copy.x + A.copy.w, A.copy.y + A.copy.h);
    hole = { l: p.x - 24, t: p.y - 16, r: q.x + 24, b: q.y + 16 };
  }

  const t = rest ? rest.heroT / 1000 : frame / 60;
  const sweep = prog(frame, 64, 132, easeInOut);
  const lineK = prog(frame, 34, 64, easeInOut);
  const chatT = ms(frame - (S3 + 30));
  const cardIn = frame - (S3 - 58);

  return (
    <AbsoluteFill className={layout === 'wide' ? '' : 'v-stack'}>
      <Layer cam={cam} prev={prev} id="cam-hero">
        <div ref={root} style={{ position: 'relative', width: W, height: H }}>
          <section className="hero" id="top" style={{ height: H, minHeight: H }}>
            <AsciiCanvas
              className="ascii-hero"
              fontSize={13}
              cell={1.28}
              dpr={rest ? 1 : 2}
              style={back}
              draw={(a) => {
                const head = sweep * (a.cols + 30);
                const i = Math.min(a.cols - 1, Math.floor(head));
                const lvl = session(i / a.cols / 1.1 + t * 0.035);
                const y = (a.rows * 0.95 - lvl * a.rows * 0.5) * a.ch;
                drawHero(a, t, {
                  pointer: sweep > 0 && sweep < 1 ? { x: head * a.cw, y } : { x: -1e4, y: -1e4 },
                  hole,
                  holeK: prog(frame, S2 - 6, 40),
                  traceCols: sweep >= 1 ? Infinity : head,
                  lineCols: lineK >= 1 ? Infinity : lineK * a.cols,
                  field: prog(frame, 4, 60),
                  fieldBoost: 1 + 2.2 * (1 - prog(frame, 120, 110)),
                  label: prog(frame, 84, 30),
                });
              }}
            />
            <div className="hero-veil" style={{ ...back, opacity: prog(frame, S2 - 14, 50) }} />
            <div className="wrap hero-grid">
              <HeroCopy f={frame - S2} dim={rest ? 0 : prog(frame, S3 + 24, 50)} />
              <HeroChat t={chatT} style={pop(cardIn, 5, 0.8)} />
            </div>
            <Marquee f={frame} style={{ opacity: prog(frame, S3 - 70, 40) }} />
          </section>
        </div>
      </Layer>
      {/* Portrait frames have no room above the stacked copy, so the nav arrives with the chat. */}
      <Nav style={(() => {
        const at = layout === 'wide' ? S3 - 64 : S3 + 30;
        return { opacity: prog(frame, at, 30), transform: `translateY(${(1 - prog(frame, at, 50)) * -24}px)` };
      })()} />
    </AbsoluteFill>
  );
};


