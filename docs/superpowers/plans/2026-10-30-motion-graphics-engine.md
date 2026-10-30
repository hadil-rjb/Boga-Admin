# Motion Graphics Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a static studio design into an animated video (layer animations, scene transitions, music, SFX). Preview it, download it as MP4/GIF, and schedule it to all six platforms.

**Architecture:**
- A pure, deterministic runtime (`frameAt(motion, design, t)`) drives both the in-browser preview and the server export.
- The server opens `/social-media/render` in headless Chromium, steps that runtime frame by frame, and pipes JPEG frames into ffmpeg, which also mixes the audio.
- Motion data lives on the design (`d.motion`). Audio and videos are stored in GridFS.

**Tech Stack:** vanilla ES modules in `frontend/studio/` (studio engine), NestJS 10 + Mongoose 8 (GridFS via `mongoose.mongo.GridFSBucket`), puppeteer-core (existing `launchChromium`), ffmpeg/ffprobe (system binaries), Web Audio API, Vitest (new; frontend and backend).

**Spec:** `docs/superpowers/specs/2026-10-30-motion-graphics-engine-design.md`

## Global Constraints

- Video length ≤ 60 000 ms. Output is at most 1080 × 1920. fps ∈ {24, 30, 60}, default 30. Scene `dur` is 500–15 000 ms.
- Video canvas sizes come from `RATIOS` in `frontend/studio/templates.js`. Allowed motion ratios: `9:16`, `1:1`, `4:5`, `16:9`. Width is scaled so the long side ≤ 1920 and the short side ≤ 1080.
- `src` is `lib:<id>` (bundled) or `media:<id>` (GridFS file id).
- Audio uploads: MP3, WAV or M4A, ≤ 20 MB, scoped per brand. Waveform: 1 000 peaks.
- Bundled audio is CC0 only. Every file has a `manifest.json` entry with `id, title, kind, mood, bpm, dur, source, license`.
- Encoding: H.264, `yuv420p`, CRF 20, `-movflags +faststart`, AAC 192k.
- Render jobs run one at a time per workspace. A stuck Chromium gets 1 retry, then the job fails with a readable message.
- Roles: `viewer` can preview only. Edit and export routes use `@Roles(...EDIT)` like `publishing.controller.ts`.
- No new frontend runtime dependencies. Only `vitest` as a devDependency in `frontend/` and `backend/`.
- Write code like the surrounding code: `engine.js` style (`ACT.*`, `PAGES.*`, template strings, `esc()`, `ic()`), and comment density to match.
- The engine sits in a 10k-line file. Motion code goes in `frontend/studio/motion/`. `engine.js` only gets thin wiring.

## Review Focus

1. **The design is edited after it was animated** (a slide deleted or reordered, a layer deleted or added). The video should drop missing scenes and layers, and new layers should take the style defaults. → `normalizeMotion` tests, Task 2.
2. **A transition longer than the scenes around it** (a 600 ms scene with a 900 ms transition). It should be clamped so it never covers more than half of either scene. → Task 2.
3. **"Fit video to music" or long scenes push past 60 s.** The total should be clamped to 60 s, with music trimmed and faded out at the end. → Tasks 2 and 3.
4. **The design changes while a render is running.** The finished render should carry the hash from when it *started*, so publishing sees it as stale and re-renders. → Task 9.
5. **A corrupt or mislabelled audio upload** (a `.mp3` that's really a PNG). It should be rejected at upload with "This file isn't audio we can play", and never reach a render. → Task 6.

Deviations from the spec, decided here:
- Frames are piped into ffmpeg instead of written to a temp folder. Only the temp audio inputs are cleaned up.
- The job timeout is `180 000 + 3 × video ms`. A flat 3 minutes can't fit 1 800 frames at 1080p.
- When the motion ratio differs from the design ratio, the slide is *fit* (contain, centered) on the video canvas, and the page background fills the canvas.
- The provider method is named `publishVideo` (it uploads and posts).
- GridFS `files.metadata` is the record for audio and video, so there's no separate `Media` row.

---

### Task 1: Vitest + effect library (`fx.js`)

**Files:**
- Modify: `frontend/package.json` (devDependency `vitest@^3`, script `"test": "vitest run"`)
- Create: `frontend/studio/motion/fx.js`
- Test: `frontend/studio/motion/fx.test.js`

**Interfaces:**
- Produces:
  - `REST = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1, clip: null, blur: 0, reveal: 1 }`. `x`/`y` are canvas px, `rotate` is deg, `clip` is `[top, right, bottom, left]` in % or null, `blur` is px, `reveal` is the 0–1 fraction of text characters shown.
  - `EASE: Record<'linear'|'in'|'out'|'inOut'|'back'|'spring', (p:number)=>number>`.
  - `FX: Record<string, { kind: 'move'|'emph'|'transition', label: string, at: (p:number, ctx:{ w:number, h:number, seed:number }) => Partial<typeof REST> }>`.
    - **Move effects** (used for both in and out): `fade, rise, drop, slide-left, slide-right, slide-up, slide-down, zoom-in, zoom-out, pop, blur-in, wipe-left, wipe-right, wipe-up, wipe-down, mask-reveal, typewriter, split-letters, spin-in, flip, stretch`.
    - **Emphasis:** `pulse, shake, bounce, glow, wiggle, float`.
    - **Transitions:** `fade, slide-left, slide-right, slide-up, slide-down, push, zoom, wipe, circle-reveal, blur`. These are keyed `t:<id>` in `FX`, and their `at` returns `{ out: Partial<REST>, in: Partial<REST> }`.
  - `STYLES: Record<'smooth'|'punchy'|'minimal'|'kinetic'|'bold', { label, sceneDur, in: { fx, dur, ease, stagger }, out: { fx, dur, ease } | null, emph: { fx, dur } | null, transition: { type, dur, ease } }>`.
  - `seedOf(id: string): number`, a stable 32-bit hash used for `wiggle`/`shake` (no `Math.random`).

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { FX, EASE, REST, STYLES, seedOf } from './fx.js';
const ctx = { w: 1080, h: 1920, seed: 7 };
const moves = Object.entries(FX).filter(([, f]) => f.kind === 'move');
it.each(Object.keys(EASE))('ease %s is 0 at 0 and 1 at 1', (k) => { expect(EASE[k](0)).toBeCloseTo(0); expect(EASE[k](1)).toBeCloseTo(1); });
it.each(moves)('move %s rests at p=1', (id, f) => { expect({ ...REST, ...f.at(1, ctx) }).toEqual(REST); });
it.each(moves)('move %s is not at rest at p=0', (id, f) => { expect({ ...REST, ...f.at(0, ctx) }).not.toEqual(REST); });
it('has the 21 moves, 6 emphasis, 10 transitions', () => {
  expect(moves).toHaveLength(21);
  expect(Object.values(FX).filter((f) => f.kind === 'emph')).toHaveLength(6);
  expect(Object.values(FX).filter((f) => f.kind === 'transition')).toHaveLength(10);
});
it('emphasis returns to rest at p=0 and p=1', () => { for (const f of Object.values(FX).filter((f) => f.kind === 'emph')) { expect({ ...REST, ...f.at(0, ctx) }).toEqual(REST); expect({ ...REST, ...f.at(1, ctx) }).toEqual(REST); } });
it('seedOf is stable', () => expect(seedOf('abc')).toBe(seedOf('abc')));
it('every style references existing effects', () => { for (const s of Object.values(STYLES)) { expect(FX[s.in.fx]).toBeDefined(); expect(FX['t:' + s.transition.type]).toBeDefined(); } });
```

- [ ] **Step 2: Run them and confirm they fail.** `npm --prefix frontend install && npm --prefix frontend test`. Expected: FAIL, cannot resolve `./fx.js`.
- [ ] **Step 3: Implement `fx.js`.** Offsets scale with `ctx.w`/`ctx.h` (for example, `rise` starts at `y: 0.06 * h`). `typewriter`/`split-letters` drive `reveal`. Wipes drive `clip`. `spring`/`back` may overshoot between 0 and 1 but must hit the ends exactly.
- [ ] **Step 4: Run the tests.** `npm --prefix frontend test`. Expected: all pass.
- [ ] **Step 5: Commit.** `git add frontend/package.json frontend/package-lock.json frontend/studio/motion/fx.* && git commit -m "Motion: effect library, easings and style presets"`

### Task 2: Runtime (`runtime.js`)

**Files:**
- Create: `frontend/studio/motion/runtime.js`
- Test: `frontend/studio/motion/runtime.test.js`

**Interfaces:**
- Consumes: `FX`, `EASE`, `REST`, `STYLES`, `seedOf` (Task 1). `RATIOS` from `../templates.js`.
- Produces:
  - `createMotion(design, styleId = 'smooth', ratio = '9:16'): Motion`. One scene per page, with style defaults applied to every visible non-background layer and a stagger by layer order.
  - `normalizeMotion(motion, design): Motion`. Drops scenes whose page is gone and layer entries whose layer is gone. Adds new layers with style defaults. Unknown fx → `'fade'`. Clamps `dur` to 500–15 000, fps to {24, 30, 60}, each transition to ≤ `min(prev.dur, next.dur) / 2`, and the total to 60 000 by shortening the last scenes.
  - `timeline(motion): { total: number, scenes: { start: number, end: number }[] }`. Scene *i* starts at `scenes[i-1].end - transition(i-1).dur`.
  - `canvasSize(ratio): { w: number, h: number }`. The long side is 1920, so `9:16` → 1080×1920 and `16:9` → 1920×1080.
  - `placement(designRatio, videoRatio): { k: number, ox: number, oy: number }`. Fits with contain and centers.
  - `frameAt(motion, design, t): { w, h, scenes: { page: string, z: number, fx: Partial<REST>, place: {k,ox,oy}, layers: Record<string, typeof REST> }[] }`. During a transition two scenes are returned, the outgoing one first. A layer is at rest between its in-end and out-start. A scene's `bgMotion` adds to `fx` over the whole scene: `slow-zoom` takes scale from 1 to 1.08, and `pan-left`/`pan-right` move x by ∓4% of w.
  - `motionHash(design): string`. A stable FNV-1a hex hash of `JSON.stringify({ pages, motion: { ...motion, render: undefined } })`, with keys sorted.

- [ ] **Step 1: Write the failing tests.** Fixture: a design with 3 pages × 2 layers (ids `a1,a2,b1,b2,c1,c2`), ratio `4:5`.

```js
it('frameAt is deterministic', () => { const m = createMotion(D, 'kinetic'); expect(frameAt(m, D, 1234)).toEqual(frameAt(m, D, 1234)); });
it('timeline overlaps transitions', () => { const m = createMotion(D); m.scenes.forEach((s) => { s.dur = 3000; s.transition = { type: 'fade', dur: 500, ease: 'inOut' }; });
  expect(timeline(m)).toEqual({ total: 8000, scenes: [{ start: 0, end: 3000 }, { start: 2500, end: 5500 }, { start: 5000, end: 8000 }] }); });
it('two scenes during a transition, one outside', () => { /* same m */ expect(frameAt(m, D, 2750).scenes).toHaveLength(2); expect(frameAt(m, D, 1000).scenes).toHaveLength(1); });
it('layers rest mid-scene', () => { expect(frameAt(m, D, 1500).scenes[0].layers.a1).toEqual(REST); });
it('drops deleted pages and layers, adds new ones', () => { const D2 = without(D, 'page2', 'a2', { add: 'a3' }); const n = normalizeMotion(createMotion(D), D2);
  expect(n.scenes).toHaveLength(2); expect(n.scenes[0].layers.a2).toBeUndefined(); expect(n.scenes[0].layers.a3.in.fx).toBe(STYLES.smooth.in.fx); });
it('unknown fx falls back to fade', () => { const m = createMotion(D); m.scenes[0].layers.a1.in.fx = 'nope'; expect(normalizeMotion(m, D).scenes[0].layers.a1.in.fx).toBe('fade'); });
it('clamps a transition longer than its scenes', () => { const m = createMotion(D); m.scenes[0].dur = 600; m.scenes[0].transition.dur = 900; expect(normalizeMotion(m, D).scenes[0].transition.dur).toBe(300); });
it('clamps the total to 60s', () => { const m = createMotion(D); m.scenes.forEach((s) => (s.dur = 15000)); m.scenes.push(...m.scenes.map((s) => ({ ...s })));
  expect(timeline(normalizeMotion(m, D)).total).toBeLessThanOrEqual(60000); });
it('canvas and placement', () => { expect(canvasSize('9:16')).toEqual({ w: 1080, h: 1920 }); const p = placement('1:1', '9:16'); expect(p.oy).toBeGreaterThan(0); expect(p.ox).toBe(0); });
it('motionHash ignores render and changes with layers', () => { const m = createMotion(D); const d = { ...D, motion: m };
  expect(motionHash({ ...d, motion: { ...m, render: { mediaId: 'x' } } })).toBe(motionHash(d)); expect(motionHash({ ...d, pages: [] })).not.toBe(motionHash(d)); });
```

- [ ] **Step 2: Run them and confirm they fail.** `npm --prefix frontend test`. Expected: FAIL, missing exports.
- [ ] **Step 3: Implement `runtime.js`.** Pure functions only: no DOM, no `Date.now()`, no `Math.random`. The ctx seed for each layer is `seedOf(layerId)`.
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "Motion: deterministic runtime, timeline and normalization"`

### Task 3: Audio mix plan + preview player (`audio.js`)

**Files:**
- Create: `frontend/studio/motion/audio.js`
- Test: `frontend/studio/motion/audio.test.js`

**Interfaces:**
- Consumes: `timeline` (Task 2).
- Produces:
  - `mixPlan(motion): { total: number, tracks: { src: string, start: number, offset: number, dur: number, gain: number, fadeIn: number, fadeOut: number }[] }`. Music is track 0, from 0 to `total`, with `dur = total`. SFX follow in time order. A pinned SFX takes its `at` from its pin: the transition start of `scene`, or the in-start of the layer. SFX that start at or after `total` are dropped.
  - `fitToMusic(motion, musicMs): Motion`. Scales scene durations proportionally so the total equals `min(musicMs, 60000)`.
  - `autoSfx(motion, ids = { transition: 'lib:whoosh-1', enter: 'lib:pop' }): Motion`. Adds pinned SFX marked `auto: true`. Running it again first removes the earlier `auto` entries.
  - `class Player { constructor(resolveUrl: (src) => string); load(motion): Promise<{ failed: string[] }>; play(fromMs); pause(); get time(): number; dispose() }`. Web Audio. `failed` lists the srcs that didn't decode, and the rest still play.

- [ ] **Step 1: Write the failing tests:**
  - **Music:** `mixPlan` music track spans `total` with the given fades.
  - **Pinned SFX:** a transition-pinned SFX lands at `timeline(m).scenes[1].start`.
  - **Past the end:** an SFX at `total + 1` is dropped.
  - **Fit to music:** `fitToMusic(m, 180000)` gives total 60 000.
  - **Auto SFX:** `autoSfx` run twice yields the same count as running it once.
- [ ] **Step 2: Run them and confirm they fail.** `npm --prefix frontend test`.
- [ ] **Step 3: Implement.** `Player` gets no unit test (it needs a browser). It is checked in the browser in Task 6.
- [ ] **Step 4: Run the tests.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "Motion: audio mix plan, fit to music, auto SFX, preview player"`

### Task 4: Motion list page, Animate button, playable preview

**Files:**
- Create: `frontend/studio/motion/apply.js`, `frontend/studio/motion/view.js`
- Modify: `frontend/studio/engine.js`. `NAV` (line ~538) gets `['motion', 'Motion', 'play', 'New']` after studio. Register the page inside `bootStudio` next to the Automations block (~7706). Add an **Animate** button to the design editor top bar next to `edBack`. Add the `play` icon to `frontend/studio/icons.js` if it's missing.
- Modify: `frontend/styles/studio.css`. Add `.mo-*` classes.

**Interfaces:**
- Consumes: `createMotion`, `normalizeMotion`, `frameAt`, `timeline`, `canvasSize` (Task 2).
- Produces:
  - `apply.js`: `mountStage(el, design, motion, posterHTML) → { seek(t), destroy() }`. It renders each page once as `.poster` (with `posterHTML`) inside `.mo-stage` at `canvasSize`, then on `seek` writes `transform`, `opacity`, `clip-path`, `filter` and text `reveal` (wrapping text chars in spans once) to `.ly[data-id]` and the scene wrappers.
  - `view.js`: `installMotion(ctx)`, where `ctx = { S, PAGES, ACT, getD, save, route, toast, esc, ic, thumb, posterHTML, RATIOS, user, api }`. It registers `PAGES.motion = { t: 'Motion', s: 'Turn designs into animated videos for Reels, TikTok and Shorts.', actions, view }`, plus `ACT.moNew`, `ACT.moOpen`, `ACT.edAnimate`. `#/motion` shows the card grid (designs with `d.motion`): a duration badge, and on hover a muted, looping `mountStage` preview that is destroyed on mouseleave. `#/motion/<id>` shows the editor shell with stage, play/pause and scrubber.

- [ ] **Step 1: Implement `apply.js` and `view.js`, and wire them into `engine.js`.** `edAnimate`/`moNew` set `d.motion = createMotion(d, 'smooth', '9:16')` if it's absent, then `save()` and go to `#/motion/<id>`. On open, run `normalizeMotion`. Playback uses `requestAnimationFrame`, with `t` from `performance.now()` minus the start, clamped to `total`.
- [ ] **Step 2: Check it in the browser.** `preview_start` the dev server and sign in with the seed admin from `backend/.env`. Confirm:
  - **Motion** appears in the sidebar, and a design's **Animate** opens `#/motion/<id>`.
  - Play animates the layers in and transitions between slides; the scrubber seeks.
  - `read_console_messages` shows no errors.
  - Reloading keeps the video (it's saved on the design).
  - Take a screenshot.
- [ ] **Step 3: Commit.** `git commit -m "Motion: list page, Animate button and playable preview"`

### Task 5: Editor — scenes rail, inspector, timeline

**Files:**
- Modify: `frontend/studio/motion/view.js` (or split into `frontend/studio/motion/editor.js` if `view.js` passes about 600 lines), `frontend/styles/studio.css`

**Interfaces:**
- Consumes: Task 4 `mountStage`. `FX`, `STYLES`, `EASE` (Task 1). `normalizeMotion`, `timeline` (Task 2).
- Produces the user-facing editor described in the spec's "Editor UI" section:
  - **Top bar:** ratio select (the 4 ratios) and style select. Changing the style re-applies the style defaults to every layer after a confirm.
  - **Scenes rail:** drag to reorder (reorders `motion.scenes`, not the design's pages) and an inline duration field.
  - **Inspector:** for a selected layer, the In / Emphasis / Out tabs with effect grid (hover runs a 600 ms preview on the stage), delay, duration and easing. For a scene: length, `bgMotion`, transition.
  - **Timeline:** scenes track with draggable right edges (snapping to 100 ms) and ⇢ transition chips; layer bars for the current scene (drag to move `in.at`, drag an end to change `in.dur`); playhead scrubbing.
  - **Keys:** Space toggles play; ←/→ step `1000 / fps`.
  - **Viewers** (`user.role === 'viewer'`): every control is disabled and preview still works.
  - **Narrow screens** (`innerWidth < 1024`): the timeline and inspector are hidden, and the top bar stays.
  - Every edit runs `normalizeMotion`, then `save()`, then re-seeks the stage.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Check it in the browser:**
  - Change an entrance to `pop`, and confirm the stage shows it when scrubbing.
  - Drag a scene edge, and confirm the total time updates.
  - Change a transition to `circle-reveal`.
  - Reorder the scenes.
  - Space and the arrow keys work.
  - `resize_window` to the mobile preset hides the timeline.
  - The console is clean.
  - Take a screenshot.
- [ ] **Step 3: Commit.** `git commit -m "Motion: editor rail, inspector and timeline"`

### Task 6: Audio library, uploads, audio panel

**Files:**
- Create:
  - `backend/data/motion-audio/manifest.json` and audio files: 8 beds (upbeat ×2, calm, corporate ×2, cinematic, lo-fi ×2) and 15 SFX (whoosh-1..3, swoosh, pop, click, riser, impact, ding, typing, …). CC0 sources only, for example Pixabay CC0 / freesound CC0. Each file is ≤ 2 MB (MP3 128k).
  - `backend/src/social/motion/audio-library.ts`
  - `backend/src/social/motion/motion-files.service.ts`
  - `backend/src/social/motion/motion.controller.ts`
  - `backend/src/social/motion/motion.module.ts` (imported by `social.module.ts`)
  - `backend/src/social/motion/probe.ts`
- Modify: `backend/package.json` (devDependency `vitest@^3`, script `"test": "vitest run"`), `frontend/studio/motion/view.js`
- Test: `backend/src/social/motion/probe.test.ts`

**Interfaces:**
- Produces:
  - `probe.ts`: `parseProbe(json: string): { dur: number, w?: number, h?: number, hasAudio: boolean, hasVideo: boolean }` (pure) and `ffprobe(path): Promise<string>` (spawns `ffprobe -v error -print_format json -show_format -show_streams`).
  - `motion-files.service.ts`: `put(brandId, kind: 'audio'|'video', buf: Buffer, meta: Record<string, unknown>): Promise<string>`, `stream(id, range?: string)`, `get(id): Promise<Buffer>`, `meta(id)`, `remove(id)`. Uses the GridFS bucket `social_motion_files`, with `metadata: { brandId, kind, mime, dur, peaks?, w?, h?, name }`.
  - `audio-library.ts`: `libraryManifest()`, `libraryPath(id): string | null`, `peaks(buf): Promise<number[]>`. Peaks come from `ffmpeg -i pipe:0 -ac 1 -ar 8000 -f s16le pipe:1`, bucketed into 1 000 absolute maxima, normalized 0–1.
  - Routes on `@Controller("social")`:
    - `GET motion/audio`: the manifest.
    - `GET motion/audio/lib/:id`: `@Public()`, streams the bundled file.
    - `GET brands/:brandId/motion/audio`: uploads list.
    - `POST brands/:brandId/motion/audio`: `@Roles(...EDIT)`, multipart `file`. Rejects anything over 20 MB. If ffprobe finds no audio stream, it returns 400 "This file isn't audio we can play".
    - `GET motion/files/:id`: `@Public()`, range-capable, `?dl=1` adds `Content-Disposition`.
  - Frontend:
    - The audio panel's Library / Uploads tabs (hover preview with an `<audio>` element).
    - The music inspector: gain, fades, offset, and "Fit video to music" → `fitToMusic`.
    - **Auto SFX** button → `autoSfx`. A toast with Undo restores the earlier `motion.audio.sfx`.
    - Music waveform and draggable SFX diamonds on the timeline.
    - `Player` is wired to play/pause/seek. Tracks that fail to decode show a ⚠ on their row.

- [ ] **Step 1: Write the failing test.** `parseProbe` on a recorded ffprobe JSON fixture for an MP3 → `{ dur: 2.5e3-ish, hasAudio: true, hasVideo: false }`. A PNG fixture → `hasAudio: false`.
- [ ] **Step 2: Run it and confirm it fails.** `npm --prefix backend install && npm --prefix backend test`.
- [ ] **Step 3: Implement the backend pieces above.** Write the manifest with the real source URL for each file.
- [ ] **Step 4: Run the tests.** Expected: pass. Then check the endpoints:
  - `curl -s localhost:4000/api/social/motion/audio | head`. Expected: JSON with 23 entries.
  - Uploading a `.png` renamed to `.mp3` returns 400 with that message.
- [ ] **Step 5: Implement the frontend panel and check it in the browser:**
  - A bundled bed plays in sync with the scrubber.
  - Auto SFX adds diamonds, and Undo removes them.
  - An upload appears under Uploads with its waveform.
  - The console is clean.
- [ ] **Step 6: Commit.** `git commit -m "Motion: audio library, uploads and audio panel"`

### Task 7: ffmpeg argument builder (`encode.ts`)

**Files:**
- Create: `backend/src/social/motion/encode.ts`
- Test: `backend/src/social/motion/encode.test.ts`

**Interfaces:**
- Consumes: the mix plan shape from Task 3, sent by the page as JSON.
- Produces:
  - `mp4Args({ fps, w, h, out, audio: { path, start, offset, dur, gain, fadeIn, fadeOut }[] }): string[]`. Video in: `-f image2pipe -framerate <fps> -c:v mjpeg -i pipe:0`. Each audio input: `-ss <offset/1000> -i <path>`. Filter graph: each track gets `atrim=0:<dur/1000>`, `adelay=<start>|<start>`, `volume=<gain>`, `afade=t=in:d=..` and `afade=t=out:st=..:d=..` when they're > 0, then `amix=inputs=N:normalize=0`. Output: `-c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart -c:a aac -b:a 192k -shortest`. With no audio, it emits no audio map.
  - `gifArgs(inMp4, out, { fps = 15, width = 540, maxMs = 15000 }): string[]`. Uses `palettegen`/`paletteuse` in one `-filter_complex`.
  - `runFfmpeg(args, stdin?: Readable): Promise<void>`. Rejects with the last 20 lines of stderr.

- [ ] **Step 1: Write the failing tests:**
  - With no audio, the args contain `-crf 20`, `yuv420p` and `+faststart`, and no `-c:a`.
  - With two tracks, the graph contains `adelay=3000|3000`, `amix=inputs=2:normalize=0` and `afade=t=out:st=` with the right start.
  - `gifArgs` contains `palettegen` and `-t 15`.
- [ ] **Step 2: Run them and confirm they fail.** `npm --prefix backend test`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "Motion: ffmpeg argument builder"`

### Task 8: Server render jobs, export and download

**Files:**
- Create:
  - `backend/src/social/motion/job.schema.ts` (`social_motion_jobs`: `brandId, designId, hash, state: 'queued'|'rendering'|'encoding'|'ready'|'failed', progress, error, mediaId, gifId, createdBy, startedAt, endedAt`)
  - `backend/src/social/motion/render.service.ts`
  - `backend/scripts/motion-smoke.ts`
- Modify:
  - `backend/src/social/publishing/live-render.service.ts`: extract the state building in `renderPost` into a public `stateFor(brandId, design, posts = [])` and reuse it there.
  - `frontend/app/(social)/social-media/render/page.tsx`: add `bogaMotion(designId)` and `bogaFrame(t)` to the window type and wiring.
  - `frontend/studio/engine.js`: the headless block (~8008) gets `renderMotion` returning `{ w, h, fps, total, mix }` after `fontsFor`, and `frame(t)`.
  - `motion.controller.ts`, `frontend/studio/motion/view.js`

**Interfaces:**
- Consumes: `launchChromium` (`publishing/headless.ts`), `stateFor`, `mp4Args`/`gifArgs`/`runFfmpeg` (Task 7), `MotionFilesService.put` (Task 6), `motionHash`/`mountStage` (Tasks 2 and 4).
- Produces:
  - `MotionRenderService.start(brandId, designId, userId, { gif?: boolean }): Promise<Job>`. Enqueues on a single promise chain, like `LiveRenderService.render`. It saves `hash = motionHash(design)` read **at start**.
  - `MotionRenderService.renderNow(job)`:
    1. Opens a page at `canvasSize` with `deviceScaleFactor: 1` and goes to `/social-media/render`.
    2. Calls `bogaBoot(state)` and `bogaMotion(designId)`.
    3. For each frame `i < ceil(total * fps / 1000)`, calls `await bogaFrame(i * 1000 / fps)`, takes `page.screenshot({ type: 'jpeg', quality: 92, clip: stage })`, and writes the result to ffmpeg's stdin.
    4. Updates `progress` every 15 frames.
    5. Writes the `lib:`/`media:` audio to a `mkdtemp` folder, which is removed in `finally`.
    6. Stores the MP4 (plus a GIF if asked) via `put`, then sets `design.motion.render = { mediaId, hash, at, dur, w, h }` with `$set` on `social_designs`.
    7. Timeout is `180000 + 3 * total`. On a timeout or a Chromium crash it closes the browser and retries once, then fails.
    8. Errors are mapped to readable messages: font load timeout → "A font didn't load", ENOENT on audio → "Audio file missing", total > 60 s → "Video longer than 60s".
  - `MotionRenderService.health(): Promise<{ ffmpeg: boolean, chromium: boolean }>`. Checked once at module init by spawning `ffmpeg -version` and launching Chromium, then cached.
  - Routes:
    - `GET motion/health`
    - `POST brands/:brandId/motion/:designId/render` (`@Roles(...EDIT)`, body `{ gif?: boolean }`)
    - `GET brands/:brandId/motion/jobs/:id`
    - `GET brands/:brandId/motion/jobs?designId=` (latest)
  - Frontend:
    - **Export ▾** offers MP4, GIF (disabled when total > 15 s) and Schedule (Task 9). Export is disabled with an explanation when `health` reports false.
    - Job progress polls every 1.5 s, shows in a toast and on the card ("Rendering 40%").
    - **Download** links to `motion/files/:id?dl=1`.
    - Card status: Draft · Rendering n% · Ready · Failed (reason).

- [ ] **Step 1: Write `backend/scripts/motion-smoke.ts`** (run with `ts-node`, like `seed.ts`):
  - Build a 3-scene, 2 s-per-scene design with one bundled bed and one SFX, and run `MotionRenderService` on it through a Nest application context.
  - `ffprobe` the result and assert: duration within ±1 frame of the timeline total, 1080×1920, one audio stream.
  - Extract frame `t = 1500` with `ffmpeg -ss 1.5 -frames:v 1`, compare it to a headless screenshot of `bogaFrame(1500)`, and assert a mean absolute pixel difference < 4/255.
  - Print `OK` or fail with non-zero.
- [ ] **Step 2: Run it and confirm it fails.** `npm --prefix backend exec ts-node -r tsconfig-paths/register scripts/motion-smoke.ts`. Expected: FAIL, `MotionRenderService` doesn't exist.
- [ ] **Step 3: Implement the backend, the render-page hooks and the engine headless additions.**
- [ ] **Step 4: Run the smoke script again.** Expected: `OK`. Also run `npm --prefix backend test` and `npm --prefix frontend test`; both pass.
- [ ] **Step 5: Implement the export UI and check it in the browser:**
  - Export MP4 shows progress, the card turns Ready, and Download returns a playable MP4.
  - Leaving the page during the render doesn't stop it.
  - The console is clean.
- [ ] **Step 6: Commit.** `git commit -m "Motion: server render jobs, MP4/GIF export and download"`

### Task 9: Platform limits, video posts in the planner, publish path

**Files:**
- Create:
  - `backend/src/social/motion/limits.ts` and `backend/src/social/motion/limits.test.ts`
  - `backend/src/social/motion/hash.ts`, `backend/src/social/motion/hash.test.ts` and `backend/src/social/motion/__fixtures__/design.json`
  - `backend/src/social/publishing/publisher.video.test.ts`
- Modify:
  - `backend/src/social/publishing/providers/types.ts`: add `PublishVideo { buffer, mime, url, dur, w, h, size }`, `PublishVideoInput { text, firstComment?, video: PublishVideo, story: boolean }`, and `publishVideo(link, input): Promise<PublishResult>` on `Base`, optional until Tasks 10–14.
  - `backend/src/social/publishing/publisher.service.ts`: in `publish()`, when `claimed.kind === 'video'`, load `design.motion`. If `motion.render?.hash !== motionHash(design)`, `await motionRender.renderAndWait(brandId, design.id)`. On failure, fall back to the existing render and add `warning: 'Published the last render: the new one failed'`. Read the buffer with `MotionFilesService.get`, and call `provider.publishVideo`. A provider without `publishVideo` → result error "Video posts aren't supported on <name> yet".
  - `frontend/studio/engine.js` planner: video posts show a ▶ badge with the duration on the card. The schedule dialog for a design with `motion` offers "Post as video". Scheduling shows `checkVideoForPlatforms` warnings and blocks on `error` level.
  - `frontend/studio/motion/view.js`: Export → Schedule opens the planner's schedule dialog with `kind: 'video'`.
  - Add a backend `motionHash` port in `backend/src/social/motion/hash.ts`, with the same algorithm as Task 2.

**Interfaces:**
- Produces:
  - `PLATFORM_VIDEO_LIMITS: Record<Net, { maxMs: number, maxBytes: number, ratios: string[] | null }>`:
    - `ig`: maxMs 90 000, maxBytes 1 GB, ratios `['9:16','4:5','1:1']`
    - `fb`: maxMs 90 000, maxBytes 1 GB, ratios null
    - `tt`: maxMs 600 000, maxBytes 4 GB, ratios `['9:16']`
    - `li`: maxMs 600 000, maxBytes 200 MB, ratios null
    - `x`: maxMs 140 000, maxBytes 512 MB, ratios null
    - `tg`: maxMs 3 600 000, maxBytes 50 MB, ratios null
  - `checkVideoForPlatforms({ dur, size, ratio }, pf: Net[]): { net, level: 'error'|'warn', msg }[]`. Duration or size over the limit → `error`. A ratio not in the list → `warn`.
  - `GET brands/:brandId/motion/:designId/check?pf=ig,tt` returns that list for the latest render.
  - `MotionRenderService.renderAndWait(brandId, designId): Promise<{ mediaId: string }>`.

- [ ] **Step 1: Write the failing tests:**
  - `limits.test.ts`: a 100 s video on `ig` gives an `error`; a `1:1` video on `tt` gives a `warn`; 60 MB on `tg` gives an `error`.
  - `hash.test.ts`: the backend `motionHash` equals the frontend output for a shared fixture JSON in `backend/src/social/motion/__fixtures__/design.json`. Import the frontend `runtime.js` through a relative path in the test only.
  - `publisher.video.test.ts`, with Mongoose models, `MotionRenderService` and the provider mocked:
    - A stale hash calls `renderAndWait` once and publishes the new `mediaId`.
    - A failed re-render publishes the old `mediaId` with the warning.
    - A provider without `publishVideo` gives a per-network error.
- [ ] **Step 2: Run them and confirm they fail.** `npm --prefix backend test`.
- [ ] **Step 3: Implement the backend.**
- [ ] **Step 4: Run the tests.** Expected: pass.
- [ ] **Step 5: Implement the planner UI and check it in the browser:**
  - Schedule a video post to `x` with a 2 s video. The card shows ▶ 0:02.
  - Choosing `tt` on a `4:5` video shows the warning.
  - The console is clean.
- [ ] **Step 6: Commit.** `git commit -m "Motion: video posts in the planner, platform limits, re-render on publish"`

### Tasks 10–14: `publishVideo` per provider

Each provider gets its own task with the same shape:
- **Files:** modify `backend/src/social/publishing/providers/<net>.ts`; test in `backend/src/social/publishing/providers/<net>.video.test.ts`. Use `vi.mock('../http')` to script the `request` responses in order, and assert the calls made.
- **Interfaces:** consumes `PublishVideoInput` (Task 9) and `request`/`ApiError` from `http.ts`. Produces `publishVideo` on that provider.
- **Error mapping:** platform errors surface through `errorText`. Polling gives up after 5 minutes with "<Name> is still processing the video".
- **Steps:** write the failing test → run it and confirm it fails → implement → run it and confirm it passes → commit `Motion: <Name> video publishing`.
- **When all five are done:** make `publishVideo` required on `Base` (a compile check guards against a missing one), and `npm --prefix backend run build` passes.

| Task | Provider | Calls the test must assert |
| --- | --- | --- |
| 10 | Telegram (`telegram.ts`) | One `sendVideo` multipart with `video`, `caption`, `supports_streaming=true`, `width`, `height`, `duration` (s). A response `ok: false` is mapped to an error |
| 11 | Meta (`meta.ts`) | IG: `POST /{ig-user}/media` with `media_type=REELS` (or `STORIES` when `story`), `video_url` = public file URL, then poll `GET /{container}?fields=status_code` until `FINISHED` (`ERROR` → error), then `POST /{ig-user}/media_publish`. FB: `POST /{page}/video_reels` start / upload (`file_url`) / finish |
| 12 | TikTok (`tiktok.ts`) | `POST /v2/post/publish/video/init/` with `source_info.source=FILE_UPLOAD`, `chunk_size` ≤ 64 MB, `total_chunk_count`; `PUT` each chunk with `Content-Range`; poll `/v2/post/publish/status/fetch/` until `PUBLISH_COMPLETE` |
| 13 | LinkedIn (`linkedin.ts`) | `POST /rest/videos?action=initializeUpload` → `PUT` every `uploadInstructions` part (collect ETags) → `POST /rest/videos?action=finalizeUpload` → `POST /rest/posts` with `content.media.id` |
| 14 | X (`x.ts`) | `POST media/upload` INIT (`media_category=tweet_video`, `total_bytes`), APPEND in 4 MB segments with `segment_index`, FINALIZE, poll STATUS while `processing_info.state` is `pending`/`in_progress`, then `POST /2/tweets` with `media.media_ids` |

Real posting is checked by hand with your test accounts after Task 14. It is not automated.
