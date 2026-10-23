import React, { useMemo, useRef } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { useFrame, useRest } from '../lib/rest';
import { drawWord, wordMask } from '../lib/ascii';
import { type Cam, Layer, per, useLayoutKind } from '../lib/camera';
import { rand } from '../lib/rand';
import { easeInOut, FPS, keys, mix, prog } from '../lib/time';
import { Type } from '../lib/type';
import { AsciiCanvas } from '../site/AsciiCanvas';
import { livePulse, pop } from '../site/anim';

/* Scene 9: the end card. The ASCII THRESHOLD wordmark resolves out of noise, READY IN FIVE MINUTES.
   types in, and the Deploy to Cloudflare button and the site address land. */

export const EndScene: React.FC = () => {
  const frame = useFrame();
  const rest = useRest();
  const layout = useLayoutKind();
  const { width: W, height: H } = useVideoConfig();
  const masks = useRef<{ key: string; m: ReturnType<typeof wordMask> } | null>(null);
  const seed = useMemo(() => (i: number, j: number) => rand(91, i, j) * 0.85 + (i / 400) * 0.15, []);

  const z = keys(frame, [
    [0, 1.1],
    [290, 1.0],
  ]);
  const cam: Cam = { x: W / 2, y: H / 2, z: rest ? 1 : z };
  const prevCam: Cam | undefined = rest ? undefined : { ...cam, z: keys(frame - 1, [[0, 1.1], [290, 1.0]]) };
  const form = prog(frame, 4, 70, easeInOut);
  // A light passes over the wordmark, as the site's pointer does on hover.
  const sweep = prog(frame, 50, 120, easeInOut);

  return (
    <AbsoluteFill>
      <Layer cam={cam} prev={prevCam} id="cam-end">
        <div style={rest ? { position: 'relative', width: W } : { position: 'relative', width: W, height: H, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <section className="end" id="start" style={{ marginTop: 0 }}>
            <AsciiCanvas
              className="ascii-word"
              fontSize={11}
              cell={1.15}
              dpr={rest ? 1 : 2}
              style={rest ? undefined : { marginTop: 0, marginBottom: per(layout, { wide: 24, tall: 60 }) }}
              draw={(a) => {
                const key = `${a.w}x${a.h}`;
                if (!masks.current || masks.current.key !== key) masks.current = { key, m: wordMask(a.w, a.h) };
                drawWord(a, masks.current.m, rest ? rest.wordT / 1000 : frame / FPS, {
                  pointer: sweep > 0 && sweep < 1 ? { x: mix(-160, a.w + 160, sweep), y: a.h * 0.5 } : { x: -1e4, y: -1e4 },
                  form,
                  seed,
                });
              }}
            />
            <div className="wrap end-copy" style={layout === 'wide' || rest ? undefined : { transform: 'scale(1.3)', transformOrigin: '50% 0' }}>
              <Type as="h2" className="dot dot-lg" text="READY IN" at={52} slow={1.5} />
              <Type as="h2" className="dot dot-lg hot" text="FIVE MINUTES." at={70} slow={1.5} />
              <div className="cta center">
                <a className="btn btn-lg btn-ink" style={pop(frame - 104, 4, 0.5)}>
                  Deploy to Cloudflare <span aria-hidden="true">→</span>
                </a>
                <a className="btn btn-lg btn-line" style={pop(frame - 110, 4, 0.5)}>
                  Read the README
                </a>
              </div>
              {rest ? null : (
                <a className="tag" style={{ ...pop(frame - 128, 3, 0.5), alignSelf: 'center', marginTop: 28 }}>
                  <span className="live" style={livePulse(frame)} />
                  kareemmsayed.github.io/Threshold
                </a>
              )}
            </div>
          </section>
          {rest ? (
            <footer className="foot">
              <div className="wrap">
                <p>
                  Threshold is open source under the MIT license. Not affiliated with or endorsed by Garmin. Garmin and Garmin Connect are trademarks of Garmin Ltd. or its
                  subsidiaries. Not medical advice.
                </p>
                <p className="foot-links">
                  <a>GitHub</a>
                  <a>Security</a>
                  <a>llms.txt</a>
                </p>
              </div>
            </footer>
          ) : null}
        </div>
      </Layer>
    </AbsoluteFill>
  );
};
