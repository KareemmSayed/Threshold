import React from 'react';
import { useCurrentFrame } from 'remotion';
import { AsciiGrid, DENS } from '../lib/ascii';
import { rand } from '../lib/rand';
import { clamp } from '../lib/time';
import { WIPE } from '../timeline';
import { AsciiCanvas } from '../site/AsciiCanvas';

/*
 * The cut between scenes, in the site's ASCII language: a front of DENS glyphs (the hero's density
 * ramp, coloured along the effort ramp) sweeps across and leaves black behind it; at the cut the
 * next scene is underneath and a second front clears the black away.
 */

export type WipeDir = 'lr' | 'rl' | 'tb' | 'radial';

const LEAD = 0.88; // share of the wipe spent waiting for the front; the rest is each cell's own change
const CELL = 0.07;
const TRAIL = 0.08;

export const AsciiWipe: React.FC<{ dir?: WipeDir; seed?: number }> = ({ dir = 'lr', seed = 1 }) => {
  const frame = useCurrentFrame();
  // frame 0..2*WIPE inside its Sequence; the cut is at WIPE
  const f = frame - WIPE;
  const covering = f < 0;
  const P = covering ? (f + WIPE) / WIPE : f / WIPE;

  const draw = (a: AsciiGrid) => {
    const { ctx, cols, rows, cw, ch } = a;
    ctx.clearRect(0, 0, a.w, a.h);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const u = i / (cols - 1);
        const v = j / (rows - 1);
        const along =
          dir === 'lr' ? u * 0.86 + v * 0.14 : dir === 'rl' ? (1 - u) * 0.86 + v * 0.14 : dir === 'tb' ? v * 0.88 + u * 0.12 : Math.min(1, Math.hypot(u - 0.5, (v - 0.5) * (a.h / a.w)) * 1.45);
        const d = clamp(along * 0.9 + rand(seed, i, j) * 0.1, 0, 1) * LEAD;
        const k = clamp((P - d) / CELL, 0, 1); // this cell's own progress
        let cover: number;
        let glow: number;
        if (covering) {
          cover = k;
          glow = P < d ? 0 : k < 1 ? 0.55 + 0.45 * k : Math.max(0, 1 - (P - d - CELL) / TRAIL);
        } else {
          cover = 1 - k;
          glow = P < d ? Math.max(0, 1 - (d - P) / TRAIL) : k < 1 ? 1 - k : 0;
        }
        if (cover > 0.002) {
          ctx.globalAlpha = cover;
          ctx.fillStyle = '#000';
          ctx.fillRect(i * cw, j * ch, cw + 0.5, ch + 0.5);
        }
        if (glow > 0.05 && rand(seed + 3, i, j) < 0.82) {
          const idx = Math.max(1, Math.min(9, Math.round(glow * 9 - rand(seed + 7, i, j, frame >> 1) * 2)));
          const col = glow > 0.94 ? 5 : Math.min(4, Math.floor(along * 5));
          const al = glow > 0.8 ? 4 : glow > 0.55 ? 3 : glow > 0.3 ? 2 : 1;
          a.put(col, al, i, DENS[idx]);
        }
      }
      ctx.globalAlpha = 1;
      a.flush(j);
    }
  };

  return (
    <AsciiCanvas
      className="ascii-wipe"
      fontSize={15}
      cell={1.3}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 100 }}
      draw={draw}
    />
  );
};
