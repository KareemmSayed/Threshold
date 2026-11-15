import '../../docs/assets/site.css';
import './styles/video.css';
import React from 'react';
import { Composition } from 'remotion';
import { Compare, type CompareProps } from './Compare';
import { Launch } from './Launch';
import { type Layout, SIZES } from './lib/camera';
import { FPS } from './lib/time';
import { TOTAL } from './timeline';

const CUTS: { id: string; layout: Layout }[] = [
  { id: 'Launch-16x9', layout: 'wide' },
  { id: 'Launch-4x5', layout: 'feed' },
  { id: 'Launch-9x16', layout: 'tall' },
];

export const Root: React.FC = () => (
  <>
    {CUTS.map(({ id, layout }) => (
      <Composition
        key={id}
        id={id}
        component={Launch}
        durationInFrames={TOTAL}
        fps={FPS}
        width={SIZES[layout].width}
        height={SIZES[layout].height}
        defaultProps={{ layout }}
      />
    ))}
    <Composition
      id="Compare"
      component={Compare}
      durationInFrames={1}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ section: 'top', top: 0, rest: { heroT: 7200, flowT: 7200, wordT: 7200, word: 1, guideP: 0.04 } } satisfies CompareProps}
    />
  </>
);
