import { sec } from './lib/time';

/*
 * The cut list at 60 fps. Each scene starts at the midpoint of the ASCII wipe that brings it in,
 * so a scene's frame 0 is fully covered and its content starts a few frames later.
 * README.md lists these as music cue points.
 */
export const SCENES = {
  hero: { from: 0, dur: 780 }, // 1 intro trace, 2 headline, 3 chat card
  math: { from: 780, dur: 300 }, // 4 code does the math
  bento: { from: 1080, dur: 350 }, // 5 feature bento
  demo: { from: 1430, dur: 360 }, // 6 the real run
  setup: { from: 1790, dur: 488 }, // 7 setup in six beats
  flow: { from: 2278, dur: 215 }, // 8 architecture
  end: { from: 2493, dur: 290 }, // 9 end card
} as const;

export const TOTAL = SCENES.end.from + SCENES.end.dur;

/** Frames the wipe takes to cover (before a cut) and to reveal (after it). */
export const WIPE = 30;

/** Beats inside the hero scene. */
export const HERO = {
  trace: 0,
  headline: sec(3.3),
  chat: sec(7.85),
};
