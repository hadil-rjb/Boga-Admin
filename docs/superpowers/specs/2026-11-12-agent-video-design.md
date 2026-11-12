# Studio Agent, phase 3: uploaded videos

Date: 2026-11-12
Status: draft for review

## Goal

The Studio Agent works on uploaded videos. With a video open, it edits the captions (text, timing, style), the colour grade and the sound, in the editor's own changes, so a run is one Undo step.

Success: with an uploaded video open and its analysis done, the user asks "fix the typos in the captions", "split the long lines", "use a bold yellow style and move the captions up", "make it warmer", "use our brand look", "lower the original sound and add calm music that ducks under the speech", and the agent does it; one Undo restores the video as it was.

## Where this sits

Phase 1 gave the agent modes `design` and `animate`; phase 2 added the planning tools in both. This phase adds a third mode, `video`, for designs with `d.footage`. Phase 4 (music, voice-over and captions on animated designs) comes after, reusing this phase's caption tools.

Not in this phase: re-transcribing (it replaces every line, so it stays the user's button); matching a reference video, replacing the video, exporting (uploads and long server jobs); saving or deleting brand looks (shared brand settings); trimming (the editor has none); anything on animated designs' audio.

## What exists today

- `d.footage` (`footage.js` `footageDoc`): `{ src, ref, lookId, look: { lut, strength, exposure, temp, sat }, out: { w, h, fps }, dur, audio? }`. `ftAudioOf(ft)` gives `{ vol, music: { src, mediaId, name, vol, duck, dur } | null }`.
- `d.captions` (`caption-store.js`): `{ on, lines: [{ id, start, end, words: [{ t, s, e }] }], style, preset, source, lang, … }`; `capsOf`, `styleOf`.
- The analysis runs on the server; the editor polls it (`footage-editor.js` `poll`, `F` session, `analysis(rec, ref)` with `settled` / `failed`, `stepInfo`).
- Caption edits: `caption-panels.js` `edit(fn)` = `mutate(() => editCaptions(d, fn))` + `save()`, exposed as `VS.captions.edit`; helpers in `captions.js`: `retext`, `split`, `merge`, `retime`, `addLine`; `toggleCaptions`; `applyPresetTo(d, id)` (`caption-presets.js` keys); `editStyle`, and `caption-inspector.js` `setStyleField(style, path, value)` (checks and clamps, `NUM` and `ENUM`), with `regroup` when a grouping field changes (async words fetch for speech captions).
- Grade: `GRADE_KEYS`, `sliderToGrade`, `gradeCommit`, `gradeReset`, `applyLook(id)` (async cube fetch), `useMatched()` (async), `canUseMatched`.
- Audio: `setAudio(fn)` (mutate), `ACT.ftDuck`, music picked through `RT.pickMusic` (a menu: compose by mood with `composer.js` in the browser, then `POST /media/audio`; or upload).
- `snap()` covers `d.footage` and `d.captions`, so all of the above is undoable through `mutate`.
- `video-studio.js`: `VIDEO_RAIL` (Scenes, Audio, Captions) has no Agent; `agentMode('video', …)` returns `null` (phase 1).

## Mode

`agentMode('video', 'animate')` returns `'video'`. The Agent item is pinned at the bottom of the uploaded video's rail (`railFor('video', …)` ends with Agent; `panelFor('video', …, 'agent')` keeps it).

Tools of the `video` mode:

| Tool | Modes |
| --- | --- |
| `read_captions`, `edit_captions`, `style_captions`, `set_grade`, `set_audio` (new) | `video` |
| `view_frame` (phase 1) | `animate`, `video` |
| `write_caption`, `rename_design` | `design`, `animate`, `video` |
| `read_planner`, `propose_schedule`, `propose_automation` | `design`, `animate`, `video` |

`video` has 11 tools. No layer, slide, scene or animation tool. `design` and `animate` keep their 22 tools.

## What the model sees

In `video` the context's `design` is `{ name, mode: 'video', kind: 'video', width, height }` plus:

```json
{
  "video": {
    "seconds": 42.3, "size": "1080×1920",
    "analysis": "ready",
    "captions": { "on": true, "preset": "viral-yellow", "language": "en", "lines": 38,
      "style": { "font": "sans-bold", "size": 64, "weight": 800, "color": "#FFFFFF", "case": "upper", "y": 0.72, "maxWords": 3, "anim": "pop", "highlight": "color" } },
    "lines": [{ "id": "l3", "start": 4.2, "end": 5.9, "text": "This is how we grow" }],
    "grade": { "kind": "brand look", "look": "Warm film", "strength": 80, "exposure": 0, "temp": 15, "sat": -5, "matchedAvailable": true },
    "brandLooks": [{ "id": "lk1", "name": "Warm film" }],
    "audio": { "originalVolume": 100, "music": { "name": "Chill · take 2", "volume": 60, "ducking": true } }
  }
}
```

- `analysis`: `running` (with the step and its percent, e.g. "transcribing 40%"), `ready`, `failed` (with the failed step), or `no video` (a blank video design).
- `lines`: the first 120 lines, times in seconds with one decimal; when there are more, `"moreLines": true`.
- Grade and volumes are in the sliders' units (−100 to 100, 0 to 100).
- The picture attached to the user's message is `view_frame`'s default frame when it can be read, else none.

## Tools

All times are seconds; the studio converts to milliseconds. Every tool that changes the video runs inside one `mutate`, so the run stays one Undo step (phase 1 `finishUndo`). While `analysis` is not `ready`, the caption and grade tools return "The video is still being analysed (<step> <percent>%). Try again when it is done." and change nothing; `set_audio` works.

### `read_captions`

`{ from?, to? }` (seconds). Returns the lines overlapping the range as JSON (id, start, end, text), at most 200.

### `edit_captions`

`{ edits: [ … ] }`, each one of:

| `action` | Fields | Uses |
| --- | --- | --- |
| `text` | `id`, `text` | `retext` (words re-timed across the line) |
| `delete` | `id` | filter |
| `merge` | `id` (merged with the next line) | `merge` |
| `split` | `id`, `atWord` (index of the first word of the second part, ≥ 1) | `split` at that word's start |
| `retime` | `id`, `start`, `end` | `retime`, kept inside the video and away from the neighbours |
| `add` | `start`, `end`, `text` | `addLine` |

- Applied in order, inside one `VS.captions.edit`; a failing edit is skipped and named in the result ("l7: no such line"; "l3: atWord out of range"); the others apply.
- At most 100 edits per call. A text over 300 characters is clipped.
- The result lists what changed and the ids of new lines.

### `style_captions`

`{ on?, preset?, style? }`.

- `on`: `toggleCaptions`.
- `preset`: a key of `caption-presets.js` (the tool's `enum`); `applyPresetTo` (it keeps position and grouping, as the panel does).
- `style`: fields `font`, `size`, `weight`, `color`, `case`, `y`, `x`, `align`, `maxWords`, `maxChars`, `lines`, `anim`, `highlight.mode`, `highlight.color`, `stroke`, `box`. Each goes through `setStyleField`, so values are checked and clamped as in the inspector; rejected values are named in the result. A preset given with style fields is applied first.
- `maxWords` or `maxChars` regroup the lines (`regroup`), as the inspector does; for speech captions this fetches the words from the server first. When the lines were edited by hand, regrouping is refused with "Regrouping would undo hand edits to the lines; ask the user" (the inspector asks the user here; the agent does not decide it).

### `set_grade`

`{ look?, strength?, exposure?, temp?, sat? }`.

- `look`: `"matched"` (only when `matchedAvailable`), `"none"` (`gradeReset` and no LUT), or a brand look id from `brandLooks` (`applyLook`). Applied before the sliders.
- Sliders: −100 to 100 (strength 0 to 100), clamped, through `sliderToGrade`.
- Applying a brand look whose caption style differs follows `applyLook`'s own rule; when that rule would ask the user, the tool applies the grade only and says so.

### `set_audio`

`{ originalVolume?, music? }` with `music` one of:

- `{ remove: true }`
- `{ volume?, ducking? }` on the current music
- `{ compose: "upbeat" | "chill" | "corporate" | "cinematic", volume?, ducking? }`: composes a track as long as the video with `composer.js`, uploads it as the music picker does, then sets it.

Volumes are 0 to 100. Composing takes a few seconds and shows the step "Composing music"; it fails with the upload's own error (e.g. the 12 MB limit).

### `view_frame` in `video`

`{ at? }` (seconds; default 40 % of the video). Draws the video frame at that time and the captions on top (`captions.js` `draw`) on a canvas and returns a JPEG. When the browser cannot read the video's pixels (no cross-origin permission on the proxy file), it returns "This frame can't be read here" and the run continues.

## Prompt

Added in `video` mode:

- The design is an uploaded video with captions, a colour grade and sound. You cannot change the footage itself, trim it, or re-transcribe it.
- Keep caption lines short: at most the style's words per line, about 1 to 2 seconds each.
- Fix spelling and punctuation in captions; never change what was said beyond that unless the user asks.
- After changing the caption style or position, call view_frame once to check it is readable and clear of the face and the platform's buttons (keep y between 0.15 and 0.8).
- For Arabic captions use the ar- presets.
- Grade gently: small slider moves (10 to 25) unless the user asks for a strong look.
- When the analysis is not ready, say so and stop.

## Architecture

### Backend

- `backend/src/ai/agent.ts`: `AgentMode` gains `"video"`; the five new tools; `view_frame` tagged `animate` and `video`; `write_caption`, `rename_design` and the planning tools tagged with all three modes; `VIDEO_PROMPT`; `agentSystemPrompt` adds it in `video` (and the plan section, as in the other modes; no `MAKE_VIDEO_HINT` in `video`).
- `backend/src/ai/dto/ai.dto.ts`: `mode` accepts `"video"`.
- Tests: `toolsFor('video')` is exactly the 11 tools; `design` and `animate` unchanged (22); the prompt.

### Frontend

- `frontend/studio/agent-video.js` (new, pure, unit-tested in `agent-video.test.js`):
  - `videoCtx({ d, rec, analysis, style, looks, maxLines }) → object` (the `video` block)
  - `captionEdits(lines, edits, durMs) → { lines, done: string[], notes: string[] }` using `captions.js` helpers
  - `gradeInput(look, input) → { look, notes }` (sliders to stored values, clamped)
  - `audioInput(audio, input) → { audio, compose?: { mood }, notes }`
  - `linesIn(lines, from, to, max) → array`
- `frontend/studio/agent-motion.js`: `agentMode('video', …)` returns `'video'`; `allowed` covers the third mode (`VIDEO_ONLY` set; tools of other modes refused in `video`).
- `frontend/studio/video-studio.js`: Agent at the bottom of the video rail; `panelFor('video', …, 'agent')`.
- `frontend/studio/footage-editor.js`: exposes on `FT` (or a new `FT.agent`) what the tools need: the session's record and analysis, `gradeCommit`-equivalent for a whole look, `applyLook(id, { quiet })`, `useMatched({ quiet })`, `setAudio(fn)`, `regroup`-equivalent, and `frameAt(ms, scale)`. `quiet` skips the confirm dialogs and toasts and reports instead of asking.
- `frontend/studio/engine.js`: `RT.composeMusic(mood, seconds) → Promise<music record>` extracted from the music picker's compose path, used by both the picker and the agent; the agent block's context, picture and the five tools.

## Errors and edge cases

- Analysis running: caption and grade tools refuse (above); `view_frame` works when the frame can be read.
- Analysis failed: the tools refuse with the failed step; the agent tells the user to use Retry in the panel.
- A blank video design (no `src`): every tool except `rename_design`, `write_caption` and the planning tools returns "Add your video first".
- Captions off: `edit_captions` still edits the lines; the result reminds that captions are off.
- The user edits captions by hand during a run: the next tool reads the current lines (ids may be gone: named in the result).
- Composing music fails or is slow: the run waits for it (it is one step); Stop cancels the run and keeps changes made so far as one Undo step.
- `view_frame` on a video whose proxy URL has expired: the editor's existing proxy refresh runs first; if it fails, the frame can't be read.

## Testing

- `agent-video.test.js`: every `captionEdits` action and its errors (unknown id, `atWord` out of range, retime outside the video or over a neighbour, clipping), applied in order; `videoCtx` (analysis states, line cap and `moreLines`, units); `gradeInput` (clamps, unknown look); `audioInput` (remove, volume, ducking, compose moods, unknown mood); `linesIn`.
- `agent-motion.test.js`: `agentMode('video', …)`, `allowed` in three modes.
- `video-studio.test.js`: the video rail ends with Agent.
- `agent.test.ts`: as above.
- By hand, with an AI key and an uploaded video whose analysis is done: the six example requests of the goal, each then one Undo; a request during analysis; `view_frame` (and whether the frame can be read: reported either way).
