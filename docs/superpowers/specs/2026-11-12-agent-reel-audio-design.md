# Studio Agent, phase 4: voice-over, music and captions on animated designs

Date: 2026-11-12
Status: draft for review

## Goal

In Animate mode, the Studio Agent writes and voices a voice-over, chooses the voice, adds and shapes music, and edits and styles captions on an animated design. Music settings become undoable for everyone, so an agent run that touches sound still undoes in one step.

Success: on an animated design in Animate mode the user asks "write a voice-over for each scene in our brand voice", "make the voices and fit the scenes to them", "use an Arabic voice, a bit slower", "add upbeat music, quieter, fading out at the end", "turn captions on with the karaoke-gold style", "fix the caption on scene 2", and the agent does it; one Undo restores the design, including its music.

## Where this sits

Phases 1–3 gave the agent modes `design`, `animate` and `video`, the planning tools, and the video tools (`read_captions`, `edit_captions`, `style_captions` among them). This phase adds sound tools to `animate` and makes the three caption tools work there too. Decided with the user: music settings join Undo for the agent and for the Audio panel.

Not in this phase: recording the microphone, importing audio files, managing brand voice samples, a mode of its own, sound in Design mode, cleaning up unused audio files on the server.

## What exists today (engine.js, reel audio block, about lines 11500–12060; audio.js; caption-panels.js)

- `d.audio` (`audioOf`): `{ music: { src, name, dur, vol, fadeIn, fadeOut, gen } | null, track, duck, voice, tone, language, mood, speed, topic }`. `fadeIn` / `fadeOut` are on unless `false`.
- Per scene: `pg.scene.vo = { text, src, dur, vol, by: 'ai' | 'rec' | 'file', srcText }` (`voOf`, `setVo`).
- `setA(patch)` writes `d.audio` with `touch(); save()` and no Undo. `snap()` does not include `d.audio`, so no Audio panel change to it can be undone; `vo` changes can (they are in `pages`).
- Voices: `options()` (`GET /ai/audio/options` → `{ voices: [{ id, name, lang, engine, model, group }], ready }`), `voiceChoice(a, o)`, `LANG_CODES`, `langOf`, brand voice samples (`brandVoices`). `voiceFor(i)`: `POST /ai/voiceover`, measures the clip, `drop`s the old clip file, then `setVo` in a snap/commit. Engines run on the API server (local).
- `fitToVoices()`: scenes shorter than their voice plus a lead grow, in one `mutate`.
- Music: `composeMusic(mood, seed)` (browser composer, upload, `setA`, `drop`s the old file); panel actions `au38MusicDel` (drops the file), `au38FadeIn`, `au38FadeOut`, `au38Duck`; the volume slider writes `d.audio.music.vol` directly and saves on change.
- Captions on a reel: the same `d.captions` store; while `source` is `voiceover` (or unset) the lines are built from the voice-over (`reelCaptions`, `voiceoverLines`); a hand edit stores them with `source: 'manual'`. `VS.captions.edit`, `toggleCaptions`, `applyPresetTo`, `editStyle`, `setStyleField` work for reels; `regroupFrom('reel', …)` is `voiceover` for built lines (style alone regroups them) or `lines` for hand-edited ones.
- `job(kind, fn)` runs one Audio panel job at a time (`S.busy`) with progress text and toasts.

## Undo: `d.audio` joins the history

- `snap()` includes `a: d.audio` when the design has `d.motion` (and `d.audio` exists); `restore()` puts it back. Footage and stills are unchanged.
- Every Audio panel change to `d.audio` becomes one Undo step: `setA` goes through `mutate` (with the panel's own redraw); the music volume slider takes a snapshot on focus and commits on change, as the voice-over lines already do; composing and removing music are one step each.
- Files are no longer deleted when Undo could bring them back: removing music, composing new music over old, and regenerating a voice keep the old file on the server (today they `drop` it). Unused files are left for a later cleanup (out of scope); a composed track is about 1–5 MB.

## Tools added to `animate`

`animate` goes from 22 to 30 tools.

| Tool | Parameters | Does |
| --- | --- | --- |
| `write_voiceover` | `lines: [{ scene, text }]` (text ≤ 600 characters) | Sets each scene's `vo.text` in one `mutate`. A scene whose voice was made from other text keeps its clip until voiced again; the result says which scenes now need a voice. |
| `make_voices` | `scenes?` (numbers; default: every scene whose text has no clip or changed), `fit?` (boolean, default true) | Voices those scenes one by one with the chosen voice (`voiceFor`, without deleting old files), then `fitToVoices` when `fit`. Shows "Voicing 2/5" as the step label. Stop is checked between scenes. |
| `set_voice` | `voice?` (an id from `sound.voices`), `speed?` (0.7–1.3), `language?` (one of `AUD.LANGUAGES`) | Writes `d.audio.voice`, `speed`, `language` in one `mutate`. Changing them does not re-voice: the result says to call `make_voices` for the change to be heard. |
| `remove_voice` | `scenes` | Clears the clip of those scenes (`src`, `dur`, `by`, `srcText`), keeping the text. |
| `set_music` | `compose?` (`upbeat`, `chill`, `corporate`, `cinematic`), `remove?`, `volume?` (0–100), `fadeIn?`, `fadeOut?`, `ducking?` (booleans) | Composes as long as the video (`composeMusic`, keeping the old file), or removes; then the settings, in one `mutate`. Settings without music answer "There is no music yet". |
| `read_captions`, `edit_captions`, `style_captions` | as in phase 3 | Now tagged `animate` and `video`. On a reel, `edit_captions` works on the lines as shown (built from the voice-over or hand-edited); `style_captions`' grouping fields regroup built lines by themselves and are refused on hand-edited ones, with the phase 3 sentence. |

Rules shared by the sound tools:

- No voice installed for the language: `make_voices` fails with "No <language> voice is installed on the server"; text is kept.
- The Audio panel is busy with its own job (`S.busy`): the sound tools answer "The Audio panel is working on something; try again when it is done".
- A scene number that does not exist: "There is no scene N", as phase 1.

## What the model sees

In `animate`, the context gains:

```json
{
  "sound": {
    "voice": { "id": "af_heart", "name": "Heart", "language": "English", "speed": 1 },
    "voices": [{ "id": "af_heart", "name": "Heart" }],
    "voicesReady": true,
    "music": { "name": "Upbeat", "volume": 35, "fadeIn": true, "fadeOut": true, "ducking": true },
    "scenes": [{ "number": 1, "text": "Gold hits a record high", "voiced": true, "voiceSeconds": 2.4, "needsVoice": false }],
    "captions": { "on": true, "from": "voiceover", "preset": "karaoke-gold" }
  }
}
```

- `voices`: the installed voices for the chosen language (`voiceChoice(...).list`), at most 30, brand voice samples included by name.
- `needsVoice`: text present and no clip, or the clip was made from other text.
- `captions.from`: `voiceover` (built from the voice-over) or `manual` (hand-edited).

## Prompt

Added to `ANIMATE_PROMPT`:

- Voice-over: one short line per scene that fits its length (about 2.5 words per second); then make_voices once for all of them.
- After make_voices the scenes may grow to fit; say the new length.
- Captions follow the voice-over until a line is edited by hand. To change what is said, use write_voiceover, not edit_captions; edit_captions freezes the captions.
- Music under a voice-over: volume 25–40 with ducking on, unless the user asks otherwise.

## Architecture

### Backend

- `backend/src/ai/agent.ts`: the five sound tools (`modes: ['animate']`); `read_captions`, `edit_captions`, `style_captions` modes `['animate', 'video']`; the prompt lines. Tests: `animate` has 30 tools, `video` still 11, `design` 22.

### Frontend

- `frontend/studio/agent-sound.js` (new, pure, unit-tested in `agent-sound.test.js`):
  - `voiceoverLines(pages, lines) → { set: [{ i, text }], notes }` (scene numbers, clip to 600, unknown scenes named)
  - `scenesToVoice(pages, scenes) → number[]` (default: text with no clip or changed text)
  - `voiceInput(audio, input, { voices, languages }) → { patch, notes }` (speed clamp 0.7–1.3, unknown voice or language named)
  - `musicInput(music, input) → { music, compose?, notes }`
  - `soundCtx({ pages, audio, voices, ready, caps, voiceName }) → object`
- `frontend/studio/agent-motion.js`: `ANIMATE_ONLY` gains the sound tools; the caption tools are allowed in `animate` and `video` (moved out of `VIDEO_ONLY` into a shared set).
- `frontend/studio/engine.js`:
  - `snap` / `restore` carry `d.audio` for reels; `setA` through `mutate`; the music slider snap/commit; panel removals and replacements stop calling `drop`.
  - The reel audio block exposes `RT.reelSound = { options, voiceChoice, voiceFor(i, { keep: true }), fitToVoices, composeMusic(mood, { keep: true }), busy() }`.
  - The agent block: context `sound` in `animate`; the five tools; the caption tools' gate accepts reels (no analysis gate; built lines read through `linesOf`).

## Errors and edge cases

- A run that voices 6 scenes and is stopped after 3: the 3 clips stay, the run is one Undo step, nothing else is voiced.
- The user switches design during `make_voices`: the phase 3 `still(run)` check stops before the next scene; no write lands in the other design.
- The API server's voice engine fails for one scene: that scene is named in the result; the others are still voiced; `fitToVoices` runs for the ones that worked.
- Undo after the change to `snap`: Undo of an older step now also restores `d.audio` as it was at that step. This is what the user chose; a music change made earlier is undone by its own step, in order.
- Captions hand-edited, then `write_voiceover`: the captions stay as edited; the result says so and that `style_captions`' Rebuild is not available to the agent (the Captions panel has Rebuild from voice-over).

## Testing

- `agent-sound.test.js`: every helper, including unknown scenes, clipping, the default scenes to voice, speed clamp, unknown voice and language, music without music, compose moods, the context's `needsVoice` and `captions.from`.
- `agent-motion.test.js`: `allowed` for the sound and caption tools in three modes.
- An engine test for `snap`/`restore` is not possible (closure); checked in the browser.
- `agent.test.ts`: tool counts per mode, prompt lines.
- By hand, with an AI key and an animated design in Animate mode (on a copy, not the user's original): the six requests of the goal; one Undo after a run that wrote, voiced, added music and styled captions; Audio panel: change the volume, Undo restores it; Stop during voicing.
