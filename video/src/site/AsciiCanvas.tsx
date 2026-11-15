import React, { useLayoutEffect, useRef } from 'react';
import { AsciiGrid } from '../lib/ascii';

/**
 * A canvas drawn once per frame, synchronously in a layout effect so the frame is complete before
 * Remotion captures it. The backing store is 2× so camera push-ins stay sharp.
 */
export const AsciiCanvas: React.FC<{
  className: string;
  fontSize: number;
  cell: number;
  dpr?: number;
  style?: React.CSSProperties;
  draw: (a: AsciiGrid) => void;
}> = ({ className, fontSize, cell, dpr = 2, style, draw }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const grid = useRef<AsciiGrid | null>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    const g = grid.current;
    if (!g || g.w !== w || g.h !== h || g.fs !== fontSize) grid.current = new AsciiGrid(canvas, w, h, fontSize, cell, dpr);
    draw(grid.current!);
  });
  return <canvas ref={ref} className={className} style={style} aria-hidden="true" />;
};

/** Layout position of `el` relative to `root`, ignoring transforms (camera moves, rise offsets). */
export function offsetIn(el: HTMLElement, root: HTMLElement) {
  const abs = (n: HTMLElement | null) => {
    let x = 0;
    let y = 0;
    while (n) {
      x += n.offsetLeft;
      y += n.offsetTop;
      n = n.offsetParent as HTMLElement | null;
    }
    return { x, y };
  };
  const a = abs(el);
  const b = abs(root);
  return { x: a.x - b.x, y: a.y - b.y, w: el.offsetWidth, h: el.offsetHeight };
}

export type Box = { x: number; y: number; w: number; h: number };
export const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
