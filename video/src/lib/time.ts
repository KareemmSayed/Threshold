import { Easing } from 'remotion';

export const FPS = 60;

/** Seconds to frames. */
export const sec = (s: number) => Math.round(s * FPS);
/** Frames to milliseconds. */
export const ms = (frames: number) => (frames * 1000) / FPS;

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const mix = (a: number, b: number, k: number) => a + (b - a) * k;
/** site.js smooth(): smoothstep between a and b. */
export const smooth = (a: number, b: number, v: number) => {
  const k = clamp((v - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};

/** The site's --ease-out, cubic-bezier(0.16, 1, 0.3, 1). */
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
/** The guide cursor's travel curve, cubic-bezier(0.65, 0, 0.35, 1). */
export const easeCursor = Easing.bezier(0.65, 0, 0.35, 1);
export const easeInOut = Easing.bezier(0.45, 0, 0.2, 1);

/** 0..1 progress of `frame` through [start, start + dur], eased. */
export const prog = (frame: number, start: number, dur: number, ease: (t: number) => number = easeOut) =>
  ease(clamp((frame - start) / Math.max(1, dur), 0, 1));

/** Piecewise keyframes: [[frame, value], ...] with the site's easing between them. */
export const keys = (frame: number, ks: [number, number][], ease: (t: number) => number = easeInOut) => {
  if (frame <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    const [f1, v1] = ks[i];
    const [f0, v0] = ks[i - 1];
    if (frame <= f1) return mix(v0, v1, ease((frame - f0) / Math.max(1, f1 - f0)));
  }
  return ks[ks.length - 1][1];
};
