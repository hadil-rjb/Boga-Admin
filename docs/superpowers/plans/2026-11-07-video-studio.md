# Video Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Video Studio editor frame for motion reels and imported videos, with a shared caption workflow (presets, style tabs, script/SRT, auto-transcription, reference style).

**Architecture:** Pure modules first (caption engine, presets, sources, caption store), then a shared shell (`video-studio.js` + `timeline.js`) that wraps the existing editor drawing through `wrapEd` the way `footage-editor.js` already does. Imported videos (footage) and motion reels become *sources* that plug into the shell; shared panels (`caption-panels.js`) only touch `d.captions`.

**Tech Stack:** Vanilla ES modules in `frontend/studio/` (Next.js host page), vitest; NestJS + ffmpeg + headless Chromium in `backend/src/footage/`.

**Spec:** `docs/superpowers/specs/2026-11-07-video-studio-design.md`

## Global Constraints

- A project is either a motion reel or an imported video; no mixing in v1.
- `frontend/studio/captions.js` is the only caption renderer (preview of both kinds, motion export, server export). After every change to it run `node backend/scripts/sync-shared.mjs` so `backend/src/footage/shared/captions.mjs` stays byte-identical (`backend/src/footage/shared.test.ts` checks this).
- New `CaptionStyle` fields are optional; a style without them renders exactly as today.
- New style field defaults, verbatim from the spec: `ls` 0, `lh` 1.15, `x` 0.5, `align` 'center', `boxOpacity` 1, `anim` 'none', `animSpeed` 1 (0.5–2), `offset` 0 (ms), `minDur` 600 (ms), `gap` 0 (ms).
- Animations: `none, fade, pop, karaoke, word, typewriter, bounce, slide`.
- Preset categories: Bold and viral, Karaoke, Clean, Cinematic, Boxed, Neon, Arabic. About 30 presets.
- Brand caption styles: `brand().captionStyles = [{ id, name, style }]`, max 20.
- Inspector tabs, in order: Font, Colors, Spacing, Layout, Box, Animate, Timing, Reference.
- Rail item order: the kind's own items first (Media, or Templates/Motion), then Captions, Styles, Script, Audio, then the rest. Never show an item that does nothing for the kind.
- Script alignment falls back to spreading when under 40 % of script words match.
- Every caption edit is one `mutate()` step; the migration to `d.captions` is not an undo step.
- UI copy: sentence case, no "please", no "successfully", verbs first on buttons.
- Icons: add to `IC` (lucide-style 24×24 stroke paths) the way `footage-editor.js` adds `ftCmp10`; never emoji.
- Export style JSON stays under the server's 8192-byte limit (`export.service.ts`).

## Review Focus

1. A footage design saved before this work (captions in `d.footage.captions`, no new style fields) opens, previews and exports exactly as before → Task 1 and Task 6 tests.
2. Arabic script pasted with diacritics, tatweel and Arabic punctuation still aligns to Whisper words → Task 4 test.
3. SRT/VTT files from real tools: BOM, CRLF line ends, `WEBVTT` header with notes, numeric cue ids, `<i>` tags, comma or dot milliseconds → Task 4 test.
4. A reel whose captions were edited by hand, then its voice-over text changes: the hand edits stay, a "Rebuild from voice-over" button appears → Task 4 (`needsRebuild`) and Task 12 test.
5. A video imported with no reference and no brand look: it reaches "ready", can be exported, and Look offers "Match a reference" → Task 8 test.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `frontend/studio/captions.js` | modify | Style fields, animations, grouping options |
| `frontend/studio/caption-presets.js` | create | Preset data, `applyPreset` |
| `frontend/studio/caption-sources.js` | create | Voice-over lines, script alignment, SRT/VTT parse and write |
| `frontend/studio/caption-store.js` | create | `kindOf`, `capsOf`, `migrateCaptions`, `CAPTIONS_DEFAULT` |
| `frontend/studio/timeline.js` | create | Track timeline (moved out of `footage-editor.js`) |
| `frontend/studio/video-studio.js` | create | Shell: rail per kind, transport, inspector routing, source registry |
| `frontend/studio/caption-panels.js` | create | Captions, Styles, Script panels; caption inspector tabs |
| `frontend/studio/footage-editor.js` | modify | Becomes the `video` source; loses transport, lane, Subtitles panel |
| `frontend/studio/footage.js` | modify | "Caption a video" entry, upload without a pair |
| `frontend/studio/engine.js` | modify | Motion becomes the `reel` source; captions via `captions.draw` |
| `frontend/styles/studio.css` | modify | Shell, tabs, preset grid, tracks |
| `backend/src/footage/jobs.service.ts` | modify | `grade` / `caption-style` skipped without a pair |
| `backend/src/footage/export.service.ts`, `ffmpeg.ts` | modify | Original volume + music bed in the export |

Test commands: frontend `cd frontend && npx vitest run studio/<name>.test.js`; backend `cd backend && npx vitest run src/footage/<name>.test.ts`.

---

## Phase A — caption engine (pure)

### Task 1: New style fields in `captions.js`

**Files:**
- Modify: `frontend/studio/captions.js` (`DEFAULT_STYLE`, `layout`, `draw`, `lineAt` callers)
- Test: `frontend/studio/captions.test.js`

**Interfaces:**
- Produces: `withDefaults(style) -> CaptionStyle` (fills every field listed in Global Constraints, leaves existing ones); `layout(ctx, line, style, w, h)` honours `ls`, `lh`, `x`, `align`; `draw(ctx, lines, style, ms, w, h)` honours `boxOpacity` and `offset` (draws the line at `ms - offset`).

- [ ] **Step 1: Write the failing tests**

```js
describe('style fields', () => {
  it('a legacy style renders the same draw calls as before', () => {
    const legacy = { ...DEFAULT_STYLE }; // no new fields
    expect(record(legacy)).toEqual(record(withDefaults(legacy))); // record() = calls on a mock ctx
  });
  it('x and align move the block', () => {
    const L1 = layout(ctx, line, withDefaults({ ...DEFAULT_STYLE, x: 0.25, align: 'left' }), 1000, 1000);
    expect(L1.x).toBeCloseTo(250 - 0, 0); // left edge at x*w when align left
    const L2 = layout(ctx, line, withDefaults({ ...DEFAULT_STYLE, x: 0.75, align: 'right' }), 1000, 1000);
    expect(L2.x + L2.w).toBeCloseTo(750, 0);
  });
  it('ls widens every word gap, lh scales row height on 2-line wraps', () => { /* L.w grows by ls*px*(n-1); 2-row L.h === 2*px*lh */ });
  it('offset delays the line', () => { expect(drawn(lines, { ...S, offset: 500 }, 100)).toBe(false); expect(drawn(lines, { ...S, offset: 500 }, 600)).toBe(true); });
  it('boxOpacity multiplies the box alpha', () => { /* fill alpha seen by mock ctx === 0.4 */ });
});
```

Use the mock 2D context the file already uses (measureText returns `text.length * px * 0.5`).

- [ ] **Step 2: Run** `cd frontend && npx vitest run studio/captions.test.js` — expect the new tests to FAIL.
- [ ] **Step 3: Implement.** `withDefaults` is exported and called at the top of `layout` and `draw`. In `layout`: word gap = `measureText(' ').width + ls * px`; row height = `px * (wrap ? 1.25 * lh / 1.15 : 1)` so the default `lh` keeps today's 1.25; anchor x = `x * w` with `align` choosing left edge / centre / right edge. In `draw`: `ms = ms - (style.offset || 0)` before `lineAt`; box fill uses `globalAlpha * boxOpacity`.
- [ ] **Step 4: Run** the same command — PASS, and the whole file passes.
- [ ] **Step 5: Sync and check the backend copy:** `node backend/scripts/sync-shared.mjs && cd backend && npx vitest run src/footage/shared.test.ts` — PASS.
- [ ] **Step 6: Commit** `git add frontend/studio/captions.js frontend/studio/captions.test.js backend/src/footage/shared/captions.mjs && git commit -m "Captions: spacing, line height, position, alignment, box opacity, offset"`

### Task 2: New animations

**Files:** Modify `frontend/studio/captions.js` (`animAt`, `changeTimes`, `draw`); Test `frontend/studio/captions.test.js`

**Interfaces:**
- Produces: `animAt(style, line, wordIndex, ms) -> { alpha, scale, dy, visible, highlight }`. Existing callers read `alpha` and `scale`; `draw` also applies `dy` (fraction of font px, positive = down), skips words with `visible: false`, and treats `highlight: true` as the active word.

Behaviour (durations are `ANIM_MS / animSpeed`, `ANIM_MS` = 133):

| anim | per word |
| --- | --- |
| karaoke | every word visible; `highlight` true for words whose `s <= ms` (fills progressively, uses `highlight` colours) |
| word | `visible` only when `w.s <= ms` |
| typewriter | `visible` when `w.s <= ms`; `alpha` ramps 0→1 over the duration |
| bounce | `dy` = −0.25 → 0 with an overshoot over 2× duration after `w.s` |
| slide | line-level: `dy` 0.6 → 0 and alpha 0 → 1 over the duration after `line.start` |

- [ ] **Step 1: Failing tests** — one `it` per row of the table, asserting the returned fields at `w.s - 1`, `w.s + dur/2`, `w.s + 3*dur`; plus `changeTimes` contains the 4 ramp steps after each word start for `typewriter`, `bounce`, and after `line.start` for `slide`; plus `animSpeed: 2` halves the ramp (`changeTimes` steps at 1/4..4/4 of 66 ms).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in `animAt`/`changeTimes`/`draw`.
- [ ] **Step 4: Run** — PASS. **Step 5:** sync-shared + `shared.test.ts`. **Step 6: Commit** "Captions: karaoke, word by word, typewriter, bounce and slide animations".

### Task 3: `group()` timing options

**Files:** Modify `frontend/studio/captions.js` (`group`); Test `captions.test.js`

**Interfaces:**
- Produces: `group(words, style)` additionally honours `style.minDur` (a line shorter than `minDur` ms takes the next word when it doesn't break `maxWords`/`maxChars`; else its `end` is extended up to the next line's start) and `style.gap` (each line's `end` is pulled back so `next.start - end >= gap`, never below `start + 1`).

- [ ] **Step 1: Failing tests** — `minDur: 600` merges a 200 ms single-word line into its neighbour; `gap: 100` leaves ≥ 100 ms between consecutive lines; defaults (`minDur` absent) give today's output for the existing fixtures.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS). **Step 5:** sync-shared. **Step 6: Commit** "Captions: minimum duration and gap when grouping".

### Task 4: `caption-sources.js`

**Files:** Create `frontend/studio/caption-sources.js`; Test `frontend/studio/caption-sources.test.js`

**Interfaces:**
- Consumes: `group(words, style)` (Task 3).
- Produces:
  - `voiceoverWords(pages, tl, lead = 150) -> Word[]` — per scene with `vo.text` and `vo.dur`, words timed by character count over `[scene.start + lead, scene.start + lead + vo.dur]`. `tl` is `MO.timeline(pages)`.
  - `alignScript(text, speechWords) -> { words: Word[], matched: number, breaks: number[] }` — `matched` is 0..1; `breaks` are indices of words that start a new line (from the script's line breaks).
  - `spreadScript(text, startMs, endMs) -> { words, breaks }`.
  - `linesFromScript(text, { speechWords, start, end, style }) -> { lines, spread: boolean }` — aligned when `speechWords.length && matched >= 0.4`, else spread; script line breaks force a new line.
  - `parseSubtitles(text) -> Line[]` (SRT or VTT, auto-detected), throws `Error('This file has no readable captions')` when no cue parses.
  - `toSrt(lines) -> string`.
  - `needsRebuild(captions, pages) -> boolean` — true when `captions.source === 'manual'` and the voice-over text/duration signature stored in `captions.voSig` differs from the current one.
  - `voSig(pages) -> string`.
- `Word` is `{ t, s, e }` (ms integers), `Line` is `{ id, start, end, words }` as in `captions.js`.

Normalization for alignment (verbatim decision): lower-case, NFKC, strip Arabic diacritics `[ً-ٰٟ]`, tatweel `ـ`, and punctuation `[\p{P}\p{S}]`; compare tokens with the LCS used by `retext` (reuse by exporting `lcsPairs` from `captions.js`).

- [ ] **Step 1: Failing tests**

```js
it('times voice-over words inside their scene', () => { /* 2 scenes, vo.dur 2000 each: first word s === 150, last word of scene 2 e === 3000+150+2000 */ });
it('aligns an Arabic script with diacritics to speech words', () => {
  const speech = [{ t: 'صباح', s: 0, e: 400 }, { t: 'الخير', s: 400, e: 900 }];
  const r = alignScript('صَبَاحُ الخَيْرِ!', speech);
  expect(r.matched).toBe(1); expect(r.words.map((w) => w.s)).toEqual([0, 400]);
});
it('falls back to spreading under 40% matches', () => { expect(linesFromScript('a b c d e', { speechWords: [{ t: 'x', s: 0, e: 100 }], start: 0, end: 5000, style }).spread).toBe(true); });
it('keeps script line breaks as caption breaks', () => { /* 'one two\nthree' with maxWords 5 → 2 lines */ });
it('parses SRT with BOM, CRLF, ids and <i> tags', () => { const t = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> world\r\n\r\n'; expect(parseSubtitles(t)[0]).toMatchObject({ start: 1000, end: 2500 }); expect(parseSubtitles(t)[0].words.map((w) => w.t)).toEqual(['Hello', 'world']); });
it('parses VTT with header, NOTE blocks and dot milliseconds', () => { /* 'WEBVTT\n\nNOTE x\n\n00:01.000 --> 00:02.000\nHi' */ });
it('throws on a file with no cues', () => { expect(() => parseSubtitles('hello')).toThrow('This file has no readable captions'); });
it('toSrt round-trips through parseSubtitles', () => { /* times and text equal */ });
it('needsRebuild only for manual captions whose voice-over changed', () => { /* source 'voiceover' → false; manual + same voSig → false; manual + changed text → true */ });
```

- [ ] **Step 2:** run — FAIL. **Step 3:** implement (export `lcsPairs` from `captions.js`, then sync-shared). **Step 4:** run — PASS.
- [ ] **Step 5: Commit** "Caption sources: voice-over timing, script alignment, SRT and VTT"

### Task 5: `caption-presets.js`

**Files:** Create `frontend/studio/caption-presets.js`; Test `frontend/studio/caption-presets.test.js`

**Interfaces:**
- Consumes: `withDefaults` (Task 1), `DEFAULT_STYLE`.
- Produces: `CATEGORIES: [{ id, name }]` (ids `viral, karaoke, clean, cinematic, boxed, neon, arabic`, names per Global Constraints); `PRESETS: [{ id, name, cat, style }]`; `presetById(id)`; `applyPreset(style, id) -> CaptionStyle` (keeps the current `y`, `x`, `maxWords` unless the preset sets them; result passes `withDefaults`); `sampleLine(lang) -> Line` (Arabic sample when `lang === 'ar'`, else English, 3 words, 0–1500 ms) for previews.

- [ ] **Step 1: Failing tests** — at least 28 presets; every category has ≥ 3; ids unique; every `style` round-trips `withDefaults` without new keys appearing that aren't in `DEFAULT_STYLE` ∪ new fields; every `style.anim` is one of the 8; `JSON.stringify(style).length < 2000`; `applyPreset({ ...DEFAULT_STYLE, y: 0.8 }, 'clean-white').y === 0.8`; the `arabic` presets use an Arabic-capable `font` key from `FONT_STACKS`.
- [ ] **Step 2:** run — FAIL. **Step 3:** write the data (Bold and viral: upper case, heavy stroke, pop/bounce; Karaoke: `anim: 'karaoke'` with box or colour highlight; Clean: no stroke, soft shadow; Cinematic: serif, small, low `y`, fade; Boxed: `box` on; Neon: coloured text, coloured shadow; Arabic: Cairo/Noto Sans Arabic stacks, `lh` 1.3). **Step 4:** run — PASS.
- [ ] **Step 5: Commit** "Caption presets: 7 categories, applyPreset"

---

## Phase B — data and backend

### Task 6: `caption-store.js` and migration

**Files:** Create `frontend/studio/caption-store.js`; Test `frontend/studio/caption-store.test.js`

**Interfaces:**
- Produces:
  - `CAPTIONS_DEFAULT = { on: true, lines: [], style: null, preset: null, source: null, lang: null, voSig: null }`
  - `kindOf(d) -> 'video' | 'reel' | 'still'` (`d.footage` → video; `d.motion` → reel).
  - `capsOf(d) -> captions object` (always `d.captions`, created from `CAPTIONS_DEFAULT` if missing — callers mutate it inside `mutate()`).
  - `migrateCaptions(d) -> boolean` — moves `d.footage.captions` (`styleFrom` dropped, `preset: null`, `source: 'speech'`, `lang` from `d.footage.captions.lang`) and maps `d.audio.captions` (boolean) to `d.captions.on` for reels (`source: 'voiceover'`). Deletes the old fields. Returns true when it changed `d`. Idempotent.
  - `styleOf(d) -> CaptionStyle` = `withDefaults(capsOf(d).style || DEFAULT_STYLE)`.

- [ ] **Step 1: Failing tests** — footage design with `footage.captions` moves over and `footage.captions` is gone; second call returns false; reel with `audio.captions: true` gets `captions.on === true`, `source 'voiceover'`; a design with both `captions` and `footage.captions` keeps `captions`; `kindOf` for the three kinds.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** "Caption store: one captions object per design, migration"

### Task 7: Footage editor on `d.captions`

**Files:** Modify `frontend/studio/footage-editor.js` (every `ED.d.footage.captions` / `ft.captions`, `analysisPatch`, `applyPatch`, `exportPayload`), `frontend/studio/footage.js` (`footageDoc` writes `d.captions` instead of `footage.captions`); Test `frontend/studio/footage-editor.test.js`, `footage.test.js`

**Interfaces:**
- Consumes: `capsOf`, `migrateCaptions` (Task 6).
- Produces: `analysisPatch(caps, ft, opts)` and `applyPatch(caps, ft, p)` take the captions object and the footage object separately; `exportPayload(d, size)` sends `footage.captions = { style: capsOf(d).on ? styleOf(d) : null, lines: capsOf(d).on ? lines : [] }` (server contract unchanged).
- `migrateCaptions(d)` runs in the editor's open path **before** the first history snapshot (so it is not an undo step), followed by `save()` when it returns true.

- [ ] **Step 1:** update the existing tests to the new signatures and add: opening a legacy footage design calls `migrateCaptions` and the undo stack is empty afterwards; `exportPayload` of a design with `captions.on === false` sends no lines.
- [ ] **Step 2:** run both test files — FAIL. **Step 3:** implement (mechanical replacement). **Step 4:** run all `studio` tests — PASS (`npx vitest run studio`).
- [ ] **Step 5:** browser check: open an existing "matched" design, captions show, edit a line, export dialog opens. **Step 6: Commit** "Footage editor: captions live on the design"

### Task 8: Import without a reference (backend + upload)

**Files:** Modify `backend/src/footage/jobs.service.ts` (`grade`, `caption-style` steps), `frontend/studio/footage-editor.js` (`analysis`, `canExport`), `frontend/studio/footage.js` (upload modal: reference and look optional; `FT.newVideo()`); Test `backend/src/footage/jobs.service.test.ts`, `frontend/studio/footage-editor.test.js`, `footage.test.js`

**Interfaces:**
- Produces: the `grade` step returns `"skipped"` (job state `skipped`, not an error) when `pair` has neither `ref` nor `lookId`; same for `caption-style` on an original without a ref. `analysis(rec, ref)` and `canExport` treat `skipped` as settled. `FT.newVideo()` opens the upload modal in "Caption a video" mode (one drop zone, no reference row) and creates a design with `pair` omitted.

- [ ] **Step 1: Failing tests** — backend: a record with `pair: {}` ends `ready` with `jobs.grade.state === 'skipped'`; `POST /footage/:id/pair` later with `ref` and a retry of `grade` produces a cube. Frontend: `canExport(rec with grade skipped) === true`; the modal's Start is enabled with only an original.
- [ ] **Step 2–4:** FAIL → implement → PASS (`backend`: `npx vitest run src/footage/jobs.service.test.ts`; frontend: `npx vitest run studio`).
- [ ] **Step 5: Commit** "Footage: import a video without a reference"

---

## Phase C — the shell

### Task 9: `timeline.js` (extracted track timeline)

**Files:** Create `frontend/studio/timeline.js`; Modify `frontend/studio/footage-editor.js` (remove the lane code shipped on 2026-11-07: `sizeTrack`, `follow`, `setZoom`, `zoomStep`, `drawWave`, `scrub`, `dragStart`); Modify `frontend/styles/studio.css` (rename `.ft-lane*` → `.vs-tl*`); Test `frontend/studio/timeline.test.js`

**Interfaces:**
- Produces:
  - Pure: `tickStep(pps) -> seconds`, `nextZoom(cur, dir, viewPx, durMs) -> pps | null` (null = fit), `clampDrag(lines, i, edge, ms, dur)` (moved from footage-editor, same behaviour).
  - `createTimeline(host, { dur, time, seek, tracks, onRetime, onSelect, onToggle, canEdit }) -> { redraw(), setTime(ms, playing), setPeaks(peaks), destroy() }`. Each track header has an icon, a label and an eye button (`onToggle(id)`) except `video` and `scenes`; a hidden `captions` track sets `captions.on = false`.
  - `tracks: [{ id: 'video'|'scenes'|'captions'|'voice'|'music', icon, label, html?: (pps) => string, blocks?: [{ id, start, end, text, on }], hidden?: boolean }]`. `captions` blocks get drag/resize; `html` is for tracks the source draws itself (scenes, audio clips).
- Behaviour kept exactly: ruler, default 40 px/s when the video is longer than the view, zoom out/in/fit, follow while playing, scrub by click/drag, current block highlight.

- [ ] **Step 1: Failing tests** for the pure helpers (`tickStep(40) === 2`, `nextZoom` from fit goes to the first step wider than fit, to null when zooming out below fit; `clampDrag` tests moved from `footage-editor.test.js`).
- [ ] **Step 2–4:** FAIL → implement, switch footage editor to `createTimeline` → PASS.
- [ ] **Step 5:** browser check on an Arabic video: zoom, scrub, drag a caption edge, follow while playing; no console errors. **Step 6: Commit** "Timeline: shared track timeline"

### Task 10: `video-studio.js` shell + video source

**Files:** Create `frontend/studio/video-studio.js`; Modify `frontend/studio/footage-editor.js` (register as source; drop its own `edRail`/`edPages` wrappers and transport), `frontend/studio/engine.js` (call `installVideoStudio(ctx)` right before `installFootage`, pass `wrapEd`), `frontend/styles/studio.css`; Test `frontend/studio/video-studio.test.js`

**Interfaces:**
- Consumes: `kindOf` (Task 6), `createTimeline` (Task 9).
- Produces:
  - Pure: `railFor(kind) -> [[key, label, icon]]` — video: `media, captions, styles, script, audio, look, agent`; reel: `templates, motion, captions, styles, script, audio, elements, text, uploads, brand, figma, data, comps, agent` (keys of existing RAIL entries kept so their panels still work).
  - `VS.register(kind, source)` where `source = { mount(stage), unmount(), player: { toggle(), play(), pause(), seek(ms), time(), duration(), playing() }, tracks(): Track[], panel(key) -> html | null, inspector(sel) -> html | null, transportExtra() -> html }`.
  - `VS.panel(key, render)` lets shared panels (Task 12–15) register `captions, styles, script` for both kinds.
  - Transport HTML/behaviour from the 2026-11-07 footage transport (back 5 s, play, fwd 5 s, time, J/K/L, arrows) now lives here, driven by `source.player`.
  - `VS.select(sel)` with `sel = { kind: 'caption', id } | { kind: 'video' } | { kind: 'scene', i } | null` routes the inspector.

- [ ] **Step 1: Failing tests** — `railFor('video')` order and contents; `railFor('reel')` starts with templates, motion, then captions; no `look` or `media` in reel; inspector routing picks `caption` → caption tabs host, `video` → source inspector.
- [ ] **Step 2–4:** FAIL → implement; the footage editor registers `video` and keeps Look, analysis polling and export window → PASS (`npx vitest run studio`).
- [ ] **Step 5:** browser check: a matched video opens in the shell; rail shows Media … Agent; play/scrub/zoom work; Look panel unchanged. **Step 6: Commit** "Video Studio shell, video source"

### Task 11: Reel source

**Files:** Modify `frontend/studio/engine.js` (motion block ~L9990–10580: expose `RT.moPlayer = { toggle, play, pause, seek, time, duration, playing }` from `PL`/`play`/`pause`; scene strip from `tlHTML` as the `scenes` track `html`; audio lanes `AU.lanes` as `voice`/`music` track `html`; register `reel` with `VS.register`), `frontend/styles/studio.css`; Test `frontend/studio/video-studio.test.js`

**Interfaces:**
- Consumes: `VS.register` (Task 10).
- Produces: reels use the shell transport and timeline; layer lanes stay under the scenes track, collapsed by default (`localStorage` key `boga.mo37Folded` reused).

- [ ] **Step 1: Failing test** — a fake reel design (`d.motion`, 2 pages) resolves to `kindOf === 'reel'` and the registered source returns tracks `['scenes', 'captions', 'voice', 'music']` in that order.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** browser check on "Reel · Nov 6": play, scene drag/resize, add scene, music and voice-over clips, export still records. Compare the frame with a video design side by side. **Step 6: Commit** "Video Studio: motion reels as a source"

---

## Phase D — shared panels

### Task 12: Captions panel (both kinds) and reel captions

**Files:** Create `frontend/studio/caption-panels.js`; Modify `frontend/studio/footage-editor.js` (remove `subsHTML`, `rowHTML`, row menu, `splitAt`, `addAtPlayhead`, `commitText`; keep Re-transcribe as an action the panel calls), `frontend/studio/engine.js` (`AU.drawCaption` → `captions.draw(ctx, capsOf(d).lines, styleOf(d), t, W*s, H*s)` when `capsOf(d).on`; rebuild lines from `voiceoverWords` when `source === 'voiceover'` and `voSig` changed); Test `frontend/studio/caption-panels.test.js`

**Interfaces:**
- Consumes: `capsOf`, `styleOf` (Task 6), `voiceoverWords`, `needsRebuild`, `voSig` (Task 4), `VS.panel` (Task 10).
- Produces: `installCaptionPanels(ctx, VS)`; panel `captions` HTML: search box, rows (time, inline edit `dir="auto"`, menu: split at playhead, merge with next, delete), Add line, Captions on/off switch, Re-transcribe (video) or Rebuild from voice-over (reel, only when `needsRebuild`). Editing any line sets `source: 'manual'` and stores `voSig` (reel). Reel without any voice-over: the panel says "Captions come from the voice-over script." with an "Open Audio" button.

- [ ] **Step 1: Failing tests** (pure helpers exported for test): `filterRows(lines, q)` matches Arabic and Latin substrings ignoring diacritics; `reelCaptions(d)` returns rebuilt lines for `source 'voiceover'` and leaves `manual` lines untouched; the toggle writes `captions.on`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** browser: edit an Arabic line on a video; on a reel with voice-over, turn captions on, see them in preview and in a recorded export. **Step 6: Commit** "Captions panel for videos and reels"

### Task 13: Styles panel (preset grid, brand styles)

**Files:** Modify `frontend/studio/caption-panels.js`, `frontend/styles/studio.css`; Test `caption-panels.test.js`

**Interfaces:**
- Consumes: `CATEGORIES`, `PRESETS`, `applyPreset`, `sampleLine` (Task 5).
- Produces: panel `styles`: category chips with counts (All, Recent, Brand, then the 7), search by name, 2-column grid of canvas previews (each drawn once with `captions.draw` at `ms = 900` on a 160×200 neutral frame, cached by preset id + lang), click applies (`mutate`: `style = applyPreset(style, id)`, `preset = id`), "Save as brand style" (name prompt, pushes to `brand().captionStyles`, cap 20 with a toast when full). Recent = last 8 applied ids in `localStorage` key `boga.capRecent`. Editing any style field sets `preset: null` (shown as "Custom").

- [ ] **Step 1: Failing tests** — `presetsFor(cat, q, recentIds, brandStyles)` filters correctly; saving a 21st brand style returns `{ ok: false }`; applying a preset then changing size sets `preset` to null.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** browser: apply Karaoke on the Arabic video, previews show Arabic sample text. **Step 6: Commit** "Styles panel: caption presets and brand styles"

### Task 14: Caption inspector tabs

**Files:** Modify `frontend/studio/caption-panels.js`, `frontend/studio/footage-editor.js` (remove the subtitle style block from `lookHTML`), `frontend/styles/studio.css`; Test `caption-panels.test.js`

**Interfaces:**
- Produces: inspector for `sel.kind === 'caption'` or when Captions/Styles is open: 4×2 icon tab grid (Font, Colors, Spacing, Layout, Box, Animate, Timing, Reference) and the controls listed in the spec's Inspector table, writing `capsOf(d).style` fields. Live preview on `input`, one `mutate()` on `change`. Words per line / max chars / max lines regroup the lines from the transcript words (today's `regroup` behaviour, now from `caption-panels.js`). Reference tab: "Copy from a video" (upload a reference, reuses `uploadFootage` + `POST /footage/:id/pair`, applies `captionStyle` when ready) and a list of brand looks with a caption style.

- [ ] **Step 1: Failing tests** — `setStyleField(style, path, value)` clamps per field (`size` 0.02–0.12, `ls` −0.05–0.3, `lh` 0.9–2, `x`/`y` 0–1, `offset` −1000–1000, `animSpeed` 0.5–2) and returns a new object; tab order equals the Global Constraints list.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** browser: each tab fits a 900 px tall window without scrolling. **Step 6: Commit** "Caption inspector: font, colours, spacing, layout, box, animation, timing, reference"

### Task 15: Script panel

**Files:** Modify `frontend/studio/caption-panels.js`; Test `caption-panels.test.js`

**Interfaces:**
- Consumes: `linesFromScript`, `parseSubtitles`, `toSrt` (Task 4); speech words from `GET /footage/:id/words` (video) or `voiceoverWords` (reel).
- Produces: panel `script`: textarea "Paste your script" + "Make captions" (asks to replace when lines exist; shows "Not enough of the script matched the speech, so the lines are spread over the video." when `spread` and speech existed), "Open SRT or VTT" (file input `.srt,.vtt`; error toast "This file has no readable captions" and no change), "Download SRT" (`toSrt`, file name `exportName` with `.srt`). Sets `source` to `script` / `srt`.

- [ ] **Step 1: Failing tests** — `scriptAction(d, text, speech)` returns `{ lines, note }` with the spread note only when speech existed; a bad SRT leaves `capsOf(d).lines` unchanged.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** "Script panel: paste a script, open SRT or VTT, download SRT"

### Task 16: Media panel, empty state, Studio tile

**Files:** Modify `frontend/studio/footage-editor.js` (panel `media`, stage drop zone when `!d.footage.src`), `frontend/studio/footage.js` (Studio → Videos tile "Caption a video" → `FT.newVideo()`; a blank video design can exist before upload), `frontend/studio/engine.js` (tile list), `frontend/styles/studio.css`; Test `footage.test.js`

**Interfaces:**
- Consumes: `FT.newVideo()` (Task 8), `uploadFootage`.
- Produces: Media panel (name, length, size, poster, "Replace video" with a confirm that captions will be re-made); stage drop zone "Add your video" / "MP4 or MOV, up to 10 min" / "or choose a file"; Captions panel steps 1–2 when empty (from the spec's Empty states); when transcription failed or found no speech, the Captions panel offers Paste script and Open SRT instead of only Retry. Look panel: "Match a reference" button when the record has no `pair.ref` (uploads the reference, `POST /footage/:id/pair`, retries `grade` and `caption-style`).

- [ ] **Step 1: Failing tests** — `videoBlank()` design passes `kindOf === 'video'` with `footage.src === null`; a file over 10 min (probe) is refused with "This video is longer than 10 minutes."
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** browser: Studio → Caption a video → drop a file → captions appear without a reference. **Step 6: Commit** "Caption a video: empty studio, media panel"

### Task 17: Audio panel for videos (original volume, music, ducking) in preview and export

**Files:** Modify `frontend/studio/footage-editor.js` (panel `audio`, player volume, music `<audio>` synced to the player), `frontend/studio/footage-player.js` (`setVolume(v)`), `backend/src/footage/export.service.ts` (validate `audio`), `backend/src/footage/ffmpeg.ts` (`buildExportArgs` gains `music?: { path, vol, duck }` and `vol`), `backend/src/footage/footage.controller.ts` (resolve a media id to a temp file); Test `backend/src/footage/export.ffmpeg.test.ts`, `export.service.test.ts`

**Interfaces:**
- Produces: `d.footage.audio = { vol: 0..1 (default 1), music: { src, mediaId, name, vol 0..1 (0.6), duck: boolean (true) } | null }`; music picked with the reel's existing music picker (`au38` code path, reused by calling its modal with a callback). Export body `footage.audio` validated (`vol` 0–1, `mediaId` 24-hex). `buildExportArgs` builds `[0:a]volume=V[a0];[1:a]aloop=-1:2e9,volume=M[m];` and, with `duck`, `[m][a0]sidechaincompress=threshold=0.05:ratio=8[md]`, then `amix=inputs=2:duration=first`; with no original audio, the music alone, trimmed to the video.

- [ ] **Step 1: Failing tests** — args contain `amix` and `sidechaincompress` with duck, no `sidechaincompress` without; `vol: 0` and no music gives `-an`; invalid `mediaId` → `ExportInvalid("Invalid music")`; the export hash changes when `audio` changes.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run src/footage`).
- [ ] **Step 5:** browser: add music to the Arabic video, preview ducks under speech, exported MP4 has both. **Step 6: Commit** "Video audio: original volume, music bed and ducking"

---

## Phase E — verification

### Task 18: End-to-end checks

**Files:** Modify `backend/src/footage/e2e.footage.test.ts` (parity run per new animation)

- [ ] **Step 1:** extend the e2e parity test to render with one preset per new animation (karaoke, word, typewriter, bounce, slide); expected: preview vs export mean ΔE < 2 on sampled frames, as today.
- [ ] **Step 2:** run `cd backend && npx vitest run src/footage/e2e.footage.test.ts` — PASS.
- [ ] **Step 3:** full suites: `cd frontend && npx vitest run` and `cd backend && npx vitest run` — PASS.
- [ ] **Step 4:** browser pass (dev servers `api-footage` and `web-footage` from `.claude/launch.json`): the five spec success scenarios; light and dark mode; 760 px width (labels collapse to icons). Screenshot each.
- [ ] **Step 5: Commit** "Video Studio: end-to-end parity for the new animations"
