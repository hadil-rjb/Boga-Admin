# Studio Agent Phase 4 (Voice-over, Music, Captions on Animated Designs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Animate mode the agent writes and voices a voice-over, picks the voice, shapes music and edits captions on an animated design; music settings join Undo for everyone.

**Architecture:** `agent.ts` adds five sound tools to `animate` and opens the three caption tools to it. A new pure module, `agent-sound.js`, checks the model's input and builds the `sound` context. `engine.js` adds `d.audio` to `snap`/`restore`, routes the Audio panel's `d.audio` changes through Undo, stops deleting audio files that Undo can bring back, exposes the reel audio block's functions as `RT.reelSound`, and runs the tools in the agent loop.

**Tech Stack:** NestJS, vanilla ES modules in `frontend/studio/`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-agent-reel-audio-design.md`

## Global Constraints

- Tool counts: `design` 22, `animate` 30, `video` 11. New `animate` tools: `write_voiceover`, `make_voices`, `set_voice`, `remove_voice`, `set_music`; `read_captions`, `edit_captions`, `style_captions` become `["animate", "video"]`.
- Limits: voice-over text 600 characters; speed 0.7–1.3; volume 0–100; `voices` in context ≤ 30. Moods `upbeat`, `chill`, `corporate`, `cinematic`. Languages: `AUD.LANGUAGES` (`audio.js`).
- Undo: `snap()` carries `d.audio` for designs with `d.motion`; every `d.audio` change from the Audio panel or the agent is one Undo step; an agent run is one step.
- No audio file is deleted from the server by the reel audio block any more (`drop` becomes a no-op with a comment): every place it was called refers to state Undo can restore.
- The agent never records the microphone, imports files, or edits brand voice samples.
- Copy: sentence case, verbs first, no "please" or "successfully", no emoji.
- Do not commit unless the user asks.
- Tests: `cd backend && npx vitest run src/ai/agent.test.ts`; `cd frontend && npx vitest run studio/<name>.test.js`; all: `cd backend && npx vitest run`, `cd frontend && npx vitest run studio`. After any `engine.js` change, the page load in the browser is the syntax check (`node --check` misses duplicate imports: phase 3 ledger).

## Review Focus

1. Undo of an Audio panel music change, and of an older layer change after a music change: each restores exactly its own step's `d.audio`. (Task 3 browser check.)
2. `make_voices` stopped half-way, or the design switched during voicing: clips made so far stay, nothing is written to another design, one Undo step. (Task 4, `still(run)` between scenes; browser check.)
3. The server's voice engine fails for one scene: the others are voiced and the failing scene is named. (Task 4.)
4. Captions hand-edited on a reel, then `style_captions` with `maxWords`: refused, not a dialog. Built captions: regroup without fetching words. (Task 4.)
5. A footage design or a still: `snap` unchanged (no `a` key), so their Undo behaves as before. (Task 3 browser check on a still.)

---

### Task 1: Backend: sound tools in `animate`, caption tools opened, prompt

**Files:** `backend/src/ai/agent.ts`; test `backend/src/ai/agent.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
it('gives animate its 30 tools: sound and captions added', () => {
  expect(names('animate')).toHaveLength(30);
  ['write_voiceover', 'make_voices', 'set_voice', 'remove_voice', 'set_music', 'read_captions', 'edit_captions', 'style_captions'].forEach((n) => expect(names('animate')).toContain(n));
  ['write_voiceover', 'make_voices', 'set_voice', 'remove_voice', 'set_music'].forEach((n) => { expect(names('video')).not.toContain(n); expect(names('design')).not.toContain(n); });
  expect(names('video')).toHaveLength(11); expect(names('design')).toHaveLength(22);
});
it('tells the agent how voice-over, captions and music work together', () => {
  expect(ANIMATE_PROMPT).toMatch(/2\.5 words per second/);
  expect(ANIMATE_PROMPT).toMatch(/edit_captions freezes the captions/);
  expect(ANIMATE_PROMPT).toMatch(/volume 25–40 with ducking on/);
});
```

Change the existing `gives each mode its 22 tools` assertion for `animate` to 30, and `gives video exactly its 11 tools, and leaves the other modes at 22` to check `design` 22 and `animate` 30. Run: FAIL.

- [ ] **Step 2: Implement.** `SOUND_TOOLS` with the spec's parameter table (`lines.items` `{ scene: integer ≥ 1, text: string }`; `scenes` arrays of integers; `voice` string; `speed` number; `language` enum: the 8 names of `frontend/studio/audio.js` `LANGUAGES`; `set_music` `compose` enum of the four moods, `remove`, `fadeIn`, `fadeOut`, `ducking` booleans, `volume` number). Descriptions say: `make_voices` "takes a few seconds per scene"; `set_voice` "does not re-voice: call make_voices after". Caption tools: `modes: ['animate', 'video']`, and `edit_captions`' description adds "On an animated design, editing a line freezes the captions: they stop following the voice-over." Append the spec's four prompt lines to `ANIMATE_PROMPT`.

- [ ] **Step 3:** `cd backend && npx vitest run` and `npx tsc --noEmit -p tsconfig.json`: PASS.

---

### Task 2: Pure helpers: `agent-sound.js`; tool sets in `agent-motion.js`

**Files:** create `frontend/studio/agent-sound.js`, `agent-sound.test.js`; modify `agent-motion.js`, `agent-motion.test.js`.

**Interfaces:**
- `voiceoverLines(pages, lines) → { set: [{ i, text }], notes }`
- `scenesToVoice(pages, scenes) → number[]` (0-based indexes; `scenes` 1-based or missing)
- `voiceInput(audio, input, { voices: [{ id, name }], languages: string[] }) → { patch, notes }`
- `musicInput(music, input) → { music, compose?, notes }` (music in stored units: `vol` 0–1)
- `soundCtx({ pages, audio, voices, ready, voiceId, voiceName, language, caps }) → object` (the spec's `sound` block)
- `agent-motion.js`: `SOUND_ONLY` (the five), part of `animate`; `CAPTION_TOOLS` (`read_captions`, `edit_captions`, `style_captions`) allowed in `animate` and `video`; `VIDEO_ONLY` keeps `set_grade`, `set_audio`.

- [ ] **Step 1: Failing tests** (`agent-sound.test.js`; scene fixture `{ scene: { k, dur, vo } }`)

```js
import { describe, expect, it } from 'vitest';
import { voiceoverLines, scenesToVoice, voiceInput, musicInput, soundCtx } from './agent-sound.js';

const P = () => [
  { scene: { dur: 3000, vo: { text: 'One', src: 's1', dur: 1200, srcText: 'One' } } },
  { scene: { dur: 3000, vo: { text: 'Two new', src: 's2', dur: 1500, srcText: 'Two' } } },
  { scene: { dur: 3000, vo: { text: 'Three' } } },
  { scene: { dur: 3000 } },
];
describe('voiceoverLines', () => {
  it('maps scene numbers to indexes, clips text, names unknown scenes', () => {
    const r = voiceoverLines(P(), [{ scene: 4, text: 'Four' }, { scene: 9, text: 'x' }, { scene: 1, text: 'a'.repeat(700) }]);
    expect(r.set.map((s) => s.i)).toEqual([3, 0]); expect(r.set[1].text).toHaveLength(600); expect(r.notes[0]).toMatch(/scene 9/);
  });
  it('refuses empty text', () => { expect(voiceoverLines(P(), [{ scene: 1, text: '  ' }]).notes[0]).toMatch(/empty/); });
});
describe('scenesToVoice', () => {
  it('defaults to text with no clip or changed text', () => { expect(scenesToVoice(P())).toEqual([1, 2]); });
  it('takes the listed scenes that have text', () => { expect(scenesToVoice(P(), [1, 4, 7])).toEqual([0]); });
});
describe('voiceInput', () => {
  const ctx = { voices: [{ id: 'af_heart', name: 'Heart' }], languages: ['English', 'Arabic'] };
  it('sets voice, clamped speed and language', () => {
    expect(voiceInput({}, { voice: 'af_heart', speed: 2, language: 'Arabic' }, ctx)).toEqual({ patch: { voice: 'af_heart', speed: 1.3, language: 'Arabic' }, notes: ['speed clamped to 1.3'] });
  });
  it('names unknown voices and languages', () => {
    const r = voiceInput({}, { voice: 'zz', language: 'Klingon' }, ctx);
    expect(r.patch).toEqual({}); expect(r.notes.join(' ')).toMatch(/af_heart/); expect(r.notes.join(' ')).toMatch(/English, Arabic/);
  });
});
describe('musicInput', () => {
  const M = { src: 'm', name: 'Chill', vol: 0.35 };
  it('sets volume, fades and ducking; removes', () => {
    expect(musicInput(M, { volume: 20, fadeIn: false, ducking: true }).music).toEqual({ ...M, vol: 0.2, fadeIn: false });
    expect(musicInput(M, { remove: true }).music).toBe(null);
  });
  it('composes by mood and refuses settings with no music', () => {
    expect(musicInput(null, { compose: 'upbeat', volume: 30 }).compose).toBe('upbeat');
    expect(musicInput(null, { volume: 30 }).notes[0]).toMatch(/no music/i);
    expect(musicInput(M, { compose: 'jazz' }).notes[0]).toMatch(/upbeat, chill, corporate, cinematic/);
  });
});
describe('soundCtx', () => {
  it('summarises the voice-over, the voice, the music and the captions', () => {
    const v = soundCtx({ pages: P(), audio: { speed: 1, duck: true, music: { name: 'Chill', vol: 0.35 } }, voices: [{ id: 'af_heart', name: 'Heart' }], ready: true, voiceId: 'af_heart', voiceName: 'Heart', language: 'English', caps: { on: true, source: 'manual', preset: 'karaoke-gold' } });
    expect(v.scenes[1]).toEqual({ number: 2, text: 'Two new', voiced: true, voiceSeconds: 1.5, needsVoice: true });
    expect(v.scenes[3]).toEqual({ number: 4, text: '', voiced: false, voiceSeconds: 0, needsVoice: false });
    expect(v.music).toEqual({ name: 'Chill', volume: 35, fadeIn: true, fadeOut: true, ducking: true });
    expect(v.captions).toEqual({ on: true, from: 'manual', preset: 'karaoke-gold' });
    expect(v.voice).toEqual({ id: 'af_heart', name: 'Heart', language: 'English', speed: 1 });
  });
});
```

`agent-motion.test.js`: in `allowed in video`, move `read_captions` and `style_captions` out of the "not in animate" list; add:

```js
it('gives animate the sound and caption tools', () => {
  ['write_voiceover', 'make_voices', 'set_voice', 'remove_voice', 'set_music', 'read_captions', 'edit_captions', 'style_captions'].forEach((t) => expect(allowed(t, 'animate')).toBe(true));
  ['write_voiceover', 'set_music'].forEach((t) => { expect(allowed(t, 'design')).toBe(false); expect(allowed(t, 'video')).toBe(false); });
  ['set_grade', 'set_audio'].forEach((t) => expect(allowed(t, 'animate')).toBe(false));
});
```

Run: FAIL.

- [ ] **Step 2: Implement** both. `needsVoice`: text non-empty and (no `src` or `srcText !== text`) and `by !== 'file'` (an imported file is never "out of date"). `voiceSeconds`: one decimal. `from`: `manual` when `caps.source === 'manual'`, else `voiceover`.

- [ ] **Step 3:** `cd frontend && npx vitest run studio`: PASS.

---

### Task 3: Undo for `d.audio`; no more file deletion

**Files:** `frontend/studio/engine.js` — `snap`/`restore` (about line 2671), reel audio block: `setA` (about 11615), the `mvol` input/change handlers (about 12060), `drop`.

- [ ] **Step 1: Implement**
- `snap`: add `...(ED.d.motion && ED.d.audio ? { a: ED.d.audio } : {})`; `restore`: `if (v.a) ED.d.audio = v.a;` and, when the design has `d.motion` but the snapshot has no `a`, leave `d.audio` as is.
- `setA(patch)`: `mutate(() => { ED.d.audio = { ...A(), ...patch }; if (ED.d.captions) delete ED.d.audio.captions; }, () => {})` then `save()`; its callers keep their own `redraw()`.
- Music volume slider: snapshot on `focusin`/`pointerdown` of `[data-au="mvol"]` (as `line`), commit on `change` (`commit(pre)`), keep the live `input` preview.
- `drop`: keep the signature, make it do nothing, with a comment: "Undo can bring back a removed or replaced clip, so its file stays on the server."
- [ ] **Step 2:** `cd frontend && npx vitest run studio`: PASS. Reload the page (syntax check).
- [ ] **Step 3: Browser check** (on a copy of an animated design; duplicate one first, never the user's original): change the music volume in the Audio panel, Undo → back; toggle ducking, Undo → back; on a still, Undo of a layer move still works and its `snap` has no audio.

---

### Task 4: Agent tools, context, caption tools on reels

**Files:** `frontend/studio/engine.js` (reel audio block: expose `RT.reelSound`; agent block: context, five tools, caption tools' reel branch).

**Interfaces:** `RT.reelSound = { options() → Promise, voiceChoice(audio, opts) → { list, cur, missing }, voiceFor(i) → Promise, fitToVoices() → number, composeMusic(mood) → Promise, busy() → string, langOf(audio) → string, LANGUAGES }`.

- [ ] **Step 1: Expose** `RT.reelSound` at the end of the reel audio block (`busy: () => S.busy`).
- [ ] **Step 2: Context.** In `animate`, add `sound: soundCtx({...})` with `await`-free data: `RT.reelSound.options()` is async, so cache its last result in the agent block (`soundOpts`), loaded at the start of each run (`await RT.reelSound.options()` before the first turn when the design is a reel).
- [ ] **Step 3: Tools** (each throws "The Audio panel is working on something; try again when it is done" when `RT.reelSound.busy()`):

| Tool | Does | `STEP` |
| --- | --- | --- |
| `write_voiceover` | `voiceoverLines`; one `mutate` setting `vo.text` (via the block's `setVo` semantics: `pg.scene = { ...sceneOf(pg), vo: { vol: 1, ...vo, text } }`); result lists scenes that now need a voice | `Writing the voice-over` |
| `make_voices` | `scenesToVoice`; voices missing → error; for each: `halt(run)`, step label `Voicing n/N`, `await voiceFor(i)` in try (failures named); then `fitToVoices()` when `fit !== false`; result: voiced scenes, failures, scenes grown, new length | `Making the voices` |
| `set_voice` | `voiceInput`; one `mutate` on `d.audio` | `Choosing the voice` |
| `remove_voice` | one `mutate` clearing `src`, `dur`, `by`, `srcText` of those scenes | `Removing voices` |
| `set_music` | `musicInput`; compose → `halt(run)` after `await composeMusic(mood)`; then one `mutate` with the settings | `Changing the music` |

`read_captions` / `edit_captions` / `style_captions` on a reel: skip `videoGate`'s footage checks (no analysis); lines via `linesOf(ED.d)` (built or manual); `style_captions` regroup: `regroupFrom('reel', caps)` → `voiceover` regroups with the style alone (no words fetch), `lines` refuses.

- [ ] **Step 4:** `cd frontend && npx vitest run studio`, `npm run check:css`; reload the page.
- [ ] **Step 5: Browser check** (AI key, a **copy** of an animated design in Animate mode):
1. "Write a voice-over for each scene in our brand voice": `vo.text` set; the Audio panel shows the lines.
2. "Make the voices and fit the scenes": `Voicing n/N` steps; scenes grow; the agent states the new length. (If no voice is installed, the error names the language: report it.)
3. "Add upbeat music at 30%, fading out": composed; settings in the panel.
4. "Turn captions on with karaoke-gold": captions built from the voice-over, styled.
5. One Undo after a run that did 1–4: voice-over, clips, scene lengths, music and captions all back.
6. Stop during voicing: clips so far stay, one Undo step.
