// Compare the video's sections with the live site, pixel for pixel, at 1920×1080.
//
//   npm run compare                      # live site
//   SITE_URL=http://localhost:8080/ npm run compare
//
// For each section the site is screenshotted with Playwright in the same Chrome build Remotion renders
// with, on a fake clock, with Math.random seeded and CSS animations off (as the video turns them off).
// The time-driven parts (the hero and wordmark canvases, the flow pulse, the hero's cycling word, the
// guide's progress bar) are read back from the page, and the Compare composition renders the same
// section in rest mode at that moment. Output: compare/<name>-{site,video,diff,side}.png and a summary.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderStill, selectComposition } from '@remotion/renderer';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const SITE = process.env.SITE_URL || 'https://kareemmsayed.github.io/Threshold/';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'compare');
await mkdir(out, { recursive: true });

// name, section id, element to put at the top of the frame, extra fake ms to run after scrolling
// `probe` lists elements whose position (relative to the section) is printed for both, to locate drift.
const SHOTS = [
  { name: 'hero', section: 'top' },
  { name: 'why', section: 'why' },
  { name: 'features', section: 'features', probe: ['.head', '.bento', '.b-ready', '.b-load'] },
  { name: 'features-2', section: 'features', anchor: '#features .b-load', probe: ['.b-load', '.b-all'] },
  { name: 'demo-1', section: 'demo', probe: ['.head', '.convo', '.turn:nth-child(1) .reply', '.turn:nth-child(1) .r-grid', '.turn:nth-child(1) .todo'] },
  { name: 'demo-2', section: 'demo', anchor: '#demo .turn:nth-child(2)', probe: ['.turn:nth-child(2)', '.turn:nth-child(2) .pbs', '.turn:nth-child(2) .r-grid'] },
  { name: 'setup', section: 'setup' },
  { name: 'how', section: 'how' },
  { name: 'start', section: 'start' },
];
const only = process.argv[2]?.split(',');

const INIT = () => {
  // Seeded Math.random (mulberry32), so the chat's typing delays are the same every run.
  let s = 0x2f6b1d;
  Math.random = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Record the rAF time of each canvas's last draw (it clears first) and of the flow diagram's.
  window.__drawT = {};
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => ((window.__rafT = t), cb(t)));
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...a) {
    if (this.canvas.id) window.__drawT[this.canvas.id] = window.__rafT;
    return clear.apply(this, a);
  };
  document.addEventListener('DOMContentLoaded', () => {
    const flow = document.getElementById('flow');
    if (flow) new MutationObserver(() => (window.__drawT.flow = window.__rafT)).observe(flow, { attributes: true, subtree: true });
    const css = document.createElement('style');
    css.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
    document.head.append(css);
  });
};

const { path: executablePath } = await ensureBrowser();
const browser = await chromium.launch({ executablePath, args: ['--use-angle=angle'] });

async function shoot(shot) {
  const { name, section, anchor } = shot;
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.addInitScript(INIT);
  await page.goto(SITE, { waitUntil: 'load', timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const sel = anchor ?? `#${section}`;
  if (section === 'top') {
    // About 7 s in the chat has answered; then wait for the cycling line to sit on a whole word.
    await page.clock.runFor(7000);
    for (let i = 0; i < 80; i++) {
      const settled = await page.evaluate(() => {
        const c = document.querySelector('[data-cycle] > span');
        return !!document.querySelector('#hero-chat .m-sigs') && c && !c.children[1].textContent && !c.children[2].textContent;
      });
      if (settled) break;
      await page.clock.runFor(50);
    }
  } else {
    await page.addStyleTag({ content: '.nav-wrap { display: none !important; }' });
    if (section === 'setup') {
      // Type the headline with the stage mostly below the fold, so the guide has not started yet.
      await page.evaluate((s) => window.scrollTo(0, document.querySelector(s).getBoundingClientRect().top + scrollY - 500), sel);
      await page.waitForTimeout(400);
      await page.clock.runFor(2500);
    }
    await page.evaluate((s) => window.scrollTo(0, document.querySelector(s).getBoundingClientRect().top + scrollY), sel);
    await page.waitForTimeout(400);
    // The guide is caught 300 ms after it starts, before its cursor first moves.
    await page.clock.runFor(section === 'setup' ? 300 : 2500);
  }
  await page.waitForTimeout(300);
  const info = await page.evaluate(
    ({ s, a, probe }) => {
      const sec = document.getElementById(s);
      const st = sec.getBoundingClientRect();
      const cyc = document.querySelector('[data-cycle]');
      const words = cyc.dataset.cycle.split('|');
      const bar = document.querySelector('#guide-steps li.on .bar');
      return {
        drawT: window.__drawT,
        word: Math.max(0, words.indexOf(cyc.textContent.trim())),
        guideP: bar ? Number(bar.style.getPropertyValue('--p') || 0) : 0,
        top: st.top,
        bottom: st.bottom,
        probe: Object.fromEntries(
          (probe ?? []).map((p) => {
            const r = sec.querySelector(p)?.getBoundingClientRect();
            return [p, r ? [+(r.top - st.top).toFixed(2), +r.height.toFixed(2)] : null];
          }),
        ),
      };
    },
    { s: section, a: anchor, probe: shot.probe },
  );
  const site = path.join(out, `${name}-site.png`);
  await page.screenshot({ path: site });
  await context.close();
  return { site, info };
}

const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts') });
const rows = [];
for (const shot of SHOTS.filter((s) => !only || only.includes(s.name))) {
  const { site, info } = await shoot(shot);
  const rest = {
    heroT: info.drawT['ascii-hero'] ?? 0,
    flowT: info.drawT.flow ?? 0,
    wordT: info.drawT['ascii-word'] ?? 0,
    word: info.word,
    guideP: info.guideP,
  };
  const inputProps = { section: shot.section, top: info.top, rest, probe: shot.probe };
  const composition = await selectComposition({ serveUrl, id: 'Compare', inputProps, chromiumOptions: { gl: 'angle' } });
  const video = path.join(out, `${shot.name}-video.png`);
  let probed = null;
  await renderStill({
    serveUrl,
    composition,
    inputProps,
    output: video,
    imageFormat: 'png',
    chromiumOptions: { gl: 'angle' },
    onBrowserLog: (l) => {
      if (l.text.startsWith('PROBE ')) probed = JSON.parse(l.text.slice(6));
    },
  });
  for (const k of Object.keys(info.probe)) {
    const a = JSON.stringify(info.probe[k]);
    const b = JSON.stringify(probed?.[k]);
    if (a !== b) console.log(`  drift ${k}: site ${a} video ${b}`);
  }

  const a = PNG.sync.read(readFileSync(site));
  const b = PNG.sync.read(readFileSync(video));
  const { width: w, height: h } = a;
  const diff = new PNG({ width: w, height: h });
  // Only the section's own rows count: above or below it the site shows its neighbours.
  const y0 = Math.max(0, Math.ceil(info.top));
  const y1 = Math.min(h, Math.floor(info.bottom));
  for (const img of [a, b])
    for (let y = 0; y < h; y++) if (y < y0 || y >= y1) img.data.fill(0, y * w * 4, (y + 1) * w * 4);
  const bad = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1, includeAA: false });
  writeFileSync(path.join(out, `${shot.name}-diff.png`), PNG.sync.write(diff));
  // site | video | diff, at half size
  const side = new PNG({ width: (w * 3) / 2, height: h / 2 });
  [a, b, diff].forEach((img, k) => {
    for (let y = 0; y < h / 2; y++)
      for (let x = 0; x < w / 2; x++) {
        const si = ((y * 2) * w + x * 2) * 4;
        const di = (y * side.width + k * (w / 2) + x) * 4;
        for (let c = 0; c < 4; c++) side.data[di + c] = img.data[si + c];
      }
  });
  writeFileSync(path.join(out, `${shot.name}-side.png`), PNG.sync.write(side));
  const pct = (100 * bad) / (w * (y1 - y0));
  rows.push({ name: shot.name, mismatch: `${pct.toFixed(3)}%`, pixels: bad, rows: [y0, y1], ...rest, top: info.top });
  console.log(`${shot.name.padEnd(10)} ${pct.toFixed(3).padStart(7)}% of pixels differ`);
}
await browser.close();
await writeFile(path.join(out, 'summary.json'), JSON.stringify({ site: SITE, rows }, null, 2));
