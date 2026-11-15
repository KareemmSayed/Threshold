import { smooth } from './time';

/*
 * The ASCII renderer shared by the hero and the closing wordmark (asciiCanvas, session, initAsciiHero,
 * initAsciiWord in site.js), with time passed in instead of read from requestAnimationFrame. Cells are
 * grouped by colour and alpha so each row costs a handful of fillText calls.
 */

export const DENS = ' .:-=+*#%@';
export const ALPHAS = [0.08, 0.2, 0.42, 0.7, 1];
export const RAMP = ['#4da8ff', '#7b8cff', '#a56bff', '#e36bd6', '#ff7a45'];
export const INK = '#f4f3ef';
export const COLORS = [...RAMP, INK];

type Buf = string[] & { dirty?: boolean; c?: number; a?: number };

export class AsciiGrid {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  fs: number;
  cw: number;
  ch: number;
  cols: number;
  rows: number;
  colors: string[];
  private bufs: Buf[][];
  private used: Buf[] = [];

  constructor(canvas: HTMLCanvasElement, w: number, h: number, fs: number, cell: number, dpr: number, colors = COLORS) {
    const ctx = canvas.getContext('2d')!;
    this.ctx = ctx;
    this.w = w;
    this.h = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fs = fs;
    ctx.font = `500 ${fs}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'top';
    this.cw = ctx.measureText('M').width;
    this.ch = Math.round(fs * cell);
    this.cols = Math.ceil(w / this.cw);
    this.rows = Math.ceil(h / this.ch);
    this.colors = colors;
    this.bufs = colors.map(() => ALPHAS.map(() => new Array(this.cols).fill(' ') as Buf));
  }

  put(c: number, a: number, i: number, chr: string) {
    const b = this.bufs[c][a];
    if (b.dirty !== true) {
      b.dirty = true;
      this.used.push(b);
      b.c = c;
      b.a = a;
    }
    b[i] = chr;
  }

  /**
   * Draw row j. `mul` scales each colour's alpha and `faint` the faintest ink level (the ambient
   * dot field), for video fades and emphasis the site does not have.
   */
  flush(j: number, mul?: number[], faint = 1) {
    const { ctx } = this;
    for (const b of this.used) {
      const m = (mul ? mul[b.c!] : 1) * (b.c === 5 && b.a === 0 ? faint : 1);
      if (m > 0.002) {
        ctx.fillStyle = this.colors[b.c!];
        ctx.globalAlpha = ALPHAS[b.a!] * m;
        ctx.fillText(b.join(''), 0, j * this.ch);
      }
      b.fill(' ');
      b.dirty = false;
    }
    this.used.length = 0;
    ctx.globalAlpha = 1;
  }
}

/** A session's intensity (0..1) at phase x: warm-up, six reps over threshold, cool-down. */
export function session(x: number) {
  const t = ((x % 1) + 1) % 1;
  if (t < 0.16) return 0.2 + smooth(0, 0.16, t) * 0.2;
  if (t > 0.88) return 0.4 - smooth(0.88, 1, t) * 0.2;
  const rep = ((t - 0.16) / 0.72) * 6;
  const k = Math.floor(rep);
  const r = rep - k;
  const hi = 0.8 + 0.07 * Math.sin(k * 2.3 + 1);
  return 0.4 + (hi - 0.4) * Math.min(smooth(0.03, 0.15, r), 1 - smooth(0.55, 0.7, r));
}

export type Rect = { l: number; t: number; r: number; b: number };
export type Pt = { x: number; y: number };

export type HeroOpts = {
  /** Where the pointer glow sits; off-screen for none. */
  pointer: Pt;
  /** The headline block the field fades behind (measureHole). */
  hole: Rect | null;
  /** 0..1: how much of the hole fade applies (it eases in with the copy). */
  holeK: number;
  /** Columns of the trace and of the threshold line drawn so far (the intro sweep). Infinity for all. */
  traceCols: number;
  lineCols: number;
  /** Alpha of the ambient contour field, the threshold label and the trace (intro fades). */
  field: number;
  /** Extra brightness for the ambient field (1 is the site), so it reads in the intro. */
  fieldBoost?: number;
  label: number;
  narrow?: boolean;
};

export const THR = 0.7;
export const HERO_LABEL = 'THRESHOLD · LT2 172 bpm';

/** One frame of the hero: the heart-rate trace under its threshold line over a drifting contour field. */
export function drawHero(a: AsciiGrid, t: number, o: HeroOpts) {
  const { ctx, cols, rows, cw, ch } = a;
  ctx.clearRect(0, 0, a.w, a.h);
  const base = rows * 0.95;
  const amp = rows * (o.narrow ? 0.34 : 0.5);
  const thr = Math.round(base - THR * amp);
  const scroll = t * 0.035;
  const level: number[] = [];
  const top: number[] = [];
  for (let i = 0; i < cols; i++) {
    level[i] = session(i / cols / 1.1 + scroll) + 0.02 * Math.sin(i * 0.9 + t * 2.4);
    top[i] = base - level[i] * amp;
  }
  const hole = o.hole;
  const fade = (x: number, y: number) => {
    if (!hole || o.holeK <= 0) return 0;
    const dx = Math.max(hole.l - x, 0, x - hole.r);
    const dy = Math.max(hole.t - y, 0, y - hole.b);
    const d = Math.sqrt(dx * dx + dy * dy);
    const k = d === 0 ? 3 : d < 40 ? 2 : d < 90 ? 1 : 0;
    return Math.round(k * o.holeK);
  };
  const mul = [1, 1, 1, 1, 1, o.field];
  const R = 170;
  const flick = Math.floor(t * 9);
  for (let j = 0; j < rows; j++) {
    const y = j * ch + ch / 2;
    for (let i = 0; i < cols; i++) {
      const x = i * cw + cw / 2;
      const dx = x - o.pointer.x;
      const dy = y - o.pointer.y;
      const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / R);
      const k = fade(x, y);
      if (j >= top[i] && j <= base && i < o.traceCols) {
        // Under the trace: dense at the edge, thinning with depth. Over threshold it burns hot.
        const d = j - top[i];
        const idx = Math.max(1, 9 - Math.floor(d * 0.85));
        let al = d < 1 ? 4 : d < 3 ? 3 : d < 7 ? 2 : 1;
        if (near > 0.3 && al < 4) al++;
        al = Math.max(0, al - k);
        const col = j < thr ? 4 : Math.min(3, Math.floor(level[i] * 5));
        a.put(col, al, i, DENS[idx]);
      } else if (j === thr && i < o.lineCols) {
        if (i % 2 === 0) a.put(4, Math.max(0, (near > 0.2 ? 3 : 2) - k), i, '-');
      } else if (k > 1) {
        continue;
      } else {
        // Ambient: drifting contour lines, like a topo map of the session
        const v = Math.sin(i * 0.045 + t * 0.12) * Math.cos(j * 0.11 - t * 0.08) + 0.6 * Math.sin((i * 0.6 - j) * 0.05 + t * 0.06);
        const f = v * 3 - Math.floor(v * 3);
        if (near > 0) {
          const h = ((i * 73856093) ^ (j * 19349663) ^ (flick * 83492791)) >>> 0;
          const dens = Math.min(9, Math.floor(near * 7 + (h % 3)));
          if (dens > 0) a.put(near > 0.55 ? 2 + (h % 2) : 5, near > 0.55 ? 2 : 1 + (near > 0.35 ? 1 : 0), i, DENS[dens]);
        } else if (f < 0.06) {
          a.put(5, 0, i, f < 0.03 ? ':' : '.');
        }
      }
    }
    a.flush(j, mul, o.fieldBoost ?? 1);
  }
  // Label the threshold line
  if (o.label > 0) {
    const label = HERO_LABEL;
    const lx = a.w - a.cw * (label.length + 3);
    ctx.globalAlpha = o.label;
    ctx.fillStyle = '#000';
    ctx.fillRect(lx - a.cw, thr * ch, a.cw * (label.length + 2), ch);
    ctx.fillStyle = RAMP[4];
    ctx.globalAlpha = 0.85 * o.label;
    ctx.fillText(label, lx, thr * ch);
    ctx.globalAlpha = 1;
  }
  return { thr, base, amp, top };
}

/** The wordmark's alpha mask: THRESHOLD in heavy sans, fitted to the canvas (initAsciiWord build()). */
export function wordMask(w: number, h: number) {
  const mw = Math.max(1, Math.round(w));
  const mh = Math.max(1, Math.round(h));
  const off = document.createElement('canvas');
  off.width = mw;
  off.height = mh;
  const c = off.getContext('2d')!;
  const word = 'THRESHOLD';
  c.font = '900 100px "Helvetica Neue", "Inter Tight", Arial, sans-serif';
  const k = Math.min((mw * 0.94) / c.measureText(word).width, (mh * 0.95) / 74);
  c.font = `900 ${100 * k}px "Helvetica Neue", "Inter Tight", Arial, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#fff';
  c.fillText(word, mw / 2, mh / 2 + 4 * k);
  return { mask: c.getImageData(0, 0, mw, mh).data, mw, mh };
}

export type WordOpts = {
  pointer: Pt;
  /** 0..1: cells resolve from noise into the word (video intro); 1 is the site's steady state. */
  form: number;
  seed: (i: number, j: number) => number;
};

/** One frame of the wordmark: the mask sampled through a gentle wave, lit by a sweep, coloured by the ramp. */
export function drawWord(a: AsciiGrid, m: ReturnType<typeof wordMask>, t: number, o: WordOpts) {
  const { ctx, cols, rows, cw, ch } = a;
  const { mask, mw, mh } = m;
  ctx.clearRect(0, 0, a.w, a.h);
  const flick = Math.floor(t * 10);
  for (let j = 0; j < rows; j++) {
    const cy = j * ch + ch / 2;
    for (let i = 0; i < cols; i++) {
      const cx = i * cw + cw / 2;
      const sx = Math.round(cx + Math.sin(cy * 0.025 + t * 1.3) * 5);
      const sy = Math.round(cy + Math.cos(cx * 0.012 + t * 0.9) * 3);
      if (sx < 0 || sy < 0 || sx >= mw || sy >= mh) continue;
      let v = mask[(sy * mw + sx) * 4 + 3] / 255;
      const dx = cx - o.pointer.x;
      const dy = cy - o.pointer.y;
      const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 140);
      // Intro: each cell lands at its own moment; until then it is a flickering glyph or nothing.
      const s = o.seed(i, j);
      const landed = o.form >= 1 || s < o.form;
      if (v < 0.04) {
        const h = ((i * 2654435761) ^ (j * 40503)) >>> 0;
        if (near > 0.2 && h % 3 === 0) a.put(5, 1, i, DENS[1 + ((h + flick) % 4)]);
        else if (h % 23 === 0 && landed) a.put(5, 0, i, '.');
        continue;
      }
      if (!landed) {
        if (s < o.form + 0.18) a.put(Math.min(4, Math.floor((i / cols) * 5)), 1, i, DENS[1 + ((i * 7 + j * 13 + flick) % 9)]);
        continue;
      }
      const sweep = 0.5 + 0.5 * Math.sin(i * 0.05 - t * 1.6);
      v = Math.min(1, v * (0.75 + sweep * 0.35) + near * 0.4);
      let chr = DENS[Math.max(1, Math.min(9, Math.round(v * 9)))];
      if (near > 0.35) chr = DENS[2 + (((i * 7 + j * 13 + flick) >>> 0) % 8)];
      const col = Math.min(4, Math.floor((i / cols) * 5));
      a.put(col, v > 0.85 ? 4 : v > 0.6 ? 3 : 2, i, chr);
    }
    a.flush(j);
  }
}
