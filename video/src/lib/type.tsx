import React from 'react';
import { useFrame } from './rest';
import { clamp, ms } from './time';
import { hash, seedOf } from './rand';

/*
 * The site's typewriter (prepType / setTyped / typeIn / cycle in site.js), driven by the frame.
 * Characters type in while the next one flickers through glyphs of its own kind; the rest of the
 * line holds its space invisibly (.dot .g / .dot .r in site.css).
 */

const DIGITS = '0123456789';
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

export function scramble(ch: string, seed: number): string {
  const pool = /\d/.test(ch) ? DIGITS : /[a-z]/i.test(ch) ? LETTERS : null;
  if (!pool) return ch;
  const g = pool[hash(seed) % pool.length];
  return ch === ch.toLowerCase() ? g.toLowerCase() : g;
}

/** typeIn(): short strings type slower, long ones faster; the whole thing lands in about half a second. */
export const typeStep = (len: number) => clamp(520 / len, 22, 64);

export type Typed = { text: string; n: number; g: string };

/** typeIn() `elapsed` ms after it starts. `slow` stretches the step for video legibility. */
export function typedAt(text: string, elapsed: number, frame: number, { from = 0, slow = 1, seed = 0 } = {}): Typed {
  if (elapsed < 0) return { text, n: from, g: '' };
  const step = typeStep(text.length) * slow;
  const n = Math.min(text.length, from + Math.floor(elapsed / step));
  // The glitch glyph re-rolls every other frame, so it visibly flickers at 60 fps.
  const g = n > from && n < text.length ? scramble(text[n], hash(seed, n, Math.floor(frame / 2))) : '';
  return { text, n, g };
}

/** Duration of typeIn() in ms. */
export const typeDur = (text: string, { from = 0, slow = 1 } = {}) => (text.length - from) * typeStep(text.length) * slow;

/**
 * cycle(): type the first word, hold, delete back to the shared "IN " prefix 28 ms a character, type
 * the next word from there. `holds` is how long each word stays (the site uses 2600 ms).
 */
export function cycleAt(words: string[], elapsed: number, frame: number, holds: number[], { slow = 1, seed = 0 } = {}): Typed {
  let t = elapsed;
  for (let k = 0; k < words.length; k++) {
    const word = words[k];
    const from = k === 0 ? 0 : 3;
    const typing = typeDur(word, { from, slow });
    if (t < typing) return typedAt(word, t, frame, { from, slow, seed: seed + k });
    t -= typing;
    const hold = holds[k] ?? 2600;
    if (k === words.length - 1 || t < hold) return { text: word, n: word.length, g: '' };
    t -= hold;
    const del = (word.length - 2) * 28;
    if (t < del) return { text: word, n: Math.max(3, word.length - Math.floor(t / 28)), g: '' };
    t -= del;
  }
  const last = words[words.length - 1];
  return { text: last, n: last.length, g: '' };
}

/** The spans prepType() builds: typed, glitch, and the hidden remainder. */
export const TypedSpans: React.FC<{ t: Typed }> = ({ t }) => (
  <span aria-hidden="true">
    <span>{t.text.slice(0, t.n)}</span>
    <span className="g">{t.n < t.text.length ? t.g : ''}</span>
    <span className="r">{t.text.slice(t.n + (t.g && t.n < t.text.length ? 1 : 0))}</span>
  </span>
);

type TypeProps = {
  text: string;
  /** Frame (in the current Sequence) when typing starts. */
  at: number;
  slow?: number;
  className?: string;
  style?: React.CSSProperties;
  as?: 'span' | 'h1' | 'h2' | 'div' | 'b';
};

/** A [data-type] Doto element that types in at frame `at`. */
export const Type: React.FC<TypeProps> = ({ text, at, slow = 1, className = 'dot', style, as = 'span' }) => {
  const frame = useFrame();
  const t = typedAt(text, ms(frame - at), frame, { slow, seed: seedOf(text) });
  const Tag = as;
  return (
    <Tag className={className || undefined} style={style} data-type="">
      <TypedSpans t={t} />
    </Tag>
  );
};
