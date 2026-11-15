// Render the three cuts to out/: H.264, yuv420p, BT.709, no audio track.
//   npm run render                 # all three
//   npm run render -- 16x9         # one cut
//   npm run render -- 16x9 0-299   # a frame range, for quick checks
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const [which, range] = process.argv.slice(2);
const cuts = ['16x9', '4x5', '9x16'].filter((c) => !which || which.split(',').includes(c));
const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, 'out'), { recursive: true });
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts') });
const chromiumOptions = { gl: 'angle' };

for (const cut of cuts) {
  const id = `Launch-${cut}`;
  const composition = await selectComposition({ serveUrl, id, chromiumOptions });
  const frameRange = range ? range.split('-').map(Number) : null;
  const outputLocation = path.join(root, 'out', `threshold-launch-${cut}${range ? `-${range}` : ''}.mp4`);
  const t0 = Date.now();
  let last = -1;
  await renderMedia({
    serveUrl,
    composition,
    codec: 'h264',
    crf: 14,
    x264Preset: 'slow',
    pixelFormat: 'yuv420p',
    colorSpace: 'bt709',
    imageFormat: 'png',
    muted: true,
    concurrency: 6,
    frameRange,
    chromiumOptions,
    outputLocation,
    onProgress: ({ progress }) => {
      const p = Math.floor(progress * 20);
      if (p !== last) {
        last = p;
        process.stdout.write(`\r${id} ${(progress * 100).toFixed(0).padStart(3)}%`);
      }
    },
  });
  console.log(`\n${outputLocation}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
