import { useLayoutEffect, useState } from 'react';
import { type Box, offsetIn } from './AsciiCanvas';

/**
 * Measures elements inside `root` once, after the first layout, so cameras can frame real site
 * components instead of guessed coordinates. Re-measures if the root changes size. A list of
 * selectors measures the union of everything they match (e.g. the inline spans of a headline, which
 * hug the text where the block is full width). Layout offsets only, so a measurement never depends
 * on which frame a render tab happened to start on.
 */
export function useAnchors<K extends string>(root: React.RefObject<HTMLElement | null>, sel: Record<K, string | string[]>) {
  const [a, setA] = useState<{ size: string; boxes: Record<K, Box> } | null>(null);
  useLayoutEffect(() => {
    const r = root.current;
    if (!r) return;
    const size = `${r.offsetWidth}x${r.offsetHeight}`;
    if (a && a.size === size) return;
    const boxes = {} as Record<K, Box>;
    for (const k of Object.keys(sel) as K[]) {
      const list = ([] as string[]).concat(sel[k]);
      let u: Box | null = null;
      for (const s of list) {
        r.querySelectorAll<HTMLElement>(s).forEach((el) => {
          const b = offsetIn(el, r);
          if (!u) u = b;
          else {
            const x = Math.min(u.x, b.x);
            const y = Math.min(u.y, b.y);
            u = { x, y, w: Math.max(u.x + u.w, b.x + b.w) - x, h: Math.max(u.y + u.h, b.y + b.h) - y };
          }
        });
      }
      boxes[k] = u ?? { x: 0, y: 0, w: 0, h: 0 };
    }
    setA({ size, boxes });
  });
  return a?.boxes ?? null;
}
