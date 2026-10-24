import React, { useLayoutEffect, useRef } from 'react';
import { AbsoluteFill } from 'remotion';
import { LayoutProvider } from './lib/camera';
import { useFonts } from './lib/fonts';
import { type Rest, RestCtx } from './lib/rest';
import { BentoScene } from './scenes/BentoScene';
import { DemoScene } from './scenes/DemoScene';
import { EndScene } from './scenes/EndScene';
import { FlowScene } from './scenes/FlowScene';
import { HeroScene } from './scenes/HeroScene';
import { MathScene } from './scenes/MathScene';
import { SetupScene } from './scenes/SetupScene';

/*
 * One site section in rest mode at 1920×1080, its top `top` px from the top of the frame (where the
 * screenshot of the live site has it; fractional, and placed by layout rather than a transform so the
 * pixels snap the same way), for scripts/compare.mjs to diff. `probe` logs where elements landed, to
 * find layout drift.
 */
export const SECTIONS = {
  top: HeroScene,
  why: MathScene,
  features: BentoScene,
  demo: DemoScene,
  setup: SetupScene,
  how: FlowScene,
  start: EndScene,
};

export type CompareProps = { section: keyof typeof SECTIONS; top: number; rest: Rest; probe?: string[] };

export const Compare: React.FC<CompareProps> = ({ section, top, rest, probe }) => {
  const ready = useFonts();
  const Scene = SECTIONS[section];
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ready || !probe?.length || !ref.current) return;
    const base = ref.current.getBoundingClientRect().top;
    const at = Object.fromEntries(
      probe.map((s) => {
        const r = ref.current!.querySelector(s)?.getBoundingClientRect();
        return [s, r ? [+(r.top - base).toFixed(2), +r.height.toFixed(2)] : null];
      }),
    );
    console.log('PROBE ' + JSON.stringify(at));
  });
  return (
    <LayoutProvider value="wide">
      <RestCtx.Provider value={rest}>
        <AbsoluteFill style={{ background: '#000' }}>
          {ready ? (
            <div ref={ref} style={{ position: 'absolute', left: 0, right: 0, top }}>
              <Scene />
            </div>
          ) : null}
        </AbsoluteFill>
      </RestCtx.Provider>
    </LayoutProvider>
  );
};
