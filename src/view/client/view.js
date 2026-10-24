/*
 * Threshold view renderer. Builds the card from a view spec (src/view/spec.ts) with DOM APIs
 * only, never innerHTML, so text from the model or from Garmin cannot become markup.
 *
 * It runs in three places:
 *   - an MCP Apps host (Claude, VS Code, Goose...): the spec arrives over postMessage
 *   - ChatGPT: the spec is window.openai.toolOutput
 *   - the private link page: the spec is embedded as JSON
 */
(() => {
  'use strict';

  const PROTOCOL = '2026-01-26';
  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = {
    ink: '#f4f3ef', hot: '#ff7a45', blue: '#4da8ff', indigo: '#7b8cff', violet: '#a56bff', pink: '#e36bd6',
    green: '#32d583', amber: '#ffb224', red: '#ff5a4e', muted: '#8e9195',
  };
  const SERIES_TONES = ['hot', 'ink', 'blue', 'violet'];
  const AURAS = new Set(['flame', 'violet', 'moss', 'azure', 'ember', 'graphite']);
  const STATUSES = new Set(['green', 'amber', 'red', 'blue']);
  const FULL_BY_DEFAULT = new Set(['stats', 'headline', 'table', 'chart', 'signals']);
  const BARE_WHEN_FULL = new Set(['stats', 'headline', 'table', 'chart', 'signals']);
  const SQL_WORDS = /^(select|from|where|group|order|by|as|and|or|not|in|is|null|join|left|inner|on|with|having|between|limit|offset|desc|asc|case|when|then|else|end|distinct|sum|count|avg|min|max|round|strftime|date|julianday|cast|coalesce|over|partition|union|all)$/i;

  const root = document.getElementById('root');
  const onPage = document.body.classList.contains('page');
  let openLink = (url) => window.open(url, '_blank', 'noopener,noreferrer');
  let notifySize = () => {};

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  function h(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
  }
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  /** Typographic minus for negative numbers, as on the site: "TSB −12". */
  const pretty = (v) => String(v).replace(/(^|[\s(·→/])-(?=\d)/g, '$1−');
  /** Put a value into a node; null and empty show a dimmed dash (missing data is never 0). */
  function setValue(node, v) {
    if (v === null || v === undefined || v === '') {
      node.textContent = '—';
      node.classList.add('missing');
    } else {
      node.textContent = pretty(v);
    }
    return node;
  }
  const toneClass = (tone) => (tone === 'hot' || !tone ? 'hot' : COLORS[tone] && tone !== 'ink' ? `tone-${tone}` : '');

  /* ---------------------------------------------------------------------- */
  /* Blocks                                                                 */
  /* ---------------------------------------------------------------------- */

  function stats(b) {
    const items = (b.items || []).slice(0, 6);
    const wrap = h('div', 'stats');
    wrap.style.setProperty('--n', String(items.length <= 4 ? items.length : 3));
    for (const it of items) {
      const cell = h('div');
      cell.append(setValue(h('span', 'dot dot-md'), it.value), h('small', null, it.label));
      wrap.append(cell);
    }
    return wrap;
  }

  function headline(b) {
    const p = h('p', 'headline');
    p.append(h('span', `dot dot-md ${toneClass(b.tone)}`, pretty(b.value || '')));
    if (b.text) p.append(document.createTextNode(b.text));
    return p;
  }

  function hero(b, half) {
    const big = h('div', 'big');
    big.append(setValue(h('span', `dot ${half ? 'dot-md' : 'dot-xl'}`), b.value));
    if (b.unit) big.append(h('small', null, b.unit));
    return big;
  }

  function bars(b) {
    const rows = b.rows || [];
    const amounts = rows.map((r) => r.amount).filter(isNum);
    const max = Math.max(...amounts);
    const min = Math.min(...amounts);
    const width = (a) => {
      if (!isNum(a) || !amounts.length) return 0;
      if (b.baseline === 'min') return max === min ? 1 : 0.6 + (0.4 * (a - min)) / (max - min);
      return max > 0 ? Math.max(0, a / max) : 0;
    };
    const ul = h('ul', 'bars');
    if (b.title) ul.setAttribute('aria-label', b.title);
    for (const r of rows) {
      const li = h('li', r.highlight ? 'hl' : null);
      if (r.tone && COLORS[r.tone]) {
        li.dataset.tone = r.tone;
        li.style.setProperty('--c', COLORS[r.tone]);
      }
      const bar = h('i');
      bar.style.setProperty('--w', width(r.amount).toFixed(3));
      li.append(h('span', null, r.label), bar, setValue(h('b'), r.value));
      ul.append(li);
    }
    return ul;
  }

  function kv(b) {
    const frag = document.createDocumentFragment();
    for (const r of b.rows || []) {
      const row = h('div', 'kv');
      row.append(h('span', null, r.label), setValue(h('b'), r.value));
      frag.append(row);
    }
    return frag;
  }

  function signals(b) {
    const ul = h('ul', 'signals');
    for (const r of b.rows || []) {
      const li = h('li');
      li.append(h('i', `sig ${STATUSES.has(r.status) ? r.status : ''}`), document.createTextNode(r.label || ''), setValue(h('span'), r.value));
      ul.append(li);
    }
    return ul;
  }

  function table(b) {
    const cols = b.columns || [];
    const rows = b.rows || [];
    const hasBar = rows.some((r) => isNum(r.bar));
    const after = Number.isInteger(b.bar_after) ? Math.min(Math.max(b.bar_after, 0), cols.length - 1) : Math.min(1, cols.length - 1);
    const strong = Number.isInteger(b.strong_column) ? b.strong_column : cols.length > 1 ? 1 : -1;
    const amounts = rows.map((r) => r.bar).filter(isNum);
    const max = Math.max(...amounts);
    const min = Math.min(...amounts);
    // Short bars still show; the spread between rows is what matters.
    const width = (a) => {
      if (!isNum(a)) return 0;
      if (max === min) return 1;
      const t = (a - min) / (max - min);
      return 0.15 + 0.85 * (b.bar_longer === 'lower' ? 1 - t : t);
    };

    const wrap = h('div', 'tbl');
    const t = h('table');
    const head = h('tr');
    cols.forEach((c, i) => {
      const th = h('th', null, c);
      th.scope = 'col';
      head.append(th);
      if (hasBar && i === after) head.append(h('th', 'bar-col'));
    });
    const thead = h('thead');
    thead.append(head);
    const tbody = h('tbody');
    for (const r of rows) {
      const tr = h('tr', r.highlight ? 'hl' : null);
      cols.forEach((_, i) => {
        const cell = (r.cells || [])[i];
        const td = h('td');
        td.append(setValue(h(i === strong ? 'b' : 'span'), cell === undefined ? null : cell));
        tr.append(td);
        if (hasBar && i === after) {
          const bar = h('td', 'bar-col');
          const line = h('i', isNum(r.bar) ? null : 'no-bar');
          line.style.setProperty('--w', width(r.bar).toFixed(3));
          bar.append(line);
          tr.append(bar);
        }
      });
      tbody.append(tr);
    }
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }

  /** Mean of a series over [from, to), or null when empty. */
  function bucket(values, from, to) {
    let sum = 0;
    let n = 0;
    for (let i = Math.floor(from); i < Math.max(Math.floor(from) + 1, Math.ceil(to)) && i < values.length; i++) {
      if (isNum(values[i])) {
        sum += values[i];
        n++;
      }
    }
    return n ? sum / n : null;
  }

  /** Value of a series at column i of `cols`: averaged when the series is longer, interpolated when shorter. */
  function sampleLine(values, i, cols) {
    const n = values.length;
    if (n > cols) return bucket(values, (i * n) / cols, ((i + 1) * n) / cols);
    const p = cols === 1 ? 0 : (i / (cols - 1)) * (n - 1);
    const a = Math.floor(p);
    const b = Math.min(n - 1, a + 1);
    const va = values[a];
    const vb = values[b];
    if (isNum(va) && isNum(vb)) return va + (vb - va) * (p - a);
    return isNum(va) ? va : isNum(vb) ? vb : null;
  }

  function chart(b) {
    const wrap = h('div', 'chart');
    const kind = b.kind === 'columns' ? 'columns' : 'line';
    const series = (b.series || []).filter((s) => Array.isArray(s.values) && s.values.some(isNum)).slice(0, kind === 'columns' ? 1 : 4);
    if (!series.length) {
      wrap.append(h('p', 'note', 'No data to chart.'));
      return wrap;
    }
    const tones = series.map((s, i) => COLORS[s.tone] || COLORS[SERIES_TONES[i]]);
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const v of s.values) {
        if (isNum(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    if (kind === 'columns') {
      lo = Math.min(0, lo);
      hi = Math.max(0, hi);
    }
    if (lo === hi) {
      lo -= 1;
      hi += 1;
    }
    if (kind === 'line') {
      const pad = (hi - lo) * 0.08;
      lo -= pad;
      hi += pad;
    }
    const ROWS = 12;
    const rowOf = (v) => Math.round((ROWS - 1) * (1 - (v - lo) / (hi - lo)));
    const n = Math.max(...series.map((s) => s.values.length));

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'dotchart');
    svg.setAttribute('role', 'img');
    const first = (vs) => vs.find(isNum);
    const last = (vs) => [...vs].reverse().find(isNum);
    svg.setAttribute('aria-label', `${b.title ? `${b.title}: ` : ''}${series.map((s) => `${s.label}, from ${first(s.values)} to ${last(s.values)}`).join('; ')}`);

    const draw = () => {
      const w = svg.clientWidth || 300;
      const height = svg.clientHeight || 120;
      const size = height / ROWS;
      const cols = Math.max(8, Math.floor(w / size));
      const ox = (w - cols * size) / 2;
      const cells = []; // [col][row] -> [color, opacity]
      for (let i = 0; i < cols; i++) cells.push(new Array(ROWS).fill(null));

      if (kind === 'line') {
        const rows = series.map((s) => Array.from({ length: cols }, (_, i) => {
          const v = sampleLine(s.values, i, cols);
          return v === null ? null : rowOf(v);
        }));
        for (let i = 0; i < cols; i++) {
          if (b.fill_between && rows.length > 1 && rows[0][i] !== null && rows[1][i] !== null) {
            const top = Math.min(rows[0][i], rows[1][i]);
            const bottom = Math.max(rows[0][i], rows[1][i]);
            for (let j = top + 1; j < bottom; j++) cells[i][j] = [tones[0], 0.16];
          }
          // Earlier series draw on top, as on the site (fatigue over fitness).
          for (let k = rows.length - 1; k >= 0; k--) {
            const j = rows[k][i];
            if (j !== null) cells[i][j] = [tones[k], k === 0 ? 1 : 0.95];
          }
        }
      } else {
        const values = series[0].values;
        const zero = rowOf(0);
        const per = cols / n;
        for (let i = 0; i < cols; i++) {
          let v;
          if (n > cols) v = bucket(values, (i * n) / cols, ((i + 1) * n) / cols);
          else {
            const k = Math.min(n - 1, Math.floor(i / per));
            // Leave a one-dot gap between buckets when they are wide enough.
            if (per >= 3 && Math.floor((i + 1) / per) !== k && i !== cols - 1) continue;
            v = values[k];
          }
          if (!isNum(v)) continue;
          const end = rowOf(v);
          const from = Math.min(end, zero);
          const to = Math.max(end, zero);
          for (let j = from; j <= to; j++) {
            const d = Math.abs(j - end);
            cells[i][j] = [tones[0], d === 0 ? 1 : Math.max(0.14, 0.6 - d * 0.06)];
          }
        }
      }

      const frag = document.createDocumentFragment();
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < ROWS; j++) {
          const [fill, op] = cells[i][j] || ['#ffffff', 0.06];
          const r = document.createElementNS(NS, 'rect');
          r.setAttribute('x', (ox + i * size + size * 0.17).toFixed(1));
          r.setAttribute('y', (j * size + size * 0.17).toFixed(1));
          r.setAttribute('width', (size * 0.66).toFixed(1));
          r.setAttribute('height', (size * 0.66).toFixed(1));
          r.setAttribute('rx', (size * 0.2).toFixed(1));
          r.setAttribute('fill', fill);
          r.setAttribute('fill-opacity', String(op));
          frag.append(r);
        }
      }
      svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
      svg.replaceChildren(frag);
    };
    wrap.append(svg);
    requestAnimationFrame(draw);
    let lastWidth = 0;
    new ResizeObserver(() => {
      if (svg.clientWidth !== lastWidth) {
        lastWidth = svg.clientWidth;
        draw();
      }
    }).observe(svg);

    const labels = Array.isArray(b.x_labels) ? b.x_labels : [];
    if (labels.length) {
      const axis = h('div', 'axis');
      if (kind === 'columns' && labels.length <= 12) {
        axis.classList.add('even');
        labels.forEach((l) => axis.append(h('span', null, l)));
      } else {
        const picks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (labels.length - 1))))];
        picks.forEach((i) => axis.append(h('span', null, labels[i])));
      }
      wrap.append(axis);
    }
    if (series.length > 1 || series[0].label) {
      const legend = h('div', 'legend');
      series.forEach((s, i) => {
        const item = h('span');
        const swatch = h('i');
        swatch.style.background = tones[i];
        item.append(swatch, document.createTextNode(pretty(s.label || '')));
        legend.append(item);
      });
      wrap.append(legend);
    }
    return wrap;
  }

  function list(b) {
    const ul = h('ul', 'plain');
    for (const item of b.items || []) ul.append(h('li', null, item));
    return ul;
  }

  function text(b) {
    return h('p', 'body', b.body);
  }

  function sql(b) {
    const pre = h('pre', 'sql');
    const code = h('code');
    const parts = String(b.sql || '').split(/('(?:[^']|'')*'|\b[A-Za-z_]+\b)/);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith("'")) code.append(h('s', null, part));
      else if (SQL_WORDS.test(part)) code.append(h('b', null, part));
      else code.append(document.createTextNode(part));
    }
    pre.append(code);
    return pre;
  }

  const RENDER = { stats, headline, hero, bars, kv, signals, table, chart, list, text, sql };

  function block(b, half) {
    if (b.type === 'list' && b.style === 'next') {
      const box = h('div', 'todo');
      box.append(h('h3', null, b.title || 'What to do next'), list(b));
      if (b.note) box.append(h('p', 'note', b.note));
      return box;
    }
    const bare = !half && BARE_WHEN_FULL.has(b.type);
    const node = h('div', bare ? 'blk' : 'r-block');
    if (b.title && b.type !== 'headline') node.append(h('h3', null, b.title));
    node.append(RENDER[b.type](b, half));
    if (b.note) node.append(h('p', b.type === 'table' && bare ? 'foot-note' : 'note', b.note));
    return node;
  }

  /* ---------------------------------------------------------------------- */
  /* The card                                                               */
  /* ---------------------------------------------------------------------- */

  function glow(el) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
    el.addEventListener('pointerleave', () => el.style.setProperty('--mx', '-999px'));
  }

  function card(aura, eyebrow, title) {
    const node = h('article', `view aura aura-${AURAS.has(aura) ? aura : 'graphite'}`);
    const head = h('header', 'v-head');
    if (eyebrow) head.append(h('p', 'eyebrow', eyebrow));
    if (title) head.append(h('h2', null, title));
    if (head.childNodes.length) node.append(head);
    return node;
  }

  function render(spec) {
    if (!spec || !Array.isArray(spec.blocks)) return fail('This view has nothing to show.');
    const view = card(spec.aura, spec.eyebrow, spec.title);
    let grid = null;
    for (const b of spec.blocks) {
      if (!b || !RENDER[b.type]) continue;
      const width = b.width || (FULL_BY_DEFAULT.has(b.type) || (b.type === 'list' && b.style === 'next') ? 'full' : 'half');
      const half = width === 'half';
      const node = block(b, half);
      if (half) {
        if (!grid) {
          grid = h('div', 'r-grid');
          view.append(grid);
        }
        grid.append(node);
      } else {
        grid = null;
        view.append(node);
      }
    }
    if (spec.source || (spec.link && !onPage)) {
      const foot = h('footer', 'v-foot');
      foot.append(h('span', null, spec.source || ''));
      if (spec.link && spec.link.url && !onPage) {
        const open = h('button', null, 'Open in browser ↗');
        open.type = 'button';
        open.addEventListener('click', () => openLink(spec.link.url));
        foot.append(open);
      }
      view.append(foot);
    }
    root.replaceChildren(view);
    glow(view);
    if (spec.title) document.title = `${spec.title} · Threshold`;
    notifySize();
  }

  function waiting() {
    const view = card('graphite', 'Threshold');
    view.classList.add('v-wait');
    const d = h('span', 'dot dot-md', 'LOADING');
    d.append(h('span', 'caret'));
    view.append(d);
    root.replaceChildren(view);
  }

  function fail(message) {
    const view = card('graphite', 'Threshold');
    view.append(h('p', 'note', message));
    root.replaceChildren(view);
    notifySize();
  }

  function fromResult(result) {
    if (!result) return;
    if (result.isError) {
      const t = (result.content || []).find((c) => c && c.type === 'text');
      fail(t ? t.text : 'The tool failed.');
      return;
    }
    if (result.structuredContent && Array.isArray(result.structuredContent.blocks)) render(result.structuredContent);
  }

  /* ---------------------------------------------------------------------- */
  /* Hosts                                                                  */
  /* ---------------------------------------------------------------------- */

  /** MCP Apps: JSON-RPC 2.0 over postMessage with the host (spec 2026-01-26). */
  function mcpApps() {
    if (window.parent === window) return;
    let nextId = 1;
    let ready = false;
    let lastHeight = 0;
    const pending = new Map();
    const send = (msg) => window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, msg), '*');
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
    const notify = (method, params) => send({ method, params: params || {} });

    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const m = event.data;
      if (!m || m.jsonrpc !== '2.0') return;
      if (m.id !== undefined && m.method === undefined) {
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.error) p.reject(m.error);
          else p.resolve(m.result);
        }
        return;
      }
      switch (m.method) {
        case 'ui/notifications/tool-result':
          fromResult(m.params);
          break;
        case 'ui/notifications/tool-cancelled':
          fail('The request was cancelled.');
          break;
        case 'ui/resource-teardown':
        case 'ping':
          if (m.id !== undefined) send({ id: m.id, result: {} });
          break;
        default:
          if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
      }
    });

    notifySize = () => {
      if (!ready) return;
      const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (height === lastHeight) return;
      lastHeight = height;
      notify('ui/notifications/size-changed', { height });
    };
    openLink = (url) => request('ui/open-link', { url }).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
    request('ui/initialize', { appInfo: { name: 'threshold-view', version: '1.0.0' }, appCapabilities: {}, protocolVersion: PROTOCOL })
      .then(() => {
        ready = true;
        notify('ui/notifications/initialized');
        notifySize();
      })
      .catch(() => {});
    new ResizeObserver(() => notifySize()).observe(document.documentElement);
  }

  /** ChatGPT's Apps SDK globals, for hosts that set them. */
  function openai() {
    const oa = window.openai;
    if (!oa) return;
    const pull = () => {
      if (oa.toolOutput && Array.isArray(oa.toolOutput.blocks)) render(oa.toolOutput);
    };
    if (typeof oa.openExternal === 'function') openLink = (url) => oa.openExternal({ href: url });
    window.addEventListener('openai:set_globals', pull);
    pull();
  }

  const embedded = document.getElementById('threshold-view-data');
  if (embedded) {
    try {
      render(JSON.parse(embedded.textContent || 'null'));
    } catch {
      fail('This view could not be read.');
    }
  } else {
    waiting();
    mcpApps();
    openai();
  }
})();
