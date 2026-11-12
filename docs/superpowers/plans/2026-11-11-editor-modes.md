# Editor Modes (Design and Animate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Studio editor has two modes with their own sidebar and tools: Design (Templates, Elements, Text, Uploads, Figma, Brand, Live data, Components, Agent) and Animate (Animation, Audio, Scenes, Captions; Scenes, Audio, Captions for an uploaded video).

**Architecture:** The Video Studio shell (`video-studio.js`) keeps drawing the rail, panel, inspector and bottom area for every kind. The unified rail and its merged items are replaced by pure helpers that derive a mode from the kind and a per-design session preference, a rail from kind and mode, and a panel from any old or new key. The engine's Motion panel splits into an Animation panel and a Scenes panel; the footage editor's Video and Look panels become one Scenes panel; Script becomes a Captions sub-tab.

**Tech Stack:** Vanilla ES modules in `frontend/studio/` (Next.js host page), vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-editor-modes-design.md`

## Global Constraints

- `kindOf(d)` (`caption-store.js`) stays `still` / `reel` / `video`. No data migration. The mode preference is session state per design id and is never written into the design.
- Saved designs of all three kinds open, preview and export exactly as before.
- `ED.tab` keeps holding a panel key. Every key that was valid before (`media`, `motion`, `look`, `styles`, `script`, `uploads`, `figma`, `comps`, `data`, and the unified items) still opens a panel that exists.
- Switching a reel to Design mode leaves `d.motion`, every `pg.scene` and every `l.anim` untouched.
- Animating a still stays one `mutate()` step (`ACT.mo37Make`); one undo makes it a still again.
- Copy: sentence case, verbs first, no "please" or "successfully", no emoji. Rail labels exactly: Templates, Elements, Text, Uploads, Figma, Brand, Live data, Components, Agent, Animation, Audio, Scenes, Captions.
- Flat visuals as in the 2026-11-08 plan: outline icons from `IC`, 1 px borders, no `box-shadow` on rail, panels or tiles. Export stays the only filled red button.
- Do not commit unless the user asks. Each task ends with its tests green instead.
- Test commands: `cd frontend && npx vitest run studio/<name>.test.js`; everything: `cd frontend && npx vitest run studio`.

## Review Focus

1. A saved `ED.tab` or deep link with an old key (`media`, `motion`, `look`) on each kind opens a real panel, never a blank one. (Task 1 tests.)
2. Undo of "Animate" while in Animate mode: the editor returns to Design mode with a Design tab open and no transport left on screen. (Task 1 `panelFor` test for a still holding `scenes`; Task 2 browser check.)
3. A reel in Design mode: Space pans and L draws a line; playback keys do nothing and the player is paused. (Task 2 `keysOn` test and browser check.)
4. A view-only user on a still: Animate is disabled; on a reel the switch works. (Task 2 `switchState` test.)
5. An uploaded video with no file yet: Scenes shows the "Add your video" state, not an empty panel; Captions still shows its two-step guide. (Task 4 test.)

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `frontend/studio/video-studio.js` | modify | `modeOf`, `railFor`, `panelFor`, `subsOf`, `itemOf`, `propTabs`, `switchState`, `keysOn`; the shell draws rail, mode switch, sub-tabs by mode |
| `frontend/studio/dock.js` | modify | `dockState(mode)`; `canSwitch` removed |
| `frontend/studio/engine.js` | modify | Motion panel split into `animation` and `scenes` panels; `mo37Make` sets the mode; ⌘K by mode |
| `frontend/studio/reel-source.js` | modify | Header comment and `SHELL_PANELS` unchanged in behaviour; pauses on leaving Animate |
| `frontend/studio/footage-editor.js` | modify | `scenes` panel = clip + Look |
| `frontend/studio/caption-panels.js` | modify | No behaviour change; header comments name Script as a Captions sub-tab |
| `frontend/studio/still-source.js` | modify | Header comment only |
| `frontend/styles/studio.css` | modify | Mode switch, scene list; dead rules removed |
| `frontend/studio/video-studio.test.js`, `dock.test.js`, `footage-editor.test.js` | modify | See tasks |

---

### Task 1: Mode, rail and panel rules (pure)

**Files:**
- Modify: `frontend/studio/video-studio.js` (the pure-helpers block, lines 27-110), `frontend/studio/dock.js`
- Test: `frontend/studio/video-studio.test.js`, `frontend/studio/dock.test.js`

**Interfaces (produces):**

```js
// video-studio.js
export const DESIGN_RAIL = [['templates','Templates','layout'], ['elements','Elements','shapes'], ['text','Text','type'],
  ['uploads','Uploads','upload'], ['figma','Figma','figma'], ['brand','Brand','palette'], ['data','Live data','chart'],
  ['comps','Components','comp33']];
export const DESIGN_FOOT = [['agent','Agent','studio']];
export const ANIMATE_RAIL = [['animation','Animation','wand'], ['audio','Audio','music38'], ['scenes','Scenes','film37'],
  ['captions','Captions','vsCc']];
export const VIDEO_RAIL = [['scenes','Scenes','vsFilm'], ['audio','Audio','music38'], ['captions','Captions','vsCc']];
/** 'design' | 'animate' */
export function modeOf(kind, pref)
/** [[key, label, icon]], fresh copies */
export function railFor(kind, mode)
/** Keys of DESIGN_FOOT: drawn pinned at the bottom */
export const isFoot = (key) => boolean
/** Sub-tabs of a rail item: captions -> [['captions','Lines'],['styles','Styles'],['script','Script']]; anything else -> [] */
export function subsOf(item)
/** The rail item that holds panel `tab`: 'styles' and 'script' -> 'captions'; anything else -> tab */
export function itemOf(tab)
/** Any key -> { mode, tab }: the mode to be in and the panel key to put in ED.tab */
export function panelFor(kind, mode, key)
/** [[key, label, on]]: design -> Design, Layers; animate -> Animate, Layers */
export function propTabs(mode, rtab)
/** The top-bar switch: null for a video; else { mode, canAnimate } (canAnimate false: a still the user cannot edit) */
export function switchState(kind, mode, canEdit)
/** Whether the transport keys are active */
export const keysOn = (mode) => mode === 'animate'

// dock.js
export function dockState(mode) // 'design' -> 'pages', 'animate' -> 'timeline'
```

Removed from `video-studio.js`: `RAIL`, `RAIL_FOOT`, `TAB_ALIAS`, `unifiedRail`, `openTab`, `GROUPS`, `groupOf`, `resolveTab`, `EMPTY`, `EMPTY_ICON`, `emptyOf`, `STILL_ANIMATE`, and `SOON.media` / `SOON.look` (replaced by `SOON.scenes`: "Your video with its name, length and size, a way to replace it, and its colour look."). Removed from `dock.js`: `canSwitch`. The DOM half of `video-studio.js` still references the removed names after this task; Task 2 rewires it, so run only the two test files named here.

`panelFor` rules (the whole table from the spec):

- `still`: a Design key (rail or foot) → `{ mode:'design', tab:key }`; `media` → `uploads`; everything else (including `motion` and every Animate key) → `templates`.
- `video`: `scenes`, `audio`, `captions`, `styles`, `script` → itself; everything else → `scenes`. Mode is always `animate`.
- `reel`: a Design key → `{ mode:'design', tab:key }`; `animation`, `audio`, `scenes`, `captions`, `styles`, `script` → `{ mode:'animate', tab:key }`; `motion` and `look` → `{ mode:'animate', tab:'scenes' }`; `media` → `{ mode:'design', tab:'uploads' }`; anything else → the first rail item of the current mode.

- [ ] **Step 1: Replace the rail tests in `video-studio.test.js`.** Delete the `unified rail`, `openTab`, `rail items and their panels`, `groupOf`, `resolveTab` describes and the `STILL_ANIMATE` test; update the `handsBack`, `rail icons` and `inspector tabs` describes to the new exports. Add:

```js
describe('modeOf', () => {
  it('a still is always Design, a video always Animate', () => {
    expect(modeOf('still')).toBe('design'); expect(modeOf('still', 'animate')).toBe('design');
    expect(modeOf('video')).toBe('animate'); expect(modeOf('video', 'design')).toBe('animate');
  });
  it('a reel opens in Animate and follows the user', () => {
    expect(modeOf('reel')).toBe('animate'); expect(modeOf('reel', 'design')).toBe('design'); expect(modeOf('reel', 'animate')).toBe('animate');
  });
});
describe('railFor', () => {
  const keys = (k, m) => railFor(k, m).map((r) => r[0]), labels = (k, m) => railFor(k, m).map((r) => r[1]);
  it('Design: the nine design tools, Agent last', () => {
    expect(labels('still', 'design')).toEqual(['Templates', 'Elements', 'Text', 'Uploads', 'Figma', 'Brand', 'Live data', 'Components', 'Agent']);
    expect(keys('reel', 'design')).toEqual(keys('still', 'design'));
    expect(isFoot('agent')).toBe(true); expect(isFoot('templates')).toBe(false);
  });
  it('Animate on a reel: Animation, Audio, Scenes, Captions and nothing else', () => {
    expect(labels('reel', 'animate')).toEqual(['Animation', 'Audio', 'Scenes', 'Captions']);
  });
  it('an uploaded video: Scenes, Audio, Captions, whatever mode is asked', () => {
    expect(labels('video', 'animate')).toEqual(['Scenes', 'Audio', 'Captions']);
    expect(labels('video', 'design')).toEqual(['Scenes', 'Audio', 'Captions']);
  });
  it('no design tool in Animate and no video tool in Design', () => {
    const d = new Set(keys('reel', 'design')), a = keys('reel', 'animate');
    expect(a.some((k) => d.has(k))).toBe(false);
  });
  it('returns fresh copies', () => { railFor('still', 'design')[0][1] = 'x'; expect(railFor('still', 'design')[0][1]).toBe('Templates'); });
});
describe('subsOf and itemOf', () => {
  it('only Captions has sub-tabs: Lines, Styles, Script', () => {
    expect(subsOf('captions')).toEqual([['captions', 'Lines'], ['styles', 'Styles'], ['script', 'Script']]);
    ['templates', 'elements', 'uploads', 'audio', 'scenes', 'animation', 'agent'].forEach((k) => expect(subsOf(k)).toEqual([]));
  });
  it('Styles and Script light Captions', () => {
    expect(itemOf('styles')).toBe('captions'); expect(itemOf('script')).toBe('captions'); expect(itemOf('audio')).toBe('audio');
  });
});
describe('panelFor', () => {
  it('a still never leaves Design: video keys open Templates, media opens Uploads', () => {
    ['scenes', 'audio', 'captions', 'animation', 'motion', 'look', 'nope', undefined].forEach((k) => expect(panelFor('still', 'design', k)).toEqual({ mode: 'design', tab: 'templates' }));
    expect(panelFor('still', 'design', 'media')).toEqual({ mode: 'design', tab: 'uploads' });
    expect(panelFor('still', 'design', 'figma')).toEqual({ mode: 'design', tab: 'figma' });
  });
  it('a video keeps its three items; media, look and design keys open Scenes', () => {
    ['media', 'look', 'motion', 'templates', 'brand', 'agent', 'animation', undefined].forEach((k) => expect(panelFor('video', 'animate', k)).toEqual({ mode: 'animate', tab: 'scenes' }));
    ['audio', 'captions', 'styles', 'script'].forEach((k) => expect(panelFor('video', 'animate', k)).toEqual({ mode: 'animate', tab: k }));
  });
  it('a reel: a key of the other mode switches mode', () => {
    expect(panelFor('reel', 'animate', 'text')).toEqual({ mode: 'design', tab: 'text' });
    expect(panelFor('reel', 'design', 'audio')).toEqual({ mode: 'animate', tab: 'audio' });
    expect(panelFor('reel', 'design', 'styles')).toEqual({ mode: 'animate', tab: 'styles' });
  });
  it('a reel: old keys', () => {
    expect(panelFor('reel', 'design', 'motion')).toEqual({ mode: 'animate', tab: 'scenes' });
    expect(panelFor('reel', 'animate', 'look')).toEqual({ mode: 'animate', tab: 'scenes' });
    expect(panelFor('reel', 'animate', 'media')).toEqual({ mode: 'design', tab: 'uploads' });
  });
  it('a reel: an unknown key opens the first item of the current mode', () => {
    expect(panelFor('reel', 'animate', 'nope')).toEqual({ mode: 'animate', tab: 'animation' });
    expect(panelFor('reel', 'design', 'nope')).toEqual({ mode: 'design', tab: 'templates' });
  });
  it('every resolved tab is on the rail of the resolved mode', () => {
    const all = ['templates', 'elements', 'text', 'uploads', 'figma', 'brand', 'data', 'comps', 'agent', 'animation', 'audio', 'scenes', 'captions', 'styles', 'script', 'media', 'motion', 'look'];
    for (const kind of ['still', 'reel', 'video']) for (const mode of ['design', 'animate']) for (const k of all) {
      const r = panelFor(kind, modeOf(kind, mode), k);
      expect(railFor(kind, r.mode).map((x) => x[0])).toContain(itemOf(r.tab));
    }
  });
});
describe('inspector tabs', () => {
  it('Design mode: Design, Layers; Animate mode: Animate, Layers', () => {
    expect(propTabs('design', 'design').map((t) => t[1])).toEqual(['Design', 'Layers']);
    expect(propTabs('animate', 'animate').map((t) => t[1])).toEqual(['Animate', 'Layers']);
  });
  it('light one tab; a tab the mode lacks lights the first', () => {
    expect(propTabs('design', 'animate').filter((t) => t[2]).map((t) => t[0])).toEqual(['design']);
    expect(propTabs('animate', 'design').filter((t) => t[2]).map((t) => t[0])).toEqual(['animate']);
    expect(propTabs('animate', 'layers').filter((t) => t[2]).map((t) => t[0])).toEqual(['layers']);
  });
});
describe('the mode switch', () => {
  it('a video has none', () => { expect(switchState('video', 'animate', true)).toBe(null); });
  it('a still can be animated only by someone who can edit', () => {
    expect(switchState('still', 'design', true)).toEqual({ mode: 'design', canAnimate: true });
    expect(switchState('still', 'design', false)).toEqual({ mode: 'design', canAnimate: false });
  });
  it('a reel switches for everyone', () => { expect(switchState('reel', 'animate', false)).toEqual({ mode: 'animate', canAnimate: true }); });
  it('transport keys only in Animate', () => { expect(keysOn('animate')).toBe(true); expect(keysOn('design')).toBe(false); });
});
```

In `dock.test.js` replace the `dockState` describe:

```js
describe('dockState', () => {
  it('Design shows pages, Animate shows the timeline', () => {
    expect(dockState('design')).toBe('pages'); expect(dockState('animate')).toBe('timeline'); expect(dockState()).toBe('pages');
  });
});
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run studio/video-studio.test.js studio/dock.test.js`. Expected: FAIL (`modeOf` is not exported).
- [ ] **Step 3: Implement** the exports above in `video-studio.js` and `dock.js`; delete the removed names from the pure-helpers block; update the file's header comment (two modes, no merged items).
- [ ] **Step 4: Run the same command.** Expected: PASS.

---

### Task 2: The shell draws by mode

**Files:**
- Modify: `frontend/studio/video-studio.js` (`installVideoStudio`), `frontend/studio/reel-source.js`, `frontend/studio/still-source.js` (comment), `frontend/styles/studio.css`
- Test: `frontend/studio/video-studio.test.js` (reel source describe)

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces, on `VS`: `mode() -> 'design'|'animate'` (the open design's mode), `setMode(mode)` (sets the preference for the open design and redraws; on a still with `mode === 'animate'` it calls `ACT.mo37Make`), `railFor` (replaces `VS.unifiedRail`). Action `ACT.vsMode` (`data-v="design"|"animate"`) calls `setMode`. `ACT.vsDock` and `ACT.vsPlayAsVideo` are removed.

- [ ] **Step 1: Mode state.** Replace `dockPref` with `modePref = {}` keyed by design id; `mode = () => modeOf(kindOf(ED.d), modePref[ED.d.id])`.
- [ ] **Step 2: `setMode(m)`.** Still + `animate`: return unless `ctx.canEdit` allows it, set `modePref[id] = 'animate'`, call `ACT.mo37Make()`. Reel: set the preference; when leaving Animate, pause the player and `select(null)` if a caption is selected; set `ED.tab = panelFor(kind, m, ED.tab).tab` when the current tab's item is not on the new rail (first item of the new rail); set `ED.rtab` to the first of `propTabs(m)` unless it is `layers` or a document tab; `ed.all()`; then `requestAnimationFrame(() => dispatchEvent(new Event('resize')))` so the canvas refits. `installVideoStudio` receives `canEdit` in `ctx` (add it to the call at `engine.js:11690`).
- [ ] **Step 3: Rail.** `edRail` wrapper: `const r = panelFor(kind, mode(), ED.tab)`; if `r.mode !== mode()` on a reel set `modePref`; `ED.tab = r.tab`; draw `railFor(kind, mode())`, lighting `itemOf(ED.tab)`, `isFoot` keys with class `foot`. No source hands the rail back any more: remove the `handsBack(S, 'nativeRail')` branches (keep `handsBack` for `nativePages`).
- [ ] **Step 4: Panel.** `edPanel` wrapper: resolve `ED.tab` as in Step 3; remove the empty-state branch; sub-tab bar from `subsOf(itemOf(ED.tab))` (shown when it has 2 or more); the rest of the chain is unchanged (`agent` → editor, shared `PANELS[k]`, `S.nativePanel(k)` → editor, `S.panel(k)`, `SOON[k]`).
- [ ] **Step 5: `ACT.edTab`.** Before calling the original, replace `a.dataset.k` handling: compute `r = panelFor(kind, mode(), a.dataset.k)`; if `r.mode !== mode()` call `setMode(r.mode)` first; call the original with `{ dataset: { k: r.tab } }`. After it: `scenes` on a video selects `{ kind: 'video' }` (was `look`); `captions` / `styles` select `{ kind: 'caption' }` as today.
- [ ] **Step 6: Bottom area.** `edPages` wrapper uses `dockState(mode())`. Remove the Pages button from `transportHTML` and the "Play as video" / "Timeline" buttons from `pagesExtras`; keep the per-page length on a reel in Design mode.
- [ ] **Step 7: Stage.** `edStage` wrapper: a reel in Design mode pauses its player (`S.player.pause()`) and the engine's preview is left (`ACT.mo37Edit()` when defined) so the canvas is the editing canvas.
- [ ] **Step 8: Inspector.** `finishProps` draws `propTabs(mode(), ED.rtab)`. If `ED.rtab` is not a tab of the mode and not a document tab, set it to the mode's first tab before the editor draws (so the engine's Animate section, gated on `ED.rtab === 'animate'`, only draws in Animate mode). Remove the still's Animate call-to-action branch.
- [ ] **Step 9: Mode switch.** In `topButtons`, after `#edKind`, keep one `<div class="seg vs-mode" id="edMode" role="group" aria-label="Editing mode">` with two buttons `data-act="vsMode" data-v="design"` ("Design") and `data-v="animate"` ("Animate"), `aria-pressed` on the active one, from `switchState(kind, mode(), canEdit())`: removed when it is `null`; the Animate button `disabled` with `title="You can view this design but not change it"` when `canAnimate` is false. Redraw only when its HTML changes.
- [ ] **Step 10: Keys.** The capture-phase `keydown` handler returns early unless `keysOn(mode())`.
- [ ] **Step 11: CSS.** `.vs-mode` in the top bar: the existing `.seg` look at small size, 1 px border, no shadow. Remove `.vs-empty` and `.vs-dock-sw` rules that no longer match anything.
- [ ] **Step 12: Tests.** In the `reel source` describe, the test "captions, styles and script are the shell's; the reel's own panels stay the editor's" asserts `nativePanel` is false for `captions`, `styles`, `script` and true for `animation`, `scenes`, `audio`, `templates`, `uploads`. Update the `handsBack` still test: a still hands back only `nativePages`.
- [ ] **Step 13: Run** `cd frontend && npx vitest run studio`. Expected: PASS.

---

### Task 3: Animation and Scenes panels for animated designs

**Files:**
- Modify: `frontend/studio/engine.js` (the Motion block, about lines 10820-10995; ⌘K at 3361; `RAIL` edits at 2651, 3620, 10144, 10857, 11285), `frontend/styles/studio.css`

**Interfaces:**
- Consumes: `VS.mode()`, `VS.setMode()`, `VS.railFor`, `panelFor` (through `ACT.edTab`).
- Produces: engine panels for `ED.tab === 'scenes'` and `ED.tab === 'animation'` on a reel (the reel source's `nativePanel` already sends them to the engine); actions `an40Fx` (`data-key`, `data-v`), `sc40Go` (`data-i`), `sc40Menu` (`data-i`).

- [ ] **Step 1: Scenes panel.** In the `edPanel` wrapper at `engine.js:10859`, handle `ED.tab === 'scenes'` instead of `'motion'` (a still never reaches it: `panelFor` sends it to Templates, so the "Make it a video" hero is deleted). Title "Scenes", the same `⋯` menu (`mo37PanelMenu`: frame rate, "Magic animate every scene", "Make it a still design") and info row as today. Above the library, a list `<ol class="sc40-list">`, one row per `TL().scenes[i]`: `thumb(page, d.ratio, 44, 54)`, `kindLabel(d, i)`, `MO.fmtTime(scene.dur, false)`, the row is a button `data-act="sc40Go" data-i` with `aria-current` on `ED.pi`, plus a `⋯` button `data-act="sc40Menu" data-i`. Below: the existing `#mo37Lib` block unchanged. `openLibrary` sets `ED.tab = 'scenes'`.
- [ ] **Step 2: Scene actions.** `sc40Go` calls `ACT.mo37Scene` with the same index. `sc40Menu` opens `menu37` with: Duplicate (`dupScene(i)`), Move earlier, Move later, `'-'`, Delete (`delScene(i)`). Move swaps the page with its neighbour inside one `mutate()` followed by `order(ED.d)`; it is disabled when the neighbour is missing or has another `MO.sceneOf(p).k` (scenes stay grouped intro, body, outro). Length and transition stay in the inspector's Animate tab with nothing selected (`sceneSec`), reached by selecting the scene.
- [ ] **Step 3: Animation panel.** `ED.tab === 'animation'`: title "Animation". `const ls = targets(), all = !ls.length, on = all ? curP().layers.filter((l) => !isBg(l) && !l.hidden) : ls`. A line saying what it applies to: "Applies to the selected layer", "Applies to N selected layers", or "Applies to every layer of this scene". Then `<button class="btn secondary sm mo-magic" data-act="mo37Magic" data-all="0">` "Magic animate this scene", then three groups labelled Enter, Exit, Loop drawn with `fxChips(MO.ENTER|EXIT|LOOP, cur, key)` but with `data-act="an40Fx"`; `cur` is the shared value of `on` or none lit when they differ. With no layers at all on the scene: one sentence "Add a layer in Design to animate it." and a button `data-act="vsMode" data-v="design"` "Open Design". `an40Fx` applies `{ [key]: v }` to `on` in one `mutate()` (reuse `setAnim` by passing the layers: give `setAnim` an optional third parameter `ls`), previewing when `v !== 'none'`. The panel redraws when the selection changes: call `edPanel()` from the engine's selection change path when `ED.tab === 'animation'` (the same place `edProps()` is called for a selection).
- [ ] **Step 4: Inspector.** `animSec` drops its Enter / Exit / Loop chip groups and keeps timing (Start, Length, Easing, Stagger, exit Length) with a one-line header naming the current presets ("Fade in · no exit · no loop") and a button `data-act="edTab" data-k="animation"` "Change animation". `sceneSec` drops its "Magic animate this scene" button (it is in the Animation panel).
- [ ] **Step 5: `mo37Make` and `mo37Off`.** `mo37Make` already converts and toasts; the shell's `setMode` set the preference before calling it. After `mo37Off` (and the undo path in `syncMotion`), the kind is `still`, so the next rail draw resolves the tab; no extra code beyond confirming `edAll()` runs.
- [ ] **Step 6: Legacy `RAIL`.** The engine's `RAIL` array is no longer drawn. Remove the `RAIL.push` / `splice` / `unshift` calls for `comps`, `motion`, `audio` and the Templates reorder; ⌘K (`engine.js:3361`) uses `VS.railFor(kind, VS.mode())` when a design is open. Leave the base `edRail` function as the wrapper's `orig`.
- [ ] **Step 7: Emptied scene card.** `emptyCard` (`engine.js:10889`): its Heading / Elements / Image buttons call `edTab` with Design keys, which now switches to Design mode through `panelFor`; "Pick a ready-made scene" opens Scenes. No code change expected; verify in Step 9.
- [ ] **Step 8: CSS.** `.sc40-list` rows: 1 px border, `aria-current` row tinted with the surface tint used by `.mo2-card.on`, no shadow.
- [ ] **Step 9: Run** `cd frontend && npx vitest run studio`. Expected: PASS. Then in the browser (dev server from `.claude/launch.json`): animate a still, open Animation with nothing selected and apply an Enter preset, select one layer and apply another, open Scenes, duplicate and move a scene, add one from the library, undo each step.

---

### Task 4: Uploaded video: Scenes holds the clip and its Look

**Files:**
- Modify: `frontend/studio/footage-editor.js` (`panel` at line 769, `mediaHTML` 588, `lookPanelHTML` 657, `ftScript` / `ftSrt` 801-802), `frontend/studio/caption-panels.js` (comments)
- Test: `frontend/studio/footage-editor.test.js`

**Interfaces:**
- Consumes: `panelFor` through `ACT.edTab`.
- Produces: the `video` source's `panel('scenes')`.

- [ ] **Step 1: Failing test** in `footage-editor.test.js`, next to the existing panel tests and using their fixture:

```js
it('Scenes holds the clip and its Look; the old keys are gone from the source', () => {
  const h = source.panel('scenes');
  expect(h.match(/<h3>/g)).toHaveLength(1); // one title
  expect(h).toContain('<h3>Scenes</h3>');
  expect(h).toMatch(/Replace/); expect(h).toMatch(/Look/);
  expect(source.panel('media')).toBe(null); expect(source.panel('look')).toBe(null);
});
it('an empty video: Scenes asks for the video', () => {
  expect(emptySource.panel('scenes')).toMatch(/Add your video|Upload a video/);
});
```

Adapt `source` / `emptySource` to the file's existing fixtures (a video with footage, and one without a file).

- [ ] **Step 2: Run** `cd frontend && npx vitest run studio/footage-editor.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** `panel: (k) => k === 'scenes' ? scenesHTML() : k === 'audio' ? audioPanelHTML() : null`. `scenesHTML()` is one pane titled "Scenes": the body of `mediaHTML()` (clip, name, length, size, Replace) then, when the video has a file, the body of `lookPanelHTML()` under a "Look" label. `panelDrawn` hooks that keyed on `media` or `look` key on `scenes`. Any `ACT.edTab({ dataset: { k: 'media' | 'look' } })` in the file keeps working through `panelFor`; change them to `scenes` anyway. `ftScript` / `ftSrt` keep `script`.
- [ ] **Step 4: Run** `cd frontend && npx vitest run studio`. Expected: PASS.
- [ ] **Step 5: Browser.** Open an uploaded video: rail is Scenes, Audio, Captions; no mode switch; Replace and the Look sliders work from Scenes and the inspector shows the Look; Captions shows Lines, Styles, Script.

---

### Task 5: Verification pass

**Files:** none new; fixes land in the files above.

- [ ] **Step 1:** `cd frontend && npx vitest run studio` and `cd frontend && npx tsc --noEmit`. Expected: both clean.
- [ ] **Step 2:** `grep -n "unifiedRail\|TAB_ALIAS\|groupOf\|resolveTab\|emptyOf\|vsDock\|vsPlayAsVideo\|canSwitch\|STILL_ANIMATE" frontend/studio/*.js`. Expected: no matches.
- [ ] **Step 3:** In the browser, the spec's five checks:
  1. A still: nine Design items, page strip, no timeline, PNG export works.
  2. Animate on a still: four Animate items, transport and timeline; one undo restores the still, Design mode, a Design tab, and the design has no `motion`, `scene` or `anim`.
  3. A reel: switch both ways; add a text box in Design, animate it in Animate; switch back and forth and play: the animation is intact. In Design mode Space pans and nothing plays.
  4. An uploaded video: three items, no switch.
  5. ⌘K lists the mode's panels; with `ED.tab` set to `media`, `motion`, `look` by hand in the console and `edAll()` called, each kind shows a real panel.
- [ ] **Step 4:** Narrow width (the `mq.narrow` path at `engine.js:4977`): the rail, the mode switch and the panel drawer still fit and open.
- [ ] **Step 5:** Tick this plan's boxes, and add a line at the top of `docs/superpowers/plans/2026-11-08-unified-studio.md` saying its rule 2 and the dock switch of Task 4 are replaced by this plan.
