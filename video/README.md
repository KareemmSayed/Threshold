# Threshold launch video

A 46-second motion-designed announcement video for the [Threshold website](https://kareemmsayed.github.io/Threshold/),
built with [Remotion](https://www.remotion.dev/) from the site's own markup and CSS. It has no audio track; the
[cue sheet](#music-cues) below gives the beats a music track can be cut to.

| Cut | Size | Use |
| --- | --- | --- |
| `Launch-16x9` | 1920 × 1080 | X, LinkedIn, YouTube |
| `Launch-4x5` | 1080 × 1350 | 4:5 feeds |
| `Launch-9x16` | 1080 × 1920 | Reels, Shorts, TikTok |

All three are H.264 (High), yuv420p, BT.709, 60 fps, CRF 14, with no audio stream.

## Render

```bash
npm ci
npm run render            # all three cuts into out/ (5 to 9 minutes each on an M1)
npm run render -- 9x16    # one cut
npm run studio            # preview and scrub in Remotion Studio
```

`out/` and `compare/` are git-ignored.

## How it is built

- **The site's CSS, unchanged.** `src/Root.tsx` imports `../docs/assets/site.css` directly, and every section is
  rebuilt as React components with the same markup and class names as `docs/index.html`. Nothing in `docs/` is
  modified.
- **`src/styles/video.css`** layers two things on top:
  1. It turns every CSS animation and transition off. Each one (the `pop`, `pulse`, `spin`, `ripple`, `press`,
     `flash`, `blink` keyframes, the `.rise` reveal, the marquee and the raw-JSON scroll) is re-driven from the
     frame number in `src/site/anim.ts`, so any frame renders the same in any tab, in any order.
  2. The portrait cuts lay the page out 864 px wide and fill the frame with it (a 1.25× camera floor), reusing the
     site's own narrow-screen rules (stacked hero, two-up bento, one-row setup steps) scoped to `.v-stack`. A
     1080 px frame never triggers the site's `max-width: 1020px` media query, so the rules are applied by class.
- **The site's animations, ported to frames.**
  - `src/lib/type.tsx`: the typewriter (`prepType` / `setTyped` / `typeIn` / `cycle`), same step formula, same
    glyph pools, glitch glyphs seeded by character and frame.
  - `src/lib/ascii.ts`: `asciiCanvas`, `session()`, the hero trace and the wordmark, with time passed in.
  - `src/site/Flow.tsx`: `initFlow`, the pulse position computed from the frame.
  - `src/site/Bento.tsx`: `dotGrid` and both charts.
  - `src/site/Guide.tsx`: the setup guide's Claude path as six frame-scripted beats with the same mock screens.
  - `src/lib/glass.tsx`: `initGlass`, the same SVG displacement filter in `backdrop-filter`, sized to the element.
- **Seeded randomness.** `Math.random()` is never called; glyph flicker, typing delays and noise come from
  `src/lib/rand.ts`.
- **Fonts.** Doto, Inter Tight and JetBrains Mono load through `@remotion/google-fonts` with the site's weights
  and Latin subsets, and nothing mounts until they have loaded. Note that `site.css` lists `'Helvetica Neue'`
  before Inter Tight, so on a Mac both the site and the video set body text in Helvetica Neue; on Linux both fall
  back to Inter Tight. Render on a Mac to match what Mac visitors see.
- **Video amplification.** A camera (`src/lib/camera.tsx`) frames measured site components with the site's
  `cubic-bezier(0.16, 1, 0.3, 1)` easing, a parallax depth for the hero's ASCII field, and a light directional
  motion blur (an SVG `feGaussianBlur` scaled by camera speed). Scene cuts are an ASCII wipe in the hero's density
  ramp and the effort ramp (`src/scenes/AsciiWipe.tsx`). Entrances use the site's own keyframes with larger
  amplitudes; the cursor in the setup beats is 1.7× with a larger ripple.

```
src/
  Root.tsx, Launch.tsx     compositions and the cut list
  timeline.ts              scene start frames
  Compare.tsx              one section in "rest mode", for the pixel comparison
  lib/                     time and easing, seeded hashing, typewriter, ASCII renderer, glass, camera, fonts
  site/                    the site's sections as components (Hero, Why, Bento, Guide, Flow) and its keyframes
  scenes/                  the nine storyboard beats, the ASCII wipe
scripts/
  render.mjs               the three MP4s
  compare.mjs              pixel comparison with the live site
  determinism.mjs          frame-identity check
  stills.mjs, sheet*.sh    stills and contact sheets for review
```

## Music cues

60 fps. Scene times are the midpoint of the ASCII wipe that brings the scene in; each wipe takes 0.5 s to cover
and 0.5 s to clear.

| Time | Frame | Beat |
| ---: | ---: | --- |
| 0.00 | 0 | Black. The dot field starts to fade in |
| 0.57 | 34 | The orange threshold line draws left to right |
| 1.07 | 64 | The heart-rate trace sweeps in (to 3.27 s), crossing the line on each rep |
| 3.30 | 198 | Hero copy: tag pops, **YOUR GARMIN,** types at 3.55 |
| 4.45 | 267 | **IN CLAUDE.** types |
| 6.41 | 385 | **IN CHATGPT.** |
| 7.35 | 441 | Camera pulls out to the full hero |
| 7.86 | 472 | **IN CURSOR.** |
| 8.18 | 491 | Push into the liquid-glass chat card |
| 9.81 | 589 | Question sent |
| 10.87 | 652 | `daily_briefing` ticks ✓ |
| 11.07 | 664 | Amber answer streams; signal chips at 12.31 |
| 13.00 | 780 | **Cut** → CODE DOES THE MATH. |
| 15.13 | 908 | Raw JSON blurs away |
| 15.37 | 922 | Readout rows snap in, one every 0.13 s |
| 16.27 | 976 | **AMBER** verdict |
| 18.00 | 1080 | **Cut** → 16 TOOLS. ZERO GUESSES. |
| 18.73 | 1124 | Cards fly in, one every 0.2 s (16:9) |
| 21.10 | 1266 | Push into the VO2 card, **58.4** types (21.57 in portrait) |
| 23.83 | 1430 | **Cut** → ONE RUN. EVERY 5K. |
| 25.23 | 1514 | Split bars grow |
| 26.63 | 1598 | Second question; PB table fills from 27.27 |
| 28.20 | 1692 | Today's **17:21** lights up |
| 29.83 | 1790 | **Cut** → SIX STEPS. Clicks: 30.65, 31.25 (Garmin key) |
| 31.53 | 1892 | Deploy: 31.82, 32.18, 32.62 |
| 32.93 | 1976 | Ready: 33.25 |
| 33.87 | 2032 | Connector: 34.15, 34.43, 34.77, 35.02, 35.23 |
| 35.30 | 2118 | Consent page: 35.62, 36.12 (Allow) |
| 36.43 | 2186 | Ask: 36.68, 37.12 (send), answer streams |
| 37.97 | 2278 | **Cut** → HOW IT WORKS.; the request pulse runs 38.47 to 41.27 |
| 41.55 | 2493 | **Cut** → the THRESHOLD wordmark resolves |
| 42.42 | 2545 | **READY IN FIVE MINUTES.** |
| 43.28 | 2597 | Deploy to Cloudflare button, then the site address at 43.68 |
| 46.38 | 2783 | End |

To add a track, drop it in `public/` and add `<Audio src={staticFile('track.mp3')} />` to `Launch.tsx`, then render
without `muted` in `scripts/render.mjs`.

## Verification

### Pixel comparison with the live site

`npm run compare` screenshots each section of the live site with Playwright at 1920 × 1080, in the same
`chrome-headless-shell` build Remotion renders with, on a fake clock with `Math.random` seeded and CSS animations
off. It reads back the time-driven state (the hero and wordmark canvases' draw times, the flow pulse, the cycling
word, the guide's progress bar), renders the same section in rest mode (`src/Compare.tsx`: camera at 1×, the site's
paddings, every entrance finished) and diffs them with pixelmatch. Results, `compare/summary.json`:

| Section | Pixels that differ |
| --- | ---: |
| Hero (ASCII canvas, liquid-glass nav and chat card included) | 0.001% |
| Why: raw JSON, readout, verdict, comparison table | 0.000% |
| Features, top | 0.76%: the bottom card, which the site has not scroll-revealed yet |
| Features, lower | 0.001% |
| Demo, turn 1 | 0.000% |
| Demo, turn 2 | 0.000% |
| Setup guide | 0.007% |
| How it works | 0.001% |
| End | 0.050% |

The remaining differing pixels are a few ASCII cells and one hairline progress bar. The portrait cuts are
re-composed rather than the site at 1080 px, so they have no pixel counterpart; `npm run compare:portrait` puts the
live site at 1080 × 1350 and 1080 × 1920 next to video frames of the same size for a visual check (same CSS for
colour, type, borders and components).

### Determinism

`npm run determinism` renders frames across all nine scenes twice as stills and once at the end of a short
sequence in a reused tab, and compares the PNG bytes. All tested frames were identical in all three cuts.
`npm run review -- out/<file>.mp4` makes contact sheets every half second and lists the frames where the picture
jumps most; outside the wipes the largest is the site's own Garmin modal overlay fading in.

### Liquid glass

The glass renders in Remotion's Chrome with `--gl=angle` (set in `remotion.config.ts` and the scripts): the hero
comparison includes the nav and chat card, displacement map and all, and matches the site.

## Differences from the site

Deliberate, for video:

- **Timing.** Typing runs 1.1 to 2.2 times slower than the site so it reads on screen; the hero chat's waits are
  about 0.6 times the site's; the setup guide's screens play in about 1.2 s each instead of 5 to 13 s; the raw JSON
  scrolls 7 times faster.
- **The hero's cycling line** stops after IN CURSOR. (the site goes on to Codex, VS Code and Gemini).
- **The dot field** is the hero's own ambient ASCII contour field, brightened for the first four seconds so it
  reads, then settling to the site's alpha. (`--dot-field` is defined in `site.css` but not used by the site.)
- **Added motion**: camera moves and parallax, motion blur, the ASCII wipes, the aura glow igniting as bento cards
  land, a light passing over each card (the site's own pointer light, `.aura::after`), dot charts lighting left to
  right, split and PB bars growing, today's PB glowing, the threshold trace's scan head (the site's pointer glow),
  the wordmark resolving out of noise with a light sweeping across it, and a glow on the flow pulse.
- **The end card** adds the site address in the site's tag pill and leaves out the footer.
- **The setup guide's screens crossfade** into each other; on the site each new screen fades in from the stage's
  dark background, which at video speed reads as a flash.
- **Portrait cuts** centre the hero copy, put the 4:5 raw JSON and readout in one slot, and bring the nav in with
  the chat card.

Simplified or left out:

- Only the setup guide's Claude path is shown (not ChatGPT or Claude Code), and each screen plays a shortened
  version of its script: the Garmin modal is not dismissed, Claude's connector list is not re-rendered after
  Allow, the answer streams in under half a second.
- The `.setup-glow` gradient is not drawn: on the site it sits at `z-index: -1` under the body's black background
  and never shows, so the video matches that. (If it is meant to show, giving `.setup` `isolation: isolate` on the
  site would fix it.)
- Sections the storyboard does not use (clients, free-tier meters, privacy, FAQ) are not built.

## Licence

The video source is MIT like the rest of the repository. Remotion itself is under the
[Remotion License](https://www.remotion.dev/license): free for individuals and companies of up to three people.
