// Render chosen frames of a composition as PNGs, bundling once.
// node scripts/stills.mjs Launch-16x9 30,120,400 [outDir]
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

const [id = 'Launch-16x9', frames = '0', outDir = 'out/stills'] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.resolve(root, outDir), { recursive: true });
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts') });
const composition = await selectComposition({ serveUrl, id, chromiumOptions: { gl: 'angle' } });
for (const f of frames.split(',').map(Number)) {
  const output = path.resolve(root, outDir, `${id}-${String(f).padStart(4, '0')}.png`);
  await renderStill({ serveUrl, composition, frame: f, output, chromiumOptions: { gl: 'angle' }, imageFormat: 'png' });
  console.log(output);
}
