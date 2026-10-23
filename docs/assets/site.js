/* Threshold site: typewriter type, ASCII canvases, liquid glass, and the animated setup guide. No dependencies. */
(() => {
  'use strict';

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, v) => { const k = clamp((v - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const RAMP = ['#4da8ff', '#7b8cff', '#a56bff', '#e36bd6', '#ff7a45'];
  const RAMP_RGB = RAMP.map(hex);
  const INK = '#f4f3ef';

  /** Runs `fn(visible)` whenever `el` enters or leaves the viewport. */
  function watch(el, fn, threshold = 0) {
    if (!el) return;
    new IntersectionObserver((es) => es.forEach((e) => fn(e.isIntersecting)), { threshold }).observe(el);
  }

  /* ---------------------------------------------------------------------- */
  /* Typewriter: Doto characters type in while the next one flickers through */
  /* random glyphs of its own kind (the Synclete app's DotText).             */
  /* ---------------------------------------------------------------------- */
  const DIGITS = '0123456789';
  const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  function scramble(ch) {
    const pool = /\d/.test(ch) ? DIGITS : /[a-z]/i.test(ch) ? LETTERS : null;
    if (!pool) return ch;
    const g = pool[(Math.random() * pool.length) | 0];
    return ch === ch.toLowerCase() ? g.toLowerCase() : g;
  }
  function prepType(el, text = el.textContent) {
    if (!el.matches('[aria-hidden="true"]')) el.setAttribute('aria-label', text);
    const wrap = document.createElement('span');
    wrap.setAttribute('aria-hidden', 'true');
    const a = document.createElement('span');
    const g = document.createElement('span');
    const r = document.createElement('span');
    g.className = 'g';
    r.className = 'r';
    wrap.append(a, g, r);
    el.replaceChildren(wrap);
    el._tw = { a, g, r, text };
    setTyped(el, 0, '');
    el.classList.add('ready');
  }
  function setTyped(el, n, glitch) {
    const { a, g, r, text } = el._tw;
    a.textContent = text.slice(0, n);
    g.textContent = n < text.length ? glitch : '';
    r.textContent = text.slice(n + (glitch && n < text.length ? 1 : 0));
  }
  function typeIn(el, delay = 0, from = 0) {
    const { text } = el._tw;
    if (reduced || !text.length) { setTyped(el, text.length, ''); return Promise.resolve(); }
    // Short strings type slower, long ones faster; the whole thing lands in about half a second.
    const step = clamp(520 / text.length, 22, 64);
    setTyped(el, from, '');
    return new Promise((res) => {
      setTimeout(() => {
        let n = from;
        const t = setInterval(() => {
          n += 1;
          setTyped(el, n, n < text.length ? scramble(text[n]) : '');
          if (n >= text.length) { clearInterval(t); res(); }
        }, step);
      }, delay);
    });
  }
  async function cycle(el) {
    const words = el.dataset.cycle.split('|');
    prepType(el, words[0]);
    await typeIn(el);
    if (reduced) return;
    let visible = true;
    watch(el, (v) => (visible = v));
    for (let k = 1; ; k = (k + 1) % words.length) {
      await sleep(2600);
      while (!visible || document.hidden) await sleep(500);
      const cur = el._tw.text;
      for (let n = cur.length; n >= 3; n--) { setTyped(el, n, ''); await sleep(28); }
      el._tw.text = words[k];
      await typeIn(el, 0, 3);
    }
  }
  function initType() {
    const hero = $$('.hero [data-type]');
    $$('[data-type]').forEach((el) => prepType(el));
    hero.forEach((el, i) => typeIn(el, 250 + i * 500).then(() => {
      const c = $('[data-cycle]');
      if (c && i === hero.length - 1) cycle(c);
    }));
    const rest = $$('[data-type]').filter((el) => !hero.includes(el));
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      typeIn(e.target, Number(e.target.dataset.delay || 0));
    }), { threshold: 0.6 });
    rest.forEach((el) => io.observe(el));
  }

  /* ---------------------------------------------------------------------- */
  /* Scroll reveal, aura light, nav state                                    */
  /* ---------------------------------------------------------------------- */
  function initReveal() {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    $$('.rise').forEach((el) => {
      const sibs = [...el.parentElement.children].filter((c) => c.classList.contains('rise'));
      el.style.setProperty('--d', `${sibs.indexOf(el) * 70}ms`);
      io.observe(el);
    });
  }
  function initAura() {
    $$('.aura').forEach((el) => {
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${e.clientX - r.left}px`);
        el.style.setProperty('--my', `${e.clientY - r.top}px`);
      });
      el.addEventListener('pointerleave', () => el.style.setProperty('--mx', '-999px'));
    });
  }
  function initNav() {
    const links = new Map($$('.nav-links a').map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      const a = links.get(e.target.id);
      if (a) a.classList.toggle('on', e.isIntersecting);
    }), { rootMargin: '-45% 0px -50% 0px' });
    links.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
  }

  /* ---------------------------------------------------------------------- */
  /* Liquid glass (after React Bits' GlassSurface): an SVG displacement map */
  /* bends the backdrop at the edges and splits it into R, G and B. Only   */
  /* Chromium renders url() in backdrop-filter; others keep the frost.     */
  /* ---------------------------------------------------------------------- */
  function initGlass() {
    const ua = navigator.userAgent;
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua);
    if (safari || /Firefox/.test(ua)) return;
    const probe = document.createElement('div');
    probe.style.backdropFilter = 'url(#probe)';
    if (!probe.style.backdropFilter) return;

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'glass-defs');
    svg.setAttribute('aria-hidden', 'true');
    const defs = document.createElementNS(NS, 'defs');
    svg.append(defs);
    document.body.append(svg);

    const mapFor = (w, h, r) => {
      const e = Math.min(w, h) * 0.035;
      return 'data:image/svg+xml,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs>` +
        `<linearGradient id="r" x1="100%" y1="0%" x2="0%" y2="0%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient>` +
        `<linearGradient id="b" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient></defs>` +
        `<rect width="${w}" height="${h}" fill="black"/>` +
        `<rect width="${w}" height="${h}" rx="${r}" fill="url(#r)"/>` +
        `<rect width="${w}" height="${h}" rx="${r}" fill="url(#b)" style="mix-blend-mode:difference"/>` +
        `<rect x="${e}" y="${e}" width="${w - 2 * e}" height="${h - 2 * e}" rx="${r}" fill="hsl(0 0% 50% / .93)" style="filter:blur(11px)"/></svg>`,
      );
    };

    $$('[data-glass]').forEach((el, i) => {
      const id = `liquid-${i}`;
      defs.insertAdjacentHTML('beforeend',
        `<filter id="${id}" color-interpolation-filters="sRGB" x="0%" y="0%" width="100%" height="100%">` +
        `<feImage x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="-180" xChannelSelector="R" yChannelSelector="G" result="dr"/>` +
        `<feColorMatrix in="dr" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="red"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="-170" xChannelSelector="R" yChannelSelector="G" result="dg"/>` +
        `<feColorMatrix in="dg" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="green"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="-160" xChannelSelector="R" yChannelSelector="G" result="db"/>` +
        `<feColorMatrix in="db" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="blue"/>` +
        `<feBlend in="red" in2="green" mode="screen" result="rg"/><feBlend in="rg" in2="blue" mode="screen" result="out"/>` +
        `<feGaussianBlur in="out" stdDeviation="0.7"/></filter>`);
      const img = defs.lastElementChild.querySelector('feImage');
      const blur = el.dataset.blur || 6;
      const update = () => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const radius = Math.min(parseFloat(el.dataset.radius || getComputedStyle(el).borderTopLeftRadius) || 20, r.height / 2);
        img.setAttribute('href', mapFor(Math.round(r.width), Math.round(r.height), radius));
      };
      update();
      new ResizeObserver(update).observe(el);
      const f = `url(#${id}) blur(${blur}px) saturate(1.7)`;
      el.style.backdropFilter = f;
      el.style.webkitBackdropFilter = f;
      el.classList.add('liquid');
      if (el.dataset.frost) el.style.setProperty('--frost', el.dataset.frost);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* ASCII renderer shared by the hero and the closing wordmark. Cells are  */
  /* grouped by colour and alpha so each row costs a handful of fillText.   */
  /* ---------------------------------------------------------------------- */
  const DENS = ' .:-=+*#%@';
  const ALPHAS = [0.08, 0.2, 0.42, 0.7, 1];
  function asciiCanvas(canvas, { size, cell }) {
    const ctx = canvas.getContext('2d');
    const s = { ctx, w: 0, h: 0, cols: 0, rows: 0, cw: 0, ch: 0, fs: 0, colors: [] };
    s.resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      s.w = r.width; s.h = r.height;
      canvas.width = Math.round(s.w * dpr);
      canvas.height = Math.round(s.h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      s.fs = size();
      ctx.font = `500 ${s.fs}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
      ctx.textBaseline = 'top';
      s.cw = ctx.measureText('M').width;
      s.ch = Math.round(s.fs * (cell || 1.3));
      s.cols = Math.ceil(s.w / s.cw);
      s.rows = Math.ceil(s.h / s.ch);
      s.bufs = s.colors.map(() => ALPHAS.map(() => new Array(s.cols).fill(' ')));
    };
    // put(color, alphaLevel, col, char) during a row, then flush(row)
    s.used = [];
    s.put = (c, a, i, chr) => {
      const b = s.bufs[c][a];
      if (b.dirty !== true) { b.dirty = true; s.used.push(b); b.c = c; b.a = a; }
      b[i] = chr;
    };
    s.flush = (j) => {
      for (const b of s.used) {
        ctx.fillStyle = s.colors[b.c];
        ctx.globalAlpha = ALPHAS[b.a];
        ctx.fillText(b.join(''), 0, j * s.ch);
        b.fill(' ');
        b.dirty = false;
      }
      s.used.length = 0;
      ctx.globalAlpha = 1;
    };
    return s;
  }

  /** Runs `draw(t)` at ~30 fps while `el` is on screen and the tab is visible. */
  function loop(el, draw) {
    let raf = 0, last = 0, on = false;
    const frame = (t) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 32) return;
      last = t;
      draw(t);
    };
    const set = (v) => {
      if (v === on) return;
      on = v;
      if (on && !reduced) raf = requestAnimationFrame(frame);
      else { cancelAnimationFrame(raf); draw(performance.now()); }
    };
    watch(el, (v) => set(v && !document.hidden));
    document.addEventListener('visibilitychange', () => set(!document.hidden && el.getBoundingClientRect().bottom > 0 && el.getBoundingClientRect().top < innerHeight));
  }

  /** A session's intensity (0..1) at phase x: warm-up, six reps over threshold, cool-down. */
  function session(x) {
    const t = ((x % 1) + 1) % 1;
    if (t < 0.16) return 0.2 + smooth(0, 0.16, t) * 0.2;
    if (t > 0.88) return 0.4 - smooth(0.88, 1, t) * 0.2;
    const rep = ((t - 0.16) / 0.72) * 6;
    const k = Math.floor(rep);
    const r = rep - k;
    const hi = 0.8 + 0.07 * Math.sin(k * 2.3 + 1);
    return 0.4 + (hi - 0.4) * Math.min(smooth(0.03, 0.15, r), 1 - smooth(0.55, 0.7, r));
  }

  function initAsciiHero() {
    const canvas = $('#ascii-hero');
    if (!canvas) return;
    const a = asciiCanvas(canvas, { size: () => (innerWidth < 720 ? 11 : 13), cell: 1.28 });
    a.colors = [...RAMP, INK];
    const pointer = { x: -1e4, y: -1e4 };
    const THR = 0.7;
    let level = [], top = [];
    // Behind the headline and copy the field fades, so the type stays legible.
    const copy = $('.hero-copy');
    let hole = { l: 0, t: 0, r: 0, b: 0 };
    const measureHole = () => {
      const c = copy.getBoundingClientRect(), r = canvas.getBoundingClientRect();
      hole = { l: c.left - r.left - 24, t: c.top - r.top - 16, r: c.right - r.left + 24, b: c.bottom - r.top + 16 };
    };
    const fade = (x, y) => {
      const dx = Math.max(hole.l - x, 0, x - hole.r), dy = Math.max(hole.t - y, 0, y - hole.b);
      const d = Math.sqrt(dx * dx + dy * dy);
      return d === 0 ? 3 : d < 40 ? 2 : d < 90 ? 1 : 0;
    };

    const draw = (time) => {
      const { ctx, cols, rows, cw, ch } = a;
      const t = time / 1000;
      ctx.clearRect(0, 0, a.w, a.h);
      const base = rows * 0.95;
      const amp = rows * (innerWidth < 720 ? 0.34 : 0.5);
      const thr = Math.round(base - THR * amp);
      const scroll = t * 0.035;
      for (let i = 0; i < cols; i++) {
        level[i] = session(i / cols / 1.1 + scroll) + 0.02 * Math.sin(i * 0.9 + t * 2.4);
        top[i] = base - level[i] * amp;
      }
      const R = 170;
      const flick = Math.floor(t * 9);
      for (let j = 0; j < rows; j++) {
        const y = j * ch + ch / 2;
        for (let i = 0; i < cols; i++) {
          const x = i * cw + cw / 2;
          const dx = x - pointer.x, dy = y - pointer.y;
          const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / R);
          const k = fade(x, y);
          if (j >= top[i] && j <= base) {
            // Under the trace: dense at the edge, thinning with depth. Over threshold it burns hot.
            const d = j - top[i];
            const idx = Math.max(1, 9 - Math.floor(d * 0.85));
            let al = d < 1 ? 4 : d < 3 ? 3 : d < 7 ? 2 : 1;
            if (near > 0.3 && al < 4) al++;
            al = Math.max(0, al - k);
            const col = j < thr ? 4 : Math.min(3, Math.floor(level[i] * 5));
            a.put(col, al, i, DENS[idx]);
          } else if (j === thr) {
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
        a.flush(j);
      }
      // Label the threshold line
      const label = 'THRESHOLD · LT2 172 bpm';
      const lx = a.w - a.cw * (label.length + 3);
      ctx.fillStyle = '#000';
      ctx.fillRect(lx - a.cw, thr * ch, a.cw * (label.length + 2), ch);
      ctx.fillStyle = RAMP[4];
      ctx.globalAlpha = 0.85;
      ctx.fillText(label, lx, thr * ch);
      ctx.globalAlpha = 1;
    };

    const start = () => {
      a.resize();
      measureHole();
      new ResizeObserver(() => { a.resize(); measureHole(); draw(performance.now()); }).observe(canvas);
      loop(canvas, draw);
    };
    const hero = canvas.parentElement;
    hero.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      if (reduced) draw(0);
    });
    hero.addEventListener('pointerleave', () => { pointer.x = pointer.y = -1e4; });
    Promise.race([document.fonts.load('500 13px "JetBrains Mono"'), sleep(1500)]).then(start, start);
  }

  function initAsciiWord() {
    const canvas = $('#ascii-word');
    if (!canvas) return;
    const a = asciiCanvas(canvas, { size: () => (innerWidth < 720 ? 8 : 11), cell: 1.15 });
    a.colors = [...RAMP, INK];
    const pointer = { x: -1e4, y: -1e4 };
    let mask = null, mw = 0, mh = 0;

    const build = () => {
      mw = Math.max(1, Math.round(a.w));
      mh = Math.max(1, Math.round(a.h));
      const off = document.createElement('canvas');
      off.width = mw; off.height = mh;
      const c = off.getContext('2d');
      const word = 'THRESHOLD';
      c.font = '900 100px "Helvetica Neue", "Inter Tight", Arial, sans-serif';
      const k = Math.min((mw * 0.94) / c.measureText(word).width, (mh * 0.95) / 74);
      c.font = `900 ${100 * k}px "Helvetica Neue", "Inter Tight", Arial, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#fff';
      c.fillText(word, mw / 2, mh / 2 + 4 * k);
      mask = c.getImageData(0, 0, mw, mh).data;
    };

    const draw = (time) => {
      if (!mask) return;
      const { ctx, cols, rows, cw, ch } = a;
      const t = time / 1000;
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
          const dx = cx - pointer.x, dy = cy - pointer.y;
          const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 140);
          if (v < 0.04) {
            const h = ((i * 2654435761) ^ (j * 40503)) >>> 0;
            if (near > 0.2 && h % 3 === 0) a.put(5, 1, i, DENS[1 + ((h + flick) % 4)]);
            else if (h % 23 === 0) a.put(5, 0, i, '.');
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
    };

    const start = () => {
      a.resize();
      build();
      new ResizeObserver(() => { a.resize(); build(); draw(performance.now()); }).observe(canvas);
      loop(canvas, draw);
    };
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      if (reduced) draw(0);
    });
    canvas.addEventListener('pointerleave', () => { pointer.x = pointer.y = -1e4; });
    Promise.race([document.fonts.ready, sleep(1500)]).then(start, start);
  }

  /* ---------------------------------------------------------------------- */
  /* Hero chat: three questions, the tool call, and the computed answer.    */
  /* ---------------------------------------------------------------------- */
  const CONVOS = [
    {
      q: 'Am I recovered enough for intervals today?',
      tool: 'daily_briefing',
      b: 'Amber.',
      a: 'HRV is slightly low (49 ms vs your normal 51–63) and your load ramp is high (ACWR 1.34). Sleep and Body Battery look fine. Keep today easy and move the intervals to tomorrow.',
      sigs: [['amber', 'HRV'], ['green', 'Resting HR'], ['green', 'Sleep'], ['green', 'Body Battery'], ['blue', 'Form'], ['amber', 'Load ramp']],
    },
    {
      q: 'Am I ramping up too fast?',
      tool: 'training_load',
      b: 'A little.',
      a: 'Your acute:chronic ratio is 1.34, just over the 1.3 caution line. Fitness (CTL) is 58 and rising; fatigue (ATL) is 70. Hold this week’s volume rather than adding more.',
    },
    {
      q: 'Break down this morning’s run.',
      tool: 'analyze_activity',
      b: '10.2 km in 48:31',
      a: '(4:45 /km). Aerobic decoupling 3.1%, so it was well paced. Fastest 5k inside it: 23:12. 61% of the time in zone 2.',
    },
  ];
  function chatAnswer(c) {
    const sigs = c.sigs ? `<div class="m m-sigs">${c.sigs.map(([k, n]) => `<span><i class="sig ${k}"></i>${n}</span>`).join('')}</div>` : '';
    return { sigs };
  }
  async function initHeroChat() {
    const body = $('#hero-chat');
    if (!body) return;
    const input = $('#hero-chat-input');
    const box = input.parentElement;
    let visible = true;
    watch(body, (v) => (visible = v));
    const add = (html) => { body.insertAdjacentHTML('beforeend', html); return body.lastElementChild; };
    const w = async (ms) => { await sleep(ms); while (!visible || document.hidden) await sleep(400); };
    if (reduced) {
      const c = CONVOS[0];
      add(`<div class="m m-user">${c.q}</div><div class="m m-tool"><span class="ok">✓</span>threshold · ${c.tool}</div><div class="m m-ai"><b>${c.b}</b> ${c.a}</div>${chatAnswer(c).sigs}`);
      return;
    }
    await sleep(1400);
    for (let k = 0; ; k = (k + 1) % CONVOS.length) {
      const c = CONVOS[k];
      box.classList.add('typing');
      input.textContent = '';
      for (const ch of c.q) { input.textContent += ch; await w(26 + Math.random() * 34); }
      await w(420);
      box.classList.remove('typing');
      input.textContent = 'Ask about your training…';
      body.replaceChildren();
      add(`<div class="m m-user">${c.q}</div>`);
      await w(350);
      const tool = add(`<div class="m m-tool"><i class="spin"></i>threshold · ${c.tool}</div>`);
      await w(1200);
      tool.innerHTML = `<span class="ok">✓</span>threshold · ${c.tool}`;
      await w(250);
      const ai = add(`<div class="m m-ai"><b>${c.b}</b> <span></span></div>`);
      const span = ai.lastElementChild;
      for (const word of c.a.split(' ')) { span.textContent += word + ' '; await w(34); }
      const { sigs } = chatAnswer(c);
      if (sigs) add(sigs);
      await w(4600);
      await body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, fill: 'forwards' }).finished;
      body.replaceChildren();
      body.getAnimations().forEach((an) => an.cancel());
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Why: a believable stream of raw Garmin JSON                            */
  /* ---------------------------------------------------------------------- */
  function initRawJson() {
    const pre = $('#raw-json');
    if (!pre) return;
    const fields = [
      ['calendarDate', '"2026-10-23"'], ['totalKilocalories', 2841], ['activeKilocalories', 912], ['bmrKilocalories', 1929],
      ['totalSteps', 14203], ['totalDistanceMeters', 11872], ['minHeartRate', 44], ['maxHeartRate', 171],
      ['restingHeartRate', 47], ['lastSevenDaysAvgRestingHeartRate', 46], ['averageStressLevel', 29], ['maxStressLevel', 96],
      ['stressDuration', 18720], ['restStressDuration', 31260], ['lowStressDuration', 11400], ['mediumStressDuration', 5160],
      ['highStressDuration', 2160], ['bodyBatteryChargedValue', 58], ['bodyBatteryDrainedValue', 61], ['bodyBatteryHighestValue', 71],
      ['bodyBatteryLowestValue', 12], ['averageSpo2', 95], ['lowestSpo2', 89], ['avgWakingRespirationValue', 14],
      ['highestRespirationValue', 22], ['floorsAscendedInMeters', 41.2], ['moderateIntensityMinutes', 38], ['vigorousIntensityMinutes', 51],
      ['sleepTimeSeconds', 26640], ['deepSleepSeconds', 5220], ['lightSleepSeconds', 14460], ['remSleepSeconds', 5520],
      ['awakeSleepSeconds', 1440], ['sleepScores', '{ "overall": { "value": 82 } }'], ['hrvSummary', '{ "weeklyAvg": 49, "lastNightAvg": 47 }'],
      ['baseline', '{ "balancedLow": 51, "balancedUpper": 63 }'], ['status', '"UNBALANCED"'], ['vo2MaxValue', 58], ['trainingEffectLabel', '"VO2MAX"'],
    ];
    const one = '{\n' + fields.map(([k, v]) => `  <span class="k">"${k}"</span>: ${esc(String(v))},`).join('\n') + '\n  …\n}\n';
    pre.innerHTML = one + one;
  }

  /* ---------------------------------------------------------------------- */
  /* Dot-matrix charts in the feature cards                                 */
  /* ---------------------------------------------------------------------- */
  /** An LED matrix of square dots sized to the SVG; `cell(x, row)` gets x in 0..1. */
  function dotGrid(svg, rows, cell) {
    const draw = () => {
      const w = svg.clientWidth || 300, h = svg.clientHeight || 110;
      const s = h / rows;
      const cols = Math.max(8, Math.floor(w / s));
      const ox = (w - cols * s) / 2;
      let out = '';
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const [fill, op] = cell(i / (cols - 1), j) || ['#fff', 0.06];
          out += `<rect x="${(ox + i * s + s * 0.17).toFixed(1)}" y="${(j * s + s * 0.17).toFixed(1)}" width="${(s * 0.66).toFixed(1)}" height="${(s * 0.66).toFixed(1)}" rx="${(s * 0.2).toFixed(1)}" fill="${fill}" fill-opacity="${op}"/>`;
        }
      }
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.innerHTML = out;
    };
    draw();
    new ResizeObserver(draw).observe(svg);
  }
  function initCharts() {
    const load = $('#chart-load');
    if (load) {
      const rows = 12;
      const toRow = (v) => Math.round((rows - 1) * (1 - (v - 30) / 50));
      const ctl = (x) => 46 + 12 * smooth(0, 1, x);
      const atl = (x) => ctl(x) + 9 * Math.sin(x * Math.PI * 2 * (48 / 7) - 1) + (x > 0.8 ? (x - 0.8) * 45 : 0) - 2;
      dotGrid(load, rows, (x, j) => {
        const c = toRow(ctl(x)), a = toRow(atl(x));
        if (j === a) return ['#ff7a45', 1];
        if (j === c) return [INK, 0.95];
        if (j > Math.min(a, c) && j < Math.max(a, c)) return ['#ff7a45', 0.16];
        return null;
      });
    }
    const power = $('#chart-power');
    if (power) {
      const rows = 12;
      const p = (sec) => 250 + 18000 / (sec + 18000 / 700);
      dotGrid(power, rows, (x, j) => {
        const sec = 5 * Math.pow(720, x);
        const topRow = Math.round((rows - 1) * (1 - (p(sec) - 200) / 760));
        if (j < topRow) return null;
        const d = j - topRow;
        return [d === 0 ? '#c6a5ff' : RAMP[d < 4 ? 2 : 1], d === 0 ? 1 : Math.max(0.12, 0.6 - d * 0.06)];
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Free-tier meters: LED bars lit in the effort ramp                      */
  /* ---------------------------------------------------------------------- */
  function initMeters() {
    $$('#meters li').forEach((li) => {
      const m = li.querySelector('.meter');
      const n = 40;
      const lit = Math.max(1, Math.round(Number(li.dataset.pct) * n));
      m.innerHTML = '<i></i>'.repeat(n);
      m.setAttribute('role', 'img');
      m.setAttribute('aria-label', `${Math.max(1, Math.round(Number(li.dataset.pct) * 100))}% of the limit or less`);
      const dots = [...m.children];
      let done = false;
      watch(li, async (v) => {
        if (!v || done) return;
        done = true;
        for (let i = 0; i < lit; i++) {
          const c = RAMP[Math.min(4, Math.floor((i / n) * 5))];
          dots[i].style.background = c;
          dots[i].style.boxShadow = `0 0 8px ${c}88`;
          if (!reduced) await sleep(22);
        }
      }, 0.5);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* How it works: the README diagram, with a request travelling through it */
  /* ---------------------------------------------------------------------- */
  function initFlow() {
    const pre = $('#flow');
    if (!pre) return;
    const W1 = 21, G = 9, W2 = 35, W3 = 16;
    const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length));
    const P = (s, c) => ({ s, c });
    const V = P('│');
    const sp = (n) => P(' '.repeat(n));
    const top = (n) => P('┌' + '─'.repeat(n) + '┐');
    const bot = (n) => P('└' + '─'.repeat(n) + '┘');
    const rows = [
      [P(pad(' YOUR AI', W1 + 2), 'hd'), sp(G), P(pad(' YOUR CLOUDFLARE ACCOUNT · FREE', W2 + 2), 'hd'), sp(G), P(pad(' GARMIN', W3 + 2), 'hd')],
      [top(W1), sp(G), top(W2), sp(G), top(W3)],
      [V, P(pad(' "How am I today?"', W1), 'tx'), V, P(pad('  OAuth', G), 'lb'), V, P(' /mcp', 'tx'), P(pad('   16 tools · 4 prompts', W2 - 5), 'lb'), V, P(pad(' API key', G), 'lb'), V, P(pad(' Personal API', W3), 'tx'), V],
      [V, sp(W1), V, P('────────▶', 'req1'), V, P('  ├─ ', 'lb'), P('analysis', 'tx'), P(pad('  load · HRV · ready', W2 - 13), 'lb'), V, P('────────▶', 'req2'), V, P(pad(' read-only', W3), 'lb'), V],
      [V, P(pad(' Claude · ChatGPT', W1), 'lb'), V, P('◀────────', 'res1'), V, P('  ├─ ', 'lb'), P('FIT decoder', 'tx'), P(pad('  VO2 max · PRs', W2 - 16), 'lb'), V, P('◀────────', 'res2'), V, sp(W3), V],
      [V, P(pad(' Cursor · Codex · …', W1), 'lb'), V, P(pad(' numbers', G), 'lb'), V, P('  └─ ', 'lb'), P('D1 archive', 'tx'), P(' '), P('◀──', 'cron'), P(pad(' cron /10 min', W2 - 19), 'lb'), V, P(pad('  data', G), 'lb'), V, P(pad(' 24 h token', W3), 'lb'), V],
      [bot(W1), sp(G), bot(W2), sp(G), bot(W3)],
    ];
    const FLOW = new Set(['req1', 'req2', 'res1', 'res2', 'cron']);
    pre.innerHTML = rows.map((row) => row.map(({ s, c }) => {
      if (FLOW.has(c)) return [...s].map((ch, i) => `<span class="f" data-c="${c}" data-i="${i}">${ch}</span>`).join('');
      return c ? `<span class="${c}">${esc(s)}</span>` : esc(s);
    }).join('')).join('\n');

    // Position of each arrow cell along one round trip: AI → Worker → Garmin → Worker → AI.
    const L = 50;
    const cells = $$('.f', pre).map((el) => {
      const c = el.dataset.c, i = Number(el.dataset.i);
      const p = c === 'req1' ? i : c === 'req2' ? 12 + i : c === 'res2' ? 24 + (8 - i) : c === 'res1' ? 36 + (8 - i) : -1;
      return { el, c, i, p, back: c.startsWith('res') };
    });
    const DIM = [61, 64, 69], HOT = RAMP_RGB[4], COOL = RAMP_RGB[0];
    const mix = (a, b, k) => `rgb(${a.map((v, n) => Math.round(v + (b[n] - v) * k)).join(',')})`;
    const draw = (time) => {
      const head = (time / 75) % L;
      const cron = (time / 140) % 6;
      for (const { el, c, i, p, back } of cells) {
        let k;
        if (c === 'cron') { const d = cron - (2 - i); k = d >= 0 && d < 3 ? 1 - d / 3 : 0; }
        else { const d = head - p; k = d >= 0 && d < 6 ? 1 - d / 6 : 0; }
        el.style.color = k ? mix(DIM, back || c === 'cron' ? COOL : HOT, k) : '';
      }
    };
    loop(pre, draw);
  }

  /* ---------------------------------------------------------------------- */
  /* Client config tabs                                                     */
  /* ---------------------------------------------------------------------- */
  function initCode() {
    const files = {
      cursor: '~/.cursor/mcp.json', vscode: '.vscode/mcp.json', codex: '~/.codex/config.toml',
      gemini: '~/.gemini/settings.json', windsurf: '~/.codeium/windsurf/mcp_config.json', stdio: 'claude_desktop_config.json · via mcp-remote',
    };
    const tabs = $$('#code-tabs button');
    let current = 'cursor';
    tabs.forEach((b) => b.addEventListener('click', () => {
      current = b.dataset.code;
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === b)));
      Object.keys(files).forEach((k) => { $(`#code-${k}`).hidden = k !== current; });
      $('#code-file').textContent = files[current];
    }));
    const copy = $('#code-copy');
    copy?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($(`#code-${current}`).textContent);
        copy.textContent = 'Copied';
      } catch { copy.textContent = 'Select and copy'; }
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* The setup guide: each step replays the real screen, with a cursor.     */
  /* ---------------------------------------------------------------------- */
  const HOST = 'threshold.you.workers.dev';
  const MCP = `https://${HOST}/mcp`;
  const DOTS = (n) => '•'.repeat(n);
  // Threshold's own page icon, as served by src/auth/pages.ts
  const TP_ICON = '<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor" opacity=".12"/><path d="M5 20h5l3-9 4 14 3-9 2 4h5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const TP_FOOT = '<footer>Threshold 0.1.1 · self-hosted · <a>source</a></footer>';

  const consentPage = (name, host, published) => `
    <div class="tp"><div class="tp-zoom"><main>
      <header>${TP_ICON}<span>Threshold</span></header>
      <h1>Allow <strong>${name}</strong> to read your Garmin data?</h1>
      ${published ? `<p>Published by <strong>${host}</strong>.</p>` : '<p>This app registered itself, so its name is not verified.</p>'}
      <p>Access will be sent to <strong>${host}</strong>. It is read-only: the app can read your health and activity data through this server, and cannot change anything on Garmin.</p>
      <label>Access key</label>
      <div class="pw" data-k="key"></div>
      <div class="row"><button>Deny</button><button class="primary" data-k="allow">Allow</button></div>
      ${TP_FOOT}
    </main></div></div>`;

  const claudeSettings = (row) => `
    <div class="cl">
      <div class="cl-rail"><i></i><i></i><i></i><i></i></div>
      <div class="cl-main">
        <h4>Settings</h4>
        <div class="cl-tabs"><span>General</span><span>Account</span><span>Privacy</span><span>Billing</span><span>Capabilities</span><span class="on">Connectors</span></div>
        <div class="cl-head"><div><b>Connectors</b><p>Allow Claude to reference other apps and services for more context.</p></div><button class="cl-btn" data-k="add">Add custom connector</button></div>
        <div class="cl-list" data-k="list">${row || '<div class="cl-row" data-k="empty"><span class="ic">+</span><span class="nm">No custom connectors yet<small>Add a remote MCP server by URL</small></span></div>'}</div>
      </div>
    </div>`;
  const claudeRow = (state) => `<div class="cl-row${state === 'new' ? ' new' : ''}"><span class="ic t">T</span><span class="nm">Threshold<small>${HOST}</small></span>${state === 'on' ? '<span class="cl-ok">Connected · 16 tools</span>' : '<button class="cl-btn pri" data-k="connect">Connect</button>'}</div>`;

  const gptShell = (inner) => `<div class="gp"><div class="gp-side"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>${inner}</div>`;
  const gptChat = (pill) => `
    <div class="gp-chat">
      <div class="gp-thread" data-k="thread"><div class="gp-hello" data-k="hello">What can I help with?</div></div>
      <div class="gp-box">${pill ? '<span class="pill">Developer mode · Threshold</span>' : ''}<div class="txt" data-k="txt"></div><span class="send" data-k="send">↑</span></div>
    </div>`;

  const ANSWER = {
    b: 'Amber today: keep it easy.',
    a: 'Your 7-day HRV is 49 ms, just under your normal 51–63 ms, and your load ramp is high (ACWR 1.34). Sleep (7 h 24, score 82) and Body Battery (71) look good. Do easy aerobic work and move the intervals to tomorrow.',
  };
  const SIGROW = '<div class="sigrow"><span><i class="sig amber"></i>HRV</span><span><i class="sig green"></i>Resting HR</span><span><i class="sig green"></i>Sleep</span><span><i class="sig green"></i>Body Battery</span><span><i class="sig blue"></i>Form</span><span><i class="sig amber"></i>Load ramp</span></div>';

  async function approve(A, $k, onDone) {
    await A.point($k('key'));
    await A.click($k('key'));
    A.focus($k('key'));
    await A.type($k('key'), DOTS(24), 32);
    A.focus(null);
    await A.point($k('allow'));
    await A.click($k('allow'));
    $k('pop').classList.add('out');
    await A.wait(340);
    $k('pop').remove();
    onDone();
  }

  const SCENES = {
    garmin: {
      url: 'connect.garmin.com/app/settings/personalApiToken',
      cap: 'Garmin Connect → <b>Personal API</b> → <b>Create</b>. Copy the key: Garmin shows it only once.',
      ms: 7600,
      html: () => `
        <div class="gm" data-k="root">
          <div class="gm-top"><b>Garmin Connect</b><span></span></div>
          <div class="gm-body">
            <div class="gm-side"><span>Account</span><span>Profile &amp; Privacy</span><span>Display Preferences</span><span class="on">Personal API</span><span>Connected Apps</span></div>
            <div class="gm-main">
              <h4>Personal API</h4>
              <p>Create a key to read your own Garmin data with your own tools.</p>
              <div class="gm-card"><div class="gm-row h"><span>Key</span><span>Created</span><span></span></div><div class="gm-empty" data-k="empty">No keys yet</div></div>
              <button class="gm-btn" data-k="create">Create</button>
            </div>
          </div>
        </div>`,
      async play(A, $k) {
        await A.point($k('create'));
        await A.click($k('create'));
        A.add($k('root'), `<div class="gm-modal" data-k="modal"><div class="gm-dialog"><h5>Your new key</h5><div class="gm-key" data-k="key"></div><p class="gm-warn">Copy it now. Garmin shows it only once.</p><button class="gm-btn" data-k="copy">Copy</button></div></div>`);
        await A.wait(350);
        await A.type($k('key'), 'Q9mL2xR7vK4pT8nW3cY6bH1d', 16);
        await A.point($k('copy'));
        await A.click($k('copy'));
        $k('copy').textContent = 'Copied ✓';
        A.toast('Garmin key copied');
        await A.wait(900);
        $k('modal').remove();
        $k('empty').outerHTML = '<div class="gm-row"><span>••••••••••••H1d</span><span>Today</span><span></span></div>';
      },
    },

    deploy: {
      url: 'dash.cloudflare.com/?to=/:account/workers-and-pages/create/deploy-to-workers',
      cap: '<b>Deploy to Cloudflare</b> asks for two secrets: your Garmin key, and an access key you make up (20+ characters).',
      ms: 10500,
      html: () => `
        <div class="cf" data-k="root">
          <div class="cf-top"><b>Cloudflare</b><span>Workers &amp; Pages</span></div>
          <div class="cf-main">
            <h4>Deploy a Worker<small>From github.com/KareemmSayed/Threshold</small></h4>
            <div class="cf-grid">
              <div class="cf-f">Git repository<span class="cf-in">you/threshold</span></div>
              <div class="cf-f">Worker name<span class="cf-in">threshold</span></div>
            </div>
            <div class="cf-res"><span>D1 database: threshold<em>New</em></span><span>KV namespace: OAUTH_KV<em>New</em></span></div>
            <div class="cf-sec"><div><code>GARMIN_API_KEY</code><small>Your Garmin Personal API key.</small></div><span class="cf-in pw" data-k="g"></span></div>
            <div class="cf-sec"><div><code>ACCESS_KEY</code><small>A password you make up, 20+ characters.</small></div><span class="cf-in pw" data-k="a"></span></div>
            <button class="cf-btn" data-k="go">Create and deploy</button>
          </div>
        </div>`,
      async play(A, $k) {
        await A.point($k('g'));
        await A.click($k('g'));
        A.focus($k('g'));
        await A.paste($k('g'), DOTS(24), '⌘V  Garmin key pasted');
        await A.point($k('a'));
        await A.click($k('a'));
        A.focus($k('a'));
        await A.type($k('a'), DOTS(26), 30);
        A.focus(null);
        await A.point($k('go'));
        await A.click($k('go'));
        $k('go').innerHTML = '<i class="spin"></i>Deploying…';
        await A.wait(1700);
        A.add($k('root'), `<div class="cf-done"><span class="ok">✓</span><h5>Success! Your Worker is live.</h5><p>Database and KV created, secrets saved.</p><span class="cf-in">${HOST}</span></div>`);
      },
    },

    ready: {
      url: HOST,
      cap: 'Your server’s page says <b>Ready</b> and shows your MCP URL. Copy it. (If a key is missing, it says which and suggests one.)',
      ms: 5200,
      html: () => `
        <div class="tp"><div class="tp-zoom"><main>
          <header>${TP_ICON}<span>Threshold</span></header>
          <h1><span class="ok">●</span> Ready</h1>
          <p>Your private Garmin MCP server is set up. Connect your AI with this URL:</p>
          <p><code class="pick" data-k="url">${MCP}</code></p>
          <p><strong>Claude</strong> (web, desktop, mobile): Settings → Connectors → Add custom connector → paste the URL → enter your access key.</p>
          <p><strong>ChatGPT</strong>: Settings → Apps &amp; Connectors → Advanced → Developer mode on → Create → paste the URL → OAuth → enter your access key.</p>
          <p><strong>Claude Code</strong>:<br><code class="pick">claude mcp add --transport http threshold ${MCP} --header "Authorization: Bearer YOUR_ACCESS_KEY"</code></p>
          <p>Cursor, VS Code, Codex, Gemini CLI, Windsurf and others: <a>setup guide</a>.</p>
          <p>Then ask: <em>"How am I today?"</em></p>
          ${TP_FOOT}
        </main></div></div>`,
      async play(A, $k) {
        await A.point($k('url'), { dx: 0.4 });
        await A.click($k('url'));
        $k('url').classList.add('sel');
        await A.wait(300);
        A.toast('⌘C  MCP URL copied');
        await A.wait(600);
      },
    },

    claudeAdd: {
      url: 'claude.ai/settings/connectors',
      cap: 'Claude → <b>Settings</b> → <b>Connectors</b> → <b>Add custom connector</b>. Name it, paste the URL, then <b>Connect</b>.',
      ms: 10800,
      html: () => `<div data-k="root" style="height:100%;position:relative">${claudeSettings()}</div>`,
      async play(A, $k) {
        await A.point($k('add'));
        await A.click($k('add'));
        A.add($k('root'), `<div class="cl-modal" data-k="modal"><div class="cl-dialog">
          <h5>Add custom connector <em>BETA</em></h5>
          <div class="cl-f">Name<span class="cl-in" data-k="name"></span></div>
          <div class="cl-f">Remote MCP server URL<span class="cl-in" data-k="url"></span></div>
          <div class="cl-adv">Advanced settings ›</div>
          <div class="cl-actions"><button class="cl-btn">Cancel</button><button class="cl-btn pri" data-k="ok">Add</button></div>
        </div></div>`);
        await A.wait(300);
        await A.point($k('name'));
        await A.click($k('name'));
        A.focus($k('name'));
        await A.type($k('name'), 'Threshold', 55);
        await A.point($k('url'));
        await A.click($k('url'));
        A.focus($k('url'));
        await A.paste($k('url'), MCP, '⌘V  URL pasted');
        A.focus(null);
        await A.point($k('ok'));
        await A.click($k('ok'));
        $k('modal').remove();
        $k('empty').outerHTML = claudeRow('new');
        await A.wait(500);
        await A.point($k('connect'));
        await A.click($k('connect'));
      },
    },

    claudeApprove: {
      url: 'claude.ai/settings/connectors',
      cap: 'Your server’s own consent page opens. Type your <b>access key</b> and click <b>Allow</b>. It is read-only.',
      ms: 6600,
      html: () => `
        <div class="popup-bg" data-k="bg">${claudeSettings(claudeRow())}</div>
        <div class="popup" data-k="pop"><div class="popup-bar"><span class="lights"><i></i><i></i><i></i></span><span>${HOST}/authorize</span></div>${consentPage('Claude', 'claude.ai', true)}</div>`,
      async play(A, $k) {
        await approve(A, $k, () => {
          $k('bg').classList.remove('popup-bg');
          $k('bg').style.height = '100%';
          $k('connect').outerHTML = '<span class="cl-ok">Connected · 16 tools</span>';
          A.toast('Threshold connected');
        });
        await A.wait(400);
      },
    },

    claudeAsk: {
      url: 'claude.ai/new',
      cap: 'Ask. Claude calls <b>daily_briefing</b>; the numbers come from code, not the model. Same on the Claude phone apps.',
      ms: 12000,
      html: () => `
        <div class="cl">
          <div class="cl-rail"><i></i><i></i><i></i><i></i></div>
          <div class="cl-chat">
            <div class="cl-thread" data-k="thread"><div class="cl-hello" data-k="hello"><div><span>✻</span> Good morning</div></div></div>
            <div class="cl-box"><div class="txt" data-k="txt"></div><div class="bot"><span class="tools">⚙ Threshold</span><span class="send" data-k="send">↑</span></div></div>
          </div>
        </div>`,
      async play(A, $k) {
        await A.point($k('txt'), { dx: 0.1 });
        await A.click($k('txt'));
        await A.type($k('txt'), 'How am I today?', 60);
        await A.point($k('send'));
        await A.click($k('send'));
        $k('txt').textContent = '';
        $k('hello').remove();
        A.hide();
        const th = $k('thread');
        A.add(th, '<div class="cl-user m">How am I today?</div>');
        await A.wait(400);
        const tool = A.add(th, '<div class="cl-tool m"><i class="spin"></i>Threshold · daily_briefing</div>');
        await A.wait(1300);
        tool.innerHTML = '<span class="ok">✓</span>Threshold · daily_briefing';
        const ans = A.add(th, `<div class="cl-ans m"><b>${ANSWER.b}</b> <span></span></div>`);
        await A.stream(ans.lastElementChild, ANSWER.a);
        A.add(th, SIGROW.replace('sigrow', 'sigrow m'));
      },
    },

    gptAdd: {
      url: 'chatgpt.com/#settings/Connectors',
      cap: 'ChatGPT → <b>Settings</b> → <b>Apps &amp; Connectors</b> → <b>Advanced</b>: turn on <b>Developer mode</b>, then <b>Create</b> with OAuth.',
      ms: 13000,
      html: () => gptShell(`${gptChat(false)}
        <div class="gp-modal" data-k="modal"><div class="gp-set" data-k="set">
          <div class="gp-nav"><span>General</span><span>Notifications</span><span>Personalization</span><span class="on">Apps &amp; Connectors</span><span>Data controls</span><span>Security</span><span>Account</span></div>
          <div class="gp-pane">
            <h5>Advanced settings</h5>
            <div class="gp-line"><div>Developer mode<small>Use custom MCP connectors in your chats.</small></div><span class="gp-tog" data-k="tog"></span></div>
            <div class="gp-line" data-k="crow" style="visibility:hidden"><div>Connectors<small>Add your own MCP server.</small></div><button class="gp-btn pri" data-k="create">Create</button></div>
          </div>
        </div></div>`),
      async play(A, $k) {
        await A.point($k('tog'));
        await A.click($k('tog'));
        $k('tog').classList.add('on');
        await A.wait(450);
        $k('crow').style.visibility = '';
        $k('crow').classList.add('m');
        await A.point($k('create'));
        await A.click($k('create'));
        $k('set').outerHTML = `<div class="gp-dlg">
          <h5>New Connector</h5>
          <div class="gp-f">Name<span class="gp-in" data-k="name"></span></div>
          <div class="gp-f">MCP Server URL<span class="gp-in" data-k="url"></span></div>
          <div class="gp-f">Authentication<span class="gp-in" data-k="auth"><span data-k="authv">No authentication</span><span>⌄</span></span></div>
          <div class="gp-check"><i data-k="trust"></i>I trust this application</div>
          <div class="cl-actions"><button class="gp-btn">Cancel</button><button class="gp-btn pri" data-k="ok">Create</button></div>
        </div>`;
        await A.wait(300);
        await A.point($k('name'));
        await A.click($k('name'));
        A.focus($k('name'));
        await A.type($k('name'), 'Threshold', 55);
        await A.point($k('url'));
        await A.click($k('url'));
        A.focus($k('url'));
        await A.paste($k('url'), MCP, '⌘V  URL pasted');
        A.focus(null);
        await A.point($k('auth'));
        await A.click($k('auth'));
        $k('authv').textContent = 'OAuth';
        $k('auth').classList.add('flash');
        await A.wait(300);
        await A.point($k('trust'), { dx: 0.5 });
        await A.click($k('trust'));
        $k('trust').classList.add('on');
        $k('trust').textContent = '✓';
        await A.point($k('ok'));
        await A.click($k('ok'));
      },
    },

    gptApprove: {
      url: 'chatgpt.com',
      cap: 'ChatGPT opens your server’s consent page. Type your <b>access key</b> and click <b>Allow</b>.',
      ms: 6600,
      html: () => `
        <div class="popup-bg" data-k="bg">${gptShell(gptChat(false))}</div>
        <div class="popup" data-k="pop"><div class="popup-bar"><span class="lights"><i></i><i></i><i></i></span><span>${HOST}/authorize</span></div>${consentPage('ChatGPT', 'chatgpt.com', false)}</div>`,
      async play(A, $k) {
        await approve(A, $k, () => {
          $k('bg').classList.remove('popup-bg');
          $k('bg').style.height = '100%';
          A.toast('Threshold connected');
        });
        await A.wait(400);
      },
    },

    gptAsk: {
      url: 'chatgpt.com',
      cap: 'In a chat, pick <b>Developer mode</b>, switch on <b>Threshold</b>, and ask.',
      ms: 12000,
      html: () => gptShell(gptChat(true)),
      async play(A, $k) {
        await A.point($k('txt'), { dx: 0.1 });
        await A.click($k('txt'));
        await A.type($k('txt'), 'How am I today?', 60);
        await A.point($k('send'));
        await A.click($k('send'));
        $k('txt').textContent = '';
        $k('hello').remove();
        A.hide();
        const th = $k('thread');
        A.add(th, '<div class="gp-user m">How am I today?</div>');
        await A.wait(400);
        const tool = A.add(th, '<div class="gp-tool m"><i class="spin" style="width:10px;height:10px;border-radius:50%;border:1.5px solid #555;border-top-color:#fff;animation:spin .7s linear infinite"></i>Calling Threshold · daily_briefing</div>');
        await A.wait(1300);
        tool.innerHTML = '<span class="ok">✓</span>Called Threshold · daily_briefing';
        const ans = A.add(th, `<div class="gp-ans m"><b>${ANSWER.b}</b> <span></span></div>`);
        await A.stream(ans.lastElementChild, ANSWER.a);
        A.add(th, SIGROW.replace('sigrow', 'sigrow m'));
      },
    },

    codeAdd: {
      url: 'Terminal — zsh',
      cap: 'One command. Your access key goes in a bearer header.',
      ms: 9000,
      html: () => '<div class="tm" data-k="tm"><div class="ln"><span class="pr">~ ❯</span> <span data-k="cmd"></span></div></div>',
      async play(A, $k) {
        A.hide();
        await A.type($k('cmd'), `claude mcp add --transport http threshold ${MCP} --header "Authorization: Bearer YOUR_ACCESS_KEY"`, 18);
        await A.wait(350);
        A.add($k('tm'), `<div class="ln m">Added HTTP MCP server threshold with URL: ${MCP} to local config</div>`);
        await A.wait(300);
        A.add($k('tm'), '<div class="ln m"><span class="pr">~ ❯</span> <span class="typed"></span></div>');
      },
    },

    codeCheck: {
      url: 'Terminal — claude',
      cap: 'Start Claude Code and run <kbd>/mcp</kbd>: <b>threshold</b> shows as connected.',
      ms: 7000,
      html: () => '<div class="tm" data-k="tm"><div class="ln"><span class="pr">~ ❯</span> <span data-k="cmd"></span></div></div>',
      async play(A, $k) {
        A.hide();
        await A.type($k('cmd'), 'claude', 70);
        await A.wait(300);
        A.add($k('tm'), '<div class="bx or m"><span class="or">✻</span> Welcome to Claude Code!\n\n  <span class="mu">cwd: ~/training</span></div>');
        await A.wait(400);
        const ln = A.add($k('tm'), '<div class="in m">&gt; <span data-k="q"></span></div>');
        await A.type(ln.lastElementChild, '/mcp', 90);
        await A.wait(400);
        A.add($k('tm'), '<div class="bx m"><b>Manage MCP servers</b>\n\n<span class="or">❯</span> 1. threshold  <span class="gr">✔ connected</span> <span class="mu">· 16 tools · Enter to view details</span></div>');
      },
    },

    codeAsk: {
      url: 'Terminal — claude',
      cap: 'Ask in the terminal. Claude Code calls the same tools.',
      ms: 11000,
      html: () => '<div class="tm" data-k="tm"><div class="bx or"><span class="or">✻</span> Welcome to Claude Code!</div><div class="in">&gt; <span data-k="q"></span></div></div>',
      async play(A, $k) {
        A.hide();
        await A.type($k('q'), 'How am I today?', 65);
        await A.wait(350);
        A.add($k('tm'), '<div class="ln m"><span class="gr">⏺</span> <b>threshold - daily_briefing</b> <span class="mu">(MCP)(date: "today")</span></div>');
        await A.wait(800);
        A.add($k('tm'), '<div class="ln m mu">  ⎿  { "overall": { "status": "amber", "rule": "red: 2+ warnings or 2+ recovery signals off; amber: 1 warning or 2+ cautions; else green." }, … }</div>');
        await A.wait(600);
        const ans = A.add($k('tm'), `<div class="ln m"><span>⏺</span> <b>${ANSWER.b}</b> <span></span></div>`);
        await A.stream(ans.lastElementChild, ANSWER.a);
      },
    },
  };

  const SHARED = [
    ['Create a Garmin key', 'Garmin Connect → Personal API → Create. Copy it; Garmin shows it once.'],
    ['Deploy with both keys', 'Click Deploy to Cloudflare. Paste your Garmin key and make up an access key.'],
    ['Open your server', 'It says Ready and shows your MCP URL. Copy it.'],
  ];
  const CLIENTS = {
    claude: {
      scenes: ['garmin', 'deploy', 'ready', 'claudeAdd', 'claudeApprove', 'claudeAsk'],
      steps: [...SHARED,
        ['Add a custom connector', 'Settings → Connectors → Add custom connector. Paste the URL.'],
        ['Approve with your access key', 'Threshold’s own page opens. Type your access key, click Allow.'],
        ['Ask', '“How am I today?” Works on web, desktop and phone.']],
    },
    chatgpt: {
      scenes: ['garmin', 'deploy', 'ready', 'gptAdd', 'gptApprove', 'gptAsk'],
      steps: [...SHARED,
        ['Create a connector', 'Settings → Apps & Connectors → Advanced → Developer mode → Create, with OAuth.'],
        ['Approve with your access key', 'Threshold’s own page opens. Type your access key, click Allow.'],
        ['Ask', 'Turn on Threshold in Developer mode and ask.']],
    },
    code: {
      scenes: ['garmin', 'deploy', 'ready', 'codeAdd', 'codeCheck', 'codeAsk'],
      steps: [...SHARED,
        ['Add the server', 'One claude mcp add command, with your access key as a bearer token.'],
        ['Check it’s connected', 'Run /mcp: threshold shows as connected.'],
        ['Ask', '“How am I today?” right in your terminal.']],
    },
  };

  function initGuide() {
    const stage = $('#stage');
    if (!stage) return;
    const screen = $('#screen');
    const cursor = $('#cursor');
    const urlEl = $('#stage-url');
    const caption = $('#stage-caption');
    const items = $$('#guide-steps li');
    const playBtn = $('#g-play');
    const CANCEL = Symbol('cancel');

    const st = { client: 'claude', i: 0, auto: !reduced, visible: false, tok: null, started: false, waiters: [] };
    const onVisible = () => new Promise((r) => st.waiters.push(r));

    const setPlayIcon = () => {
      const ended = st.i === items.length - 1 && st.finished;
      playBtn.textContent = ended ? '↻' : st.auto ? '❚❚' : '▶';
      playBtn.setAttribute('aria-label', ended ? 'Replay' : st.auto ? 'Pause' : 'Play');
    };

    const renderList = () => {
      const steps = CLIENTS[st.client].steps;
      items.forEach((li, n) => {
        li.querySelector('.t b').textContent = steps[n][0];
        li.querySelector('.t span').textContent = steps[n][1];
        li.classList.toggle('on', n === st.i);
        li.classList.toggle('done', n < st.i);
        li.querySelector('button').setAttribute('aria-current', n === st.i ? 'step' : 'false');
        li.querySelector('.bar').style.setProperty('--p', n < st.i ? 1 : 0);
      });
      // On narrow screens the steps are one scrolling row; keep the current one in view.
      const list = items[0].parentElement;
      if (list.scrollWidth > list.clientWidth) {
        list.scrollTo({ left: items[st.i].offsetLeft - list.offsetLeft - 16, behavior: reduced ? 'auto' : 'smooth' });
      }
    };

    function api(tok) {
      const chk = () => { if (tok.dead) throw CANCEL; };
      const wait = async (ms) => {
        if (!reduced) await sleep(ms);
        chk();
        while (!st.visible || document.hidden) { await Promise.race([onVisible(), sleep(600)]); chk(); }
      };
      const A = {
        wait,
        async point(el, { dx = 0.5, dy = 0.55 } = {}) {
          chk();
          if (!el) return;
          const r = el.getBoundingClientRect();
          const s = stage.getBoundingClientRect();
          cursor.classList.add('show');
          cursor.style.transform = `translate(${r.left - s.left + r.width * dx}px, ${r.top - s.top + r.height * dy}px)`;
          await wait(820);
        },
        async click(el) {
          chk();
          cursor.classList.remove('click');
          void cursor.offsetWidth;
          cursor.classList.add('click');
          el?.classList.add('press');
          await wait(280);
          el?.classList.remove('press');
          cursor.classList.remove('click');
        },
        async type(el, text, speed = 45) {
          el.classList.add('typed');
          if (reduced) el.textContent = text;
          else for (const ch of text) { el.textContent += ch; await wait(speed * (0.6 + Math.random() * 0.8)); }
          el.classList.remove('typed');
        },
        async paste(el, text, note) {
          el.textContent = text;
          el.classList.remove('flash');
          void el.offsetWidth;
          el.classList.add('flash');
          if (note) A.toast(note);
          await wait(650);
        },
        async stream(el, text) {
          for (const word of text.split(' ')) { el.textContent += word + ' '; await wait(38); }
        },
        focus(el) {
          $$('.focus', screen).forEach((e) => e.classList.remove('focus'));
          el?.classList.add('focus');
        },
        add(parent, html) { parent.insertAdjacentHTML('beforeend', html); return parent.lastElementChild; },
        toast(msg) {
          $$('.toast', screen).forEach((t) => t.remove());
          const t = A.add(screen, `<div class="toast">${esc(msg)}</div>`);
          setTimeout(() => t.remove(), 1700);
        },
        hide() { cursor.classList.remove('show'); },
      };
      return A;
    }

    let rafId = 0;
    async function run() {
      if (st.tok) st.tok.dead = true;
      const tok = (st.tok = { dead: false });
      st.finished = false;
      setPlayIcon();
      const name = CLIENTS[st.client].scenes[st.i];
      const sc = SCENES[name];
      renderList();
      screen.innerHTML = sc.html();
      urlEl.textContent = sc.url;
      caption.innerHTML = sc.cap;
      cursor.classList.remove('show', 'click');
      // The cursor starts each scene from the middle of the screen
      cursor.style.transition = 'none';
      cursor.style.transform = `translate(${stage.clientWidth * 0.55}px, ${stage.clientHeight * 0.62}px)`;
      void cursor.offsetWidth;
      cursor.style.transition = '';

      const bar = items[st.i].querySelector('.bar');
      const t0 = performance.now();
      let paused = 0, pauseAt = 0;
      cancelAnimationFrame(rafId);
      const tick = (now) => {
        if (tok.dead) return;
        if (!st.visible) { if (!pauseAt) pauseAt = now; }
        else if (pauseAt) { paused += now - pauseAt; pauseAt = 0; }
        bar.style.setProperty('--p', Math.min(0.96, (now - t0 - paused) / sc.ms).toFixed(3));
        rafId = requestAnimationFrame(tick);
      };
      if (!reduced) rafId = requestAnimationFrame(tick);

      const $k = (k) => screen.querySelector(`[data-k="${k}"]`);
      const A = api(tok);
      try {
        await A.wait(450);
        await sc.play(A, $k);
        cancelAnimationFrame(rafId);
        bar.style.setProperty('--p', 1);
        await A.wait(2600);
      } catch (e) {
        if (e === CANCEL) return;
        throw e;
      }
      if (tok.dead) return;
      st.finished = true;
      if (st.auto && st.i < items.length - 1) { st.i += 1; run(); }
      else setPlayIcon();
    }

    const go = (i) => { st.i = clamp(i, 0, items.length - 1); run(); };
    items.forEach((li, n) => li.querySelector('button').addEventListener('click', () => go(n)));
    $('#g-prev').addEventListener('click', () => go(st.i - 1));
    $('#g-next').addEventListener('click', () => go(st.i + 1));
    playBtn.addEventListener('click', () => {
      if (st.finished && st.i === items.length - 1) { st.auto = !reduced; go(0); return; }
      st.auto = !st.auto;
      setPlayIcon();
      if (st.auto && st.finished) go(st.i + 1);
    });
    $$('#guide-tabs button').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.client === st.client) return;
      st.client = b.dataset.client;
      $$('#guide-tabs button').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
      // The first three steps are the same for every app; jump to where the paths differ.
      go(3);
    }));

    renderList();
    caption.innerHTML = SCENES.garmin.cap;
    urlEl.textContent = SCENES.garmin.url;
    screen.innerHTML = SCENES.garmin.html();
    watch($('.stage-wrap'), (v) => {
      st.visible = v;
      if (v) { st.waiters.splice(0).forEach((r) => r()); if (!st.started) { st.started = true; run(); } }
    }, 0.35);
  }

  /* ---------------------------------------------------------------------- */
  initType();
  initReveal();
  initAura();
  initNav();
  initRawJson();
  initCharts();
  initMeters();
  initFlow();
  initCode();
  initGuide();
  initHeroChat();
  initAsciiHero();
  initAsciiWord();
  // Glass last, once layout has settled
  requestAnimationFrame(() => requestAnimationFrame(initGlass));
})();
