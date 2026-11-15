import React, { useRef } from 'react';
import { useFrame, useRest } from '../lib/rest';
import { useLiquidGlass } from '../lib/glass';
import { rand } from '../lib/rand';
import { FPS, ms, sec } from '../lib/time';
import { cycleAt, typedAt, TypedSpans } from '../lib/type';
import { livePulse, pop, spin } from './anim';

/* The nav, hero copy, hero chat card and marquee from docs/index.html, with the site's class names. */

export const Logo: React.FC = () => (
  <svg className="logo" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <g fill="#ff7a45">
      <rect x="1" y="1" width="4" height="4" rx="1.2" />
      <rect x="7" y="1" width="4" height="4" rx="1.2" />
      <rect x="13" y="1" width="4" height="4" rx="1.2" />
      <rect x="19" y="1" width="4" height="4" rx="1.2" />
    </g>
    <g fill="currentColor">
      <rect x="13" y="7" width="4" height="4" rx="1.2" />
      <rect x="13" y="13" width="4" height="4" rx="1.2" />
      <rect x="13" y="19" width="4" height="4" rx="1.2" />
    </g>
    <g fill="currentColor" opacity=".14">
      <rect x="7" y="7" width="4" height="4" rx="1.2" />
      <rect x="19" y="7" width="4" height="4" rx="1.2" />
      <rect x="7" y="13" width="4" height="4" rx="1.2" />
      <rect x="19" y="13" width="4" height="4" rx="1.2" />
      <rect x="1" y="7" width="4" height="4" rx="1.2" />
      <rect x="1" y="13" width="4" height="4" rx="1.2" />
    </g>
  </svg>
);

const GitHubMark: React.FC = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path
      fill="currentColor"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
    />
  </svg>
);

export const Nav: React.FC<{ style?: React.CSSProperties; active?: string }> = ({ style, active }) => {
  const ref = useRef<HTMLElement>(null);
  const glass = useLiquidGlass('liquid-0', ref, 0.42);
  return (
    <header className="nav-wrap" style={{ position: 'absolute', ...style }}>
      {glass.defs}
      <nav ref={ref} className={`nav glass ${glass.className}`} style={glass.style} aria-label="Main">
        <a className="brand">
          <Logo />
          <span>Threshold</span>
        </a>
        <div className="nav-links">
          {['Features', 'Demo', 'Setup', 'Clients', 'How it works', 'FAQ'].map((l) => (
            <a key={l} className={l === active ? 'on' : undefined}>
              {l}
            </a>
          ))}
        </div>
        <a className="btn btn-sm btn-ink">
          <GitHubMark />
          <span>GitHub</span>
        </a>
      </nav>
    </header>
  );
};

/* ---------------------------------------------------------------------- */

export const CYCLE = ['IN CLAUDE.', 'IN CHATGPT.', 'IN CURSOR.'];

/** Frame offsets (from the copy's start) of each beat in the hero copy, for the camera and the README. */
export const COPY = {
  tag: 0,
  line1: sec(0.25),
  line2: sec(1.15),
  slow: 1.6,
  holds: [900, 600, 4000],
  rest: sec(2.2),
};

export const HeroCopy: React.FC<{ f: number; amp?: number; dim?: number }> = ({ f, amp = 1.6, dim = 0 }) => {
  const frame = useFrame();
  const rest = useRest();
  const l1 = typedAt('YOUR GARMIN,', ms(f - COPY.line1), frame, { slow: COPY.slow, seed: 11 });
  const l2 = rest
    ? { text: CYCLE[rest.word], n: CYCLE[rest.word].length, g: '' }
    : cycleAt(CYCLE, ms(f - COPY.line2), frame, COPY.holds, { slow: COPY.slow, seed: 23 });
  const r = (i: number): React.CSSProperties => {
    const g = f - COPY.rest - i * sec(0.07);
    return pop(g, 3 * amp, 0.7);
  };
  return (
    <div className="hero-copy" style={dim ? { opacity: 1 - dim * 0.6 } : undefined}>
      <a className="tag" style={pop(f - COPY.tag, 2 * amp, 0.6)}>
        <span className="live" style={livePulse(frame)} />
        Open source · MIT · v0.1.1
      </a>
      <h1 className="hero-title">
        <span className="sr">Garmin MCP server: ask Claude or ChatGPT about your training</span>
        <span className="dot dot-xl" data-type="" aria-hidden="true">
          <TypedSpans t={l1} />
        </span>
        <span className="dot dot-xl hot cycle" aria-hidden="true" style={f < COPY.line2 ? { visibility: 'hidden' } : undefined}>
          <TypedSpans t={l2} />
        </span>
      </h1>
      <p className="lead" style={r(0)}>
        Threshold is an open-source <strong>Garmin MCP server</strong>. Ask Claude, ChatGPT or any AI about your training, sleep and recovery, and get
        numbers computed in code, not guessed. It runs free on your own Cloudflare account.
      </p>
      <div className="cta" style={r(1)}>
        <a className="btn btn-lg btn-ink">
          Deploy to Cloudflare <span aria-hidden="true">→</span>
        </a>
        <a className="btn btn-lg btn-line">See the 5-minute setup</a>
      </div>
      <ul className="trust" style={r(2)}>
        <li>No Garmin password</li>
        <li>Read-only</li>
        <li>Free on Workers</li>
        <li>GPS stripped by default</li>
      </ul>
    </div>
  );
};

/* ---------------------------------------------------------------------- */
/* Hero chat: the question, the tool call, and the computed answer (initHeroChat). */

const CONVO = {
  q: 'Am I recovered enough for intervals today?',
  tool: 'daily_briefing',
  b: 'Amber.',
  a: 'HRV is slightly low (49 ms vs your normal 51–63) and your load ramp is high (ACWR 1.34). Sleep and Body Battery look fine. Keep today easy and move the intervals to tomorrow.',
  sigs: [
    ['amber', 'HRV'],
    ['green', 'Resting HR'],
    ['green', 'Sleep'],
    ['green', 'Body Battery'],
    ['blue', 'Form'],
    ['amber', 'Load ramp'],
  ],
};

/** initHeroChat()'s waits, tightened for video (the site's are in the comments). */
const PACE = 0.62;
const charDelay = (i: number) => (26 + rand(7, i) * 34) * PACE; // 26–60 ms a character
const typedEnd = CONVO.q.split('').reduce((s, _c, i) => s + charDelay(i), 0);
export const CHAT = (() => {
  const send = typedEnd + 300; // w(420)
  const user = send;
  const tool = user + 300; // w(350)
  const ok = tool + 760; // w(1200)
  const ai = ok + 200; // w(250)
  const words = CONVO.a.split(' ');
  const wordMs = 34;
  const sigs = ai + words.length * wordMs + 120;
  return { send, user, tool, ok, ai, sigs, words, wordMs, end: sigs + 400 };
})();

export const HeroChat: React.FC<{ t: number; style?: React.CSSProperties; amp?: number }> = ({ t, style, amp = 2 }) => {
  const frame = useFrame();
  const ref = useRef<HTMLDivElement>(null);
  const glass = useLiquidGlass('liquid-1', ref, 0.5);
  const f = (msAt: number) => ((t - msAt) / 1000) * FPS;

  let input = 'Ask about your training…';
  let typing = false;
  if (t >= 0 && t < CHAT.send) {
    let acc = 0;
    let n = 0;
    while (n < CONVO.q.length && acc + charDelay(n) <= t) acc += charDelay(n++);
    input = CONVO.q.slice(0, n);
    typing = true;
  }
  const nWords = Math.max(0, Math.min(CHAT.words.length, Math.floor((t - CHAT.ai) / CHAT.wordMs) + 1));

  return (
    <div ref={ref} className={`hero-chat glass ${glass.className}`} style={{ ...glass.style, ...style }} aria-hidden="true">
      {glass.defs}
      <div className="hc-bar">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        <span className="hc-title">New chat</span>
        <span className="hc-conn">
          <i />
          Threshold
        </span>
      </div>
      <div className="hc-body">
        {t >= CHAT.user ? (
          <div className="m m-user" style={pop(f(CHAT.user), amp)}>
            {CONVO.q}
          </div>
        ) : null}
        {t >= CHAT.tool ? (
          <div className="m m-tool" style={pop(f(CHAT.tool), amp)}>
            {t < CHAT.ok ? <i className="spin" style={spin(frame)} /> : <span className="ok">✓</span>}
            threshold · {CONVO.tool}
          </div>
        ) : null}
        {t >= CHAT.ai ? (
          <div className="m m-ai" style={pop(f(CHAT.ai), amp)}>
            <b>{CONVO.b}</b> <span>{CHAT.words.slice(0, nWords).map((w) => w + ' ').join('')}</span>
          </div>
        ) : null}
        {t >= CHAT.sigs ? (
          <div className="m m-sigs" style={pop(f(CHAT.sigs), amp)}>
            {CONVO.sigs.map(([k, n], i) => (
              <span key={n} style={pop(f(CHAT.sigs + i * 55), amp * 1.5)}>
                <i className={`sig ${k}`} />
                {n}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className={`hc-input${typing ? ' typing' : ''}`}>
        <span>{input}</span>
        <b style={t >= CHAT.send && t < CHAT.send + 250 ? { transform: `scale(${0.9 + 0.1 * ((t - CHAT.send) / 250)})` } : undefined}>↑</b>
      </div>
    </div>
  );
};

/* ---------------------------------------------------------------------- */

const ASKS = [
  '“How am I today?”',
  '“Am I recovered enough for intervals today?”',
  '“Is my HRV trending down?”',
  '“Am I ramping up too fast?”',
  '“Break down this morning’s run.”',
  '“What are my 5k and 10k bests this year?”',
  '“Which months did I climb the most?”',
  '“Should I race on Sunday?”',
];

/** The marquee: 70 s linear, translateX(-50%). */
export const Marquee: React.FC<{ f: number; style?: React.CSSProperties }> = ({ f, style }) => (
  <div className="marquee" style={style}>
    <div className="marquee-track" style={{ transform: `translateX(${-(((f / FPS) % 70) / 70) * 50}%)` }}>
      {[...ASKS, ...ASKS].map((q, i) => (
        <span key={i}>{q}</span>
      ))}
    </div>
  </div>
);
