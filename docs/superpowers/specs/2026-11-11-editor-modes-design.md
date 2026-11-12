# Editor modes: Design and Animate

Date: 2026-11-11
Status: draft for review

## Goal

The Studio editor has two editing modes, each with its own sidebar and tools, so static design tools and video tools are never mixed:

- **Design mode** for static posts and carousels, and for changing the layers of an animated design.
- **Animate mode** for animated designs and uploaded videos: animation, audio, scenes, captions, timing.

Success: a user editing a static design sees only design tools; a user animating or editing a video sees only video tools; switching is one click and loses nothing.

## What this replaces

The Unified Studio plan (`docs/superpowers/plans/2026-11-08-unified-studio.md`) gave every kind one seven-item rail (Templates, Elements, Text, Media, Audio, Captions, Brand, Agent) with merged items shown as sub-tabs and empty states where an item did not apply. This spec replaces that plan's design rule 2 ("one rail, same order, every kind") and the Pages / Timeline dock switch from its Task 4.

Kept from that plan: the Video Studio shell and its sources (`still`, `reel`, `video`), the timeline and transport, the kind tag, the Export label, History and Comments in the top bar, the flat visual rules, the copy rules, and "the kind is derived, not chosen".

## Modes

`kindOf(d)` stays `still` / `reel` / `video`. The mode is derived from the kind and, for a reel, the user's choice:

| Kind | Modes | Opens in | Top bar |
| --- | --- | --- | --- |
| `still` | Design | Design | Design / Animate switch; Animate converts the design |
| `reel` | Design, Animate | Animate | Design / Animate switch |
| `video` (footage) | Animate | Animate | No switch |

Rules:

- `modeOf(kind, pref)`: `still` → `design`; `video` → `animate`; `reel` → `design` when `pref === 'design'`, else `animate`.
- The preference is session state per design id (as `dockPref` is today). It is not saved in the design. No data migration.
- On a still, choosing Animate runs the existing `mo37Make` step (`toMotion` inside one `mutate()`), which makes it a reel, so the editor lands in Animate mode. One undo makes it a still again and the editor returns to Design mode.
- On a reel, switching to Design keeps `d.motion`, every `pg.scene` and every `l.anim` untouched. It only changes the rail, the bottom area and the inspector tabs. Playback stops when leaving Animate mode.
- The switch is a two-button segmented control in the top bar next to the kind tag: "Design", "Animate". It is not drawn for `video`.

## Sidebars

Flat rails. No merged items. An item that does nothing for the open design is not shown, so there are no "turn it into a video first" empty states.

### Design mode (still, and reel in Design mode)

In this order: Templates, Elements, Text, Uploads, Figma, Brand, Live data, Components, then Agent pinned at the bottom.

Each item opens the editor's existing panel of the same key (`templates`, `elements`, `text`, `uploads`, `figma`, `brand`, `data`, `comps`, `agent`). No sub-tabs. Templates lists designs only; motion scene templates are under Scenes in Animate mode.

### Animate mode, reel

In this order: Animation, Audio, Scenes, Captions.

| Item (key) | Content | Source today |
| --- | --- | --- |
| Animation (`animation`) | "Magic animate" for the open scene; enter, exit and loop presets applied to the selected layers, or to every layer of the scene when nothing is selected | The preset pickers of the inspector's Animate tab and the Motion panel's Magic animate |
| Audio (`audio`) | Music and voice-over, volume, ducking | The reel's Audio panel, unchanged |
| Scenes (`scenes`) | The scene list: select, reorder, duplicate, delete, length, transition. Below it, the scene library (Intros, Scenes, Outros). The timeline's "+" still aims the library | The Motion panel's library, and the scene controls of the Animate tab |
| Captions (`captions`) | Sub-tabs Lines, Styles, Script | `caption-panels.js`; Script moves here from Audio |

### Animate mode, uploaded video

In this order: Scenes, Audio, Captions. Animation is not shown: footage has no layers.

| Item (key) | Content | Source today |
| --- | --- | --- |
| Scenes (`scenes`) | The clip: name, length, size, replace. Below it, the colour Look and "Match a reference" | Footage editor's `media` and `look` panels |
| Audio (`audio`) | Original sound volume, music bed, ducking | Footage editor's Audio panel, unchanged |
| Captions (`captions`) | Sub-tabs Lines, Styles, Script | As for a reel |

Agent is a Design-mode item only. An uploaded video therefore has no Agent panel.

## What else follows the mode

- **Bottom area.** Design: the page strip. Animate: transport and timeline. `dockState` takes the mode. The Pages button in the transport, the Timeline button on the strip, and "Play as video" on a still's strip are removed; the top-bar switch does all three jobs. On a reel in Design mode each page still shows its length.
- **Inspector tabs.** Design mode: Design, Layers. Animate mode on a reel: Animate, Layers. The Animate tab keeps the selection's timing (delay, duration, easing) and, with nothing selected, the scene's role, length and transition. Presets are picked in the Animation panel; the tab tunes them. An uploaded video keeps its Look inspector and the caption inspector as today. History and Comments stay in the top bar.
- **Keys.** The transport keys (Space, J, K, L, arrows) are active in Animate mode only. In Design mode on a reel the editor's own keys apply (Space pans, L draws a line).
- **Stage.** A reel in Design mode shows the static canvas of the open page, with every layer at its final state. Animate mode mounts the reel player as today.

## Old keys and entry points

`ED.tab` keeps holding a panel key. `panelFor(kind, mode, key)` resolves any key to `{ mode, tab, sub }`:

| Key | Resolves to |
| --- | --- |
| `media` | `uploads` (Design); `scenes` for a video |
| `motion` | `scenes` (Animate); on a still, `templates` |
| `look` | `scenes` for a video |
| `styles`, `script` | `captions` with that sub-tab (Animate) |
| a Design key on a reel in Animate mode | switches to Design mode and opens it |
| an Animate key on a reel in Design mode | switches to Animate mode and opens it |
| an Animate key on a still | the first Design item (Templates); nothing converts without the user choosing Animate |
| a Design key on a video | Scenes |

⌘K "Open …" lists the items of the current mode. `ACT.edTab` goes through `panelFor`, so saved tabs, deep links and buttons inside existing panels keep working.

## Architecture

- `frontend/studio/video-studio.js`: `modeOf`, `railFor(kind, mode)`, `panelFor`, `subsOf(kind, key)` (only Captions has sub-tabs), `propTabs(mode, rtab)`. `RAIL`, `RAIL_FOOT`, `TAB_ALIAS`, `GROUPS`, `groupOf`, `resolveTab`, `EMPTY`, `emptyOf`, `unifiedRail` are removed. The shell draws the rail, the mode switch and the sub-tabs; `vsMode` action replaces `vsDock` and `vsPlayAsVideo`.
- `frontend/studio/dock.js`: `dockState(mode)`; `canSwitch` removed.
- `frontend/studio/engine.js`: the Motion panel (`mo37`) splits into an Animation panel and a Scenes panel, registered as shell panels; the top-bar switch host; ⌘K by mode; the still's Animate tab call-to-action goes (the tab is not shown in Design mode).
- `frontend/studio/reel-source.js`: panel keys follow the Animate rail; Design mode unmounts the player and hands the stage, panels and strip back to the editor.
- `frontend/studio/still-source.js`: unchanged behaviour; its header comment is updated.
- `frontend/studio/footage-editor.js`: `scenes` panel renders the clip and the Look together; `media` and `look` keys resolve to it.
- `frontend/studio/caption-panels.js`: Script is a Captions sub-tab.
- `frontend/styles/studio.css`: the mode switch, the scene list, removal of unused empty-state and dock-switch styles.

The mode, rail and resolution rules are pure functions with no DOM, so they are unit-tested in `video-studio.test.js` and `dock.test.js`.

## Error handling and edge cases

- A viewer without edit rights sees the mode switch and can change mode on a reel; on a still the Animate button is disabled, as conversion is an edit.
- Undoing the conversion while in Animate mode returns the editor to Design mode with a valid Design tab (`panelFor` re-resolves `ED.tab` on every rail draw).
- Opening another design resets nothing global: the preference is per design id.
- A reel with a selected caption line that switches to Design mode drops that selection (`VS.select(null)`).

## Testing

Unit (vitest):

- `modeOf` for every kind and preference.
- `railFor`: exact items and order for `still`/design, `reel`/design, `reel`/animate, `video`/animate; Agent last and only in Design; no Animation for a video; fresh copies.
- `panelFor`: every key of the table above, for every kind and mode; every previously valid key resolves to a panel that exists.
- `subsOf`: Captions has Lines, Styles, Script; every other item has none.
- `propTabs` by mode; `dockState` by mode.
- Existing reel, footage and caption panel tests updated for the new keys.

In the browser, per the repo's verification workflow:

1. A still shows the nine Design items and the page strip, no timeline, and exports PNG as before.
2. Animate on a still: the editor switches to the four Animate items, transport and timeline; one undo restores the still and Design mode with no `d.motion`, `pg.scene` or `l.anim` left.
3. A reel: Design / Animate switch both ways; a text box added in Design mode appears in Animate mode and can be given an animation; animation survives the round trip.
4. An uploaded video: Scenes, Audio, Captions only; no switch; replace and Look work from Scenes.
5. ⌘K and old keys open the right panel and mode.

## Out of scope

- Footage inside a reel (still Task 9 of the unified plan).
- Saving the mode in the design.
- New animation presets, audio features or caption features; this moves existing tools.
- Trim controls for an uploaded clip beyond what the footage editor has today.
