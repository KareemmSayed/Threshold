import { createContext, useContext } from 'react';
import { useCurrentFrame } from 'remotion';

/*
 * Rest mode, for checking the video against the live site: a scene renders its section exactly as
 * the site lays it out (camera at 1×, site paddings, every one-shot animation finished), with the
 * time-driven parts set to the moment the site was screenshotted. Only the Compare composition uses it.
 */
export type Rest = {
  /** Site clock (ms) of the last hero canvas, flow diagram and wordmark draws. */
  heroT: number;
  flowT: number;
  wordT: number;
  /** Which hero cycle word is showing. */
  word: number;
  /** The setup guide's first step progress bar (0..1). */
  guideP: number;
};

export const RestCtx = createContext<Rest | null>(null);
export const useRest = () => useContext(RestCtx);

/**
 * A frame late enough for every one-shot animation to have finished, and a whole number of periods
 * of the site's looping CSS animations (pulse 2.4 s, spin 0.7 s, blink 1 s, marquee 70 s), so those
 * sit at their resting phase as they do with animations off.
 */
export const REST_FRAME = 25200;

/** The current frame, or REST_FRAME in rest mode. */
export function useFrame() {
  const f = useCurrentFrame();
  return useRest() ? REST_FRAME : f;
}
