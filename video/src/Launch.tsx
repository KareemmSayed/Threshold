import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { type Layout, LayoutProvider } from './lib/camera';
import { useFonts } from './lib/fonts';
import { AsciiWipe, type WipeDir } from './scenes/AsciiWipe';
import { BentoScene } from './scenes/BentoScene';
import { DemoScene } from './scenes/DemoScene';
import { EndScene } from './scenes/EndScene';
import { FlowScene } from './scenes/FlowScene';
import { HeroScene } from './scenes/HeroScene';
import { MathScene } from './scenes/MathScene';
import { SetupScene } from './scenes/SetupScene';
import { SCENES, WIPE } from './timeline';

const PARTS: { key: keyof typeof SCENES; name: string; C: React.FC; wipe?: WipeDir }[] = [
  { key: 'hero', name: '1–3 Hero', C: HeroScene },
  { key: 'math', name: '4 Code does the math', C: MathScene, wipe: 'lr' },
  { key: 'bento', name: '5 Features', C: BentoScene, wipe: 'lr' },
  { key: 'demo', name: '6 Real run', C: DemoScene, wipe: 'lr' },
  { key: 'setup', name: '7 Setup', C: SetupScene, wipe: 'lr' },
  { key: 'flow', name: '8 Architecture', C: FlowScene, wipe: 'tb' },
  { key: 'end', name: '9 End card', C: EndScene, wipe: 'radial' },
];

export const Launch: React.FC<{ layout: Layout }> = ({ layout }) => {
  const ready = useFonts();
  return (
    <LayoutProvider value={layout}>
      <AbsoluteFill style={{ background: '#000' }}>
        {ready ? (
          <>
            {PARTS.map(({ key, name, C }) => (
              <Sequence key={key} from={SCENES[key].from} durationInFrames={SCENES[key].dur} name={name}>
                <C />
              </Sequence>
            ))}
            {PARTS.filter((p) => p.wipe).map(({ key, wipe }, i) => (
              <Sequence key={`wipe-${key}`} from={SCENES[key].from - WIPE} durationInFrames={WIPE * 2} name={`wipe → ${key}`}>
                <AsciiWipe dir={wipe} seed={i + 1} />
              </Sequence>
            ))}
          </>
        ) : null}
      </AbsoluteFill>
    </LayoutProvider>
  );
};
