import React, { useLayoutEffect, useRef, useState } from 'react';
import { continueRender, delayRender } from 'remotion';

/*
 * Liquid glass, as initGlass() in site.js builds it: an SVG displacement map bends the backdrop at the
 * edges and splits it into R, G and B. The map is sized to the element, so it is measured once laid out,
 * and the frame waits until the map image has decoded.
 */

const mapFor = (w: number, h: number, r: number) => {
  const e = Math.min(w, h) * 0.035;
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs>` +
        `<linearGradient id="r" x1="100%" y1="0%" x2="0%" y2="0%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient>` +
        `<linearGradient id="b" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient></defs>` +
        `<rect width="${w}" height="${h}" fill="black"/>` +
        `<rect width="${w}" height="${h}" rx="${r}" fill="url(#r)"/>` +
        `<rect width="${w}" height="${h}" rx="${r}" fill="url(#b)" style="mix-blend-mode:difference"/>` +
        `<rect x="${e}" y="${e}" width="${w - 2 * e}" height="${h - 2 * e}" rx="${r}" fill="hsl(0 0% 50% / .93)" style="filter:blur(11px)"/></svg>`,
    )
  );
};

/** Returns the filter defs to render and the inline style for a `.glass` element with `data-glass`. */
export function useLiquidGlass(id: string, ref: React.RefObject<HTMLElement | null>, frost: number, blur = 6) {
  const [map, setMap] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!w || !h) return;
    const radius = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 20, h / 2);
    const next = mapFor(Math.round(w), Math.round(h), radius);
    if (next === map || next === pending.current) return;
    pending.current = next;
    const handle = delayRender(`liquid glass map ${id}`);
    const img = new Image();
    const done = () => requestAnimationFrame(() => requestAnimationFrame(() => continueRender(handle)));
    img.onload = () => {
      setMap(next);
      done();
    };
    img.onerror = done;
    img.src = next;
  });

  const defs = (
    <svg className="glass-defs" aria-hidden="true">
      <defs>
        <filter id={id} colorInterpolationFilters="sRGB" x="0%" y="0%" width="100%" height="100%">
          <feImage x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" href={map ?? undefined} />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={-180} xChannelSelector="R" yChannelSelector="G" result="dr" />
          <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="red" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={-170} xChannelSelector="R" yChannelSelector="G" result="dg" />
          <feColorMatrix in="dg" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="green" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={-160} xChannelSelector="R" yChannelSelector="G" result="db" />
          <feColorMatrix in="db" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="blue" />
          <feBlend in="red" in2="green" mode="screen" result="rg" />
          <feBlend in="rg" in2="blue" mode="screen" result="out" />
          <feGaussianBlur in="out" stdDeviation="0.7" />
        </filter>
      </defs>
    </svg>
  );
  const f = map ? `url(#${id}) blur(${blur}px) saturate(1.7)` : undefined;
  const style = {
    backdropFilter: f,
    WebkitBackdropFilter: f,
    ['--frost' as string]: String(frost),
  } as React.CSSProperties;
  return { defs, style, className: map ? 'liquid' : '' };
}
