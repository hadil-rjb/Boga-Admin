# Studio Agent Phase 3 (Uploaded Videos) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Studio Agent gets a third mode, `video`, for uploaded videos: it edits the captions and their style, the colour grade and the sound, as one Undo step per run.

**Architecture:** `agent.ts` gains the `video` mode, five tools and a prompt section. A new pure module, `agent-video.js`, turns the model's input into caption lines, grade values and audio settings, and builds the context. The video editor (`footage-editor.js`) exposes a small `FT.agent` API that applies those values through its own `mutate` paths without dialogs; `engine.js` extracts music composing into `RT.composeMusic` and runs the tools in the agent loop.

**Tech Stack:** NestJS, vanilla ES modules in `frontend/studio/`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-agent-video-design.md`

## Global Constraints

- Modes are `design`, `animate`, `video`. `video` has exactly 11 tools: `read_captions`, `edit_captions`, `style_captions`, `set_grade`, `set_audio`, `view_frame`, `write_caption`, `rename_design`, `read_planner`, `propose_schedule`, `propose_automation`. `design` and `animate` keep their 22 tools; `view_frame` gains `video`.
- Every change to a video goes through `mutate` (one run = one Undo step). No confirm dialog or toast is shown for an agent's change; the tool's result says what happened instead.
- The agent never re-transcribes, replaces the video, matches a reference, exports, or saves or deletes a brand look.
- While the analysis is not `ready`, caption and grade tools return "The video is still being analysed (<step> <percent>%). Try again when it is done." and change nothing. A blank video (no `footage.src`) answers "Add your video first" for every video tool.
- Model units: seconds (one decimal) for times; −100 to 100 for exposure, temp, sat; 0 to 100 for strength and volumes. Stored units are those of the editor (ms; `look` values via `sliderToGrade`; volumes 0–1).
- Caption style values are the stored ones: `size` is a fraction of the video height (0.02–0.12), `y` and `x` 0–1; the tool descriptions say so (spec example showed pixels: ruling, see Task 1).
- Limits: `edit_captions` 100 edits per call, text 300 characters; `read_captions` 200 lines; context lines 120.
- Copy: sentence case, verbs first, no "please" or "successfully", no emoji.
- Do not commit unless the user asks.
- Test commands: `cd backend && npx vitest run src/ai/agent.test.ts`; `cd frontend && npx vitest run studio/<name>.test.js`; everything: `cd backend && npx vitest run` and `cd frontend && npx vitest run studio`.

## Review Focus

1. A batch of caption edits where an earlier edit removes or merges a line a later edit names: the later edit is skipped and named, nothing else breaks. (Task 3 test.)
2. Retime that overlaps a neighbour or leaves the video: clamped between the neighbours and inside the video, never reordered. (Task 3 test.)
3. `maxWords` asked on hand-edited lines (`source` is `manual`, which `edit_captions` itself sets): refused with the spec's text, never a dialog the agent cannot answer. (Task 4 wiring; Task 5 browser check.)
4. A run that edits captions, then the user presses Undo once: captions, grade and sound all return to before the run. (Task 5 browser check.)
5. `view_frame` when the proxy video is not readable by a canvas (CORS) or not loaded at that time: returns the text answer, the run continues. (Task 4 spike result; Task 5.)

---

### Task 1: Backend: the `video` mode, five tools, prompt

**Files:** Modify `backend/src/ai/agent.ts`, `backend/src/ai/dto/ai.dto.ts`; test `backend/src/ai/agent.test.ts`.

**Interfaces:** Produces `AgentMode = 'design' | 'animate' | 'video'`; tools above; `VIDEO_PROMPT`; DTO `mode` accepts `video`.

- [ ] **Step 1: Failing tests**

```ts
it('gives video exactly its 11 tools, and leaves the other modes at 22', () => {
  expect(names('video')).toEqual(['edit_captions', 'propose_automation', 'propose_schedule', 'read_captions', 'read_planner', 'rename_design', 'set_audio', 'set_grade', 'style_captions', 'view_frame', 'write_caption']);
  expect(names('design')).toHaveLength(22); expect(names('animate')).toHaveLength(22);
});
it('adds the video section in video mode only, with the plan section, and no make_video hint', () => {
  const v = JSON.stringify({ design: { mode: 'video', kind: 'video' } });
  expect(agentSystemPrompt(v, 'video')).toBe(`${AGENT_PROMPT}\n\n${VIDEO_PROMPT}\n\n${PLAN_PROMPT}`);
  expect(agentSystemPrompt(v, 'animate')).not.toContain(VIDEO_PROMPT);
});
it('names every caption preset and the style units', () => {
  const t = JSON.stringify(AGENT_TOOLS.find((x) => x.name === 'style_captions'));
  ['viral-yellow', 'karaoke-gold', 'clean-white', 'cine-serif', 'box-pill', 'neon-cyan', 'ar-bold'].forEach((k) => expect(t).toContain(k));
  expect(t).toMatch(/fraction of the video height/);
});
```

Import `VIDEO_PROMPT`. Run `cd backend && npx vitest run src/ai/agent.test.ts`: FAIL.

- [ ] **Step 2: Implement**
- The five tools, `modes: ['video']`, parameters as the spec's "Tools" section. `edit_captions.edits.items`: `action` enum `text`, `delete`, `merge`, `split`, `retime`, `add`; `id`, `text`, `atWord` (integer ≥ 1), `start`, `end`. `style_captions.preset` enum: the 33 keys of `frontend/studio/caption-presets.js` `PRESETS` (copy them); `style` properties: `font` enum `sans-bold`, `sans`, `serif`, `display`; `size` ("fraction of the video height, 0.02–0.12"); `weight`; `color` (#hex); `case` enum `none`, `upper`, `lower`; `y`, `x` (0–1, from the top / left); `align` enum; `maxWords` (1–8); `maxChars` (8–60); `lines` (1–2); `anim` enum `none`, `fade`, `pop`, `karaoke`, `word`, `typewriter`, `bounce`, `slide`; `highlightMode` enum `box`, `color`, `scale`, `none`; `highlightColor`. `set_grade.look` string ("matched", "none" or a brand look id). `set_audio.music` object with `remove` (boolean), `volume`, `ducking` (boolean), `compose` enum `upbeat`, `chill`, `corporate`, `cinematic`.
- `view_frame.modes` = `['animate', 'video']`, and its `at` description adds "(an uploaded video: default 40% of its length)". `write_caption`, `rename_design` and the three planning tools: all three modes.
- `VIDEO_PROMPT`: the seven lines of the spec's "Prompt", each `- `, headed `The design is an uploaded video (design.mode is "video").`
- `agentSystemPrompt`: mode section `video` → `VIDEO_PROMPT`; no `MAKE_VIDEO_HINT` in `video`; `PLAN_PROMPT` as before.
- DTO: `@IsIn(["design", "animate", "video"])`.
- Ruling to ledger: caption `size` is exposed in stored units (fraction of height), not the spec example's pixels — the inspector's checks use fractions.

- [ ] **Step 3:** `cd backend && npx vitest run` and `npx tsc --noEmit -p tsconfig.json`: PASS, clean.

---

### Task 2: Mode plumbing: `agentMode`, `allowed`, the video rail

**Files:** Modify `frontend/studio/agent-motion.js`, `frontend/studio/video-studio.js`; tests `agent-motion.test.js`, `video-studio.test.js`.

**Interfaces:** `agentMode('video', any) → 'video'`; `VIDEO_ONLY: Set` (the five new tools); `allowed(tool, mode)` for three modes; `railFor('video', …)` ends with `['agent', 'Agent', 'studio']`; `panelFor('video', m, 'agent') → { mode: 'animate', tab: 'agent' }`.

- [ ] **Step 1: Failing tests**

```js
// agent-motion.test.js — replace the video line of 'follows the kind and the editor mode' with:
expect(agentMode('video', 'animate')).toBe('video');
// new
it('keeps the video tools to the video mode, and the layer tools out of it', () => {
  ['edit_captions', 'set_grade', 'set_audio', 'read_captions', 'style_captions'].forEach((t) => { expect(allowed(t, 'video')).toBe(true); expect(allowed(t, 'design')).toBe(false); expect(allowed(t, 'animate')).toBe(false); });
  ['update_layers', 'add_layers', 'manage_slides', 'animate_layers', 'make_video', 'check_design', 'view_slide'].forEach((t) => expect(allowed(t, 'video')).toBe(false));
  ['view_frame', 'write_caption', 'rename_design', 'read_planner', 'propose_schedule'].forEach((t) => expect(allowed(t, 'video')).toBe(true));
});
// video-studio.test.js — the 'an uploaded video: Scenes, Audio, Captions' test becomes Scenes, Audio, Captions, Agent; 'gives a video no Agent' is replaced by:
it('gives a video the Agent, pinned at the bottom', () => { expect(keys('video', 'animate')).toEqual(['scenes', 'audio', 'captions', 'agent']); expect(panelFor('video', 'animate', 'agent')).toEqual({ mode: 'animate', tab: 'agent' }); });
```

The existing `panelFor` video test lists `'agent'` among keys that open Scenes: remove `'agent'` from that list. Run both files: FAIL.

- [ ] **Step 2: Implement.** `allowed(tool, mode)`: in `video`, a tool is allowed when it is in `VIDEO_ONLY` or in `SHARED_VIDEO = { view_frame, write_caption, rename_design, read_planner, propose_schedule, propose_automation }`; in `design` and `animate`, tools in `VIDEO_ONLY` are refused, the rest as today. `VIDEO_RAIL` stays three items; `railFor` appends `DESIGN_FOOT` for `video`; `panelFor` for `video` keeps `agent`.

- [ ] **Step 3:** `cd frontend && npx vitest run studio`: PASS.

---

### Task 3: Pure helpers: `agent-video.js`

**Files:** Create `frontend/studio/agent-video.js`, `frontend/studio/agent-video.test.js`.

**Interfaces (pure):**
- `captionEdits(lines, edits, durMs) → { lines, done: string[], notes: string[], added: string[] }`
- `linesIn(lines, fromS, toS, max) → [{ id, start, end, text }]` (seconds)
- `gradeInput(look, input, { looks, matched }) → { look?: 'matched' | 'none' | id, values: { strength?, exposure?, temp?, sat? }, notes }` where `values` are stored values (`sliderToGrade`)
- `audioInput(audio, input, { hasMusic }) → { audio, compose?: string, notes }` with `audio = { vol, music }` (stored units)
- `analysisState(rec, ref) → { state: 'ready' | 'running' | 'failed' | 'no video', label }`
- `videoCtx({ d, caps, style, state, looks, matched, maxLines }) → object` (the spec's `video` block)

- [ ] **Step 1: Failing tests** (fixtures: lines `{ id, start, end, words: [{ t, s, e }] }`)

```js
import { describe, expect, it } from 'vitest';
import { captionEdits, linesIn, gradeInput, audioInput, analysisState, videoCtx } from './agent-video.js';

const W = (t, s, e) => ({ t, s, e });
const L = () => [
  { id: 'a', start: 0, end: 1500, words: [W('Hello', 0, 500), W('wrold', 500, 1000), W('today', 1000, 1500)] },
  { id: 'b', start: 2000, end: 3000, words: [W('second', 2000, 3000)] },
  { id: 'c', start: 3500, end: 4500, words: [W('third', 3500, 4500)] },
];
const text = (l) => l.words.map((w) => w.t).join(' ');
describe('captionEdits', () => {
  it('fixes text and keeps the timing of unchanged words', () => {
    const r = captionEdits(L(), [{ action: 'text', id: 'a', text: 'Hello world today' }], 10000);
    expect(text(r.lines[0])).toBe('Hello world today'); expect(r.lines[0].words[0]).toEqual(W('Hello', 0, 500)); expect(r.done).toHaveLength(1);
  });
  it('splits at a word, merges with the next line, deletes', () => {
    let r = captionEdits(L(), [{ action: 'split', id: 'a', atWord: 2 }], 10000);
    expect(r.lines.map(text)).toEqual(['Hello wrold', 'today', 'second', 'third']); expect(r.added).toHaveLength(1);
    r = captionEdits(L(), [{ action: 'merge', id: 'b' }], 10000); expect(r.lines.map(text)).toEqual(['Hello wrold today', 'second third']);
    r = captionEdits(L(), [{ action: 'delete', id: 'c' }], 10000); expect(r.lines).toHaveLength(2);
  });
  it('applies in order and skips edits whose line is gone, naming them', () => {
    const r = captionEdits(L(), [{ action: 'delete', id: 'b' }, { action: 'text', id: 'b', text: 'x' }, { action: 'text', id: 'c', text: 'Third' }], 10000);
    expect(r.lines.map(text)).toEqual(['Hello wrold today', 'Third']); expect(r.notes[0]).toMatch(/b: no such line/);
  });
  it('refuses a split outside the line, a merge of the last line, an unknown action', () => {
    const r = captionEdits(L(), [{ action: 'split', id: 'a', atWord: 3 }, { action: 'split', id: 'a', atWord: 0 }, { action: 'merge', id: 'c' }, { action: 'spin', id: 'a' }], 10000);
    expect(r.lines).toEqual(L()); expect(r.notes).toHaveLength(4);
  });
  it('keeps a retime between its neighbours and inside the video', () => {
    let r = captionEdits(L(), [{ action: 'retime', id: 'b', start: 1, end: 4 }], 10000);
    expect([r.lines[1].start, r.lines[1].end]).toEqual([1500, 3500]); expect(r.notes[0]).toMatch(/clamped/);
    r = captionEdits(L(), [{ action: 'retime', id: 'c', start: 9, end: 12 }], 10000);
    expect([r.lines[2].start, r.lines[2].end]).toEqual([9000, 10000]);
    r = captionEdits(L(), [{ action: 'retime', id: 'b', start: 3, end: 2 }], 10000); expect(r.notes[0]).toMatch(/end/);
  });
  it('adds a line in a gap, and refuses one with no room', () => {
    let r = captionEdits(L(), [{ action: 'add', start: 5, end: 6, text: 'four' }], 10000);
    expect(r.lines.map(text)).toEqual(['Hello wrold today', 'second', 'third', 'four']); expect(r.added).toHaveLength(1);
    r = captionEdits(L(), [{ action: 'add', start: 1.55, end: 1.6, text: 'x' }], 10000); expect(r.notes[0]).toMatch(/room/);
  });
  it('clips long text and caps the batch at 100 edits', () => {
    const r = captionEdits(L(), [{ action: 'text', id: 'a', text: 'w '.repeat(400) }], 10000);
    expect(text(r.lines[0]).length).toBeLessThanOrEqual(300);
    expect(captionEdits(L(), Array.from({ length: 120 }, () => ({ action: 'text', id: 'a', text: 'Hi' })), 10000).notes.join(' ')).toMatch(/100/);
  });
  it('never changes the lines it was given', () => { const l = L(); captionEdits(l, [{ action: 'delete', id: 'a' }], 10000); expect(l).toEqual(L()); });
});
describe('linesIn', () => {
  it('lists the lines overlapping a range in seconds, capped', () => {
    expect(linesIn(L(), 1.8, 3.6, 200)).toEqual([{ id: 'b', start: 2, end: 3, text: 'second' }, { id: 'c', start: 3.5, end: 4.5, text: 'third' }]);
    expect(linesIn(L(), undefined, undefined, 2)).toHaveLength(2);
  });
});
describe('gradeInput', () => {
  const ctx = { looks: [{ id: 'lk1', name: 'Warm' }], matched: true };
  it('maps slider units to stored values and clamps', () => {
    const r = gradeInput({}, { temp: 20, exposure: 300, strength: 50 }, ctx);
    expect(r.values.exposure).toBe(gradeInput({}, { exposure: 100 }, ctx).values.exposure); expect(r.notes.join(' ')).toMatch(/exposure/);
    expect(Object.keys(r.values).sort()).toEqual(['exposure', 'strength', 'temp']);
  });
  it('accepts matched, none or a brand look, and refuses the rest', () => {
    expect(gradeInput({}, { look: 'lk1' }, ctx).look).toBe('lk1');
    expect(gradeInput({}, { look: 'none' }, ctx).look).toBe('none');
    expect(gradeInput({}, { look: 'matched' }, { ...ctx, matched: false }).notes[0]).toMatch(/matched/);
    expect(gradeInput({}, { look: 'teal' }, ctx).notes[0]).toMatch(/lk1/);
  });
});
describe('audioInput', () => {
  const A = { vol: 1, music: { src: 'm', name: 'Chill', vol: 0.6, duck: true } };
  it('sets volumes in 0–100, ducking, and removes music', () => {
    expect(audioInput(A, { originalVolume: 40, music: { volume: 30, ducking: false } }, { hasMusic: true }).audio).toEqual({ vol: 0.4, music: { src: 'm', name: 'Chill', vol: 0.3, duck: false } });
    expect(audioInput(A, { music: { remove: true } }, { hasMusic: true }).audio.music).toBe(null);
  });
  it('asks to compose by mood, refuses unknown moods and settings on no music', () => {
    expect(audioInput(A, { music: { compose: 'chill', volume: 50 } }, { hasMusic: true }).compose).toBe('chill');
    expect(audioInput(A, { music: { compose: 'jazz' } }, { hasMusic: true }).notes[0]).toMatch(/upbeat, chill, corporate, cinematic/);
    expect(audioInput({ vol: 1, music: null }, { music: { volume: 20 } }, { hasMusic: false }).notes[0]).toMatch(/no music/i);
  });
});
describe('analysisState', () => {
  it('reads the server record', () => {
    expect(analysisState(null, null).state).toBe('no video');
    expect(analysisState({ status: 'ready', jobs: { transcribe: { state: 'running', progress: 0.4 } } }, null)).toEqual({ state: 'running', label: 'transcribing 40%' });
    expect(analysisState({ status: 'ready', jobs: { transcribe: { state: 'failed', error: 'x' } } }, null).state).toBe('failed');
  });
});
```

Adapt the `analysisState` fixtures to `footage-editor.js` `analysis(rec, ref)` and `stepInfo` (read them first; `analysisState` must call `analysis`, not re-implement it). Run: FAIL.

- [ ] **Step 2: Implement.** Decisions the tests leave open:
- `captionEdits` works on a deep copy; `split` at `atWord` k uses `split(line, line.words[k].s)` (`captions.js`), valid for 1 ≤ k < words.length; new line ids are `'l' + random base36`, as `mkLine` makes them if it already sets ids (check and reuse).
- Retime clamp: `start ≥ prev.end` (or 0), `end ≤ next.start` (or `durMs`), `end - start ≥ 200`; else note.
- `add`: refused when `[start, end]` overlaps a line or is under 200 ms ("no room").
- `gradeInput` uses `sliderToGrade` and `GRADE_KEYS` from `footage-editor.js` (export what is missing).
- `videoCtx` returns the spec's block; `lines` from `linesIn(…, maxLines)` plus `moreLines`.

- [ ] **Step 3:** `cd frontend && npx vitest run studio/agent-video.test.js`: PASS.

---

### Task 4: The video editor's agent API and music composing

**Files:** Modify `frontend/studio/footage-editor.js` (near `FT.session` at about line 1061; `setAudio` 735, `applyLook` 958, `useMatched` 978, `regroup` in `caption-inspector.js` 340); `frontend/studio/engine.js` (`RT.pickMusic` at about 11844).

**Interfaces:**
- `RT.composeMusic(mood, seconds) → Promise<{ src, name, dur, gen }>` (the picker's compose path; `RT.pickMusic` uses it).
- `FT.agent = { ready(), state(), lines(), setLook(values), applyLook(id) → Promise<string>, useMatched() → Promise<string>, resetGrade(), setAudio(audio), music(mood) → Promise<string>, words() → Promise<words>, frameAt(ms, scale) → Promise<dataUrl | null> }`. All changes go through `mutate`; none shows a dialog or toast; each async one returns a sentence for the tool result or throws.

- [ ] **Step 1: Spike (first, before any code): can the video frame be read?** In the browser, open an uploaded video whose analysis is done, then in the console run: draw `document.querySelector('video')` on a canvas and call `toDataURL()`. Ledger the result: readable, or a `SecurityError` (tainted canvas). If it throws, `frameAt` returns `null` always and Task 5 reports it.
- [ ] **Step 2: Implement**
- `RT.composeMusic`: move the body of the picker's `compose(mood)` into it; the picker calls it. The 8–120 s clamp stays.
- `FT.agent.applyLook(id)`: as `applyLook`, but when the look's caption grouping differs and lines exist, it applies the grade only (`applyLookTo` with the current lines unchanged, or the look without `captionStyle`: read `applyLookTo` and pick the one that leaves captions as they are) and returns "Applied the look's colours; its captions use N words per line, which would replace your line breaks, so they were left as they are".
- `FT.agent.useMatched()`: as `useMatched`, no toast.
- `FT.agent.frameAt(ms, scale)`: seek a second, off-screen `<video crossOrigin="anonymous">` on the proxy URL (not the visible player), wait for `seeked`, draw it and `captions.js draw(ctx, lines, style, ms, w, h)` on a canvas, return JPEG 0.85; any error (including a tainted canvas) returns `null`. Keep the element for the run; drop it with a `dropFrame()` the agent calls at the end of the run.
- Grouping changes go through the agent (Task 5), not here.
- [ ] **Step 3:** `cd frontend && npx vitest run studio` and `node --check` both files: PASS.

---

### Task 5: The agent loop in `video` mode

**Files:** Modify `frontend/studio/engine.js` (agent v25 block: `agMode`, `context`, `shot`, `T`, `STEP`; `agentCopy` call sites), `frontend/studio/agent-motion.js` (`agentCopy` for `video`), its test.

- [ ] **Step 1: Failing test** (`agent-motion.test.js`)

```js
it('speaks of the video in video mode', () => {
  const c = agentCopy('video', 0, 1, 'slide');
  expect(c.sub).toBe('Edits this video'); expect(c.placeholder).toBe('Ask for caption, colour or sound changes');
  expect(c.prompts.map((p) => p[1])).toEqual(['Fix the captions', 'Make the captions pop', 'Add calm music']);
});
```

Prompts' texts: `Fix the spelling and punctuation of every caption line`, `Give the captions a bold, high-contrast style that stands out, and check a frame`, `Add calm music that ducks under the speech`. `chip`: `Whole video`; `empty`: `Describe what to change: caption text and style, colours, sound. I edit the video for you.` Run: FAIL; implement; PASS.

- [ ] **Step 2: Loop**
- `agMode()`: `agentMode(kindOf, VS.mode())`, now `video` for footage.
- `context()` in `video`: `design: { name, mode: 'video', kind: 'video', width, height }` (no `slides`, no `brand.templates`… keep `brand` as is) and `video: videoCtx(…)` from `FT.agent.state()`, `capsOf`, `styleOf`, `brand().looks`.
- `shot()` in `video`: `FT.agent.frameAt(0.4 × duration)`, else none.
- Guard, before a video tool runs: a blank video (no `footage.src`) → "Add your video first" for the five video tools and `view_frame`; analysis not `ready` → the spec's "still being analysed" text for `edit_captions`, `style_captions` and `set_grade` only (`read_captions`, `set_audio` and `view_frame` still run).
- Tools, each with `run.moved` unset (no scene preview):

| Tool | Does | `STEP` |
| --- | --- | --- |
| `read_captions` | `JSON.stringify(linesIn(capsOf(d).lines, from, to, 200))` | `Reading the captions` |
| `edit_captions` | `VS.captions.edit((lines) => captionEdits(lines, a.edits, durMs).lines)` (one mutate); result: done, notes, added ids; reminder when captions are off | `Editing N caption line(s)` |
| `style_captions` | one `mutate`: `on` (`toggleCaptions` when it differs), `preset` (`applyPresetTo`), `style` fields via `setStyleField` then `editStyle`; when a grouping field (`REGROUP_FIELDS`) changes: `regroupFrom` — `lines` (hand-edited) → refuse with "Regrouping would undo hand edits to the lines; ask the user", `speech` → `await FT.agent.words()` before the mutate, then `group(words, style)` inside it | `Styling the captions` |
| `set_grade` | `gradeInput`; `look` → `FT.agent.applyLook` / `useMatched` / `resetGrade`; then `FT.agent.setLook(values)` | `Changing the colours` |
| `set_audio` | `audioInput`; `compose` → `FT.agent.music(mood)` (step label `Composing music`); then `FT.agent.setAudio(audio)` | `Changing the sound` |
| `view_frame` (video) | `FT.agent.frameAt(at ? at × 1000 : 0.4 × dur, s)`; null → "This frame can't be read here" | `Looking at the video` |

- End of run: `FT.agent.dropFrame()`.

- [ ] **Step 3:** `cd frontend && npx vitest run studio`, `node --check`, `npm run check:css`: PASS.

- [ ] **Step 4: Browser check** (API restarted, page reloaded, an uploaded video whose analysis is done; if the workspace has none, report it and stop — do not upload the user's files):
1. The Agent item is at the bottom of the video's rail; the panel reads "Edits this video".
2. "Fix the spelling and punctuation of the captions": steps `Reading the captions` / `Editing N caption lines`; one Undo restores them.
3. "Use the viral-yellow style and move the captions up a bit": preset applied, `y` lower; a frame is checked (or "can't be read" reported); Undo.
4. "Make it warmer": temperature moves 10–25; Undo.
5. "Lower the original sound to 40% and add calm music that ducks": composing step, music set; Undo removes both. The composed file stays uploaded (as with the picker).
6. "Show me 3 words per line" after step 2's edit (lines now hand-edited): refused with the regroup sentence.
7. Undo once after a run that touched captions, grade and sound: all three return.
