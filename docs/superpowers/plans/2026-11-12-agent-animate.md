# Studio Agent Phase 1 (Tool Sets per Mode, Animate Agent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Studio Agent gets a tool set per editor mode and works in Animate mode on an animated design: it animates layers, builds and times scenes, and looks at a frame of the video.

**Architecture:** The loop stays in the browser (`engine.js`, v25 block) and the endpoint stays `/api/ai/agent`. Each tool in `agent.ts` is tagged with its modes; the studio sends `mode` with every turn and the server sends only that mode's tools and prompt. Everything about the new tools that needs no DOM lives in a new pure module, `agent-motion.js`; the tools in `engine.js` are thin wrappers around it and around the motion block's existing functions, exposed on `RT.motion`.

**Tech Stack:** NestJS + class-validator (backend), vanilla ES modules in `frontend/studio/` (Next.js host page), vitest on both sides.

**Spec:** `docs/superpowers/specs/2026-11-12-agent-animate-design.md`

## Global Constraints

- Design mode behaves exactly as today: same 18 existing tools with unchanged names, parameters and descriptions, same prompt text, same context fields (two fields are added: `design.mode`, `design.kind`).
- Agent modes are exactly `'design'` and `'animate'`. A request without `mode` is `design`.
- Tool sets: `design` = the 18 existing tools + `make_video` (19). `animate` = the existing tools minus `manage_slides`, `resize_canvas`, `apply_brand_template`, `build_live_slide`, plus `animate_layers`, `auto_animate`, `manage_scenes`, `set_scene`, `view_frame` (19).
- The model reads and writes seconds; designs store milliseconds. Model field names: `enter`, `exit`, `loop`, `delay`, `duration`, `exitDuration`, `ease` map to `in`, `out`, `loop`, `d`, `t`, `ot`, `e`.
- Limits: scene length 500 to 60000 ms; entrance `t` 100 ms to the scene's length; delay `d` 0 to scene length minus `t`; exit `ot` 100 ms to the scene's length; transition `trd` 100 ms to half the scene's length; 20 scenes at most; at least one scene.
- One agent run is one Undo step. Every change to a design goes through `mutate`.
- An uploaded video (`kind === 'video'`) has no Agent item and no agent mode.
- No data migration. Nothing new is saved in a design.
- Copy: sentence case, verbs first, no "please" or "successfully", no emoji.
- Do not commit unless the user asks. Each task ends with its tests green instead.
- Test commands: `cd backend && npx vitest run src/ai/agent.test.ts`; `cd frontend && npx vitest run studio/<name>.test.js`; everything: `cd frontend && npx vitest run studio` and `cd backend && npx vitest run`.

## Review Focus

1. A conversation that crosses modes (a still, then `make_video`, then Animate turns): earlier calls to `manage_slides` in the history must not be dropped or rejected by the server. (Task 1, `cleanMessages` test.)
2. The model sends a delay longer than the scene, or shortens a scene under its layers' timings: every layer must still appear inside the scene. (Task 2, `animPatch` and `fitAnims` tests.)
3. The model calls a Design-only tool while the editor is in Animate mode (stale habit or history): the call returns an error text and changes nothing. (Task 2 `allowed` test; Task 5 wiring.)
4. `view_frame` with a time past the end of the video, a negative time, or a scene that does not exist: clamped to the last frame, clamped to 0, and an error "There is no scene N" respectively. (Task 2, `frameTime` tests.)
5. An older studio tab posts without `mode` after the backend is deployed: it gets the Design set and prompt, as today. (Task 1, `toolsFor(undefined)` and DTO test.)

---

### Task 1: Backend: tools tagged by mode, the six new tools, the Animate prompt

**Files:**
- Modify: `backend/src/ai/agent.ts`
- Modify: `backend/src/ai/dto/ai.dto.ts` (`AgentStepDto`)
- Modify: `backend/src/ai/ai.service.ts:83-112` (`agentStep`)
- Test: `backend/src/ai/agent.test.ts`

**Interfaces:**
- Produces: `type AgentMode = 'design' | 'animate'`; `AgentTool` gains `modes: AgentMode[]`; `toolsFor(mode?: AgentMode): AgentTool[]`; `ANIMATE_PROMPT: string`; `MAKE_VIDEO_HINT: string`; `agentSystemPrompt(context: string, mode?: AgentMode): string`. Request body field `mode?: 'design' | 'animate'`.

- [ ] **Step 1: Write the failing tests** (new `describe('agent modes')` in `agent.test.ts`)

```ts
const names = (m?: any) => toolsFor(m).map((t) => t.name).sort();
const DESIGN_ONLY = ['manage_slides', 'resize_canvas', 'apply_brand_template', 'build_live_slide', 'make_video'];
const ANIMATE_ONLY = ['animate_layers', 'auto_animate', 'manage_scenes', 'set_scene', 'view_frame'];

it('gives each mode its 19 tools', () => {
  expect(names('design')).toHaveLength(19);
  expect(names('animate')).toHaveLength(19);
  DESIGN_ONLY.forEach((n) => { expect(names('design')).toContain(n); expect(names('animate')).not.toContain(n); });
  ANIMATE_ONLY.forEach((n) => { expect(names('animate')).toContain(n); expect(names('design')).not.toContain(n); });
  ['update_layers', 'add_layers', 'view_slide', 'check_design', 'write_caption'].forEach((n) => { expect(names('design')).toContain(n); expect(names('animate')).toContain(n); });
});
it('treats a missing mode as design', () => { expect(names(undefined)).toEqual(names('design')); });
it('tags every tool with at least one mode', () => { AGENT_TOOLS.forEach((t) => expect(t.modes.length).toBeGreaterThan(0)); });
it('adds the Animate section only in animate, and the make_video hint only in design', () => {
  expect(agentSystemPrompt('{}', 'animate')).toContain(ANIMATE_PROMPT);
  expect(agentSystemPrompt('{}', 'animate')).not.toContain(MAKE_VIDEO_HINT);
  expect(agentSystemPrompt('{}', 'design')).toBe(`${AGENT_PROMPT}\n\n${MAKE_VIDEO_HINT}`);
  expect(agentSystemPrompt('{}')).toBe(agentSystemPrompt('{}', 'design'));
});
it('keeps calls from both modes in one conversation', () => {
  const m = cleanMessages([{ role: 'user', text: 'hi' }, { role: 'assistant', calls: [{ id: 'a1', name: 'manage_slides', input: {} }, { id: 'a2', name: 'animate_layers', input: {} }, { id: 'a3', name: 'view_frame', input: {} }] }]);
  expect((m[1] as any).calls.map((c: any) => c.name)).toEqual(['manage_slides', 'animate_layers', 'view_frame']);
});
it('names the presets the studio knows in the tool descriptions', () => {
  const t = (n: string) => JSON.stringify(AGENT_TOOLS.find((x) => x.name === n));
  ['rise', 'slideUp', 'pop', 'zoom', 'wipe', 'fade'].forEach((k) => expect(t('animate_layers')).toContain(k));
  ['cut', 'fade', 'slide', 'push', 'zoom', 'wipe'].forEach((k) => expect(t('set_scene')).toContain(k));
  ['intro', 'body', 'outro'].forEach((k) => expect(t('manage_scenes')).toContain(k));
});
```

Update the three existing assertions that compare `agentSystemPrompt(x)` to `AGENT_PROMPT` with `toBe`: they now expect `${AGENT_PROMPT}\n\n${MAKE_VIDEO_HINT}` (and `toContain(DESIGN_SYSTEM_PROMPT)` is unchanged).

- [ ] **Step 2: Run** `cd backend && npx vitest run src/ai/agent.test.ts`. Expected: FAIL, `toolsFor` is not exported.

- [ ] **Step 3: Implement in `agent.ts`**

- Add `modes` to every existing tool per the Global Constraints table. Do not change their other fields.
- Add the six tools with these parameters (all optional unless marked):

| Tool | Parameters |
| --- | --- |
| `make_video` | none |
| `animate_layers` | `scene` (number, 1-based, default current); `updates` (required): `[{ id (required), anim (required): { enter, exit, loop, ease (strings); delay, duration, exitDuration (numbers, seconds) } }]` |
| `auto_animate` | `scenes`: `'current'`, `'all'` or a scene number, as a string |
| `manage_scenes` | `action` (required, enum `add`, `duplicate`, `delete`, `move`, `go`); `index`; `to`; `role` (enum `intro`, `body`, `outro`); `starter` (string) |
| `set_scene` | `scene`; `seconds`; `transition` (enum `cut`, `fade`, `slide`, `push`, `zoom`, `wipe`); `transitionSeconds`; `role` (enum `intro`, `body`, `outro`) |
| `view_frame` | `at` (seconds from the start of the video); `scene`; `offset` (seconds into the scene) |

  The preset keys, as `enum` on each field (they mirror `frontend/studio/motion.js`):
  - `enter`: `none`, `fade`, `rise`, `slideUp`, `slideDown`, `slideLeft`, `slideRight`, `zoom`, `pop`, `blur`, `wipe`, `reveal`, `spin`
  - `exit`: `none`, `fade`, `rise`, `slideUp`, `slideDown`, `zoom`, `blur`, `wipe`
  - `loop`: `none`, `pulse`, `float`, `wiggle`, `drift`, `spin`
  - `ease`: `smooth`, `snappy`, `bounce`, `gentle`, `linear`
  - `starter`, in its description, by role: intro: `blank`, `title`, `logo`, `bold`; body: `blank`, `headline`, `stat`, `list`, `quote`, `media`; outro: `blank`, `cta`, `logo`, `subscribe`. Say in `manage_scenes` that `move` only moves a scene among scenes of the same role, and that scenes are always ordered intro, scenes, outro.
- `MAKE_VIDEO_HINT = 'When the user asks to animate the design or to make it a video, call make_video first; you then get the animation tools.'`
- `ANIMATE_PROMPT`: the seven rules of the spec's "Prompt" section, one `- ` line each, headed by `The design is a video (design.mode is "animate"). A slide is called a scene; page and index parameters are scene numbers. Times are in seconds.`
- `toolsFor(mode = 'design')` filters `AGENT_TOOLS` by `modes`.
- `agentSystemPrompt(context, mode = 'design')`: `AGENT_PROMPT`, then `DESIGN_SYSTEM_PROMPT` when the context has a system (as today), then `ANIMATE_PROMPT` in `animate` or `MAKE_VIDEO_HINT` in `design`, joined by blank lines.
- `cleanMessages` is unchanged: it already accepts every name in `AGENT_TOOLS`.

- [ ] **Step 4: `AgentStepDto`**: add `@IsOptional() @IsIn(["design", "animate"]) mode?: "design" | "animate";`.

- [ ] **Step 5: `agentStep`**: `const mode = d.mode ?? "design", tools = toolsFor(mode);` use `agentSystemPrompt(d.context, mode)` and `tools` in both provider bodies in place of `AGENT_TOOLS`.

- [ ] **Step 6: Run** `cd backend && npx vitest run` and `cd backend && npx tsc --noEmit -p tsconfig.json`. Expected: all tests pass, no type errors.

---

### Task 2: Frontend pure helpers: `agent-motion.js`

**Files:**
- Create: `frontend/studio/agent-motion.js`
- Test: `frontend/studio/agent-motion.test.js`

**Interfaces:**
- Consumes: `motion.js` (`ENTER`, `EXIT`, `LOOP`, `EASES`, `TRANSITIONS`, `KINDS`, `STARTERS`, `anim`, `sceneOf`, `timeline`).
- Produces (all pure, no DOM):
  - `agentMode(kind, editorMode) → 'design' | 'animate' | null`
  - `DESIGN_ONLY`, `ANIMATE_ONLY`: `Set<string>` of tool names; `allowed(tool, mode) → boolean`
  - `animPatch(layer, input, sceneMs) → { anim, notes: string[] }` (`anim` is the full stored object)
  - `fitAnims(layers, sceneMs) → number` (clamps each layer's stored `anim` in place to the scene; returns how many changed)
  - `scenePatch(scene, input, isFirst) → { scene, notes: string[] }` (`scene` is the full stored object)
  - `animOut(layer) → object | undefined`
  - `videoCtx(pages, fps) → { fps, seconds, scenes: [{ number, role, start, seconds, transition, transitionSeconds }] }`
  - `frameTime(tl, input, currentIndex) → { ms, scene, offsetMs }` (throws `Error('There is no scene N')`)
  - `starterFor(role, key) → { role, key }` (throws on an unknown starter, naming the valid keys of that role)
  - `sec(ms) → number` (seconds, one decimal)

- [ ] **Step 1: Write the failing tests**

```js
import { describe, expect, it } from 'vitest';
import * as MO from './motion.js';
import { agentMode, allowed, animPatch, fitAnims, scenePatch, animOut, videoCtx, frameTime, starterFor, sec } from './agent-motion.js';

describe('agentMode', () => {
  it('follows the kind and the editor mode', () => {
    expect(agentMode('still', 'design')).toBe('design');
    expect(agentMode('reel', 'design')).toBe('design');
    expect(agentMode('reel', 'animate')).toBe('animate');
    expect(agentMode('video', 'animate')).toBe(null);
  });
});
describe('allowed', () => {
  it('keeps each mode to its own tools', () => {
    expect(allowed('manage_slides', 'animate')).toBe(false);
    expect(allowed('make_video', 'animate')).toBe(false);
    expect(allowed('animate_layers', 'design')).toBe(false);
    expect(allowed('view_frame', 'design')).toBe(false);
    ['update_layers', 'view_slide', 'check_design'].forEach((t) => { expect(allowed(t, 'design')).toBe(true); expect(allowed(t, 'animate')).toBe(true); });
  });
});
describe('animPatch', () => {
  const L = { id: 'a', anim: { in: 'fade', d: 200, t: 600, e: 'smooth', out: 'none', ot: 450, loop: 'none' } };
  it('maps names and seconds, and keeps what was not given', () => {
    const { anim, notes } = animPatch(L, { enter: 'rise', delay: 0.5 }, 3000);
    expect(anim).toEqual({ in: 'rise', d: 500, t: 600, e: 'smooth', out: 'none', ot: 450, loop: 'none' });
    expect(notes).toEqual([]);
  });
  it('starts from the defaults on a layer with no animation', () => {
    expect(animPatch({ id: 'b' }, { enter: 'pop' }, 3000).anim).toEqual({ ...MO.ANIM_DEFAULT, in: 'pop' });
  });
  it('clamps the duration to the scene, then the delay to what is left', () => {
    const { anim, notes } = animPatch(L, { delay: 9, duration: 2 }, 3000);
    expect(anim.t).toBe(2000); expect(anim.d).toBe(1000);
    expect(notes.join(' ')).toMatch(/delay/);
  });
  it('clamps the lower bounds', () => {
    const { anim } = animPatch(L, { delay: -1, duration: 0, exitDuration: 0 }, 3000);
    expect([anim.d, anim.t, anim.ot]).toEqual([0, 100, 100]);
  });
  it('rejects unknown presets and names the valid ones', () => {
    const { anim, notes } = animPatch(L, { enter: 'teleport', ease: 'nope' }, 3000);
    expect(anim.in).toBe('fade'); expect(anim.e).toBe('smooth');
    expect(notes[0]).toContain('teleport'); expect(notes[0]).toContain('rise');
    expect(notes[1]).toContain('nope');
  });
  it('ignores values that are not numbers', () => { expect(animPatch(L, { delay: 'soon' }, 3000).anim.d).toBe(200); });
});
describe('fitAnims', () => {
  it('pulls timings inside a shorter scene and counts the layers it changed', () => {
    const ls = [{ anim: { ...MO.ANIM_DEFAULT, d: 2500, t: 700 } }, { anim: { ...MO.ANIM_DEFAULT, d: 100, t: 300 } }, {}];
    expect(fitAnims(ls, 1000)).toBe(1);
    expect(ls[0].anim.t).toBe(700); expect(ls[0].anim.d).toBe(300);
    expect(ls[2].anim).toBeUndefined();
  });
});
describe('scenePatch', () => {
  const S = { k: 'body', dur: 3000, tr: 'fade', trd: 500 };
  it('sets length, transition and role', () => {
    expect(scenePatch(S, { seconds: 4.5, transition: 'zoom', transitionSeconds: 0.8, role: 'outro' }, false).scene).toEqual({ k: 'outro', dur: 4500, tr: 'zoom', trd: 800 });
  });
  it('clamps the length to 0.5–60 s and the transition to half the scene', () => {
    expect(scenePatch(S, { seconds: 0.1 }, false).scene.dur).toBe(500);
    expect(scenePatch(S, { seconds: 600 }, false).scene.dur).toBe(60000);
    const r = scenePatch(S, { seconds: 1, transitionSeconds: 5 }, false);
    expect(r.scene.trd).toBe(500); expect(r.notes.length).toBeGreaterThan(0);
  });
  it('gives the first scene no transition', () => {
    const r = scenePatch({ ...S, tr: 'cut' }, { transition: 'zoom' }, true);
    expect(r.scene.tr).toBe('cut'); expect(r.notes[0]).toMatch(/first scene/i);
  });
  it('rejects an unknown transition or role', () => {
    const r = scenePatch(S, { transition: 'spin', role: 'middle' }, false);
    expect(r.scene).toEqual(S); expect(r.notes).toHaveLength(2);
  });
});
describe('animOut', () => {
  it('hides a layer with no entrance, exit or loop', () => {
    expect(animOut({})).toBeUndefined();
    expect(animOut({ anim: { ...MO.ANIM_DEFAULT, in: 'none' } })).toBeUndefined();
  });
  it('shows the model its own field names, in seconds', () => {
    expect(animOut({ anim: { in: 'rise', d: 250, t: 700, e: 'smooth', out: 'fade', ot: 450, loop: 'none' } }))
      .toEqual({ enter: 'rise', delay: 0.3, duration: 0.7, ease: 'smooth', exit: 'fade', exitDuration: 0.5, loop: 'none' });
  });
});
describe('videoCtx', () => {
  const pages = [{ scene: { k: 'intro', dur: 2000, tr: 'cut', trd: 500 }, layers: [] }, { scene: { k: 'body', dur: 3500, tr: 'fade', trd: 500 }, layers: [] }];
  it('lists the scenes with the timeline\'s own starts and total', () => {
    const v = videoCtx(pages, 30), tl = MO.timeline(pages);
    expect(v.fps).toBe(30); expect(v.seconds).toBe(sec(tl.total));
    expect(v.scenes.map((s) => s.number)).toEqual([1, 2]);
    expect(v.scenes[1]).toEqual({ number: 2, role: 'body', start: sec(tl.scenes[1].start), seconds: 3.5, transition: 'fade', transitionSeconds: 0.5 });
  });
});
describe('frameTime', () => {
  const tl = MO.timeline([{ scene: { k: 'body', dur: 2000, tr: 'cut', trd: 0 }, layers: [] }, { scene: { k: 'body', dur: 4000, tr: 'cut', trd: 0 }, layers: [] }]);
  it('defaults to 60 % into the current scene', () => { expect(frameTime(tl, {}, 1)).toEqual({ ms: tl.scenes[1].start + 2400, scene: 2, offsetMs: 2400 }); });
  it('takes a time from the start of the video', () => { const f = frameTime(tl, { at: 1 }, 1); expect(f.ms).toBe(1000); expect(f.scene).toBe(1); expect(f.offsetMs).toBe(1000); });
  it('takes a scene and an offset, kept inside the scene', () => {
    expect(frameTime(tl, { scene: 2, offset: 1 }, 0).ms).toBe(tl.scenes[1].start + 1000);
    expect(frameTime(tl, { scene: 1, offset: 99 }, 0).offsetMs).toBe(1999);
  });
  it('clamps a time outside the video', () => {
    expect(frameTime(tl, { at: -3 }, 0).ms).toBe(0);
    expect(frameTime(tl, { at: 999 }, 0).ms).toBe(tl.total - 1);
  });
  it('refuses a scene that does not exist', () => { expect(() => frameTime(tl, { scene: 7 }, 0)).toThrow('There is no scene 7'); });
});
describe('starterFor', () => {
  it('defaults to a blank body scene', () => { expect(starterFor()).toEqual({ role: 'body', key: 'blank' }); });
  it('accepts a starter of its role', () => { expect(starterFor('intro', 'title')).toEqual({ role: 'intro', key: 'title' }); });
  it('names the valid starters on a miss', () => { expect(() => starterFor('intro', 'nope')).toThrow(/title/); });
});
```

The fixtures match `motion.js` as it is today: `timeline(pages)` returns `{ scenes: [{ i, start, dur, tr, trd, k }], total }`, the first scene's `tr` is always `cut`, and `anim(l)` gives a layer without `anim` the defaults with `in: 'none'`.

- [ ] **Step 2: Run** `cd frontend && npx vitest run studio/agent-motion.test.js`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `agent-motion.js`**

Header comment in the house style (what the file is, that it is pure and unit-tested). Decisions the tests do not fully pin:
- `sec(ms)` rounds to one decimal.
- `animPatch` order: presets, then `t`, then `d` clamped to `sceneMs - t`, then `ot`. A note is added for every value that was clamped or rejected, in the form `delay clamped to 1 s` / `Unknown enter "teleport". Use: none, fade, rise, …`.
- `animOut` returns `undefined` when `in`, `out` and `loop` are all `'none'`.
- `DESIGN_ONLY` = `manage_slides`, `resize_canvas`, `apply_brand_template`, `build_live_slide`, `make_video`. `ANIMATE_ONLY` = `animate_layers`, `auto_animate`, `manage_scenes`, `set_scene`, `view_frame`.

- [ ] **Step 4: Run** `cd frontend && npx vitest run studio/agent-motion.test.js`. Expected: PASS.

---

### Task 3: Shell: the Agent item in the Animate rail, and the mode exposed to the engine

**Files:**
- Modify: `frontend/studio/video-studio.js` (`railFor`, `panelFor`, the install closure near line 195, the header comment lines 30-33)
- Test: `frontend/studio/video-studio.test.js`

**Interfaces:**
- Produces: `railFor('reel', 'animate')` ends with `['agent', 'Agent', 'studio']`; `panelFor('reel', 'animate', 'agent') → { mode: 'animate', tab: 'agent' }`; `RT.vs = { mode: () => 'design' | 'animate', setMode: (m) => void }`, set when the shell installs.

- [ ] **Step 1: Write the failing tests** (add to the existing `railFor` and `panelFor` describes)

```js
it('ends a reel\'s Animate rail with the Agent, pinned at the bottom', () => {
  expect(keys('reel', 'animate')).toEqual(['animation', 'audio', 'scenes', 'captions', 'agent']);
  expect(isFoot('agent')).toBe(true);
});
it('gives a video no Agent', () => { expect(keys('video', 'animate')).not.toContain('agent'); });
it('keeps the agent in the mode the reel is in', () => {
  expect(panelFor('reel', 'animate', 'agent')).toEqual({ mode: 'animate', tab: 'agent' });
  expect(panelFor('reel', 'design', 'agent')).toEqual({ mode: 'design', tab: 'agent' });
  expect(panelFor('still', 'design', 'agent')).toEqual({ mode: 'design', tab: 'agent' });
});
```

Existing assertions that list the reel's Animate rail as four items change to five; the existing `panelFor('video', 'animate', 'agent')` → `scenes` assertion stays.

- [ ] **Step 2: Run** `cd frontend && npx vitest run studio/video-studio.test.js`. Expected: the three new tests FAIL.

- [ ] **Step 3: Implement**

- `railFor`: the reel's Animate rail is `[...ANIMATE_RAIL, ...DESIGN_FOOT]`.
- `panelFor`: for a reel, `key === 'agent'` returns `{ mode, tab: 'agent' }` before the `DESIGN_KEYS` test.
- In the install closure, after `mode` and `setMode` are defined: `RT.vs = { mode, setMode };` (use the runtime object the file already imports for `RT.motion` consumers; if the shell receives it through `ctx`, use that).
- Update the header comment: Agent is in both rails of a reel.

- [ ] **Step 4: Run** `cd frontend && npx vitest run studio/video-studio.test.js studio/dock.test.js studio/home.test.js`. Expected: PASS.

---

### Task 4: Motion block: what the agent's tools call, on `RT.motion`

**Files:**
- Modify: `frontend/studio/engine.js`, motion block (`RT.motion =` at about line 11285; `prepare` at 11100; `frame` at 11153; `addScene` 10839; `moveScene` 10892; `ACT.mo37Make` 11035)

**Interfaces:**
- Consumes: the block's own `toMotion`, `addScene`, `dupScene`, `delScene`, `moveScene`, `canMove`, `order`, `previewScene`, `exitPreview`, `prepare`, `frame`, `TL`.
- Produces, added to the existing `RT.motion` object:
  - `make() → void`: what `ACT.mo37Make` does, without the toast.
  - `addScene(role, key, at) → void`; `dupScene(i)`; `delScene(i)`; `moveScene(i, by)`; `canMove(i, by) → boolean`; `order(d)`; `previewScene(i)`.
  - `frameAt(ms, scale) → Promise<Blob | null>`: a JPEG of the video at `ms`.
  - `dropFrames() → void`: forgets the prepared assets.

- [ ] **Step 1: Implement**

- `make`: `exitPreview(true); mutate(() => toMotion(ED.d)); fitZoom();`. `ACT.mo37Make` calls `make()` then its toast, so there is one implementation.
- `addScene` keeps its toast for the panels; add an optional last parameter `quiet` and pass it from `RT.motion.addScene` so the agent's runs do not toast.
- `frameAt(ms, scale)`: keeps one prepared set in a block variable `{ d, s, prep }`; calls `prepare(ED.d, scale, () => {})` when the design object or the scale differs or after `dropFrames()`; draws with `frame(ctx, ED.d, prep, TL(), ms, scale)` on a canvas sized as `record` sizes its canvas; returns `canvas.toBlob` as `image/jpeg`, quality 0.85. Any throw returns `null`.
- `dropFrames()` clears the variable. The design changes between frames during a run, so `frameAt` must not reuse a set prepared before a mutation: also clear it from the block's existing hook that runs on every `mutate` if there is one; otherwise the agent calls `dropFrames()` after each tool that changes the design (Task 5 does this either way).

- [ ] **Step 2: Verify nothing moved**

Run: `cd frontend && npx vitest run studio`. Expected: PASS (same count as before plus Tasks 2 and 3).

- [ ] **Step 3: Check in the browser** (dev server through the preview tool, a reel open in Animate mode, browser console)

`await RT.motion.frameAt(1000, 0.5)` returns a `Blob` of type `image/jpeg`; opening it shows the frame at 1 s with a half-finished entrance. If `RT` is not reachable from the console, expose nothing new: check through Task 5's `view_frame` instead and note it there.

---

### Task 5: The agent loop: mode, context and the six tools

**Files:**
- Modify: `frontend/studio/engine.js`, v25 block (about lines 7895-8230: `context`, `picture`, `T`, `STEP`, `agAI`), and the import list at the top of the file

**Interfaces:**
- Consumes: Task 2's `agentMode`, `allowed`, `animPatch`, `fitAnims`, `scenePatch`, `animOut`, `videoCtx`, `frameTime`, `starterFor`, `sec`; Task 3's `RT.vs.mode()`; Task 4's `RT.motion.*`; `kindOf` from `caption-store.js`; `MO` (`motion.js`).
- Produces: request body `{ provider, model, mode, context, messages }`; `AGAPI.mode() → 'design' | 'animate' | null`.

- [ ] **Step 1: Mode**

`const agMode = () => agentMode(kindOf(ED.d), RT.vs ? RT.vs.mode() : 'design') || 'design';` and add `mode: agMode` to `AGAPI`. The request in `agAI` sends `mode: agMode()`, read again on every turn.

- [ ] **Step 2: Context and picture**

- `context()`: `design` gains `mode: agMode()` and `kind: ED.d.motion ? 'video' : 'still'`. In `animate` it also gains a top-level `video: videoCtx(d.pages, d.motion.fps || 30)`, and `compact(l)` adds `anim: animOut(l)` when defined.
- A helper `frameImage(ms)` turns `RT.motion.frameAt(ms, s)` into a data URL with the same scale rule as `picture` (long side at most 1000 px), or `null`.
- The picture attached to the user's message: in `animate`, `frameImage(frameTime(MO.timeline(d.pages), {}, ED.pi).ms)`; in `design`, `picture(ED.pi)` as today.

- [ ] **Step 3: Guard**

In the call loop, before `T[call.name]` runs: `if (!allowed(call.name, agMode())) throw new Error('This tool is not available in this mode');`.

- [ ] **Step 4: The six tools in `T`, with their `STEP` labels**

A local `sceneIx(n)` like `pageIx` whose error reads `There is no scene N`. Every tool that changes the design calls `RT.motion.exitPreview(true)` first, sets `run.moved = true`, and calls `RT.motion.dropFrames()` after.

| Tool | Does | Returns | `STEP` label |
| --- | --- | --- | --- |
| `make_video` | Throws `This design is already a video` when `ED.d.motion`; else `RT.motion.make()` | `The design is now a video with N scene(s). You are in Animate mode.` | `Turning the design into a video` |
| `animate_layers` | One `mutate`: for each update, `layerIn(scene, id)` then `l.anim = animPatch(l, u.anim, sceneDur).anim`; errors and notes are collected per layer | `Animated N layer(s).` + notes | `Animating N layer(s)` |
| `auto_animate` | One `mutate`: `MO.autoAnimate(pg.layers, MO.sceneOf(pg), w, h)` on the current scene, the numbered scene, or all | `Animated scene 2 (6 layers).` / `Animated every scene (4).` | `Animating the scene` / `Animating every scene` |
| `manage_scenes` | `add`: throws at 20 scenes; `starterFor(role, starter)`, then `RT.motion.addScene(role, key, index + 1, true)`. `duplicate`: throws at 20 scenes. `delete`: throws `A video keeps at least one scene` at one. `move`: `to` is a scene number; throws `A scene can only move among the scenes of its role` when the target has another role, else steps `RT.motion.moveScene` until it is there. `go`: sets `ED.pi`, clears the selection, redraws | Names the final number: `Added an intro as scene 1; it is now the current scene.` | `Adding a scene`, `Duplicating a scene`, `Deleting a scene`, `Moving a scene`, `Opening a scene` |
| `set_scene` | One `mutate`: `pg.scene = scenePatch(MO.sceneOf(pg), a, i === 0).scene`; `fitAnims(pg.layers, pg.scene.dur)`; `RT.motion.order(ED.d)` when the role changed | `Scene 2: 4.5 s, zoom transition.` + notes, + `Adjusted N layer timing(s) to fit.` when `fitAnims` > 0, + the new number when it moved | `Updating the scene` |
| `view_frame` | `frameTime(tl, a, ED.pi)` then `frameImage(ms)` | `{ text: 'Frame at 4.2 s: scene 2, 1.2 s in.', image }`, or `The frame could not be rendered.` | `Looking at the video` |

Existing tools in `animate`: `get_slide`, `view_slide` and the layer tools work unchanged (a scene is a page). Their `STEP` labels and result texts say "slide"; leave them.

- [ ] **Step 5: End of a run**

In `agAI`'s `finally`, after `finishUndo(run)`: `RT.motion.dropFrames()`; and when `run.moved` and the editor is still on this design in Animate mode, `RT.motion.previewScene(ED.pi)`. The stopped-run path (`agStop` override) drops the frames and does not play.

- [ ] **Step 6: Run** `cd frontend && npx vitest run studio`. Expected: PASS.

- [ ] **Step 7: Check in the browser** (backend and frontend dev servers, an AI key set in Settings → AI; if no key is available, say so and stop here rather than faking the check)

1. Reel in Animate mode, Agent tab: "Animate this scene". The steps show `Animating the scene` and `Looking at the video`; the scene plays once at the end; one Undo restores the previous animation.
2. "Make it 15 seconds with an intro and an outro": scenes are added in intro, scenes, outro order; the agent's last message states the final length; the timeline total matches it.
3. "Slow the title down": only that layer's bar changes in the timeline.
4. A still in Design mode: "Turn this into a video and animate it". The editor switches to Animate mode during the run and later steps are animation tools; one Undo makes it a still in Design mode again.
5. Press Stop during a run: the changes so far stay, as one Undo step, and nothing plays.
6. Network tab: the Design-mode request body has `mode: "design"`; the server's request to the provider (backend log or a temporary breakpoint) carries 19 tools in each mode.

---

### Task 6: The agent panel in Animate mode

**Files:**
- Modify: `frontend/studio/engine.js` (`agCtx` about line 3184, `agPanel` 3190, `agEmpty` 3145 and its v25 override 8210, `PROMPTS` in the v25 block, `ACT.agScope` 3241)
- Modify: `frontend/studio/agent-motion.js`, `frontend/studio/agent-motion.test.js`
- Modify: `frontend/studio/reel-source.js` (only if the player unmounts when `ED.tab === 'agent'`)
- Modify: `frontend/styles/studio.css` (only if the foot item does not sit at the bottom of the Animate rail)

**Interfaces:**
- Consumes: `AGAPI.mode()`.
- Produces: `agentCopy(mode, pi, n, scope) → { sub, chip, scopeTitle, placeholder, empty, prompts: [[key, label, text]] }` in `agent-motion.js`.

- [ ] **Step 1: Write the failing test**

```js
describe('agentCopy', () => {
  it('speaks of slides in design and scenes in animate', () => {
    expect(agentCopy('design', 1, 5, 'slide').sub).toBe('Edits slide 2 of 5');
    expect(agentCopy('animate', 1, 5, 'slide').sub).toBe('Edits scene 2 of 5');
    expect(agentCopy('design', 1, 5, 'all').chip).toBe('All 5 slides');
    expect(agentCopy('animate', 1, 5, 'all').chip).toBe('All 5 scenes');
    expect(agentCopy('animate', 1, 5, 'slide').chip).toBe('Scene 2');
  });
  it('offers the three animation prompts in animate only', () => {
    expect(agentCopy('animate', 0, 1, 'slide').prompts.map((p) => p[1])).toEqual(['Animate this scene', 'Animate every scene', 'Add an intro and an outro']);
    expect(agentCopy('design', 0, 1, 'slide').prompts).toEqual([]);
  });
  it('asks for animation changes in animate', () => {
    expect(agentCopy('animate', 0, 1, 'slide').placeholder).toBe('Ask for animation changes');
    expect(agentCopy('design', 0, 1, 'slide').placeholder).toBe('Ask for changes');
  });
});
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run studio/agent-motion.test.js`. Expected: FAIL, `agentCopy` is not exported.

- [ ] **Step 3: Implement `agentCopy`** with this exact copy:

| Field | design | animate |
| --- | --- | --- |
| `sub` | `Edits slide N of M` | `Edits scene N of M` |
| `chip` | `Slide N` / `All M slides` | `Scene N` / `All M scenes` |
| `scopeTitle` | `Choose what the agent edits` | `Choose which scenes the agent works on` |
| `placeholder` | `Ask for changes` | `Ask for animation changes` |
| `empty` | `''` (the panel keeps today's text) | `Describe the motion you want: entrances, timing, scenes, transitions. I animate the video for you.` |
| `prompts` | `[]` (the panel keeps today's quick actions) | `['animate', 'Animate this scene', 'Animate this scene: entrances in reading order, the headline first']`, `['animateAll', 'Animate every scene', 'Animate every scene of this video with a consistent style']`, `['bookends', 'Add an intro and an outro', 'Add an intro scene and an outro scene in the brand\'s look, and animate them']` |

- [ ] **Step 4: Use it in the panel**

- `agPanel` and `agCtx` take `sub`, `chip`, `scopeTitle` and `placeholder` from `agentCopy(AGAPI ? AGAPI.mode() : 'design', ED.pi, d.pages.length, ED.agScope)`. `ACT.agScope`'s toasts say "scene(s)" in animate.
- In `animate` with an AI model: the empty state shows `empty` and the three prompts as the existing quick-action buttons (same markup and classes as today's actions); their text is sent through `agAI`. In `animate` with no AI model: the empty state shows only the existing "No AI model" chip and one line, `Add an AI key in Settings to use the agent on videos.`; the rule-based actions are not drawn.
- The scope `all` in `animate` sends every scene's layers in the context, as `all` does for slides today (no new code beyond the labels).

- [ ] **Step 5: Run** `cd frontend && npx vitest run studio` and `cd frontend && npm run check:css`. Expected: PASS.

- [ ] **Step 6: Check in the browser**

1. Reel, Animate mode: the rail shows Animation, Audio, Scenes, Captions, and Agent pinned at the bottom. Opening Agent keeps the player and the timeline on screen.
2. The panel header reads "Edits scene 1 of N"; the three prompts run.
3. Switch to Design mode with the Agent open: the panel stays open and reads "Edits slide 1 of N" with today's actions.
4. An uploaded video: no Agent in the rail.
5. A still in Design mode: the panel is pixel-for-pixel as before (compare with a screenshot taken before this task).
6. Narrow window (mobile preset): the Agent item is reachable in the Animate rail and the panel slides in as in Design mode.
7. Take a screenshot of the Animate agent after a run for the hand-off.
