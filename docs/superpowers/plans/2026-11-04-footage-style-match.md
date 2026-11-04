# Footage Style Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Match a reference" video type in Studio. It imports an original and a reference video,
copies the reference's color grade and subtitle style, transcribes editable subtitles, previews them
live and exports an MP4.

**Architecture:** Footage lives on disk with a Mongo record. A NestJS `FootageModule` runs an in-process
job queue (ffmpeg, Python workers, Claude vision). Grading is a 33³ LUT in the proxy's BT.709 space. The
editor previews it in WebGL, and at export it is composed with HLG→709 and the tweaks into one
`export.cube`. Captions are drawn by one pure module (`captions.js`), used both in the editor and in
headless Chromium for the export overlay.

**Tech Stack:** NestJS 10 + Mongoose, Next 15 / the vanilla-JS studio engine, ffmpeg/ffprobe (Homebrew,
no libass, no zscale), Python 3.10+ (numpy, faster-whisper), puppeteer-core (`headless.ts`), vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-11-04-footage-style-match-design.md`

## Global Constraints

- Footage files live under `FOOTAGE_DIR` (default `backend/storage/footage`, git-ignored), one folder per id: `source.<ext>`, `proxy.mp4`, `words.json`, `stats.json`, `look.cube`, `exports/<jobId>.mp4`.
- Upload: 8 MB chunks, limit 2 GB, video MIME types only, resumable.
- The proxy is 720p on the long side, H.264, `-g 15`, `+faststart`, rotation applied, HLG→709 through `hlg2709.cube`.
- LUTs are 33³ `.cube`. `look.cube` is 709 SDR in and 709 SDR out.
- `export.cube` = tweaks ∘ mix(look, identity, strength) ∘ hlg2709 (hlg2709 only for HDR sources).
- Transcription: faster-whisper `large-v3-turbo`, word timestamps. A new line starts after a pause of 350 ms or more, after punctuation, or past `maxWords`/`maxChars`.
- Caption-style detection: 6 text frames from the band 40–85% of height out of 60 sampled frames, plus 1 full frame, sent to Claude (Sonnet) through `AiService`, logged under feature `"Footage captions"`. The source file is never sent; at most 7 downscaled reference frames are.
- Export: H.264 `-crf 18 -preset medium -pix_fmt yuv420p`, AAC 192k, `+faststart`. Default output is the reference's size (1080×1920 when there is none). At most 2 concurrent exports. Timeout = 4 × duration + 5 min.
- ffmpeg and Python are spawned with argument arrays (never a shell), on paths built from ObjectIds only.
- Only `admin`/`editor` roles can upload, export or delete footage. Footage is scoped to the brand.
- Studio UI copy: sentence case, "you", short (match the existing engine.js tone). New engine code goes in a new `frontend/studio/footage.js`, not in engine.js beyond its registration.
- Times in `d.footage.captions` are in milliseconds.

## Review Focus

1. **SDR, landscape or no-rotation original** (e.g. a 16:9 camera file): expect no tone-mapping, the 709 proxy as is, and a center crop to the 9:16 output. Pinned by the `buildProxyArgs`/`buildExportArgs` tests in Tasks 6 and 13.
2. **Original with no audio track:** transcribe is marked `skipped` (not `failed`), the editor opens with an empty subtitle list and "Add a line", and the export has no audio stream. Pinned in Tasks 7 and 13.
3. **Reference with no burned-in subtitles, or no Anthropic key:** caption-style falls back to `DEFAULT_STYLE` with `note`, and grading still runs. Pinned in Task 8.
4. **Upload interrupted** (tab closed at 60%): reopening the Create modal with the same file resumes from the received chunks instead of starting over. Pinned in Tasks 5 and 9.
5. **Arabic lines containing Latin digits or words** (e.g. "نسبة 25% في Q3"): the right-to-left word order is kept, the highlight box sits on the correct word in preview and export, and editing such a line keeps the timings. Pinned in Task 3.

---

### Task 1: Test runners

**Files:**
- Modify: `frontend/package.json` (add `"test": "vitest run"`, devDependency `vitest@^3.0.0`)
- Modify: `backend/package.json` (same)
- Create: `frontend/vitest.config.mjs` (`include: ['studio/**/*.test.js']`, environment `node`)
- Create: `backend/vitest.config.mts` (`include: ['src/**/*.test.ts']`)
- Create: `backend/tts/requirements-footage.txt` (`numpy>=1.26`, `faster-whisper>=1.1`, `pytest>=8`, `pillow>=10`)
- Modify: `backend/tts/setup.sh` (install `requirements-footage.txt` into `.tts/venv`, then pre-download `large-v3-turbo` into `.tts/hf` the way the F5 block does)
- Modify: `backend/.gitignore` (`storage/`)

- [ ] **Step 1:** `npm --prefix frontend i -D vitest@^3 && npm --prefix backend i -D vitest@^3`
- [ ] **Step 2:** Add a throwaway `frontend/studio/smoke.test.js` (`it('runs', () => expect(1).toBe(1))`). Run `npm --prefix frontend test` and expect `1 passed`. Delete it.
- [ ] **Step 3:** Run `bash backend/tts/setup.sh`, then `backend/.tts/venv/bin/python -c "import numpy, faster_whisper"`. Expect exit 0.
- [ ] **Step 4:** Commit: `git commit -m "Footage: vitest and pytest runners, footage Python deps"`

---

### Task 2: `look.js`, the grade math (cube parse, sample, compose, tweaks)

**Files:**
- Create: `frontend/studio/look.js`
- Test: `frontend/studio/look.test.js`

**Interfaces:**
- Produces:
  - `parseCube(text: string): { size: number, data: Float32Array }`. `data` is RGB triplets with red varying fastest, values 0..1.
  - `writeCube(lut, title?: string): string`
  - `identityCube(size = 33)`
  - `sampleCube(lut, [r,g,b]): [r,g,b]` (trilinear)
  - `tweak([r,g,b], { exposure, temp, sat }): [r,g,b]`. Each value is -1..1:
    - exposure multiplies linear light by `2 ** (exposure * 2)` (sRGB decode, then re-encode);
    - temp adds `+temp*0.06` to R and `-temp*0.06` to B in sRGB, clamped;
    - sat mixes with Rec.709 luma by `1 + sat`.
  - `bakeExport({ look, hlg, strength, tweaks }): lut`. For every node: `tweak(mix(sample(look, x), x, strength))` with `x = hlg ? sample(hlg, node) : node`.
  - `GLSL_TWEAK: string`, a GLSL function with exactly the same formulas (used by Task 10).
- Consumed by: Task 10 (preview), Task 13 (server import through a tiny copy: `backend/src/footage/look.ts` re-exports by `import` of the same file. The backend tsconfig already allows JS; if not, add `"allowJs": true`).

- [ ] **Step 1: Write the failing tests**

```js
import { parseCube, writeCube, identityCube, sampleCube, tweak, bakeExport } from './look.js';
it('round-trips a cube', () => { const l = identityCube(5); expect(parseCube(writeCube(l)).data).toEqual(l.data); });
it('identity samples to itself', () => { const l = identityCube(33); expect(sampleCube(l, [0.31, 0.62, 0.9])).toEqual([0.31, 0.62, 0.9].map((v) => expect.closeTo(v, 5))); });
it('zero tweaks are identity', () => { expect(tweak([0.2, 0.5, 0.8], { exposure: 0, temp: 0, sat: 0 })).toEqual([0.2, 0.5, 0.8].map((v) => expect.closeTo(v, 6))); });
it('sat -1 gives gray', () => { const [r, g, b] = tweak([0.9, 0.2, 0.1], { exposure: 0, temp: 0, sat: -1 }); expect(r).toBeCloseTo(g, 5); expect(g).toBeCloseTo(b, 5); });
it('strength 0 bakes to identity', () => { const look = identityCube(9); look.data.fill(0.5); const out = bakeExport({ look, hlg: null, strength: 0, tweaks: { exposure: 0, temp: 0, sat: 0 } }); expect(out.data).toEqual(Array.from(identityCube(9).data).map((v) => expect.closeTo(v, 5))); });
it('parses LUT_3D_SIZE, skips TITLE and comments', () => { expect(parseCube('TITLE "x"\n# c\nLUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(8)).size).toBe(2); });
```

- [ ] **Step 2:** Run `npm --prefix frontend test -- look` and expect FAIL (module not found).
- [ ] **Step 3:** Implement the exports above in `frontend/studio/look.js` (pure ESM, no DOM).
- [ ] **Step 4:** Run `npm --prefix frontend test -- look` and expect 6 passed.
- [ ] **Step 5:** Commit: `git commit -m "Footage: look.js, LUT parse/sample/bake and grade tweaks"`

---

### Task 3: `captions.js`, grouping, editing and drawing

**Files:**
- Create: `frontend/studio/captions.js`
- Test: `frontend/studio/captions.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_STYLE: CaptionStyle`, the spec's `CaptionStyle` shape with these defaults: `font 'sans-bold'`, `size 0.045`, `weight 800`, `case 'none'`, `color '#FFFFFF'`, `stroke null`, `shadow { color: 'rgba(0,0,0,.55)', blur: 0.006, y: 0.002 }`, `box null`, `highlight { mode: 'box', color: '#E8B54A', text: '#1A1A1A', radius: 0.18 }`, `y 0.65`, `maxWords 3`, `maxChars 22`, `lines 1`, `anim 'none'`.
  - `group(words: {t,s,e}[], style): Line[]` with `Line = { id, start, end, words }`.
  - `retext(line: Line, text: string): Line`. Aligns the new tokens to the old ones by token-level LCS: kept tokens keep `s`/`e`, and runs of new tokens split evenly the gap between their kept neighbors.
  - `split(line, atMs): [Line, Line]`, splitting at the first word with `s >= atMs`.
  - `merge(a, b): Line`
  - `lineAt(lines, ms): Line | null`
  - `activeWord(line, ms): number` (index, or -1)
  - `layout(ctx2d, line, style, w, h): { x, y, w, h, words: {i, x, y, w, h}[] }`. RTL is decided by the first strong character. Words are measured one by one and laid out in visual order; the gap is a measured space.
  - `draw(ctx2d, lines, style, ms, w, h): void`
  - `FONT_STACKS: Record<CaptionStyle['font'], string>`, each with an Arabic-capable family first (`'sans-bold'` → `"Cairo", "Noto Sans Arabic", "Inter", sans-serif`; Cairo and Noto Sans Arabic are loaded from Google Fonts in `footage.js` and on the render page).

- [ ] **Step 1: Write the failing tests** (`layout` tests use a fake ctx whose `measureText(s)` returns `{ width: s.length * 10 }`)

```js
const W = (t, s, e) => ({ t, s, e });
it('groups by maxWords', () => { expect(group([W('a',0,100),W('b',100,200),W('c',200,300),W('d',300,400)], { ...DEFAULT_STYLE, maxWords: 3 }).map((l) => l.words.length)).toEqual([3, 1]); });
it('breaks on a 350 ms pause', () => { expect(group([W('a',0,100),W('b',450,500)], DEFAULT_STYLE)).toHaveLength(2); });
it('breaks after punctuation', () => { expect(group([W('a.',0,100),W('b',100,200)], DEFAULT_STYLE)).toHaveLength(2); });
it('retext keeps timings of unchanged words', () => { const l = retext({ id:'x', start:0, end:300, words:[W('one',0,100),W('two',100,200),W('three',200,300)] }, 'one 2 three'); expect(l.words.map((w) => [w.t, w.s, w.e])).toEqual([['one',0,100],['2',100,200],['three',200,300]]); });
it('retext to empty yields a line with no words that lineAt skips', () => { const l = retext({ id:'x', start:0, end:100, words:[W('a',0,100)] }, '  '); expect(lineAt([l], 50)).toBeNull(); });
it('split and merge round-trip', () => { const l = group([W('a',0,100),W('b',100,200)], { ...DEFAULT_STYLE, maxWords: 9 })[0]; const [x, y] = split(l, 100); expect(merge(x, y).words).toEqual(l.words); });
it('activeWord follows time', () => { const l = { words: [W('a',0,100),W('b',100,200)] }; expect([activeWord(l, 50), activeWord(l, 150), activeWord(l, 250)]).toEqual([0, 1, -1]); });
it('Arabic line with digits lays out right to left', () => { const L = layout(fakeCtx, { words: [W('نسبة',0,1),W('25%',1,2),W('في',2,3),W('Q3',3,4)] }, DEFAULT_STYLE, 1080, 1920); expect(L.words.map((w) => w.i)).toEqual([3, 2, 1, 0].reverse().sort((a, b) => L.words[a].x - L.words[b].x) && L.words.slice().sort((a, b) => b.x - a.x).map((w) => w.i)).toEqual([0, 1, 2, 3]); });
```

  The last test asserts that word 0 is the right-most and word 3 the left-most. Rewrite the expectation plainly when implementing: `sorted by x descending → indices [0,1,2,3]`.

- [ ] **Step 2:** Run `npm --prefix frontend test -- captions` and expect FAIL.
- [ ] **Step 3:** Implement `frontend/studio/captions.js` (pure, the only DOM use is the passed `ctx2d`). In `draw`, the highlight box is drawn behind the active word only when `highlight.mode === 'box'`, with radius `radius × word height`; `'color'` paints the word in `highlight.color`; `'scale'` draws it at 1.12×. Line ids come from `uid()`-style random strings, not from timings.
- [ ] **Step 4:** Run `npm --prefix frontend test -- captions` and expect 8 passed.
- [ ] **Step 5:** Commit: `git commit -m "Footage: captions.js, line grouping, text edits with kept timings, RTL layout and drawing"`

---

### Task 4: `grade.py`, color transfer to a LUT, plus `hlg2709.cube`

**Files:**
- Create: `backend/tts/footage/grade.py`
- Create: `backend/tts/footage/cube.py` (`read_cube(path) -> (size, ndarray[N,N,N,3])`, `write_cube(path, lut, title)`; same layout as `look.js`, red fastest)
- Test: `backend/tts/footage/test_grade.py`

**Interfaces:**
- CLI (called by Task 7 with argument arrays). Each command prints one JSON line on stdout:
  - `python grade.py hlg2709 OUT.cube` writes a 33³ HLG/BT.2020 → BT.709 SDR LUT: HLG inverse OETF, OOTF with a 1000 nit peak, BT.2020→709 matrix, BT.2390 EETF roll-off to 100 nits, then the sRGB/709 OETF. Prints `{"ok":true}`.
  - `python grade.py transfer --src SRC_FRAMES_DIR --ref REF_FRAMES_DIR --out look.cube --stats stats.json` prints `{"ok":true,"stats":{...}}`. Frames are PNGs at 256 px, already 709 (taken from the proxies).
  - `python grade.py textframes --frames DIR --keep 6` prints `{"ok":true,"frames":[names], "band":[y0,y1], "colors":{"text":"#RRGGBB","highlight":"#RRGGBB"|null}}`. It scores the band 0.40–0.85 of height by the density of strong horizontal edges, keeps the top 6, and samples:
    - text = the median of pixels with L > 85 inside edge-dense rows;
    - highlight = the k-means (k=3) centroid with the highest chroma among pixels with C > 30 in those rows, or `null` if that cluster covers less than 1.5% of the band.
- Transfer algorithm:
  1. Convert to Lab (D65).
  2. Skin mask: Cb 77–127 and Cr 133–173, keeping the largest connected component whose centroid lies in the middle third. Use a simple flood fill on the 256 px mask; no scipy.
  3. a,b: per-region mean/std match, blended 0.6 skin / 0.4 rest; if skin covers < 2% of the frame in either clip, use global stats only.
  4. L: monotonic curve from matching the 256-bin CDFs, smoothed with a 9-bin box filter and forced non-decreasing.
  5. Bake: for each of the 33³ nodes apply 3 + 4 and write `look.cube`.
  - The stats include the per-region source, reference and result means, used by Task 14.

- [ ] **Step 1: Write the failing tests**

```python
def test_identity_when_ref_equals_src(tmp_path):  # same frames → LUT within 1/255 of identity
def test_removes_uniform_cast(tmp_path):          # src = ref + (+20 b*) → result b* mean within 1.5 of ref
def test_l_curve_is_monotonic(tmp_path):
def test_cube_roundtrip(tmp_path):
def test_hlg2709_maps_hlg_white_75pct_to_near_sdr_white():  # HLG 0.75 signal gray → 709 code value 0.70–0.80
def test_textframes_finds_white_text_and_gold_box(tmp_path): # synthetic frames: white text + #E8B54A box at 65% height
def test_textframes_none_when_no_text(tmp_path):              # flat frames → frames == [] and colors.text is None
```

  Each test builds synthetic PNGs with numpy and Pillow in `tmp_path`.

- [ ] **Step 2:** Run `backend/.tts/venv/bin/python -m pytest -q backend/tts/footage` and expect 7 failures.
- [ ] **Step 3:** Implement `cube.py`, then `grade.py` (numpy and Pillow only).
- [ ] **Step 4:** Run the same command and expect `7 passed`.
- [ ] **Step 5:** Commit: `git commit -m "Footage: grade.py, LUT color transfer, HLG to 709 cube, caption text frame finder"`

---

### Task 5: Footage storage, upload and serving (backend)

**Files:**
- Create: `backend/src/footage/footage.schema.ts` (the spec's `footage` record; `jobs` is a `Mixed` map)
- Create: `backend/src/footage/footage.store.ts` (paths and chunk I/O)
- Create: `backend/src/footage/footage.controller.ts`
- Create: `backend/src/footage/footage.module.ts`
- Modify: `backend/src/app.module.ts` (import `FootageModule`)
- Test: `backend/src/footage/footage.store.test.ts`

**Interfaces:**
- `FootageStore`:
  - `dir(id: string): string`, which throws unless `id` is a 24-hex ObjectId
  - `writeChunk(id, i: number, body: Buffer): Promise<void>`, writing `chunks/<i>`
  - `received(id): Promise<number[]>`
  - `assemble(id, ext: string): Promise<string>`, which concatenates into `source.<ext>`, deletes the chunks and returns the path
  - `remove(id)`
  - `file(id, name: 'proxy.mp4' | 'look.cube' | 'words.json' | 'stats.json' | `exports/${string}.mp4`): string`
- HTTP (all `@Roles("admin","editor")` except the file GETs, which use the studio auth guard and a brand check):
  - `POST /footage { name, size, mime, role, brand }` → `{ id, chunkSize: 8388608, received: [] }`. It rejects a size > 2 GB or a non-`video/*` MIME with 400. If a record with the same `brand`, `name`, `size` and `createdBy` in status `uploading` exists, it returns that one with its `received` (the resume case).
  - `PUT /footage/:id/chunk?i=n` takes a raw `application/octet-stream` body ≤ 8 MB (register `express.raw` for this route only in `main.ts`).
  - `POST /footage/:id/complete` assembles the file, sets `status: 'processing'` and enqueues the `probe` step (Task 6).
  - `GET /footage/:id` returns the record, including `jobs` and `received`.
  - `GET /footage/:id/proxy.mp4` and `GET /footage/:id/exports/:job.mp4` stream with `Range` support (`fs.createReadStream` with start/end, 206).
  - `DELETE /footage/:id` → 409 when a design or version still references the id (reuse the `inUse()` scan style from `media.controller.ts`).

- [ ] **Step 1: Write the failing tests** (store only; use a tmp `FOOTAGE_DIR`)

```ts
it("rejects ids that are not ObjectIds", () => expect(() => store.dir("../etc")).toThrow());
it("assembles chunks in index order", async () => { await store.writeChunk(id, 1, Buffer.from("b")); await store.writeChunk(id, 0, Buffer.from("a")); expect(await fs.readFile(await store.assemble(id, "mp4"), "utf8")).toBe("ab"); });
it("lists received chunks for resume", async () => { await store.writeChunk(id, 0, Buffer.from("a")); await store.writeChunk(id, 2, Buffer.from("c")); expect(await store.received(id)).toEqual([0, 2]); });
```

- [ ] **Step 2:** Run `npm --prefix backend test -- footage.store` and expect FAIL.
- [ ] **Step 3:** Implement the store, schema, controller and module.
- [ ] **Step 4:** Run `npm --prefix backend test -- footage.store` and expect 3 passed. Then start the API and check by hand:

```bash
curl -s -X POST localhost:4000/footage -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"name":"a.mp4","size":10,"mime":"video/mp4","role":"original","brand":"b1"}'
```

  Expected: `{"id":"…","chunkSize":8388608,"received":[]}`.

- [ ] **Step 5:** Commit: `git commit -m "Footage: disk storage, resumable chunked upload, ranged playback"`

---

### Task 6: Job queue, probe and proxy

**Files:**
- Create: `backend/src/footage/jobs.service.ts`
- Create: `backend/src/footage/ffmpeg.ts` (pure argument builders and parsers)
- Test: `backend/src/footage/ffmpeg.test.ts`

**Interfaces:**
- `ffmpeg.ts`:
  - `parseProbe(json: any): Probe` with `Probe = { dur, w, h, rotation, fps, hdr: 'hlg'|'pq'|null, audio: boolean }`:
    - `w`/`h` are the *display* size after rotation;
    - `rotation` comes from the `side_data_list` display matrix (`-90` → `90`, the clockwise turn to apply);
    - `hdr` comes from `color_transfer` (`arib-std-b67` → `'hlg'`, `smpte2084` → `'pq'`).
  - `buildProxyArgs(src, out, probe, hlgCube): string[]`. It applies the rotation through `transpose` (90 → `transpose=1`, 270 → `transpose=2`, 180 → `hflip,vflip`), prefixed with `-noautorotate`. For HDR it uses `format=gbrpf32le` (or `rgb48le`), then `lut3d=file=hlgCube:interp=tetrahedral`, then `format=yuv420p`. It scales the long side to 720, and encodes with `-c:v libx264 -crf 23 -g 15 -movflags +faststart`, plus `-c:a aac -b:a 128k` when there is audio.
  - `parseProgress(line: string, durMs): number | null`, parsing `out_time_us=` lines into 0..1.
- `JobsService`:
  - `enqueue(footageId, step: Step)` with `Step = 'probe'|'proxy'|'frames'|'transcribe'|'grade'|'caption-style'`.
  - Steps run in order per footage. One ffmpeg process at a time overall. A Python step can run while ffmpeg runs.
  - It writes `jobs[step] = { state, progress, error? }` and `status` to the record (`ready` when every step is done or skipped, `failed` only when `probe` or `proxy` fail).
  - On boot it generates `hlg2709.cube` into `FOOTAGE_DIR` once, by calling `grade.py hlg2709` through `spawn(python, [...])`.
- The chain: `probe → proxy → frames`. For the original: `→ transcribe → grade` (grade waits for the paired reference's `frames`, or uses a brand look's `look.cube`). For the reference: `frames → caption-style`.
- `frames`: ffmpeg from `proxy.mp4` → `frames/%03d.png`, 60 frames at 256 px wide (`fps=60/dur`).

- [ ] **Step 1: Write the failing tests** (fixtures: save the real ffprobe JSON of the 3 sample files to `backend/src/footage/__fixtures__/probe-*.json` with `ffprobe -v error -print_format json -show_streams -show_format`)

```ts
it("phone HLG clip: portrait display size, rotation 90, hlg", () => expect(parseProbe(hlg)).toMatchObject({ w: 1080, h: 1920, rotation: 90, hdr: "hlg", audio: true }));
it("reference: SDR, no rotation", () => expect(parseProbe(ref)).toMatchObject({ w: 1080, h: 1920, rotation: 0, hdr: null }));
it("proxy args for HLG include transpose=1 and the cube", () => { const a = buildProxyArgs("s", "o", parseProbe(hlg), "c.cube").join(" "); expect(a).toMatch(/-noautorotate/); expect(a).toMatch(/transpose=1/); expect(a).toMatch(/lut3d=file=c.cube/); });
it("proxy args for an SDR landscape file have no lut3d and no transpose", () => { const a = buildProxyArgs("s", "o", { dur: 1, w: 1920, h: 1080, rotation: 0, fps: 30, hdr: null, audio: true }, "c").join(" "); expect(a).not.toMatch(/lut3d|transpose/); expect(a).toMatch(/scale=720:-2|scale=-2:720|scale='min/); });
it("no audio → no audio codec args", () => expect(buildProxyArgs("s", "o", { ...parseProbe(ref), audio: false }, "c")).not.toContain("aac"));
it("parses progress", () => expect(parseProgress("out_time_us=5000000", 10000)).toBeCloseTo(0.5));
```

- [ ] **Step 2:** Run `npm --prefix backend test -- ffmpeg` and expect FAIL.
- [ ] **Step 3:** Implement `ffmpeg.ts` and `JobsService` (spawn `ffmpeg` with `-progress pipe:1 -nostats`).
- [ ] **Step 4:** Run `npm --prefix backend test -- ffmpeg` and expect 6 passed. Upload `20261103_134552.mp4` through the API and expect `jobs.proxy.state === 'done'`. Then run `ffprobe proxy.mp4`, expecting 406×720 or 404×720 (portrait), `yuv420p`, `bt709`. Open the proxy and check that it looks like a normal phone video, not washed out.
- [ ] **Step 5:** Commit: `git commit -m "Footage: job queue, probe, SDR proxy with rotation and HLG tone mapping"`

---

### Task 7: Transcribe and grade steps

**Files:**
- Create: `backend/tts/footage/whisper_worker.py` (a long-lived worker with the same line protocol as `voice_worker.py`: prints `{"ready":true}`, then for each `{"id","audio","lang"?}` writes `{"id","ok":true,"words":[{"t","s","e","p"}],"lang"}` with times in ms)
- Modify: `backend/src/ai/local-tts.service.ts` (`export class PyWorker`, unchanged otherwise)
- Modify: `backend/src/footage/jobs.service.ts` (the `transcribe` and `grade` steps)
- Test: `backend/src/footage/jobs.service.test.ts`

**Interfaces:**
- Consumes: `PyWorker` (Task 7 export). Its `call(req)` currently returns a WAV. Add `ask(req): Promise<any>`, which resolves the raw message, and keep `call` for TTS.
- `transcribe`:
  - When `probe.audio` is false, set `jobs.transcribe = { state: 'skipped' }`.
  - Otherwise extract 16 kHz mono WAV (`-vn -ac 1 -ar 16000`), call the worker with `lang` = the brand's caption language code (`Arabic` → `ar`, otherwise auto-detect), and write `words.json`.
  - Worker settings: `model large-v3-turbo, compute_type int8, word_timestamps=True, vad_filter=True`, model dir `HF_HOME=backend/.tts/hf`, boot 180 s, call timeout = 2 × duration + 60 s.
- `grade`: run `python grade.py transfer --src <orig>/frames --ref <ref>/frames --out <orig>/look.cube --stats <orig>/stats.json`. With a brand look and no reference, copy the look's cube instead (Task 12 stores looks as files under `FOOTAGE_DIR/looks/<id>.cube`).

- [ ] **Step 1: Write the failing tests** (mock `PyWorker.ask` and `spawn`)

```ts
it("skips transcribe when there is no audio", async () => { await jobs.run(idNoAudio, "transcribe"); expect((await rec(idNoAudio)).jobs.transcribe.state).toBe("skipped"); });
it("passes ar for an Arabic brand", async () => { await jobs.run(idAr, "transcribe"); expect(ask).toHaveBeenCalledWith(expect.objectContaining({ lang: "ar" })); });
it("grade waits for the reference frames", async () => { /* reference frames not done → grade stays queued; after frames done → spawn called with --ref */ });
it("a failed transcribe does not fail the footage", async () => { ask.mockRejectedValue(new Error("x")); await jobs.run(id, "transcribe"); expect((await rec(id)).status).not.toBe("failed"); });
```

- [ ] **Step 2:** Run `npm --prefix backend test -- jobs` and expect FAIL.
- [ ] **Step 3:** Implement the worker and both steps.
- [ ] **Step 4:** Run `npm --prefix backend test -- jobs` and expect 4 passed. Upload both sample files as a pair and expect `words.json` to hold Arabic words with increasing times. In `stats.json`, the result means should be closer to the reference than the source in L and in b on the skin region.
- [ ] **Step 5:** Commit: `git commit -m "Footage: local Whisper transcription and reference grade transfer"`

---

### Task 8: Caption-style detection

**Files:**
- Modify: `backend/src/ai/ai.service.ts` (`captionStyle(images: Img[], sampled: { text: string|null, highlight: string|null }, actor): Promise<{ style: Partial<CaptionStyle>, model: string }>`)
- Modify: `backend/src/footage/jobs.service.ts` (the `caption-style` step)
- Create: `backend/src/footage/caption-style.ts` (`mergeStyle(ai: unknown, sampled, defaults): { style: CaptionStyle, note?: string }`, which validates and clamps every field)
- Test: `backend/src/footage/caption-style.test.ts`

**Interfaces:**
- Consumes: `grade.py textframes` (Task 4), `AiService.complete` with `images` and `json: true`, `feature: "Footage captions"`. Use the Anthropic provider with the settings model, or `claude-sonnet-5-5` when the settings model is not a vision model.
- The prompt asks for JSON with exactly the `CaptionStyle` keys (except colors). It describes what to look for: the font class, weight, words shown per line, vertical center as a fraction, whether one word is emphasized and how (box, color or scale), the box radius relative to the text height, stroke, shadow, a background box behind the whole line, and the case. Pixel-sampled colors always override the AI's colors.
- `DEFAULT_STYLE` in the backend is imported from `frontend/studio/captions.js` the same way as `look.js` in Task 2.
- Result: written to the reference record as `captionStyle` and returned by `GET /footage/:id`.

- [ ] **Step 1: Write the failing tests**

```ts
it("pixel colors override AI colors", () => expect(mergeStyle({ color: "#000000" }, { text: "#FFFFFF", highlight: "#E8B54A" }, DEFAULT_STYLE).style).toMatchObject({ color: "#FFFFFF", highlight: { color: "#E8B54A" } }));
it("clamps out-of-range numbers", () => expect(mergeStyle({ y: 4, maxWords: 0, size: 2 }, {}, DEFAULT_STYLE).style).toMatchObject({ y: 0.95, maxWords: 1, size: 0.12 }));
it("garbage from the AI falls back to defaults", () => expect(mergeStyle("not json", {}, DEFAULT_STYLE).style).toEqual(DEFAULT_STYLE));
it("no text found → defaults with a note", async () => { /* textframes returns frames: [] → style DEFAULT_STYLE, note 'No subtitles found in the reference. Using the default style.' and AI not called */ });
it("no Anthropic key → defaults with a note, grade unaffected", async () => { /* complete throws → note 'Add an Anthropic key in Settings, AI to copy the subtitle style.' */ });
```

  Clamp ranges: `y 0.05–0.95`, `size 0.02–0.12`, `maxWords 1–8`, `maxChars 8–40`, `lines 1–2`, `weight 300–900`, `highlight.radius 0–0.5`.

- [ ] **Step 2:** Run `npm --prefix backend test -- caption-style` and expect FAIL.
- [ ] **Step 3:** Implement `mergeStyle`, `AiService.captionStyle` and the step.
- [ ] **Step 4:** Run `npm --prefix backend test -- caption-style` and expect 5 passed. Run the step on `dom 1 ex-captioned_1.mp4` and expect `highlight.mode 'box'`, a highlight color within ΔE 6 of gold `#E8B54A`, a white `color`, `y` between 0.6 and 0.7, and `maxWords` between 2 and 4.
- [ ] **Step 5:** Commit: `git commit -m "Footage: subtitle style read from the reference by Claude and pixel sampling"`

---

### Task 9: Create tile, upload modal and design creation (frontend)

**Files:**
- Create: `frontend/studio/footage.js` (the IIFE block, registered like the v37/v38 blocks: `import * as FT from './footage'` in engine.js is **not** used; follow the engine's pattern of version blocks that wrap editor functions, placed in `footage.js` and imported once at the end of engine.js via `import './footage'` with access to the shared helpers it needs through an `installFootage(ctx)` call that receives `{ ED, S, api, modal, toast, ic, IC, esc, mutate, save, touch, uid, brand, openEditor }`)
- Create: `frontend/studio/upload.js` (`uploadFootage(file, { role, brand, api, onProgress }): Promise<{ id }>`)
- Modify: `frontend/studio/engine.js` (after the v38 block: `installFootage({...})`; in the Create block's Videos row, an extra tile `data-act="ftNew"` labelled **Match a reference**, subtitle **Copy a video's look and subtitles**)
- Modify: `frontend/styles/studio.css` (an `ft-` prefix for every new class)
- Test: `frontend/studio/upload.test.js`

**Interfaces:**
- Produces:
  - `d.footage` with the exact shape from the spec. A new design gets `ratio` = `${out.w}x${out.h}`, `pages: [one blank page]`, name `"<original file name> · matched"`.
  - `FT.open(d)` opens the footage editor (Task 10).
- `uploadFootage`: POST, then PUT only the chunks not in `received` (3 in parallel), then `complete`. Progress = bytes sent / size.
- Modal copy:
  - Title "Match a reference".
  - Drop zone 1 "Your video": "Drop the raw clip (MP4 or MOV, up to 2 GB)".
  - Drop zone 2 "Reference": "Drop an edited video to copy its look and subtitles", **or** a "Use a brand look" list when `brand().looks` is non-empty.
  - Button "Start". After both uploads complete, create the design and open it. The editor shows the analysis progress (Task 10).

- [ ] **Step 1: Write the failing tests** (mock `api`)

```js
it('uploads only missing chunks on resume', async () => { api.mockResolvedValueOnce({ id: 'x', chunkSize: 4, received: [0, 2] }); await uploadFootage(fileOf(16), { role: 'original', brand: 'b', api }); expect(putIndexes()).toEqual([1, 3]); });
it('reports progress up to 1', async () => { const p = []; await uploadFootage(fileOf(8), { role: 'original', brand: 'b', api, onProgress: (v) => p.push(v) }); expect(p.at(-1)).toBe(1); });
it('refuses non-video files before uploading', async () => { await expect(uploadFootage(new File(['x'], 'a.txt', { type: 'text/plain' }), { role: 'original', brand: 'b', api })).rejects.toThrow('Choose a video file'); });
```

- [ ] **Step 2:** Run `npm --prefix frontend test -- upload` and expect FAIL.
- [ ] **Step 3:** Implement `upload.js`, the tile, the modal and design creation. Make sure `api()` can send a raw `Blob` body (add a `raw: true` option to the studio's api helper if it only sends JSON).
- [ ] **Step 4:** Run `npm --prefix frontend test -- upload` and expect 3 passed. Then run `npm run dev` and open Studio → Create. Expect the tile; dropping both sample files uploads with a progress bar. Close the tab at about 50%, reopen, drop the same file, and expect the progress to resume from about 50%.
- [ ] **Step 5:** Commit: `git commit -m "Footage: Match a reference tile, resumable upload, footage design"`

---

### Task 10: Footage editor canvas: WebGL LUT preview, caption overlay, transport, before/after

**Files:**
- Create: `frontend/studio/footage-player.js` (`createPlayer(host, { proxyUrl, look, captions, onTime }): Player`)
- Modify: `frontend/studio/footage.js` (wrap the editor's canvas, panel and timeline rendering when `d.footage` is set, as v37 does for `d.motion`; show analysis progress by polling `GET /footage/:id` every 2 s until `status` is `ready`/`failed`, then load `words.json` → `group()` → `d.footage.captions.lines` if they are still empty, the reference's `captionStyle` → `captions.style`, and `look.cube` → `look.lut`)
- Test: none automated (WebGL). The shader's tweak math is covered by `GLSL_TWEAK` mirroring `tweak()` in Task 2; verify visually in Step 3.

**Interfaces:**
- `Player`: `play()`, `pause()`, `seek(ms)`, `time(): ms`, `setLook(look)` (re-uploads the cube texture only when `lut` changes), `setCaptions(captions)`, `setSplit(x: 0..1 | null)`, `destroy()`.
- Rendering: `<video muted=false playsinline>` → WebGL2 `TEXTURE_3D` 33³ `RGB16F`, sampled with LINEAR filtering at `(c * (N-1) + 0.5) / N`, then `mix(orig, graded, strength)`, then `GLSL_TWEAK`. With the split set, pixels left of the split skip the LUT and the tweaks. A 2D canvas on top calls `captions.draw` at the output aspect ratio. The frame loop uses `requestVideoFrameCallback` when available, else rAF.
- Keys: Space play/pause; J/L back/forward 5 s; K pause; ←/→ one frame (1000/fps).

- [ ] **Step 1:** Implement `footage-player.js`.
- [ ] **Step 2:** Wire it into the editor in `footage.js`: a center stage with the player at the output aspect ratio, a Before/After toggle button (a draggable split handle), the play button and the time readout. Skeletons show in both side panels while `jobs.transcribe`/`jobs.grade` run, and a failed step shows its error with **Retry** (`POST /footage/:id/retry { step }`; add this endpoint to the controller from Task 5).
- [ ] **Step 3:** Verify in the browser preview with the sample pair:
  - the proxy plays with audio;
  - the graded image is visibly warmer and more contrasty, and Before/After shows the difference;
  - subtitles appear in Arabic with the gold box on the spoken word;
  - scrubbing keeps captions in sync within one frame;
  - no console errors.
  Take a screenshot as proof.
- [ ] **Step 4:** Commit: `git commit -m "Footage: live preview with WebGL grade, caption overlay and before/after"`

---

### Task 11: Subtitles panel and caption timeline lane

**Files:**
- Modify: `frontend/studio/footage.js`
- Modify: `frontend/styles/studio.css`
- Test: `frontend/studio/captions.test.js` (add `retime`, below)

**Interfaces:**
- Consumes: `group`, `retext`, `split`, `merge`, `lineAt` (Task 3), and the `Player` (Task 10).
- Adds to `captions.js`: `retime(line, start, end): Line`, which scales word times linearly into the new range, and `addLine(lines, atMs, text = '')`, which inserts a 1500 ms line or one shorter that fits before the next line.
- Every change goes through the editor's `mutate()`, so undo/redo, autosave and versions work.
- Left panel, "Subtitles":
  - one row per line: `0:12.4 – 0:14.1` and an inline-editable text field (`dir="auto"`);
  - clicking the time seeks; the active row is highlighted while playing;
  - row actions in a ⋯ menu: Split at playhead, Merge with next, Delete;
  - footer: "Add a line at the playhead", "Words per line" (a number input 1–8 that re-groups all lines from the original word list, with confirmation "This replaces your line breaks"), and "Re-transcribe" (confirmation "This replaces your edited subtitles").
- Timeline lane: a waveform (decode the proxy's audio once with `AudioContext.decodeAudioData`, 1 peak per pixel) and one block per line. Dragging an edge changes start or end (the minimum line length is 200 ms, and lines can't overlap the next one); dragging the block moves it.

- [ ] **Step 1: Write the failing tests**

```js
it('retime scales words into the new range', () => { expect(retime({ id:'x', start:0, end:200, words:[W('a',0,100),W('b',100,200)] }, 1000, 1400).words.map((w) => [w.s, w.e])).toEqual([[1000,1200],[1200,1400]]); });
it('addLine fits before the next line', () => { const ls = addLine([{ id:'n', start:1000, end:2000, words:[W('z',1000,2000)] }], 500); expect(ls[0]).toMatchObject({ start: 500, end: 1000 }); });
```

- [ ] **Step 2:** Run `npm --prefix frontend test -- captions` and expect 2 failures.
- [ ] **Step 3:** Implement `retime` and `addLine`, the panel and the lane.
- [ ] **Step 4:** Run `npm --prefix frontend test -- captions` and expect 10 passed. In the browser:
  - edit a word and expect the preview to show it at the same moment;
  - split, merge and undo;
  - drag a block edge and see the caption change timing;
  - type an Arabic line with "25%" and check the box lands on the spoken token.
- [ ] **Step 5:** Commit: `git commit -m "Footage: editable subtitle list and caption timeline lane"`

---

### Task 12: Look panel and brand looks

**Files:**
- Modify: `frontend/studio/footage.js`
- Modify: `backend/src/footage/footage.controller.ts` (`POST /footage/looks { footageId, name }` copies `look.cube` → `FOOTAGE_DIR/looks/<lookId>.cube` and returns `{ id, lut }`; `DELETE /footage/looks/:id`)

**Interfaces:**
- Look data: `brand().looks: { id, name, lut, captionStyle, refThumb, createdAt }[]`, persisted with `save()` like the other brand fields. `refThumb` is a 160 px JPEG data URL of the reference's frame 30.
- Right panel, "Look":
  - Grade section: Strength 0–100%, Exposure, Temperature and Saturation (each −100…100, shown as integers), and Reset.
  - Subtitle style section: Font (4 options), Size, Weight, Text color, Stroke (on/off, color, width), Shadow (on/off), Highlight (Box, Color, Scale, None, plus color(s)), Position (a slider; dragging the caption on the canvas also sets `y`), Words per line, Animation (None, Pop, Fade).
  - Brand looks section: "Save as brand look" (a name prompt, default "<reference file name>") and a list of the brand's looks with thumbnail, Apply and Delete.
  - Applying a look sets `look.lut` to the look's cube and `captions.style` to its style, then re-groups the lines when `maxWords` changed.
- Every control updates the player live (`setLook`/`setCaptions`) and commits through `mutate()` on release.

- [ ] **Step 1:** Implement the backend look endpoints. Check them with curl: the POST returns `{ id, lut: "looks/<id>.cube" }`, and the file exists.
- [ ] **Step 2:** Implement the panel.
- [ ] **Step 3:** In the browser:
  - Strength 0 looks the same as Before;
  - changing the highlight color updates the next frame;
  - save a look, then open a new "Match a reference" with `20261104_115014.mp4` and "Use a brand look";
  - expect the same subtitle style, and a grade applied without uploading a reference (the grade step copies the look's cube).
- [ ] **Step 4:** Commit: `git commit -m "Footage: grade and subtitle style controls, brand looks"`

---

### Task 13: Export: caption overlay in headless Chromium and the ffmpeg encode

**Files:**
- Create: `backend/src/footage/export.service.ts`
- Modify: `backend/src/footage/ffmpeg.ts` (`buildExportArgs`)
- Modify: `frontend/app/(social)/social-media/render/page.tsx` (when `?mode=captions`, expose `window.bogaCaptions(captions, style, w, h, times: number[]) => Promise<string[]>`, which returns a PNG data URL per time, drawn with `captions.draw` on a transparent canvas after `document.fonts.load` for the style's font)
- Modify: `backend/src/footage/footage.controller.ts` (`POST /footage/export { designId, w, h, fps }` → `{ jobId }`; `GET /footage/export/:jobId` → `{ state, progress, url?, error? }`)
- Modify: `frontend/studio/footage.js` (an Export button and modal with size choices "1080 × 1920 (reference)", "720 × 1280", "2160 × 3840", progress, then Download and Schedule)
- Test: `backend/src/footage/ffmpeg.test.ts`, `backend/src/footage/export.service.test.ts`

**Interfaces:**
- Consumes: `bakeExport`, `parseCube`, `writeCube` (Task 2), `lineAt` (Task 3), `launchChromium()` (`backend/src/social/publishing/headless.ts`), `parseProbe` and `parseProgress` (Task 6).
- `changeTimes(lines, style, durMs): number[]`: every ms at which the drawn overlay changes (line start/end, word start/end, plus 4 frames after each word start when `anim !== 'none'`), deduplicated and sorted, starting at 0. It goes in `captions.js` and is tested there.
- The overlay goes to `job/overlay/%05d.png` plus a `concat.txt` with `file`/`duration` pairs. Captions-free stretches use one transparent PNG.
- `buildExportArgs({ src, probe, cube, concat, out, w, h, fps }): string[]`:
  - `-noautorotate -i src -f concat -safe 0 -i concat`;
  - filter: `[0:v] transpose… , scale=w:h:force_original_aspect_ratio=increase, crop=w:h, format=rgb48le, lut3d=file=cube:interp=tetrahedral, format=yuv420p [v]; [1:v] fps=fps, format=rgba [o]; [v][o] overlay=0:0:format=auto, format=yuv420p`;
  - `-r fps -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709`;
  - `-c:a aac -b:a 192k` when there is audio, `-an` otherwise; `-movflags +faststart -progress pipe:1 -nostats`.
- `ExportService.start(designId, opts)`:
  - Bake `export.cube` with `bakeExport({ look, hlg: probe.hdr ? hlg2709 : null, strength, tweaks })`.
  - Render the overlay through Chromium in batches of 50 times.
  - Run ffmpeg; progress = 0.3 × overlay + 0.7 × encode.
  - Save to `exports/<jobId>.mp4` and set `d.footage.export = { jobId, url, at, hash }`.
  - The hash is SHA-1 of `JSON.stringify({ src, look, captions, out })`. When an export with the same hash exists, return it immediately.
  - Enforce the concurrency (2) and the timeout.

- [ ] **Step 1: Write the failing tests**

```ts
it("export args: HLG portrait → transpose, crop to 1080x1920, lut, overlay, faststart", () => { const a = buildExportArgs({ src: "s", probe: parseProbe(hlg), cube: "e.cube", concat: "c.txt", out: "o.mp4", w: 1080, h: 1920, fps: 30 }).join(" "); for (const re of [/transpose=1/, /crop=1080:1920/, /lut3d=file=e.cube/, /overlay=0:0/, /-crf 18/, /\+faststart/, /aac/]) expect(a).toMatch(re); });
it("landscape SDR source is center-cropped to 9:16 without transpose", () => { const a = buildExportArgs({ src: "s", probe: { dur: 1, w: 1920, h: 1080, rotation: 0, fps: 30, hdr: null, audio: true }, cube: "e", concat: "c", out: "o", w: 1080, h: 1920, fps: 30 }).join(" "); expect(a).not.toMatch(/transpose/); expect(a).toMatch(/force_original_aspect_ratio=increase,crop=1080:1920/); });
it("no audio → -an", () => expect(buildExportArgs({ src: "s", probe: { ...parseProbe(ref), audio: false }, cube: "e", concat: "c", out: "o", w: 1080, h: 1920, fps: 30 })).toContain("-an"));
it("same hash returns the previous export without re-encoding", async () => { /* ExportService.start twice with the same design → spawn called once */ });
it("third concurrent export waits", async () => { /* 3 starts → only 2 ffmpeg spawns until one resolves */ });
```

  In `captions.test.js`: `it('changeTimes covers line and word boundaries', …)` expects `[0, s1, e1, …]` for a two-word line.

- [ ] **Step 2:** Run `npm --prefix backend test -- ffmpeg export` and `npm --prefix frontend test -- captions`. Expect the new tests to fail.
- [ ] **Step 3:** Implement `changeTimes`, `buildExportArgs`, `ExportService`, the render-page mode, the endpoints and the Export modal. Schedule hands `url` to the existing planner as a video post through `openSchedule(d)`, with the media set to the export URL, the same way motion exports are scheduled.
- [ ] **Step 4:** Run both test commands and expect all to pass. Export the sample pair at 1080×1920:
  - `ffprobe` shows h264, yuv420p, bt709, AAC, a duration within 0.1 s of the source;
  - the MP4 plays in QuickTime;
  - the subtitles and grade match the preview.
- [ ] **Step 5:** Commit: `git commit -m "Footage: export with burned-in captions and the matched grade"`

---

### Task 14: End-to-end parity test on the sample files

**Files:**
- Create: `backend/src/footage/e2e.footage.test.ts` (skipped unless `FOOTAGE_SAMPLES` is set to a folder holding the three sample files)
- Create: `backend/tts/footage/delta_e.py` (`python delta_e.py A.png B.png` → `{"mean": float}`, CIEDE2000)

**Interfaces:**
- Consumes everything above through the services (not HTTP): store → jobs (all steps) → set `captions` from `words.json` → `ExportService.start` with a 10 s trim (`-t 10` added through an `opts.limitMs` test-only option of `buildExportArgs`).
- Preview frames: render 5 frames (t = 1, 3, 5, 7, 9 s) of the proxy through the same `export.cube` pipeline the shader uses. A headless page loads `footage-player.js` with `setSplit(null)` and calls `canvas.toDataURL` after seeking. Compare them with the export's frames at the same times, scaled to the same 360 px width.

- [ ] **Step 1:** Write the test. Expected: for each of the 5 frames, mean ΔE2000 < 2. `stats.json` result means are closer to the reference than the source. In at least one exported frame, the caption band holds ≥ 0.3% pixels within ΔE 10 of the style's highlight color.
- [ ] **Step 2:** Run `FOOTAGE_SAMPLES=~/Downloads npm --prefix backend test -- e2e.footage` and expect 1 passed. If parity fails, diff `tweak()` vs `GLSL_TWEAK` first, then check LUT texel addressing.
- [ ] **Step 3:** Manual run of the spec's checklist in the browser:
  - upload the pair;
  - edit a word;
  - retime a line;
  - change the style;
  - save a brand look;
  - apply it to `20261104_115014.mp4`;
  - export;
  - play the MP4.
- [ ] **Step 4:** Commit: `git commit -m "Footage: end-to-end preview/export parity test on sample footage"`
