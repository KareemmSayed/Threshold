import React, { useLayoutEffect, useRef, useState } from 'react';
import { INK, RAMP } from '../lib/ascii';
import { smooth } from '../lib/time';

/* #features: the dot-matrix charts (dotGrid / initCharts in site.js) and the aura glow origins. */

type Cell = (x: number, row: number) => [string, number] | null;

/**
 * An LED matrix of square dots sized to the SVG, as dotGrid() draws it. `lit` (0..1) lights the
 * columns left to right for video; unlit dots keep the matrix's 6% white.
 */
export const DotChart: React.FC<{ id: string; rows: number; cell: Cell; lit?: number }> = ({ id, rows, cell, lit = 1 }) => {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const w = svg.clientWidth || 300;
    const h = svg.clientHeight || 110;
    if (!size || size[0] !== w || size[1] !== h) setSize([w, h]);
  });
  const [w, h] = size ?? [300, 110];
  const s = h / rows;
  const cols = Math.max(8, Math.floor(w / s));
  const ox = (w - cols * s) / 2;
  const head = lit * (cols + 2);
  const rects: React.ReactNode[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      let [fill, op] = cell(i / (cols - 1), j) || ['#fff', 0.06];
      if (lit < 1 && op > 0.06) {
        const d = head - i;
        if (d < 0) [fill, op] = ['#fff', 0.06];
        else if (d < 2) op = Math.min(1, op * (1 + (2 - d) * 0.6));
      }
      rects.push(
        <rect
          key={i * rows + j}
          x={(ox + i * s + s * 0.17).toFixed(1)}
          y={(j * s + s * 0.17).toFixed(1)}
          width={(s * 0.66).toFixed(1)}
          height={(s * 0.66).toFixed(1)}
          rx={(s * 0.2).toFixed(1)}
          fill={fill}
          fillOpacity={op}
        />,
      );
    }
  }
  return (
    <svg ref={ref} className="dotchart" id={id} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {size ? rects : null}
    </svg>
  );
};

/** Training load: CTL (ink) and ATL (hot) with the gap between them lit faintly. */
export const loadCell: Cell = (() => {
  const rows = 12;
  const toRow = (v: number) => Math.round((rows - 1) * (1 - (v - 30) / 50));
  const ctl = (x: number) => 46 + 12 * smooth(0, 1, x);
  const atl = (x: number) => ctl(x) + 9 * Math.sin(x * Math.PI * 2 * (48 / 7) - 1) + (x > 0.8 ? (x - 0.8) * 45 : 0) - 2;
  return (x, j) => {
    const c = toRow(ctl(x));
    const a = toRow(atl(x));
    if (j === a) return ['#ff7a45', 1];
    if (j === c) return [INK, 0.95];
    if (j > Math.min(a, c) && j < Math.max(a, c)) return ['#ff7a45', 0.16];
    return null;
  };
})();

/** Power curve, 5 s to 60 min on a log axis. */
export const powerCell: Cell = (() => {
  const rows = 12;
  const p = (sec: number) => 250 + 18000 / (sec + 18000 / 700);
  return (x, j) => {
    const sec = 5 * Math.pow(720, x);
    const topRow = Math.round((rows - 1) * (1 - (p(sec) - 200) / 760));
    if (j < topRow) return null;
    const d = j - topRow;
    return [d === 0 ? '#c6a5ff' : RAMP[d < 4 ? 2 : 1], d === 0 ? 1 : Math.max(0.12, 0.6 - d * 0.06)];
  };
})();

/** Where each aura's glow is centred (site.css .aura-*), so the ignition blooms from there. */
export const AURA_ORIGIN: Record<string, string> = {
  moss: '100% 100%',
  ember: '50% -10%',
  flame: '85% 110%',
  violet: '15% 110%',
  azure: '0% 0%',
  graphite: '85% 0%',
};

/**
 * The aura glow lighting up as a card lands: the card's own var(--aura-glow), on a layer that
 * blooms from the glow's centre and settles to exactly the site's gradient.
 */
export const AuraIgnite: React.FC<{ aura: string; k: number }> = ({ aura, k }) =>
  k >= 1 ? null : (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: -1,
        pointerEvents: 'none',
        backgroundImage: 'var(--aura-glow)',
        transformOrigin: AURA_ORIGIN[aura],
        opacity: Math.min(1, k * 1.6),
        transform: `scale(${0.55 + 0.45 * k + Math.sin(k * Math.PI) * 0.12})`,
        filter: `brightness(${1 + Math.sin(k * Math.PI) * 0.9})`,
      }}
    />
  );
