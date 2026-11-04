# Footage Style Match — design

Date: 2026-11-04 · Workspace: Social Media Admin (Studio) · Status: approved in chat, awaiting spec review

## Goal

Import a raw video (the *original*) and an already-edited video (the *reference*). The studio copies the
reference's **color grade** and **subtitle style** onto the original, transcribes it into **editable
subtitles**, shows a **live preview**, and **exports** the final MP4.

Success: upload a phone clip plus a reference reel, wait for the analysis, then get a preview that looks
like the reference (warm, contrasty grade, Arabic word-by-word subtitles with a gold active-word box).
Fix a few words, export, and the MP4 matches the preview frame for frame (mean ΔE < 2 on sampled frames).

### Decisions taken

| Question | Decision |
| --- | --- |
| Placement | A new **"Match a reference"** video type in Studio → Create → Videos. It opens a footage mode of the existing editor shell. The scene-based motion editor is untouched |
| Reuse | The analyzed grade and subtitle style can be saved as a **brand look** and applied to later clips without a reference |
| Color transfer | Statistical transfer (Lab mean/std + luminance CDF, face/background weighted) baked into a 33³ `.cube` LUT. The same LUT drives the WebGL preview and the ffmpeg export |
| Subtitle style detection | Claude vision on ~6 reference frames that contain text, plus pixel sampling for exact colors → an editable `captionStyle` object |
| Transcription | Local `faster-whisper` (large-v3-turbo, MIT) worker in `backend/tts/`, word-level timestamps |
| Burned-in subtitles | Rendered by headless Chromium with the same `captions.js` as the preview (exact Arabic shaping, no libass dependency), overlaid by ffmpeg |
| Export | Server-side ffmpeg job, H.264 CRF 18 + AAC, reference resolution by default |

### Constraints found in the sample footage and tooling

- Originals are HEVC 10-bit **HLG / BT.2020** with a `-90°` display matrix (stored 1920×1080, shown as
  portrait), 300–500 MB, up to 2:43. The reference is 1080×1920 SDR BT.709 H.264.
- Browsers can't reliably play HEVC HDR → the editor plays an SDR **proxy**.
- The local ffmpeg has `lut3d`, `tonemap` and `colortemperature`, but **no `libass` and no `zscale`**. The
  HLG→709 conversion is therefore baked into a LUT (see Grade), and subtitles are not rendered by ffmpeg.
- `Media` stores bytes in MongoDB (16 MB document limit) → footage goes to disk.

### Out of scope (v1)

Cutting or trimming, several clips per video, music or voice-over on footage videos, translated
subtitles, grading separate shots differently, color matching across several references, and exports
longer than 10 minutes.

## Architecture

### Storage

- `FOOTAGE_DIR` (default `backend/storage/footage`, git-ignored). One folder per upload:
  `<id>/source.<ext>`, `proxy.mp4`, `words.json`, `stats.json`, `look.cube`, `exports/<jobId>.mp4`.
- Mongo collection `footage` (new `FootageModule`):

```ts
{
  _id, brand, createdBy, role: 'original' | 'reference',
  name, size, mime, status: 'uploading' | 'processing' | 'ready' | 'failed',
  probe: { dur, w, h, rotation, fps, hdr: 'hlg' | 'pq' | null, primaries, transfer, audio: boolean },
  jobs: { [step]: { state: 'queued'|'running'|'done'|'failed', progress: 0..1, error?: string } },
  createdAt
}
```

- Upload: `POST /footage` (metadata) → `{ id, chunkSize }`, then `PUT /footage/:id/chunk?i=n` (raw body,
  8 MB), then `POST /footage/:id/complete`. Uploads can resume: `GET /footage/:id` returns the chunks
  received. Limit 2 GB, video MIME types only.
- Files are served by `GET /footage/:id/proxy.mp4` (Range requests supported) and `/footage/:id/exports/:job.mp4`,
  behind the same auth as the studio. The source is never served.
- Clean-up: deleting the design (or a nightly sweep for footage no design or version references,
  older than 7 days) removes the folder.

### Design data

A footage video is a normal design (autosave, versions, comments, brand scoping) with:

```js
d.footage = {
  src: footageId,               // the original
  ref: footageId | null,        // the reference (null when a brand look was applied)
  lookId: string | null,        // brand look it came from, if any
  look: {
    lut: 'footage/<id>/look.cube',   // HLG→709 + transfer, 33³
    strength: 1,                // 0..1, mixes the transfer part only (HLG→709 always applies)
    exposure: 0, temp: 0, sat: 0,    // -1..1 user tweaks on top of the LUT
  },
  captions: {
    style: CaptionStyle,
    lines: [{ id, start, end, words: [{ t, s, e }] }],   // ms; line start/end = first/last word
    lang: 'ar',
  },
  out: { w: 1080, h: 1920, fps: 30 },
  export: { jobId, url, at, hash } | null,   // last good export; hash of footage+look+captions
}

CaptionStyle = {
  font: 'sans-bold' | 'sans' | 'serif' | 'display',  // mapped to brand/Google fonts with Arabic coverage
  family?: string,             // explicit override
  size: 0.045,                 // fraction of frame height
  weight: 800, case: 'none' | 'upper',
  color: '#FFFFFF',
  stroke: { color, width } | null, shadow: { color, blur, y } | null,
  box: { color, radius, pad } | null,                // background behind the whole line
  highlight: { mode: 'box' | 'color' | 'scale' | 'none', color: '#E8B54A', text: '#1A1A1A', radius: 0.18 },
  y: 0.65,                     // vertical center of the line, fraction of height
  maxWords: 3, maxChars: 22, lines: 1,
  anim: 'none' | 'pop' | 'fade',
}
```

`brand.looks[] = { id, name, lut, captionStyle, refThumb, createdAt }` (brand settings, saved like the
rest of the brand).

### Analysis pipeline

A small in-process job queue (one ffmpeg job at a time per server, a few Python workers) runs these
steps. The editor polls `GET /footage/:id` for progress.

1. **probe** — `ffprobe`: duration, size, rotation, fps, color primaries and transfer, audio.
2. **proxy** — ffmpeg applies the rotation, scales to 720p on the long side, converts HLG→709 with a
   fixed `hlg2709.cube` (generated once by `grade.py`), and encodes H.264 `-g 15` with faststart
   (frequent keyframes make seeking smooth). SDR sources are only scaled.
3. **transcribe** (original only) — `whisper_worker.py` (faster-whisper large-v3-turbo, int8 on CPU,
   Metal/CUDA when available) reads the audio and writes `words.json` with `[{ t, s, e, p }]`. The
   language comes from the brand caption language or auto-detection. Words are grouped into lines in
   JS (`captions.js#group`): up to `maxWords`/`maxChars`, and a new line after a pause of 350 ms or more or
   after punctuation.
4. **grade** (original + reference, or original + brand look) — `grade.py` (numpy only):
   - samples 40 evenly spaced frames from each proxy at 256 px;
   - builds a skin mask (YCbCr range plus the largest component in the center third) so face and
     background statistics are kept separately;
   - in Lab: matches the mean and std of a/b per region (blended 60% face / 40% background) and maps L
     through the CDF of the reference's luminance (smoothed, monotonic);
   - writes a 33³ `.cube`: input = the source's native encoding (HLG BT.2020 for these clips), output =
     graded BT.709, so the export needs one `lut3d` pass;
   - also writes `stats.json` (before/after means, used by the integration test).
5. **caption-style** (reference only) — finds frames with text with a cheap check (high-contrast
   horizontal edges in the band 40–85% of height across 60 sampled frames), keeps 6, and sends the
   crops plus one full frame to Claude (the existing `AiService`, counted in AI usage, Sonnet) with a
   strict JSON schema matching `CaptionStyle`. Colors come from pixel sampling: the text color is the
   median of bright stroke pixels, the highlight is the dominant saturated cluster in the band. If no
   text is found or no AI key is set → the default style, with a note in the UI.

A failed step does not block the editor. The editor shows what failed with a Retry button. Without
`words`, you add lines by hand. Without a grade, the plain HLG→709 conversion is used.

### Editor (footage mode)

New file `frontend/studio/footage.js`, registered by `engine.js` the way `motion.js` and `audio.js` are.
`frontend/studio/captions.js` holds the pure caption logic (grouping, layout, drawing on a 2D canvas)
and is shared with the headless renderer.

- **Create:** a "Match a reference" tile in Create → Videos opens a modal. Drop the original, then drop
  a reference **or** pick a saved brand look. The upload shows progress, and the design opens as soon as
  the proxy is ready while transcription and grading continue (their panels show skeletons).
- **Canvas:** the proxy `<video>` is drawn into a WebGL2 canvas. A fragment shader samples the 3D LUT
  texture (trilinear), mixes it with the plain HLG→709 result by `strength`, then applies exposure,
  temperature and saturation. A 2D canvas on top draws the captions with `captions.js` at the current
  time. **Before/After:** a split line you drag across the frame.
- **Transport:** Space plays and pauses, J/K/L, and the timeline below shows the audio waveform (from the
  proxy) plus one block per caption line. Drag a block's edges to retime it, or drag the block to move it.
- **Left panel "Subtitles":** one row per line with its time range and the text, editable inline.
  Clicking a row seeks there. Row actions: split at the cursor, merge with next, delete, add a line at
  the playhead. When text is edited, words are matched to their old timings by alignment; new words
  share the time evenly. "Re-group lines" applies a new `maxWords`. "Re-transcribe" runs the worker again.
- **Right panel "Look":**
  - Grade: strength, exposure, temperature, saturation, reset.
  - Subtitle style: font, size, weight, text color, stroke, shadow, highlight mode and colors, vertical
    position (also draggable on the canvas), words per line, animation.
  - Look: "Save as brand look", and a list of brand looks to apply.
- **Undo/redo**, autosave and version history come from the editor shell.

### Export

`POST /footage/:designId/export { w, h, fps }`, a job with progress:

1. **Overlay:** headless Chromium (`headless.ts`) opens `/social-media/render?mode=captions`, which loads
   `captions.js` and the design's caption data and draws each frame into a transparent canvas the size
   of the output. Frames are written as PNGs into the job folder, and only frames whose caption changes
   are rendered (a concat list holds each image's duration), so a 60 s clip renders hundreds of frames,
   not 1,800.
2. **Encode:** ffmpeg runs `source → transpose (rotation) → scale/crop to out → lut3d=look.cube (strength
   via a blend with the plain conversion) → eq/colortemperature (tweaks) → overlay=captions → libx264
   -crf 18 -preset medium -pix_fmt yuv420p, AAC 192k, +faststart`. Progress comes from `-progress`.
3. The result goes to `exports/<jobId>.mp4`. `d.footage.export` is set. The editor shows Download and
   Schedule; Schedule hands the MP4 to the existing planner as a video post.

Preview vs export parity: both use the same `.cube` and the same caption drawing code. The tweaks use
the same formulas in the shader and in ffmpeg (the `eq` gamma/saturation mapping is documented in
`footage.js`).

### Security and limits

- Only `admin`/`editor` roles can upload or export. Footage is scoped to the brand.
- ffmpeg and Python run with argument arrays (no shell) on paths built from IDs only.
- At most 2 concurrent exports per server. The job timeout is 4× the clip duration plus 5 min.
- The source file is never sent to Claude. Only up to 7 downscaled reference frames are.

## Testing

- **Unit (Jest, frontend):** `captions.js` (grouping by words, characters and pauses; mapping edited
  text to old word timings; split and merge), and LUT sampling in JS vs a known cube.
- **Unit (pytest, backend/tts):** `grade.py` on synthetic images (a uniform color cast is removed, the
  identity reference gives an identity LUT within 1/255), and that the cube writer round-trips.
- **Integration (backend, opt-in, needs ffmpeg and the sample files):** run the full pipeline on
  `20261103_134552.mp4` + `dom 1 ex-captioned_1.mp4`, export 10 s, then compare 5 exported frames with
  the matching preview frames rendered headless: mean ΔE2000 < 2. Also check that the caption band of
  the exported frame contains the highlight color.
- **Manual:** the three sample files in the browser: upload, wait for analysis, edit a word, retime a
  line, change the style, save as brand look, apply the look to the second clip, export, play the MP4.
