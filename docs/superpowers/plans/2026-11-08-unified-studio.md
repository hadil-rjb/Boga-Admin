# Unified Studio Implementation Plan

> **Superseded in part (2026-11-11):** design rule 2 (one rail for every kind) and the Pages / Timeline switch of Task 4 are replaced by `2026-11-11-editor-modes.md` (Design and Animate modes, each with its own rail).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Studio editor for still posts, carousels, animated posts, reels and videos. The user picks a size and a starting point, never an editor. Every kind has the same rail, the same inspector tabs and the same bottom dock; what changes is the content of the panels, the dock's state and the Export format.

**Architecture:** The Video Studio shell (`video-studio.js`) already takes over reels and videos through `wrapEd` and a per-kind source. This plan makes it take over stills too (a third `still` source), replaces the per-kind `RAILS` with one rail, moves "how to change it" tools from the rail to the inspector, and turns the bottom area into one dock with two states (Pages and Timeline). The data model stays the same: `kindOf(d)` (`caption-store.js`) is still `still` / `reel` / `video`, and `toMotion` (engine.js) is still how a still becomes a reel, but it is now triggered by the user's edits instead of a separate Motion panel.

**Tech Stack:** Vanilla ES modules in `frontend/studio/` (Next.js host page), vitest.

**Design reference:** the unified editor wireframe and rationale from the 2026-11-08 design session (summarised in "Design rules" below).

## Design rules (the acceptance bar for every task)

1. **Left rail = add. Right inspector = change.** Any tool that edits the selection lives in the inspector, never in the rail.
2. **One rail, same order, every kind:** Templates, Elements, Text, Media, Audio, Captions, Brand, then Agent pinned at the bottom. Items never appear, disappear or reorder. A panel with nothing to do for the kind shows an empty state that says what to do next (replaces the spec rule "never show an item that does nothing for the kind").
3. **Inspector tabs, every kind:** Design, Animate, Layers. History and Comments move to top-bar icons (they belong to the document, not the selection).
4. **Bottom dock:** Pages (thumbnail strip) for stills; Timeline for reels and videos; a Pages / Timeline switch whenever the design has time. Tracks appear only when they have content, plus one "+ Track" row.
5. **The kind is derived, not chosen.** Animating a layer, "Play as video" or adding audio turns a still into a reel (`toMotion`). The top bar shows a kind tag ("Still · 2 pages", "Video · 0:11") and Export picks PNG / PDF or MP4 by kind.
6. **Flat visuals:** outline icons only (the `IC` lucide-style paths), 1 px borders and surface tints for depth, no `box-shadow` on panels, cards, tiles or rail items. One red primary button per view (Export).
7. Copy rules as in the Video Studio plan: sentence case, verbs first, no "please" or "successfully", no emoji.

## Global constraints

- Saved designs of all three kinds open, preview and export exactly as before. No data migration; every change is in the UI layer.
- Old rail keys stay valid as aliases (saved `ED.tab`, ⌘K "Open …" commands at engine.js:2833, any `data-k` in existing panels): `uploads`, `figma` → `media`; `comps`, `data` → `elements`; `styles` → `captions`; `script` → `audio`; `motion` → `templates`; `look` → `media` for videos plus the inspector's Adjust section.
- A design is still a reel **or** a video in v1 (no footage clip inside a reel). Task 9 lists what lifting that would take; it is out of scope here.
- `captions.js` is untouched, so `sync-shared.mjs` is not needed.
- Every user edit stays one `mutate()` step. Converting a still to a reel because the user animated a layer is part of that same step (one undo reverts both).

## Review focus

1. A still with no motion opens with the new rail and the Pages strip, never shows a timeline, and exports PNG exactly as before.
2. Animating one layer on a still: one undo returns it to a still (no `d.motion`, no `pg.scene`, no `l.anim`).
3. Every old rail key opens the right new panel and sub-tab (⌘K, saved tab, deep links).
4. A video never shows Templates scene presets that can't apply to it; the Templates panel shows the empty state instead.
5. No `box-shadow` left in `studio.css` on `.ed-rail`, `.ed-panel`, `.ed-props`, `.tile`, `.cr37*`, `.vs-*`, `.ft-*` (grep check in Task 8).

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `frontend/studio/video-studio.js` | modify | One `RAIL`, `TAB_ALIAS`, `railTab` alias resolution, takes over stills, dock state, kind tag |
| `frontend/studio/still-source.js` | create | The `still` source: no player, Pages strip, editor-native panels and inspector |
| `frontend/studio/rail-panels.js` | create | Merged panels: Media (uploads, Figma, video), Elements (shapes, components, live data), Audio (music, voice, script) |
| `frontend/studio/dock.js` | create | Pure helpers for the dock: `dockState`, `visibleTracks`; DOM for the Pages strip |
| `frontend/studio/reel-source.js` | modify | `nativePanel` keys follow the new rail; hides empty tracks |
| `frontend/studio/footage-editor.js` | modify | Look moves to the inspector's Adjust section; Media panel gets the reference / "Match a reference" entry |
| `frontend/studio/caption-panels.js` | modify | Styles becomes a sub-tab of Captions; Script moves to the Audio panel |
| `frontend/studio/engine.js` | modify | Inspector tabs Design / Animate / Layers; History and Comments to the top bar; Motion panel content goes to Templates (Scenes filter) and the Animate tab; auto `toMotion`; Studio home Create block |
| `frontend/styles/studio.css` | modify | Rail with Agent pinned at the bottom, Pages strip, kind tag, shadow removal |
| `frontend/studio/*.test.js` | modify / create | See each task |

Test commands: `cd frontend && npx vitest run studio/<name>.test.js`; everything: `cd frontend && npx vitest run studio`.

---

## Task 1: One rail with aliases (pure)

**Files:** `video-studio.js`, `video-studio.test.js`

- [ ] Replace `RAILS` with one list:
  ```js
  export const RAIL = [['templates','Templates','layout'], ['elements','Elements','shapes'], ['text','Text','type'],
    ['media','Media','vsFilm'], ['audio','Audio','music38'], ['captions','Captions','vsCc'], ['brand','Brand','palette']];
  export const RAIL_FOOT = [['agent','Agent','studio']];
  export const TAB_ALIAS = { uploads:'media', figma:'media', comps:'elements', data:'elements', styles:'captions',
    script:'audio', motion:'templates', look:'media' };
  /** The sub-tab an alias opens inside its panel ('styles' -> captions/styles), or null */
  export const SUBTAB = { uploads:'uploads', figma:'figma', comps:'components', data:'data', styles:'styles', script:'script', motion:'scenes', look:'look' };
  ```
- [x] `unifiedRail()` returns `[...RAIL, ...RAIL_FOOT]` copies, the same for every kind.
- [x] Pure `openTab(kind, tab) -> { tab, sub }`: a unified key opens itself; an old key opens its new item on its sub-tab (`'styles'` → `{ tab:'captions', sub:'styles' }`); anything else opens Media for a video, Templates otherwise.
- [x] Tests: Agent is last; every old per-kind rail key resolves to a unified item; every alias has a sub-tab; fallbacks per kind; fresh copies.
- Not wired into the live rail yet: switching `edRail` before the merged panels exist would hide Figma, Components, Live data, Motion, Styles, Script and Look. `railFor` / `railTab` stay as they are until Task 3.

## Task 2: The shell takes over stills

**Files:** create `still-source.js` (+ test); modify `video-studio.js`, `engine.js` (install call next to the reel source)

- [ ] `takesOver(d)` returns true for every kind.
- [ ] The `still` source: `player: null`, `tracks: () => []`, `nativePanel: (k) => k !== 'media' && k !== 'elements' && k !== 'audio' && k !== 'captions'`, `nativeInspector: true`, `mount/unmount` no-ops.
- [ ] Shell: a source without a player draws no transport; `edPages` hands the bottom area to the dock (Task 4). Keyboard handler already returns early when `P()` is null; add a test.
- [ ] Rail rendering: Agent goes in a separate `<div class="ed-rail-foot">` so CSS can pin it at the bottom.
- [ ] Tests: `takesOver` for all kinds; `installStillSource` touches no DOM until the shell draws (same pattern as `installReelSource`).

## Task 3: Merged panels

**Files:** `video-studio.js`, `still-source.js`, `studio.css` (+ tests)

Done:
- [x] The live rail is `unifiedRail()` for every kind, Agent pinned at the bottom (`button.foot`). Stills no longer hand the rail back (`nativeRail` removed).
- [x] `ED.tab` keeps the open panel's own key (`uploads`, `figma`, `styles`, `motion`…), so every existing panel and handler works unchanged. `groupOf(kind, tab)` lights the rail item; `resolveTab(kind, tab)` opens a rail item's first panel, and sends a panel the kind lacks to its item (or the kind's first item).
- [x] Sub-tabs per kind (`subsOf`): Templates = Designs, Motion; Elements = Shapes, Components, Live data; Media = Uploads, Figma (stills, reels) or Video, Look (videos); Audio = Music and voice / Sound, Script; Captions = Lines, Styles. The bar sits above whatever draws the panel; a `MutationObserver` on `#edPanel` puts it back when a panel redraws itself.
- [x] Empty states (`EMPTY`): stills' Audio and Captions; videos' Templates, Elements, Text and Brand. One sentence plus a button to the panel to open instead.
- [x] `inspectorRoute` sends a still to the editor's properties whatever panel is open.
- [x] `railFor`, `railTab`, `RAILS`, `SUBTAB` removed; tests cover every old panel staying reachable per kind.

Moved to later tasks:
- [ ] Remembering the last sub-tab per item (dropped for now: a rail item always opens its first panel, which is predictable).
- [ ] Templates "Scenes" chips inside one panel, and a scene template on a still running `toMotion` in the same `mutate()` → Task 5 (with the Animate tab, which owns still → reel conversion).
- [ ] Video Look's colour grade moving into the inspector's Adjust section → Task 5.

## Task 4: The bottom dock

**Files:** `dock.js` (+ test), `video-studio.js`, `reel-source.js`, `footage-editor.js`, `engine.js` (filmstrip copy), `studio.css`

Done:
- [x] `dockState(kind, pref)`: stills → Pages; videos → Timeline (one page, nothing to switch to); reels → Timeline unless the user picked Pages (per design, session only). `canSwitch` is reels only.
- [x] Reels: a Pages button in the transport and a Timeline button on the strip (`vsDock`); in Pages each page shows its length (`durLabel`).
- [x] Stills: "Play as video" on the strip (`vsPlayAsVideo` → the same step as "Animate this design"; one undo makes it a still again).
- [x] `visibleTracks`: sources mark tracks `empty` with an `add`; empty Captions, Voice-over and Music rows leave the timeline and one "+ Track" row offers them (it opens the panel that fills them). Hidden until the timeline has a length. A video's Voice row (the clip's own sound) always stays.
- [x] The strip says "Pages" / "Add page" / "New page"; the timeline track keeps "Scenes".

Not done: other wording that still says "slide" outside the strip (⌘K group, export dialog, Agent tool labels) → Task 8's copy pass.

## Task 5: Inspector tabs Design / Animate / Layers

**Files:** `video-studio.js` (`finishProps`, `propTabs`, `DOC_TABS`, `vsDoc`), `engine.js` (the motion inspector hook), `studio.css`

Done:
- [x] Stills and reels: the tabs are Design, Animate, Layers (the shell's inspector wrapper rewrites the tab bar after every editor draw).
- [x] History opens from a new top-bar button (`#edHist`, next to Comments); the Comments button also opens the comment list while comment mode is on. Both show under a header with a close button back to Design. Videos get History too.
- [x] Reels: the Animate tab holds the selected layer's animation (enter, exit, loop), else the scene's role, length, transition and "Magic animate this scene". These left the Design tab.
- [x] Stills: the Animate tab explains and offers "Animate this design" (one undo makes it a still again); after it, the same tab shows the scene and layer animation.

Changed from the plan:
- Picking an animation preset directly on a still layer (convert + set that layer's anim in one step) is replaced by the "Animate this design" button in the Animate tab: it reuses `toMotion` and auto-animates every layer; the user then changes the one they want.
- Videos keep their own inspector (Look, or the caption style tabs) without Design / Animate / Layers: a video has no layers to animate, so those tabs would do nothing. Look stays reachable from the inspector and from Media → Look.
- History's "Save version" is a filled red button next to Export → fix in Task 8 (one primary per view).

## Task 6: Top bar kind tag and Export

**Files:** `video-studio.js` (`kindTag`, `clock`, `exportLabel`, `kindBar`), `studio.css`

Done:
- [x] A tag after the size: "Post", "Carousel · 3 pages", "Video · 0:11.5" (same time format as the transport; the length follows edits and appears once the player knows it). Hidden under 900 px.
- [x] The Export button says "Export" for posts and "Export video" for reels and videos; it already opened the right dialog per kind (images / PDF, motion export, footage export), and a video's "available once ready" state is kept.
- [x] Turning a still into a video (and undoing it) updates both at once.

Not done: folding the zoom controls into one menu (the top bar still fits at 1440 px with the tag) → revisit in Task 8 if it crowds narrower screens.

## Task 7: Studio home: size first, then a starting point

**Files:** `home.js` (+ test), `engine.js` (the Studio page's Create block, `crSize`, `crTemplates`, `crUpload`), `studio.css`

Done:
- [x] **Size:** Square, Portrait, Story / Reel, Landscape 1920 × 1080, Thumbnail 1280 × 720, Carousel (3 pages, 4:5). Each opens a blank post at that size (no `d.motion`); pages and Animate do the rest.
- [x] **Start from:** Template (the library's Templates tab), Upload a video (an empty video, then the file picker), Match a reference, Import from Figma.
- [x] The Posts and Videos rows are gone; every old tile's flow is one or two clicks away (a video format = its size + Animate).
- [x] Flat tiles: no hover shadow or lift.

Not done: dropping a video file anywhere on the home (Upload a video covers it); the unused `mo37New` action stays for now.

## Task 8: Flat visual pass

**Files:** `studio.css` (one scoped block at the end), `engine.js` (button classes, copy)

Done:
- [x] Inside the editor (`.ed`) and the Studio home: `--shadow-xs` is none, and every blurred shadow on rail, panels, inspector, tabs, page thumbnails, canvas, video frame, play button, Agent panel, audio cards, tiles and the timeline's scene "+" is gone (depth from 1 px borders and tints). Checked in the app: no blurred `box-shadow` left on any visible element of the home, a still, a reel, a video or the Agent panel.
- [x] Kept on purpose: focus rings, selection rings (spread only, no blur), drag feedback, floating menus, modals, toasts, colour picker and the mobile drawers (floating layers).
- [x] One filled red button per view (Export, or New design on the home): History's "Save version", the comment list's "Add a comment", Motion's "Animate this design" and Live data's "Replace page with calendar" are now secondary. The red play button stays (a control, not an action).
- [x] "Slide" → "page" in the editor: ⌘K (Add page, Duplicate page), the image export dialog, comment locations, the Agent's step labels, the Templates, Figma and Live data panels, and the Brand kit's empty template note.

Not done:
- "Slides" outside the editor (Settings, AI usage, the Figma import dialog's "Separate designs / One carousel" mode) where it means carousel slides.
- Folding the zoom controls into one menu: the top bar fits at 1440 px; revisit with a narrow-screen pass.

## Task 9 (follow-up, not in this plan): footage inside a reel

Lifting "a design is a reel **or** a video" means a video clip becomes a layer on a scene: `d.footage` would move to `page.layers[].footage`, `footage-player.js` would play per scene, and `backend/src/footage/export.service.ts` would composite clips into the motion export. That needs its own spec. Until then, adding a video in Media on a still or reel offers "Start a video from this clip" (a new video design) instead.

---

## Order and checkpoints

Tasks 1 → 2 → 3 land the new rail on every kind (checkpoint: open one design of each kind, every old ⌘K "Open …" command still works). Tasks 4 and 5 can run in parallel after 2 (different files except `engine.js` regions: dock at the slide strip, inspector at edProps). Tasks 6, 7 and 8 are independent of each other after 5.
