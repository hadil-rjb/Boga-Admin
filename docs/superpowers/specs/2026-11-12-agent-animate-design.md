# Studio Agent, phase 1: tool sets per mode and the Animate agent

Date: 2026-11-12
Status: draft for review

## Goal

One Studio Agent that works in every editor mode. This phase gives it a tool set per mode and makes it able to animate: it appears in Animate mode on an animated design (reel), animates layers, builds and times scenes, and looks at a frame of the video to check its work.

Success: with a reel open in Animate mode, the user asks "animate this scene", "make it a 15 second video with an intro and an outro" or "slow the title down", and the agent does it with tools. One run is one Undo step. In Design mode the agent behaves exactly as today.

## The whole project, and what this phase is

Decided with the user: one agent, in the studio only, for static design, animation, video, scheduling and automation. Anything that publishes is proposed in the chat and happens only on Confirm. It is built in three phases, each with its own spec, plan and release:

| Phase | Adds |
| --- | --- |
| 1 (this spec) | Tool sets per mode; the agent in Animate mode on a reel; animation and scene tools |
| 2 | Reading the planner; schedule and automation proposal cards with Confirm and Edit |
| 3 | Uploaded videos: caption, grade and audio tools. Music, voice-over and captions on a reel |

Not in this phase: anything in phases 2 and 3, an agent outside the editor, an agent that runs with no tab open, changes to the Overview's prompt box, changes to the rule-based actions used when no AI key is set.

## What exists today

- `backend/src/ai/agent.ts`: `AGENT_TOOLS` (18 layer and slide tools), `AGENT_PROMPT`, the provider-neutral conversation, `cleanMessages`. `ai.service.ts` `agentStep` sends every tool on every turn.
- `frontend/studio/engine.js`, v25 block: the loop runs in the browser. Each turn posts `{ provider, model, context, messages }` to `/api/ai/agent`, runs the returned calls through the table `T`, and sends the results back. `STEP` holds the label shown for each call. A run is one Undo step (`finishUndo`).
- `frontend/studio/video-studio.js`: `railFor(kind, mode)`. The Agent item is in `DESIGN_FOOT`, so it is drawn in Design mode only. The editor modes spec (2026-11-11) says "Agent is a Design-mode item only"; this spec replaces that sentence for reels.
- `frontend/studio/motion.js`: the animation model. A layer's `anim` is `{ in, d, t, e, out, ot, loop }` (presets in `ENTER`, `EXIT`, `LOOP`, easings in `EASES`). A page's `scene` is `{ k, dur, tr, trd }` (`KINDS`, `TRANSITIONS`). `autoAnimate` is Magic animate. `STARTERS` is the scene library.
- `engine.js`, motion block: `toMotion`, `addScene`, `dupScene`, `delScene`, `moveScene`, `order`, `setAnim`, `previewScene`, `exitPreview`, and the frame renderer used by `record`.

## Approach

One agent, one loop, one endpoint. Each tool is tagged with the modes it belongs to, and the server sends only the tools of the mode the editor is in. The model sees about 20 tools per turn whatever the project grows to, and never sees a tool that cannot work on the open design.

Rejected: one flat list of every tool (more tokens each turn, calls that fail in the wrong mode); separate specialist agents behind a router (several prompts to maintain, context lost at each handoff).

## Modes and tool sets

The studio sends the agent's mode with every turn. It is derived, never chosen by the user:

| Open design | Editor mode | Agent mode |
| --- | --- | --- |
| still | Design | `design` |
| reel | Design | `design` |
| reel | Animate | `animate` |
| uploaded video | Animate | no agent in this phase |

Because the mode travels with each turn, a run can change mode: after `make_video` on a still, the next turn of the same run is sent as `animate` and gets the Animate tools.

| Tool | `design` | `animate` |
| --- | --- | --- |
| `update_layers`, `add_layers`, `delete_layers`, `duplicate_layers`, `arrange_layers`, `align_layers`, `set_background` | yes | yes |
| `rename_design`, `write_caption`, `select_layer`, `get_slide`, `view_slide`, `view_reference`, `check_design` | yes | yes |
| `manage_slides`, `resize_canvas`, `apply_brand_template`, `build_live_slide` | yes | no |
| `make_video` (new) | yes, on a still only | no |
| `animate_layers`, `auto_animate`, `manage_scenes`, `set_scene`, `view_frame` (new) | no | yes |

`design` has 19 tools, `animate` has 19.

In `animate`, a page is called a scene: `page` and `index` parameters mean the scene number, and `get_slide` / `view_slide` read a scene with every layer at its final state.

## New tools

All times the model gives and reads are in seconds; the studio converts to the model's milliseconds.

### `make_video` (design, still only)

No parameters. Turns the open still into an animated design with the existing `toMotion` step and switches the editor to Animate mode, as the top bar's Animate button does. Result: "The design is now a video with N scene(s). You are in Animate mode." On a reel it fails with "This design is already a video."

### `animate_layers`

`{ scene?, updates: [{ id, anim }] }`, where `anim` may hold:

| Field | Meaning | Stored as |
| --- | --- | --- |
| `enter` | Entrance preset (a key of `ENTER`) | `in` |
| `exit` | Exit preset (a key of `EXIT`) | `out` |
| `loop` | Loop preset (a key of `LOOP`) | `loop` |
| `delay` | Seconds after the scene starts | `d` |
| `duration` | Entrance length in seconds | `t` |
| `exitDuration` | Exit length in seconds | `ot` |
| `ease` | Easing (a key of `EASES`) | `e` |

Only the fields given change; the rest of the layer's `anim` is kept (`MO.anim(l)` supplies defaults). Limits, the same as dragging a layer's bar in the timeline: `duration` from 0.1 s to the scene's length, `delay` from 0 to the scene's length minus the duration, `exitDuration` from 0.1 s to the scene's length. Values outside are clamped and the result says so. An unknown preset or easing is not applied and the result names it and lists the valid keys. Result: "Animated N layer(s)." plus the notes.

### `auto_animate`

`{ scenes?: 'current' | 'all' | number }` (default `current`). Runs `MO.autoAnimate` on those scenes, as Magic animate does. Result: "Animated scene 2 (6 layers)." or "Animated every scene (4)."

### `manage_scenes`

`{ action: 'add' | 'duplicate' | 'delete' | 'move' | 'go', index?, to?, role?, starter? }`.

- `add`: inserts a scene after `index` (default: the current scene). `role` is `intro`, `body` or `outro` (default `body`); `starter` is a key of `STARTERS[role]` (default `blank`), built in the brand's look with the existing `addScene`. The tool description lists the starter keys per role.
- `duplicate`, `delete`, `move`, `go`: the existing `dupScene`, `delScene`, `moveScene` and the scene jump.
- Scenes stay ordered intro, scenes, outro (`order`), so the result always gives the scene's final number: "Added an intro as scene 1; it is now the current scene."
- Limits: 20 scenes at most; a video keeps at least one scene.

### `set_scene`

`{ scene?, seconds?, transition?, transitionSeconds?, role? }`. Sets the scene's length (`dur`), its transition in (`tr`, a key of `TRANSITIONS`) and the transition's length (`trd`), and its role (`k`). Limits: a scene lasts 0.5 to 60 s, as in the timeline; a transition lasts 0.1 s to half the scene's length. Values outside are clamped and the result says so. Shortening a scene also clamps its layers' delays and durations to fit. The first scene has no transition: asking for one returns a note and changes nothing. Changing the role re-orders the scenes; the result gives the new number.

### `view_frame`

`{ at?, scene?, offset? }`. Returns a JPEG (long side at most 1000 px) of the video at a moment: `at` is seconds from the start of the video; or `scene` with `offset` seconds into it (default: the current scene, 60 % of its length). Rendered with the same frame renderer the recording uses, so transitions and half-finished entrances show as they play. The text of the result says where the frame is: "Frame at 4.2 s: scene 2, 1.2 s in."

## What the model sees

In `animate` the context gains:

- `design.mode: "animate"`, and `design.scenes` replaces `design.slides` in meaning (same counts).
- `video: { fps, seconds, scenes: [{ number, role, start, seconds, transition, transitionSeconds }] }`.
- Each layer in the layer lists gains `anim: { enter, delay, duration, ease, exit, exitDuration, loop }` when it has an animation other than the default "none".

In `design` the context is as today plus `design.mode: "design"` and `design.kind: "still" | "video"`.

The picture attached to the user's message in `animate` is the frame `view_frame` would return by default, not the static slide.

## Prompt

`agentSystemPrompt(context, mode)` returns the current prompt, plus the design system section as today, plus an Animate section when `mode === 'animate'`:

- The design is a video made of scenes; each scene is a slide whose layers animate. Layer tools change what a scene shows; animation tools change how it moves.
- Start from `auto_animate` for a scene with no animation, then adjust single layers with `animate_layers`.
- Order entrances by reading order, most important first. Keep delays short enough that everything is on screen with time left to read it: about 60 % of the scene's length at most.
- A scene needs time to be read: about 2 to 5 seconds. Change a scene's length rather than rushing its layers.
- After changes to motion that matter, call `view_frame` once and fix what is wrong. A layer that should be visible and is not usually has a delay longer than the scene.
- Live data scenes keep their live texts.
- When the user asks for a length, make the scenes add up to it and say the final length.

In `design` on a still, one line is added: when the user asks to animate or to make a video, call `make_video` first.

## Architecture

### Backend

- `backend/src/ai/agent.ts`
  - `AgentTool` gains `modes: AgentMode[]`, with `AgentMode = 'design' | 'animate'`. Every existing tool is tagged; the six new tools are added.
  - `toolsFor(mode)` returns the tools of a mode.
  - `ANIMATE_PROMPT` and `agentSystemPrompt(context, mode)`.
  - `cleanMessages` keeps accepting every tool name, whatever the mode, because a conversation can cross modes.
  - The preset, easing, transition and starter keys are written into the tool descriptions. The studio is the authority: it validates against `motion.js` and answers an unknown key with the valid ones, so a list that drifts costs one extra turn and never corrupts a design.
- `backend/src/ai/dto/ai.dto.ts`: `AgentStepDto` gains `@IsOptional() @IsIn(['design', 'animate']) mode`. Missing means `design`, so an older studio tab keeps working.
- `backend/src/ai/ai.service.ts`: `agentStep` uses `toolsFor(d.mode ?? 'design')` and `agentSystemPrompt(d.context, mode)` for both providers.

### Frontend

- `frontend/studio/agent-motion.js` (new, pure, no DOM): everything about the new tools that can be tested without the editor.
  - `agentMode(kind, editorMode)`: `'design' | 'animate' | null`.
  - `animPatch(layer, input, sceneMs)`: `{ anim, notes }`; maps the model's field names and seconds to the stored `anim`, clamps, rejects unknown keys.
  - `scenePatch(scene, input, isFirst)`: `{ scene, notes }`, same idea for `set_scene`.
  - `animOut(layer)`: the `anim` shown to the model, or `undefined` when it is the default.
  - `videoCtx(pages, fps)`: the `video` block of the context.
  - `frameTime(timeline, input, currentIndex)`: `{ ms, scene, offsetMs }` for `view_frame`.
- `frontend/studio/engine.js`
  - v25 block: `context()` adds the mode and, in `animate`, the video block and each layer's `anim`; the request body carries `mode`; the user message's picture comes from the frame renderer in `animate`. `T` and `STEP` gain the six tools; each is a thin wrapper around the helpers above and the motion block's existing functions. A call to a tool that is not in the current mode's set returns "Error: not available in this mode", so a stale call cannot act.
  - Motion block: exposes what the tools need on `RT.motion` next to `play`, `pause`, `exitPreview`, `record`: `toMotion` (as the Animate button runs it), `addScene`, `dupScene`, `delScene`, `moveScene`, `order`, `previewScene`, and `frameAt(ms, scale)` which returns a JPEG blob: it runs the recording's own `prepare` and `frame(ctx, d, prep, tl, t, s)` on an off-screen canvas. The prepared assets are kept for the length of a run, so several `view_frame` calls prepare once.
  - Agent panel: in `animate` the header reads "Edits scene 2 of 5", the scope chip reads "Scene 2" / "All 5 scenes", the placeholder and the empty state speak of animation, and the quick prompts are "Animate this scene", "Animate every scene", "Add an intro and an outro".
- `frontend/studio/video-studio.js`: `railFor('reel', 'animate')` ends with the Agent foot item. `panelFor` keeps the key `agent` in the current mode on a reel, where it switches to Design today. A video's rail is unchanged.
- `frontend/studio/reel-source.js`: while the agent panel is open in Animate mode the player stays mounted.
- `frontend/styles/studio.css`: the Agent foot item in the Animate rail. No new components.

## Data flow of a run in Animate mode

1. The user sends a message. The studio stops playback (`exitPreview(true)`), takes the Undo snapshot, and posts the turn with `mode: 'animate'`, the context and the default frame.
2. The server answers with text and calls from the Animate set.
3. The studio runs each call. Tools that change the design stop playback first and go through `mutate`, as the panels' own actions do. `view_frame` renders without touching the player's position.
4. Results go back; steps 2 to 4 repeat, 16 turns at most, as today.
5. When the run ends, the changes become one Undo step. If the run changed any animation or scene, the studio plays the current scene once (`previewScene`), as Magic animate does.

## Errors and edge cases

- The user switches mode during a run: the run continues; the next turn is sent with the new mode.
- The user switches to another design or leaves the editor: the run is cancelled, as today.
- Undo of a run that called `make_video` makes the design a still again and the editor returns to Design mode (existing behaviour of `mo37Make`).
- A read-only user (`canEdit()` false) cannot send, as today.
- `view_frame` when the renderer fails: "The frame could not be rendered." The run continues.
- A tool call with a scene number that does not exist: "There is no scene N."
- Deleting the scene that is playing: playback is already stopped by the tool; the current scene becomes the nearest one.
- No AI key: the Agent item is still drawn in the Animate rail; the panel shows the existing "No AI model" chip and its setup link. The rule-based actions are for static designs and are not offered in `animate`.
- An older backend with a newer studio is not supported (they ship together). A newer backend with an older tab: `mode` is missing, the tab gets the Design set, as today.

## Testing

- `backend/src/ai/agent.test.ts`: `toolsFor` returns the table above for each mode; every tool has at least one mode; `agentSystemPrompt` includes the Animate section only for `animate`; `cleanMessages` keeps calls to Animate tools.
- `frontend/studio/agent-motion.test.js`: `agentMode` for every kind and mode; `animPatch` (field mapping, seconds to ms, clamping, unknown preset, untouched fields kept); `scenePatch` (first scene has no transition, clamping, role); `animOut` (default hidden); `videoCtx` (starts and lengths match `MO.timeline`); `frameTime` (`at`, `scene` + `offset`, default, out of range).
- `frontend/studio/video-studio.test.js`: the Animate rail of a reel ends with Agent; a video's rail has no Agent; `panelFor` keeps `agent` in Animate mode on a reel.
- By hand, with a Claude key: on a reel, "animate this scene" then Undo; "make it 15 seconds with an intro and an outro"; on a still, "turn this into a video" then Undo; Stop in the middle of a run keeps the changes as one Undo step.

## What the next phases plug into

- Phase 2 adds tools tagged for both modes (`read_planner`, `propose_schedule`, `propose_automation`) and a card in the chat message; no change to the loop.
- Phase 3 adds a third mode, `video`, with its own tools and context, and audio and caption tools tagged `animate` and `video`.
