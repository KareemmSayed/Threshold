// Every frame must be a pure function of its number. Renders frames as stills (each in a fresh tab)
// and again as part of a sequence (tabs reused across frames, out of order), and compares the bytes.
//   node scripts/determinism.mjs [composition] [frames]
import path from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { renderFrames, renderStill, selectComposition } from '@remotion/renderer';

const [id = 'Launch-16x9', list = '0,100,260,520,700,790,900,1010,1200,1300,1520,1760,1880,2000,2150,2240,2400,2600,2760'] = process.argv.slice(2);
const frames = list.split(',').map(Number);
const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'out', 'determinism', id);
await mkdir(dir, { recursive: true });
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts') });
const chromiumOptions = { gl: 'angle' };
const composition = await selectComposition({ serveUrl, id, chromiumOptions });

for (const frame of frames) {
  for (const k of ['a', 'b']) {
    await renderStill({ serveUrl, composition, frame, output: path.join(dir, `${frame}-${k}.png`), imageFormat: 'png', chromiumOptions });
  }
}
// Again at the end of a short sequence in one tab, which carries state from the frames before it.
for (const frame of frames) {
  await renderFrames({
    serveUrl,
    composition,
    frameRange: [Math.max(0, frame - 2), frame],
    imageFormat: 'png',
    outputDir: path.join(dir, `seq-${frame}`),
    concurrency: 1,
    chromiumOptions,
    inputProps: {},
    onStart: () => {},
    onFrameUpdate: () => {},
  });
}
let bad = 0;
for (const frame of frames) {
  const a = await readFile(path.join(dir, `${frame}-a.png`));
  const b = await readFile(path.join(dir, `${frame}-b.png`));
  const seq = (await readdir(path.join(dir, `seq-${frame}`))).sort();
  const c = await readFile(path.join(dir, `seq-${frame}`, seq[seq.length - 1]));
  const same = a.equals(b) && a.equals(c);
  if (!same) bad++;
  console.log(`${String(frame).padStart(5)}  still×2 ${a.equals(b) ? 'same' : 'DIFF'}  sequence ${a.equals(c) ? 'same' : 'DIFF'}`);
}
console.log(bad ? `${bad} frame(s) differ` : 'all frames identical');
process.exit(bad ? 1 : 0);
