import { useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';
import { loadFont as loadDoto } from '@remotion/google-fonts/Doto';
import { loadFont as loadInterTight } from '@remotion/google-fonts/InterTight';
import { loadFont as loadJetBrainsMono } from '@remotion/google-fonts/JetBrainsMono';

/*
 * The site's Google Fonts request: Doto 100..900 (it uses 600–800), Inter Tight 400/500/600 and
 * JetBrains Mono 400/500/700, Latin subsets. Each loadFont() holds the render until its files load.
 * Note site.css lists 'Helvetica Neue' before Inter Tight, so on a Mac both the site and the video set
 * body text in Helvetica Neue; elsewhere both fall back to Inter Tight.
 */
const subsets: ('latin' | 'latin-ext')[] = ['latin', 'latin-ext'];
const faces = [
  loadDoto('normal', { weights: ['600', '700', '800', '900'], subsets }),
  loadInterTight('normal', { weights: ['400', '500', '600'], subsets }),
  loadJetBrainsMono('normal', { weights: ['400', '500', '700'], subsets }),
];

export const fontsReady: Promise<void> = Promise.all(faces.map((f) => f.waitUntilDone())).then(() => document.fonts.ready.then(() => undefined));

/** Nothing mounts until the fonts have loaded, so canvases measure and draw with the real glyphs. */
export function useFonts() {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    fontsReady.then(() => {
      setReady(true);
      continueRender(handle);
    });
  }, [handle]);
  return ready;
}
