import type React from 'react';
import { clamp, easeOut, FPS, mix } from '../lib/time';

/*
 * The site's CSS keyframes (site.css @keyframes pop, fadein, pulse, spin, ripple, press, flash, blink,
 * popin, popout, and the .rise reveal) as functions of the frame. `amp` > 1 exaggerates the motion
 * for video; 1 is the site exactly.
 */

const k = (f: number, dur: number) => clamp(f / (dur * FPS), 0, 1);

/** @keyframes pop: 0.32s var(--ease-out), from opacity 0, translateY(6px) scale(.98). */
export const pop = (f: number, amp = 1, dur = 0.32): React.CSSProperties => {
  if (f < 0) return { opacity: 0 };
  const e = easeOut(k(f, dur));
  if (e >= 1) return {};
  return { opacity: e, transform: `translateY(${(1 - e) * 6 * amp}px) scale(${1 - (1 - e) * 0.02 * amp})` };
};

/** @keyframes fadein. */
export const fadein = (f: number, dur = 0.45): React.CSSProperties => (f < 0 ? { opacity: 0 } : { opacity: easeOut(k(f, dur)) });

/** html.js .rise / .rise.in: 0.7s var(--ease-out) from translateY(18px). */
export const rise = (f: number, amp = 1, dur = 0.7): React.CSSProperties => {
  if (f < 0) return { opacity: 0, transform: `translateY(${18 * amp}px)` };
  const e = easeOut(k(f, dur));
  return e >= 1 ? {} : { opacity: e, transform: `translateY(${(1 - e) * 18 * amp}px)` };
};

/** .live: @keyframes pulse, 2.4s var(--ease-out) infinite. */
export const livePulse = (f: number): React.CSSProperties => {
  const t = ((f / FPS) % 2.4) / 2.4;
  if (t < 0.7) {
    const e = easeOut(t / 0.7);
    return { boxShadow: `0 0 0 ${7 * e}px rgba(50, 213, 131, ${0.55 * (1 - e)})` };
  }
  return { boxShadow: '0 0 0 0 transparent' };
};

/** @keyframes spin, 0.7s linear infinite. */
export const spin = (f: number): React.CSSProperties => ({ transform: `rotate(${((f / FPS / 0.7) % 1) * 360}deg)` });

/** @keyframes blink, 1s steps(1): visible for the first half of each second. */
export const blinkOn = (f: number) => (f / FPS) % 1 < 0.5;

/** .cursor.click i: @keyframes ripple, 0.5s var(--ease-out). */
export const ripple = (f: number, amp = 1): React.CSSProperties => {
  if (f < 0 || f > 0.5 * FPS) return { transform: 'scale(0)', opacity: 0 };
  const e = easeOut(k(f, 0.5));
  return { transform: `scale(${mix(0.2, 1.4, e) * amp})`, opacity: 0.9 * (1 - e) };
};

/** .press: @keyframes press, 0.25s ease, scale(.95) and brightness(1.15) at the midpoint. */
export const press = (f: number): React.CSSProperties => {
  if (f < 0 || f > 0.25 * FPS) return {};
  const t = k(f, 0.25);
  const m = 1 - Math.abs(t - 0.5) * 2;
  return { transform: `scale(${1 - 0.05 * m})`, filter: `brightness(${1 + 0.15 * m})` };
};

/** .flash: @keyframes flash, amber background fading out. */
export const flash = (f: number, dur = 0.9): React.CSSProperties => {
  if (f < 0 || f > dur * FPS) return {};
  return { background: `rgba(255, 178, 36, ${0.35 * (1 - k(f, dur))})` };
};
