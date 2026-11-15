// Side-by-side references for the portrait cuts: the live site at 1080×1350 and 1080×1920 next to
// video frames at the same size. The cuts are re-composed (an 864 px page, stacked sections), so this
// is a visual check of colour, type and components rather than a pixel diff.
//   node scripts/compare-portrait.mjs
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { PNG } from 'pngjs';

const SITE = process.env.SITE_URL || 'https://kareemmsayed.github.io/Threshold/';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'compare');
await mkdir(out, { recursive: true });

// section to scroll to on the site, and a video frame where the same section is at rest
const PAIRS = [
  { name: 'hero', sel: '#top', frame: 455 },
  { name: 'why', sel: '#why', frame: 900 },
  { name: 'features', sel: '#features', frame: 1250 },
  { name: 'demo', sel: '#demo .turn:nth-child(2)', frame: 1760 },
  { name: 'setup', sel: '#setup', frame: 2160 },
  { name: 'end', sel: '#start', frame: 2700 },
];
const CUTS = [
  { id: 'Launch-4x5', width: 1080, height: 1350 },
  { id: 'Launch-9x16', width: 1080, height: 1920 },
];

const { path: executablePath } = await ensureBrowser();
const browser = await chromium.launch({ executablePath, args: ['--use-angle=angle'] });
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts') });
const chromiumOptions = { gl: 'angle' };

for (const cut of CUTS) {
  const page = await browser.newPage({ viewport: { width: cut.width, height: cut.height }, deviceScaleFactor: 1 });
  await page.goto(SITE, { waitUntil: 'load', timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  const composition = await selectComposition({ serveUrl, id: cut.id, chromiumOptions });
  for (const p of PAIRS) {
    await page.evaluate((s) => window.scrollTo(0, document.querySelector(s).getBoundingClientRect().top + scrollY - 40), p.sel);
    await page.waitForTimeout(2500);
    const site = path.join(out, `portrait-${cut.id}-${p.name}-site.png`);
    await page.screenshot({ path: site });
    const video = path.join(out, `portrait-${cut.id}-${p.name}-video.png`);
    await renderStill({ serveUrl, composition, frame: p.frame, output: video, imageFormat: 'png', chromiumOptions });
    const a = PNG.sync.read(readFileSync(site));
    const b = PNG.sync.read(readFileSync(video));
    const side = new PNG({ width: a.width * 2 + 20, height: a.height });
    PNG.bitblt(a, side, 0, 0, a.width, a.height, 0, 0);
    PNG.bitblt(b, side, 0, 0, b.width, b.height, a.width + 20, 0);
    writeFileSync(path.join(out, `portrait-${cut.id}-${p.name}.png`), PNG.sync.write(side));
    console.log(cut.id, p.name);
  }
  await page.close();
}
await browser.close();
