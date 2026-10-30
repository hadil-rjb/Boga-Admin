# Motion Graphics Engine — design

Date: 2026-10-30 · Workspace: Social Media Admin · Status: approved in chat, awaiting spec review

## Goal

Let users turn an existing static studio design into an animated video (layer animations, scene
transitions, music, sound effects), preview it in the browser, download it, and schedule it through
the planner to every connected platform.

Success: pick a design → one click gives a playable video with a style preset → tweak timing,
transitions, music and SFX → preview → export an MP4 identical to the preview → schedule it.

### Decisions taken

| Question | Decision |
| --- | --- |
| Use | Download **and** planner publishing, publishing first; platform ratio presets (9:16, 1:1, 4:5, 16:9) |
| Audio | Bundled CC0 library (music beds + SFX) plus per-brand uploads |
| Editing depth | Style presets + light timeline (per-layer In / Emphasis / Out, scene length, transitions). No keyframe editor |
| Architecture | Own deterministic runtime in the studio; server render with headless Chromium + ffmpeg (reuses the live-render pipeline) |
| Platforms for video publishing in v1 | All: Instagram, Facebook, TikTok, LinkedIn, X, Telegram |

### Out of scope (v1)

Keyframe/curve editor, AI-generated music, voiceover/TTS, captions, video clips as layers,
videos longer than 60 s, 4K output, in-browser export.

## Architecture

### Data model

Motion data is an optional block on the design (`d.motion`). Static slides are never changed. The block
inherits autosave, version history, comments and brand scoping; no new design collection.

```js
d.motion = {
  ratio: '9:16',              // video canvas; may differ from the design's ratio (re-laid via RATIOS)
  fps: 30,                    // 24 | 30 | 60
  style: 'smooth',            // preset id; supplies defaults for anything not set below
  scenes: [{
    page: pageId,             // a slide of the design
    dur: 3000,                // ms, 500–15000
    bgMotion: 'slow-zoom',    // optional: none | slow-zoom | pan-left | pan-right
    transition: { type: 'slide-left', dur: 500, ease: 'inOut' },   // into the next scene
    layers: {
      [layerId]: {
        in:   { fx: 'rise',  at: 0,    dur: 600, ease: 'out' },
        emph: { fx: 'pulse', at: 1200, dur: 400 },
        out:  { fx: 'fade',  dur: 300 },               // ends at scene end
      },
    },
  }],
  audio: {
    music: { src, gain: 0.8, fadeIn: 500, fadeOut: 1200, offset: 0 },
    sfx: [{ src, at: 3000, gain: 1, pin: { scene: 1, kind: 'transition' } }],   // pin is optional
  },
  render: { mediaId, hash, at, dur, w, h },   // last good export
}
```

`src` is either `lib:<id>` (bundled) or `media:<id>` (uploaded). `hash` is a stable hash of the design
pages plus `motion` (minus `render`), used to decide whether a re-render is needed.

Totals: video length is the sum of scene durations, minus transition overlaps. It is capped at 60 s.

### Frontend units (`frontend/studio/motion/`)

| File | Purpose | Depends on |
| --- | --- | --- |
| `runtime.js` | Pure, deterministic `frameAt(motion, design, t)` → visible scenes, transition progress, and per-layer `{x, y, scale, rotate, opacity, clip, blur}`; `timeline(motion)` → scene start/end times, total length. No `Date.now()`, no unseeded randomness | `fx.js` |
| `fx.js` | Effect library and easings. ~20 enter/exit (fade, rise, drop, slide ×4, zoom in/out, pop, blur-in, wipe ×4, mask-reveal, typewriter, split-letters, spin-in, flip, stretch), 6 emphasis (pulse, shake, bounce, glow, wiggle, float), 10 transitions (fade, slide ×4, push, zoom, wipe, circle-reveal, blur). Style presets: Smooth, Punchy, Minimal, Kinetic, Bold | — |
| `audio.js` | Web Audio preview playback (music bed with gain/fades/offset, SFX at times) and `mixPlan(motion)` → the plain description the server turns into ffmpeg arguments | — |
| `apply.js` | Applies a `frameAt` result to the studio's rendered layer DOM (CSS transforms/opacity/clip-path/filter) | `runtime.js` |
| `view.js` | `#/motion` list page and `#/motion/<designId>` editor, registered on `PAGES` / `NAV` like Automations | all above, engine helpers |

`engine.js` changes: register the page and nav item, add an **Animate** button to the design editor,
and expose `bogaFrame(designId, t)` on the headless renderer next to `renderPost`.

Every effect is defined by a function of local progress `p ∈ [0,1]` that returns a transform delta;
at `p = 1` for "in" and `p = 0` for "out", the delta is the identity (the layer rests where it sits in
the static design).

### Backend units (`backend/src/social/motion/`)

| Unit | Purpose |
| --- | --- |
| `motion.controller.ts` | `GET /social/motion/audio` (bundled manifest), `POST /social/motion/audio` (upload), `GET /social/motion/health`, `POST /social/motion/:designId/render`, `GET /social/motion/jobs/:id`, `GET /social/motion/video/:mediaId` (range-capable stream) |
| `render.service.ts` | Job runner: open `/social-media/render` in headless Chromium (reuses `publishing/headless.ts`), boot with the design, call `bogaFrame(t)` for every frame, screenshot to a temp folder, hand off to `encode.ts` |
| `encode.ts` | Builds ffmpeg arguments: image sequence → H.264 (yuv420p, CRF 20, `+faststart`), audio mix (music with `afade` / `volume` / `atrim`, SFX via `adelay` + `amix`), GIF variant via palettegen. Pure argument builder + a thin spawn wrapper |
| `audio-library.ts` | Reads `backend/data/motion-audio/manifest.json`; computes waveform peaks for uploads (ffmpeg → 1 000 peaks) |
| `job.schema.ts` | `social_motion_jobs`: `brandId, designId, hash, state, progress, error, mediaId, createdBy, startedAt, endedAt` |
| `limits.ts` | `PLATFORM_VIDEO_LIMITS` and `checkVideoForPlatforms(video, pf)` |

Storage: audio uploads and rendered videos are stored in **GridFS** (bucket `media_files`) with a
`Media` record of `kind: 'audio' | 'video'` that points at the GridFS file. Images keep the current
in-document storage. A single Mongo document is capped at 16 MB, and a 60 s 1080p MP4 can exceed that.

## Editor UI

- **Sidebar → Motion** (`#/motion`, after Studio). A card grid of the brand's motion videos, with a looping hover
  preview, a duration badge and a status (Draft · Rendering n% · Ready · Failed). **New video** opens a design picker,
  which creates scenes from the slides and applies the default style.
- **Design editor → Animate.** This does the same thing for the open design.
- **Editor layout:**
  - **Top bar:** back, name, ratio, style, Preview, Export (MP4 · GIF · Schedule).
  - **Left:** a scenes rail with thumbnails, drag-to-reorder and duration.
  - **Centre:** the canvas.
  - **Right:** an inspector. A selected layer shows In / Emphasis / Out (effect, delay, duration, easing). With
    nothing selected it shows scene settings. With the music track selected it shows music settings, including
    "fit video to music".
- **Timeline (bottom):**
  - A playhead with scrubbing.
  - A scenes track. Drag the edges to change length; the ⇢ chips pick the transition.
  - Layer bars for the current scene.
  - A music waveform and SFX diamonds that can be dragged.
  - Keys: Space plays and pauses; ←/→ step one frame.
- **Audio panel:**
  - *Library* (hover to preview) and *Uploads* (per brand).
  - **Auto SFX** adds a whoosh on each transition and a pop on each entrance. One undo removes it.
- **Export.** Shows render progress in a toast and on the card. You can leave the page while it renders. Download when
  it's ready.
- **Mobile.** Preview, style, music and export only. The full timeline is desktop-only.
- **Roles.** `viewer` can preview but cannot edit or export.

## Audio library

- Bundled files live in `backend/data/motion-audio/`: about 8 music beds (upbeat, calm, corporate, cinematic, lo-fi)
  and about 15 SFX (whoosh ×3, swoosh, pop, click, riser, impact, ding, typing, …).
- Every file is CC0. `manifest.json` records `id, title, kind, mood, bpm, dur, source URL, license` for each one, so the
  licensing trail is kept.
- Uploads accept MP3, WAV and M4A up to 20 MB, scoped per brand. Waveform peaks are stored when the file is uploaded.

## Publishing

- A planner post may reference a motion video: `post.kind = 'video'`, `post.d = designId`.
- At schedule time, `checkVideoForPlatforms` validates length, ratio and size for each selected platform. The
  planner shows the warnings, and video posts carry a ▶ badge with their duration.
- At publish time, the scheduler compares `motion.render.hash` with the current hash and re-renders if they differ.
  If that render fails, it uses the last good render and flags the post.
- The provider interface gets `uploadVideo(file, meta)`:
  - **Meta (IG/FB Reels).** Create a container, poll its status, then publish.
  - **TikTok.** Content Posting API: init, chunked upload, publish. This completes the existing scaffolding.
  - **LinkedIn.** Assets API: register the upload, upload in chunks, then create the post.
  - **X.** Media upload INIT / APPEND / FINALIZE, poll STATUS, then post.
  - **Telegram.** `sendVideo` (bot uploads are capped at 50 MB).
- `PLATFORM_VIDEO_LIMITS` is the only place platform limits live (for example: Reels 90 s, TikTok 10 min, X 140 s,
  LinkedIn 10 min, Telegram 50 MB).
- Provider work is built **last**, so the editor and the download path ship first.

## Error handling

- **Render jobs.**
  - States: `queued → rendering → encoding → ready | failed`. One job runs at a time per workspace, with a 3-minute
    timeout.
  - A stuck Chromium is killed and the job retried once. After that the job fails with a readable reason shown on
    the card ("A font didn't load", "Audio file missing", "Video longer than 60s").
  - Temporary frame folders are always removed.
- **Health check.** At startup the API checks for ffmpeg and Chromium. `/social/motion/health` reports the result, and
  Export is disabled with an explanation when either is missing.
- **Limits.** Video length is capped at 60 s, output at 1080×1920, and fps at 60.
- **Opening a video.** Motion data is checked when a video opens. Layers that no longer exist are dropped, and unknown
  effect ids fall back to `fade`.
- **Audio decode failure.** A warning shows on that track and the rest still plays.
- **Publishing errors** use the existing failed-post state and notification, with the platform's message attached.

## Testing

The repo has no test setup today. This adds a minimal one:

- **Frontend (Vitest, `frontend/studio/motion/*.test.js`).**
  - `frameAt` is deterministic.
  - Scene boundaries and transition progress are correct.
  - Every effect is the identity at its resting end.
  - Easings return 0 at 0 and 1 at 1.
  - Durations are clamped.
  - `timeline` totals are correct.
  - `mixPlan` output is right.
- **Backend (Vitest).**
  - `encode.ts` argument builder.
  - `limits.ts`.
  - Each provider's `uploadVideo` against a mocked `http.ts`: chunking, polling and error mapping.
- **End-to-end render check (`backend/scripts/motion-smoke.ts`).**
  - Renders a sample: 3 scenes, 2 s, music and one SFX.
  - `ffprobe` checks the duration, resolution and that an audio stream exists.
  - One exported frame is compared with the browser preview at the same `t`, within a small pixel tolerance.
- **Browser check** after each UI step: play, scrub, edit, export, download.
- **Manual.** Real posting to each platform with test accounts once the provider steps land.

## Build order (for the implementation plan)

1. Runtime + effects + tests.
2. `#/motion` list and editor with preview (no audio).
3. Audio: library, uploads, preview playback, Auto SFX.
4. Server render + encode + download (GridFS, jobs, health), plus the render smoke check.
5. Planner video posts + limits + re-render-on-publish.
6. Provider `uploadVideo`: Telegram → Meta → TikTok → LinkedIn → X.
