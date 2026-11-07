# Video Studio — design

Date: 2026-11-07 · Workspace: Social Media Admin (Studio) · Status: approved in chat, awaiting spec review

## Goal

One **Video Studio** editor for every video design. Motion reels (scenes, templates) and imported videos
(footage) open in the same frame, with the same rail, panels, timeline, transport and icons. Captions get a
full workflow like a dedicated caption tool: a style preset library, fine style tabs, script and SRT/VTT
import, auto-transcription, and copying the style from a reference video.

Success:

- Open a motion reel and an imported video one after the other: the frame, the rail items they share
  (Captions, Styles, Script, Audio, Agent), the transport and the timeline look and behave the same.
- From an empty studio, drop a talking-head video, get Arabic or English captions automatically, apply the
  "Karaoke" preset, nudge the size and position, export: the MP4 matches the preview.
- On a motion reel with a voice-over, turn captions on: lines follow the voice-over script, with the same
  presets and animations as on a video.
- Paste a script on a video with speech: every line gets the timing of the spoken words.

### Decisions taken

| Question | Decision |
| --- | --- |
| Scope | One editor frame for **both** motion reels and imported videos |
| Mixing | A project is **either** a motion reel **or** an imported video in v1. No intro/outro around a video, no multi-clip timeline |
| Architecture | A shared **studio shell** (rail, side panel, inspector, transport, track timeline). Motion and video are *sources* that plug into it. Captions, Styles, Script and Audio are built once and shared |
| Captions storage | `d.captions` on the design, for both kinds. Footage designs move `d.footage.captions` there on first open |
| Caption engine | `frontend/studio/captions.js` stays the single renderer: preview of both kinds, motion export, and the server footage export (byte-identical copy via sync-shared) |
| Presets | ~30 built-in presets as pure data in `caption-presets.js`, in categories, plus brand styles saved in the brand kit |
| Reference | Optional. Import works without a reference or brand look; the grade step is skipped and a Look can be added later |
| Exports | Unchanged paths: server ffmpeg export for videos, browser recording for motion reels. Both draw the new caption styles and animations |

### Out of scope (v1)

Mixing motion scenes with an imported video, several video clips, cutting or trimming the video, translated
captions, per-line styles (one style per design), and fonts uploaded by the user.

## Layout

```
┌ top bar: back · name · kind pill (Video / Reel) · undo/redo · search ······· Preview · Schedule · Export ┐
├ rail ┬ side panel ─────┬ stage (preview) ─────────────────────────────┬ inspector ─────────────┤
│ icons│ content of the  │  the frame at the output ratio               │ follows the selection │
│      │ rail item       │  transport: back 5 s · play · fwd 5 s · time  │                       │
│      │                 │  · Before/After (video) · loop (reel)         │                       │
├──────┴─────────────────┴──────────────────────────────────────────────┴───────────────────────┤
│ timeline: ruler · zoom (− + fit) · tracks: Video|Scenes · Captions · Voice · Music · playhead     │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Rail

| Item | Icon | Video | Reel | Side panel |
| --- | --- | --- | --- | --- |
| Media | film | ✓ | | The video: name, length, size, Replace video. Empty project: drop zone |
| Templates | layout | | ✓ | As today |
| Motion | film37 | | ✓ | As today (scene starters) |
| Captions | cc | ✓ | ✓ | Caption lines: search, timestamps, inline edit, add line, split/merge/delete, Re-transcribe (video), "Captions on/off" |
| Styles | palette | ✓ | ✓ | Preset grid by category, search, Recent, Brand styles, "Save as brand style" |
| Script | doc | ✓ | ✓ | Paste script (aligned or spread), Open SRT/VTT, Download SRT |
| Audio | music | ✓ | ✓ | Video: original sound volume, music bed, ducking. Reel: as today (music, voice-over per scene) |
| Look | color filter | ✓ | | Colour grade (today's Look panel) and "Match a reference" |
| Elements, Text, Brand, Figma, Live data, Components | as today | | ✓ | As today |
| Agent | sparkles | ✓ | ✓ | As today |

Rail order: the kind's own items first (Media or Templates/Motion), then Captions, Styles, Script, Audio,
then the rest. The rail never shows an item that does nothing for the kind.

### Inspector (right)

Follows the selection:

- **A caption line or the Captions/Styles panel open** → caption style tabs, 4 × 2 icon grid:
  Font, Colors, Spacing, Layout, Box, Animate, Timing, Reference.
- **The video track** → Look (grade sliders, brand looks).
- **A scene or a layer of a reel** → today's Scene / layer properties.

Each tab is short (no scroll on a 900 px tall window):

| Tab | Controls |
| --- | --- |
| Font | Family (stacks incl. Arabic), weight, size, case (Aa / AA) |
| Colors | Text, active word (highlight) text and fill, outline colour + width, shadow colour + blur |
| Spacing | Letter spacing, line height, words per line, max characters, max lines |
| Layout | Vertical position (also by dragging on the frame), horizontal position, alignment, safe-zone guide toggle |
| Box | Background box on/off, colour, opacity, padding, radius; highlight mode (box, colour, scale, none) |
| Animate | None, Fade, Pop, Karaoke, Word by word, Typewriter, Bounce, Slide up; speed |
| Timing | Offset (± 1 s), minimum line duration, gap between lines |
| Reference | Copy the style from a reference video (upload), or from a saved brand look |

### Timeline

One shared component for both kinds (it replaces the footage lane and hosts the motion scene strip):

- Ruler with time labels, zoom out / zoom in / fit, scroll that follows the playhead, click or drag to
  seek. Same behaviour as the footage lane shipped on 2026-11-07.
- Track headers with an icon and a name; each track can be hidden from the preview (eye) except Video/Scenes.
- **Video** (video kind): the clip with its poster frames. **Scenes** (reel): today's scene blocks.
- **Captions**: one block per line, drag to move, drag the edges to retime, current line highlighted.
- **Voice**: waveform of the video's sound, or the reel's voice-over clips.
- **Music**: the music bed, or "+ Add music".
- Motion layer lanes (reel) stay below, collapsed by default.

### Empty states

- New video project: the stage shows a large drop zone "Add your video" (MP4, MOV, up to 10 min), with
  "or open from Media". The Captions panel shows two steps: 1. Add your video, 2. Add captions (Auto
  from speech, Paste script, Open SRT/VTT).
- Reel without voice-over: the Captions panel explains that captions come from the voice-over script,
  with a button to open Audio.

## Data model

### Kinds

`kindOf(d)` returns `'video'` when `d.footage` exists, else `'reel'` when the design is a motion design,
else `'still'` (posts and carousels keep today's editor; the shell only takes over video kinds).

### Captions

```js
d.captions = {
  on: true,                 // shown in preview and export
  lines: [{ id, start, end, words: [{ t, s, e }] }],   // ms, as today
  style: { ...CaptionStyle },
  preset: 'karaoke-gold' | null,   // the preset the style came from; null once edited ("Custom")
  source: 'speech' | 'script' | 'srt' | 'voiceover' | 'manual',
  lang: 'ar' | 'en' | ... | null,
}
```

- Footage designs: on open, if `d.footage.captions` exists and `d.captions` doesn't, it moves over in one
  `mutate()` (`styleFrom` maps to `preset: null`). The footage export reads `d.captions`, falling back to
  `d.footage.captions` for designs never opened since.
- Reels: `d.audio.captions` (today a boolean) becomes `d.captions.on`; lines are rebuilt from the
  voice-over (below) whenever a scene's voice-over text or audio changes, unless the user edited them
  (`source: 'manual'`), in which case a "Rebuild from voice-over" button appears.

### Caption style

`CaptionStyle` extends today's `DEFAULT_STYLE` (all new fields optional, defaults keep today's rendering
identical, so stored designs render as before):

| Field | Default | Note |
| --- | --- | --- |
| `ls` | 0 | letter spacing, em |
| `lh` | 1.15 | line height |
| `x` | 0.5 | horizontal centre, 0–1 of width |
| `align` | 'center' | left, center, right |
| `boxOpacity` | 1 | |
| `anim` | 'none' | none, fade, pop, karaoke, word, typewriter, bounce, slide |
| `animSpeed` | 1 | 0.5–2 |
| `offset` | 0 | ms, applied at draw time |
| `minDur` | 600 | ms, used by grouping |
| `gap` | 0 | ms between lines, used by grouping |

`highlight.mode: 'karaoke'` is not added: Karaoke is an animation that uses the highlight colours.

### Presets

`frontend/studio/caption-presets.js`: `PRESETS = [{ id, name, cat, style }]`, `CATEGORIES`, `applyPreset(style, id)`
(keeps the user's position `y`/`x` and `maxWords` unless the preset sets them). Categories: Bold and viral,
Karaoke, Clean, Cinematic, Boxed, Neon, Arabic. Previews in the grid are drawn with `captions.draw()` on
a small canvas over a neutral frame, with a sample line in the caption language (Arabic sample when
`lang` is Arabic).

Brand styles: `brand().captionStyles = [{ id, name, style }]`, max 20, saved through the existing brand save.
Brand looks keep their own `captionStyle` as today and appear in the Brand section of the grid too.

## Caption sources

| Source | How lines are made |
| --- | --- |
| Speech (video) | Today's local Whisper words → `group(words, style)` |
| Voice-over (reel) | Per scene: the voice-over text split into words, timed proportionally to character count across `vo.dur`, starting at the scene start + `LEAD` |
| Paste script | If speech words exist: align the script words to them (normalized-token sequence alignment, Arabic diacritics and punctuation ignored); a script word with no match gets the time between its neighbours. Without speech words: spread over the duration (video) or the voice-over (reel). Line breaks in the script are kept as line breaks |
| SRT / VTT | Parsed cues keep their times; words inside a cue are spread by character count. Styling tags are stripped |
| Manual | Add line at the playhead (today's `addLine`) |

Export of the lines: "Download SRT" in the Script panel.

## Rendering and export

- `captions.js` gains: the new style fields, the new animations in `animAt`, `changeTimes` covering
  them (so the export renders the frames where the drawing changes), and `offset`.
  Backend keeps a byte-identical copy through `scripts/sync-shared.mjs` (as today).
- Video preview: `footage-player.js` draws `d.captions` (unchanged API, new style fields).
- Reel preview and export: the motion canvas renderer calls `captions.draw()` after the scene layers when
  `d.captions.on`. The browser recording therefore includes captions.
- Video export: unchanged pipeline (headless Chromium render with `captions.js`, ffmpeg overlay); it reads
  `d.captions`.

## Import without a reference

- The "Add video" drop zone and Media → Replace video upload with today's `uploadFootage` (resumable)
  and create the footage record without `pair`.
- Backend: the `grade` step becomes `skipped` (not failed) when the record has neither `ref` nor `lookId`;
  `caption-style` is skipped too. `canExport` treats `skipped` like `done`.
- Look → "Match a reference" uploads a reference, calls `POST /footage/:id/pair`, and retries `grade`
  and `caption-style` (endpoints exist). A brand look can be applied without any upload (as today).
- The Studio → Videos tile "Match a reference" stays and opens the same upload window; a new tile
  "Caption a video" opens an empty video project straight on the drop zone.

## Code structure

| File | Role |
| --- | --- |
| `studio/video-studio.js` (new) | The shell: rail model per kind, side panel host, inspector host, transport, kind detection, wraps the editor drawing (via `wrapEd`) for `video` and `reel` kinds |
| `studio/timeline.js` (new) | The track timeline: ruler, zoom/scroll, playhead, track headers, caption track drag (moved out of `footage-editor.js`), hosts the scene strip and audio clips |
| `studio/caption-panels.js` (new) | Captions, Styles, Script panels and the caption inspector tabs; works on `d.captions` only |
| `studio/caption-presets.js` (new) | Pure data + `applyPreset` |
| `studio/caption-sources.js` (new) | Pure: voice-over → lines, script alignment, SRT/VTT parse and write |
| `studio/captions.js` | New style fields and animations |
| `studio/footage-editor.js` | Keeps the video source: player, Look, analysis polling, export window. Loses its own transport, lane and Subtitles panel |
| `studio/engine.js` | Motion editor registers as the reel source (stage, scene track, audio clips); its own transport and timeline header move to the shell. Rail entries come from the shell for video kinds |

Each new file is pure where it can be (presets, sources) so it is unit-tested without a DOM.

## Error handling

- Video won't decode in the browser (codec): the proxy is used as today; the drop zone message says the
  file is being prepared.
- Transcription fails or finds no speech: the Captions panel offers Paste script and Open SRT instead of a
  dead end.
- Invalid SRT/VTT: "This file has no readable captions" and nothing changes.
- Script alignment matches under 40 % of the words: lines are spread instead, with a note.
- No Claude key for Reference: today's note, the default style is kept.
- Every caption change is one `mutate()` step (undo/redo), as today.

## Testing

- Unit (vitest): `caption-presets` (every preset is a valid style, `applyPreset` keeps position),
  `caption-sources` (voice-over timing, script alignment incl. Arabic, SRT/VTT parse/write round trip),
  `captions.js` (new animations at given times, `changeTimes`, offset; old designs render unchanged),
  migration of `d.footage.captions` → `d.captions`, rail model per kind.
- Backend: grade/caption-style `skipped` without a pair; export reads `d.captions` with the fallback.
- Browser checks: open a reel and a video and compare the frame; import a video with no reference; apply a
  preset and export; reel with voice-over and captions on, recorded export shows them.
- Existing footage e2e parity test (preview vs export) runs with a preset using each new animation.
