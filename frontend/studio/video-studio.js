/* ============================================================
   Video Studio shell: one editor for videos and reels. Sources register per kind and the shell draws the rest:
   - the rail of the editing mode (railFor: Design or Animate, with the Design / Animate switch in the top bar) and its side panel: a shared panel (VS.panel) first, else the source's panel,
     else the panel's title and one sentence of what it will hold;
   - the transport under the stage (back 5 s, play, forward 5 s, time, the source's extra controls, keyboard J/K/L,
     Space and the arrows), driven by `source.player`;
   - the bottom area: the source's tracks in the shared timeline (timeline.js);
   - the inspector, routed by the selection (VS.select).
   The shell takes over videos (footage-editor.js), reels (reel-source.js) and stills (still-source.js, which hands its rail,
   panels and slide strip back to the editor until the unified rail and the Pages dock land).

   A source: { mount(stage), unmount(), player, tracks() -> Track[], panel(key) -> html | null, inspector(sel) -> html | null,
   transportExtra() -> html } and, optionally, panelDrawn(key), canEdit(), onRetime(...), onSelect(id), onToggle(id)
   (the timeline's callbacks), nativeRail / nativePages (true: the editor draws the rail and its panels / the bottom area), nativePanel(key) (true: the editor's own panel draws that rail item) and nativeInspector
   (true: the editor's own properties draw when the shell has no inspector for the selection), captions (helpers for the shared
   Captions panel, see caption-panels.js). `player`: { toggle(), play(), pause(), seek(ms), time(), duration(), playing() } and
   optionally ready() (false until the media can play) and frameMs().
   The source tells the shell about playback with VS.tick(ms, playing), new tracks with VS.refresh(), the waveform with
   VS.setPeaks(peaks), and a closed session with VS.reset().
   The pure helpers at the top are unit-tested; installVideoStudio is a DOM module.
   ============================================================ */
import { kindOf } from './caption-store.js';
import { createTimeline } from './timeline.js';
import { fmtMs } from './footage-player.js';
import { dockState, visibleTracks, durLabel } from './dock.js';

/* ---------- pure helpers ---------- */
/* ---------- modes and rails ----------
   Two editing modes, each with its own rail (Editor modes spec, 2026-11-11):
   - Design: the tools that add to a static design. Stills always; an animated design (reel) when the user switches to it.
   - Animate: animation, audio, scenes and captions. Reels by default; an uploaded video always (it has no layers: no Animation).
   The Agent is pinned at the bottom of both rails of a still and a reel (Studio Agent spec, 2026-11-12); an uploaded video has it too.
   The mode comes from the kind and, for a reel, the user's choice for the session (never saved in the design).
   ED.tab holds the key of the open panel; panelFor sends any key, old ones too, to a panel that exists and the mode it lives in. */
export const DESIGN_RAIL = [['templates', 'Templates', 'layout'], ['elements', 'Elements', 'shapes'], ['text', 'Text', 'type'],
  ['uploads', 'Uploads', 'upload'], ['figma', 'Figma', 'figma'], ['brand', 'Brand', 'palette'], ['data', 'Live data', 'chart'],
  ['comps', 'Components', 'comp33']];
export const DESIGN_FOOT = [['agent', 'Agent', 'studio']];
export const ANIMATE_RAIL = [['animation', 'Animation', 'wand'], ['audio', 'Audio', 'music38'], ['scenes', 'Scenes', 'film37'],
  ['captions', 'Captions', 'vsCc']];
export const VIDEO_RAIL = [['scenes', 'Scenes', 'vsFilm'], ['audio', 'Audio', 'music38'], ['captions', 'Captions', 'vsCc']];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** The editing mode: a still is always 'design', a video always 'animate', a reel 'animate' unless the user picked 'design' */
export function modeOf(kind, pref) {
  if (kind === 'video') return 'animate';
  if (kind === 'reel') return pref === 'design' ? 'design' : 'animate';
  return 'design';
}
/** The rail of a kind in a mode: [[key, label, icon]] (fresh copies). A video has one rail whatever the mode */
export function railFor(kind, mode) {
  const r = kind === 'video' ? [...VIDEO_RAIL, ...DESIGN_FOOT] : mode === 'animate' && kind === 'reel' ? [...ANIMATE_RAIL, ...DESIGN_FOOT] : [...DESIGN_RAIL, ...DESIGN_FOOT];
  return r.map((x) => [...x]);
}
const FOOT = new Set(DESIGN_FOOT.map((r) => r[0]));
/** Rail items pinned at the bottom */
export const isFoot = (key) => FOOT.has(key);
/** The panels of a rail item, shown as sub-tabs: only Captions has some */
const SUBS = { captions: [['captions', 'Lines'], ['styles', 'Styles'], ['script', 'Script']] };
export const subsOf = (item) => (has(SUBS, item) ? SUBS[item].map((r) => [...r]) : []);
/** The rail item that holds panel `tab` */
export const itemOf = (tab) => (tab === 'styles' || tab === 'script' ? 'captions' : tab);
const DESIGN_KEYS = new Set([...DESIGN_RAIL, ...DESIGN_FOOT].map((r) => r[0]));
const ANIMATE_KEYS = new Set(['animation', 'audio', 'scenes', 'captions', 'styles', 'script']);
const VIDEO_KEYS = new Set(['scenes', 'audio', 'captions', 'styles', 'script']);
/**
 * Where a panel key opens: { mode, tab }. Old keys keep working ('media', 'motion', 'look'). On a reel a key of the other
 * mode switches mode; a still never leaves Design (nothing converts it but the user choosing Animate); a video keeps its rail.
 */
export function panelFor(kind, mode, key) {
  if (kind === 'video') return { mode: 'animate', tab: VIDEO_KEYS.has(key) || isFoot(key) ? key : 'scenes' };
  if (kind !== 'reel') return { mode: 'design', tab: DESIGN_KEYS.has(key) ? key : key === 'media' ? 'uploads' : 'templates' };
  if (isFoot(key)) return { mode: mode === 'animate' ? 'animate' : 'design', tab: key }; // the agent stays in the mode the reel is in
  if (DESIGN_KEYS.has(key)) return { mode: 'design', tab: key };
  if (ANIMATE_KEYS.has(key)) return { mode: 'animate', tab: key };
  if (key === 'motion' || key === 'look') return { mode: 'animate', tab: 'scenes' };
  if (key === 'media') return { mode: 'design', tab: 'uploads' };
  return mode === 'design' ? { mode: 'design', tab: 'templates' } : { mode: 'animate', tab: 'animation' };
}
/** The top-bar Design / Animate switch: null for a video; canAnimate false on a still its viewer cannot edit (animating is an edit) */
export function switchState(kind, mode, canEdit) {
  if (kind === 'video') return null;
  return { mode, canAnimate: kind === 'reel' || !!canEdit };
}
/** The transport keys (Space, J, K, L, arrows) belong to Animate; in Design the editor's own keys apply */
export const keysOn = (mode) => mode === 'animate';
/**
 * Where the inspector goes for a selection: 'caption' (the caption style tabs), 'source' (the source's own inspector,
 * the video's Look) or 'scene' (a reel's scene / layer properties, a still's Design / Layers). Nothing selected: the caption
 * tabs while the Captions or Styles panel is open (`tab`), else the source for a video, the scene for a reel or a still.
 */
export function inspectorRoute(sel, kind, tab) {
  const k = sel && sel.kind;
  if (k === 'caption') return 'caption';
  if (kind === 'still') return 'scene';
  if (k === 'video') return 'source';
  if (k === 'scene') return 'scene';
  if (tab === 'captions' || tab === 'styles') return 'caption';
  return kind === 'video' ? 'source' : 'scene';
}
/** The inspector's tabs by mode: [[key, label, on]] (History and Comments open from the top bar). A tab the mode lacks lights the first */
export function propTabs(mode, rtab) {
  const tabs = mode === 'animate' ? [['animate', 'Animate'], ['layers', 'Layers']] : [['design', 'Design'], ['layers', 'Layers']];
  const on = tabs.some(([k]) => k === rtab) ? rtab : tabs[0][0];
  return tabs.map(([k, l]) => [k, l, k === on]);
}
/** Inspector tabs that belong to the document, not the selection: drawn under a header with a close button */
export const DOC_TABS = { history: 'History', comments: 'Comments' };
export const isDocTab = (rtab) => has(DOC_TABS, rtab);
/** The top-bar button for a document tab: open it, or back to Design when it is open */
export const docToggle = (rtab, k) => (rtab === k ? 'design' : k);
/** The length for the top bar: the transport's m:ss.t, without a trailing ".0" (0:11.5, 2:43) */
export const clock = (ms) => fmtMs(ms).replace(/\.0$/, '');
/** What the design is, next to its size in the top bar: "Post", "Carousel · 3 pages", "Video · 0:11" */
export function kindTag(kind, { pages = 1, ms = 0 } = {}) {
  if (kind === 'still') return pages > 1 ? `Carousel · ${pages} pages` : 'Post';
  return ms > 0 ? `Video · ${clock(ms)}` : 'Video';
}
/** The Export button: a post exports images or a PDF, a reel or a video exports a video */
export const exportLabel = (kind) => (kind === 'still' ? 'Export' : 'Export video');
/** The shell opens every design: videos, reels and stills (a still's source hands most parts back to the editor) */
export const takesOver = (d) => !!d;
/** Whether the editor, not the shell, draws `part` ('nativeRail': the rail and its panels, 'nativePages': the bottom area) */
export const handsBack = (S, part) => !S || !!S[part];
/** What a rail item without a panel yet will hold: one sentence under its title */
export const SOON = {
  scenes: 'Your video with its name, length and size, a way to replace it, and its colour look.',
  captions: 'Caption lines to read, edit, retime, split and merge.',
  styles: 'Caption style presets by category, with your saved brand styles.',
  script: 'Paste a script to time it to the speech, or open and download SRT and VTT files.',
  audio: 'The original sound’s volume, a music bed and ducking under the voice.',
};

/* ---------- DOM ---------- */
export function installVideoStudio(ctx) {
  const { ED, ACT, IC, ic, esc, wrapEd, ed } = ctx;
  /** Whether the viewer can change designs (no toast: only to enable the Animate button) */
  const editable = () => (ctx.editable ? !!ctx.editable() : true);
  Object.assign(IC, {
    vsFilm: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4"/>',
    vsStyle: '<path d="M4 7V5h11v2"/><path d="M9.5 5v14"/><path d="M7 19h5"/><path d="M18 9.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z"/>',
    vsCc: '<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>',
    vsLook: '<circle cx="9" cy="9" r="7"/><circle cx="15" cy="15" r="7"/>',
    vsBack5: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    vsFwd5: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    vsDesign: '<path d="M12 20h9"/><path d="M16.4 3.6a2 2 0 0 1 2.8 2.8L7 18.6 3 20l1.4-4Z"/>',
    vsView: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
    vsKbd: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  });
  const $ = (s) => document.querySelector(s);
  /** Registered sources by kind, shared panels and inspectors by key */
  const SRC = {}, PANELS = {}, INSP = {};
  /** The selection, the timeline (and its host, kept across redraws of the bottom area), the waveform, the mounted source */
  let sel = null, tl = null, tlHost = null, peaks = null, mounted = null;
  /** The source of the open design, or null when the shell does not take it over */
  const src = () => (ED.d && takesOver(ED.d) && SRC[kindOf(ED.d)]) || null;
  const ready = (P) => !!P && (!P.ready || !!P.ready());

  /* ---- transport ---- */
  let ctlOk = null; // whether the drawn [data-vs-ctl] buttons are enabled: tick() touches them only when the player's ready state changes
  function transportHTML(S) {
    const P = S.player, ok = ready(P), ms = ok ? P.time() : 0, dur = ok ? P.duration() : 0, playing = ok && !!P.playing(), off = ok ? '' : 'disabled';
    ctlOk = ok;
    const extra = S.transportExtra ? S.transportExtra() : '';
    return `<div class="ft-tp">
      <div class="ft-tp-g">
        <button class="ft-ib" data-act="vsBack" data-vs-ctl aria-label="Back 5 seconds (J)" title="Back 5 s (J)" ${off}>${ic('vsBack5', 18)}</button>
        <button class="ft-play" id="vsPlay" data-act="vsPlay" data-vs-ctl data-on="${playing}" aria-label="${playing ? 'Pause' : 'Play'} (Space)" title="${playing ? 'Pause' : 'Play'} (Space)" ${off}>${ic(playing ? 'pause37' : 'play37', 18)}</button>
        <button class="ft-ib" data-act="vsFwd" data-vs-ctl aria-label="Forward 5 seconds (L)" title="Forward 5 s (L)" ${off}>${ic('vsFwd5', 18)}</button>
        <span class="ft-time"><b id="vsT">${fmtMs(ms)}</b><span class="ft-sep">/</span><span id="vsDur">${fmtMs(dur)}</span></span>
      </div>
      <div class="ft-tp-g">${extra}${extra ? '<span class="ft-div" aria-hidden="true"></span>' : ''}
        <span class="ft-ib ft-kbd" tabindex="0" role="img" aria-label="Keyboard shortcuts: Space play or pause, J and L 5 seconds back or forward, K pause, left and right arrows one frame" title="Space  play / pause
J / L  5 s back / forward
K  pause
← / →  one frame">${ic('vsKbd', 17)}</span>
      </div>
    </div>`;
  }
  /** Playback moved (the source calls this from its player): time, play button, controls enabled, the timeline's playhead */
  function tick(ms, playing) {
    const S = src(); if (!S) return;
    const P = S.player, ok = ready(P);
    const t = $('#vsT'); if (t) t.textContent = fmtMs(ms);
    const td = $('#vsDur'); if (td) td.textContent = fmtMs(ok ? P.duration() : 0);
    // the transport is drawn before the player exists: enable it as soon as the player is there
    if (ok !== ctlOk) { ctlOk = ok; document.querySelectorAll('[data-vs-ctl]').forEach((b) => { b.disabled = !ok; }); }
    const pb = $('#vsPlay');
    if (pb && pb.dataset.on !== String(!!playing)) {
      const l = playing ? 'Pause (Space)' : 'Play (Space)';
      pb.dataset.on = String(!!playing); pb.innerHTML = ic(playing ? 'pause37' : 'play37', 18); pb.setAttribute('aria-label', l); pb.title = l;
    }
    if (tl) tl.setTime(ms, playing);
    if (!playing) kindBar(); // the length is known once the player is ready, and changes with an edit
  }

  /* ---- the editing mode: Design or Animate, per design for the session (a reel's choice; stills and videos have one) ---- */
  const modePref = {};
  const kindNow = () => (ED.d ? kindOf(ED.d) : 'still');
  const mode = () => modeOf(kindNow(), ED.d && modePref[ED.d.id]);
  /** ED.tab on a panel that exists for the design; a reel's tab of the other mode takes the mode with it */
  function settleTab() {
    const kind = kindNow(), r = panelFor(kind, mode(), ED.tab);
    if (kind === 'reel' && r.mode !== mode()) {
      // the tab was left from the other mode (a saved tab, or a mode change): the mode wins, on its first item
      ED.tab = railFor(kind, mode())[0][0];
    } else ED.tab = r.tab;
    return ED.tab;
  }
  /** Leaves or enters a mode: the rail, the bottom area and the inspector tabs follow; nothing in the design changes */
  function setMode(m) {
    if (!ED.d) return;
    const kind = kindNow(), want = m === 'animate' ? 'animate' : 'design';
    if (kind === 'video') return;
    if (kind === 'still') { // animating a still is an edit: one mutate() step, one undo makes it a still again
      if (want !== 'animate' || !editable() || !ACT.mo37Make) return;
      modePref[ED.d.id] = 'animate'; ED.tab = 'animation'; ED.rtab = 'animate';
      ACT.mo37Make(); return;
    }
    if (want === mode()) return;
    const S = src();
    if (want === 'design') { // playback stops, a caption selection goes with its panel
      if (S && ready(S.player)) S.player.pause();
      if (ACT.mo37Edit) ACT.mo37Edit();
      if (sel && sel.kind === 'caption') sel = null;
    }
    modePref[ED.d.id] = want;
    if (panelFor(kind, want, ED.tab).mode !== want) ED.tab = railFor(kind, want)[0][0];
    if (!isDocTab(ED.rtab) && ED.rtab !== 'layers') ED.rtab = propTabs(want)[0][0];
    ed.all();
    requestAnimationFrame(() => dispatchEvent(new Event('resize'))); // the canvas refits to the new bottom area
  }
  /** The tracks with content, then one "+ Track" row offering the empty ones (captions, voice-over, music) */
  function withAddRow(tracks, hasLength) {
    const { keep, adds } = visibleTracks(tracks);
    if (!adds.length || !hasLength) return keep; // lanes draw once there is a length: no empty "+ Track" row before
    const btns = adds.map((a) => `<button class="au-add vs-add-tr" data-act="${esc(a.act)}"${a.k ? ` data-k="${esc(a.k)}"` : ''}>${ic('plus', 11)}${esc(a.label)}</button>`).join('');
    return [...keep, { id: 'add', icon: ic('plus', 14), label: 'Track', toggle: null, height: 30, html: () => `<div class="vs-add-row">${btns}</div>` }];
  }
  /** On the page strip of an animated design (Design mode): each page's length */
  function pagesExtras(host, kind) {
    if (kind !== 'reel' || !ED.d) return;
    host.querySelectorAll('.pg').forEach((el, i) => {
      const pg = ED.d.pages[i], t = durLabel(pg && pg.scene && pg.scene.dur);
      if (t && !el.querySelector('.vs-pg-dur')) el.insertAdjacentHTML('beforeend', `<span class="vs-pg-dur">${esc(t)}</span>`);
    });
  }

  /* ---- timeline: mounted once per session in its host, moved back in when the bottom area is redrawn ---- */
  function mountTimeline(S, host) {
    if (!tlHost) {
      tlHost = document.createElement('div'); tlHost.className = 'vs-tl-host';
      // a click on the Video track or on a scene puts the inspector back on the Look or the scene's properties
      tlHost.addEventListener('click', (e) => {
        const row = e.target.closest('.vs-tl-row'); if (!row || !src()) return;
        if (row.dataset.track === 'video') select({ kind: 'video' });
        else if (row.dataset.track === 'scenes') { const b = e.target.closest('[data-i]'); if (b) select({ kind: 'scene', i: +b.dataset.i }); }
      });
    }
    host.append(tlHost);
    if (tl) { tl.redraw(); return; }
    const P = S.player, mine = () => src() === S;
    tl = createTimeline(tlHost, {
      dur: () => (ready(P) ? P.duration() : 0),
      time: () => (ready(P) ? P.time() : 0),
      seek: (ms) => { if (mine() && ready(P)) P.seek(ms); },
      tracks: () => (mine() ? withAddRow(S.tracks(), ready(P) && P.duration() > 0) : []),
      canEdit: () => (S.canEdit ? S.canEdit() : true),
      onRetime: (...a) => { if (mine() && S.onRetime) S.onRetime(...a); },
      onSelect: (id) => { if (!mine()) return; select({ kind: 'caption', id }); if (S.onSelect) S.onSelect(id); },
      onToggle: (id) => { if (mine() && S.onToggle) S.onToggle(id); },
    });
    if (peaks) tl.setPeaks(peaks);
  }
  /** The session closed: the timeline goes (a drag in progress is cancelled), the waveform and the selection too */
  function reset() {
    if (tl) tl.destroy(); tl = null;
    if (tlHost) tlHost.remove(); tlHost = null;
    peaks = null; sel = null;
  }
  const refresh = () => { if (tl) tl.redraw(); };
  function setPeaks(p) { peaks = p || null; if (tl) tl.setPeaks(peaks); }

  /* ---- sub-tabs: the panels of a rail item that has several (Captions: Lines, Styles, Script), above whatever draws the panel ----
     Panels redraw #edPanel's content in many places (async loads too): an observer puts the bar back whenever it goes */
  function subsHTML(item, k) {
    const subs = subsOf(item); if (subs.length < 2) return '';
    const label = (railFor(kindNow(), mode()).find((r) => r[0] === item) || [item, item])[1];
    return `<div class="vs-subs" role="tablist" aria-label="${esc(label)}">${subs.map(([sk, l]) =>
      `<button role="tab" aria-selected="${sk === k}" class="${sk === k ? 'on' : ''}" data-act="edTab" data-k="${sk}">${esc(l)}</button>`).join('')}</div>`;
  }
  function putSubs() {
    const p = $('#edPanel'); if (!p) return;
    const S = src(), old = p.querySelector(':scope > .vs-subs');
    const h = S && ED.d ? subsHTML(itemOf(ED.tab), ED.tab) : '';
    if (!h) { if (old) old.remove(); return; }
    if (old && old.outerHTML === h) return;
    if (old) old.outerHTML = h; else p.insertAdjacentHTML('afterbegin', h);
  }
  let watched = null;
  function watchSubs() {
    const p = $('#edPanel'); if (!p || watched === p) return;
    watched = p;
    new MutationObserver(() => { if (watched === p) putSubs(); }).observe(p, { childList: true });
  }

  /* ---- inspector: the mode's tabs (Design, Layers or Animate, Layers); History and Comments open from the top bar ---- */
  function finishProps(el, kind) {
    const tabs = el.querySelector(':scope > .tabs');
    if (tabs) {
      if (isDocTab(ED.rtab)) {
        const t = DOC_TABS[ED.rtab];
        tabs.outerHTML = `<div class="tabs vs-doc-h"><b>${esc(t)}</b><button class="btn ghost icon sm" data-act="edRTab" data-k="design" aria-label="Close ${esc(t.toLowerCase())}" title="Close">${ic('x', 16)}</button></div>`;
      } else tabs.innerHTML = propTabs(mode(), ED.rtab).map(([k, l, on]) => `<button class="${on ? 'on' : ''}" data-act="edRTab" data-k="${k}" aria-pressed="${on}">${esc(l)}</button>`).join('');
    }
    topButtons();
  }
  /** The kind tag after the size, and the Export label: redrawn when they change (a still turned into a video, a new length) */
  function kindBar() {
    if (!ED.d) return;
    const S = src(), kind = kindOf(ED.d), P = S && S.player;
    const ms = kind === 'still' ? 0 : P && ready(P) ? P.duration() : (ED.d.footage && ED.d.footage.dur) || 0;
    const t = kindTag(kind, { pages: (ED.d.pages || []).length, ms });
    let tag = $('#edKind');
    if (!tag) { const at = $('#edRatio'); if (at) { at.insertAdjacentHTML('afterend', `<span class="vs-kind" id="edKind" aria-live="polite"></span>`); tag = $('#edKind'); } }
    if (tag && tag.textContent !== t) { tag.textContent = t; tag.dataset.kind = kind; }
    const b = document.querySelector('.ed-top [data-act=edExport]'), l = exportLabel(kind);
    if (b && b.dataset.label !== l) { b.dataset.label = l; b.innerHTML = `${ic('download', 16)}${esc(l)}`; }
  }
  /**
   * The Design / Animate switch: at the top of the inspector (the right sidebar), above its tabs, with what the mode does
   * and, on a video, "Make it a still design". On a phone, where the sidebar is a drawer, the top bar keeps a compact
   * copy. None for an uploaded video; Animate turns a still into a video.
   */
  function modeSwitch() {
    const kind = ED.d ? kindNow() : null, st = ED.d ? switchState(kind, mode(), editable()) : null;
    const top = $('#edMode'), side = $('#edModeBox');
    if (!st) { if (top) top.remove(); if (side) side.remove(); return; }
    const btn = (v, l, icon, off) => `<button class="${st.mode === v ? 'on' : ''}" data-act="vsMode" data-v="${v}" aria-pressed="${st.mode === v}" aria-label="${l}" title="${off ? 'You can view this design but not change it' : l === 'Design' ? 'Design: add and arrange layers' : 'Animate: animation, audio, scenes and captions'}"${off ? ' disabled=""' : ''}>${ic(icon, 15)}<span class="lbl">${l}</span></button>`;
    const seg = (id) => `<div class="seg vs-mode" id="${id}" role="group" aria-label="Editing mode">${btn('design', 'Design', 'vsDesign')}${btn('animate', 'Animate', 'play37', !st.canAnimate)}</div>`;
    // the top bar's copy (shown on small screens only, see .ed-top #edMode)
    const h = seg('edMode');
    if (top) { if (top.outerHTML !== h) top.outerHTML = h; } else { const at = $('#edKind') || $('#edRatio'); if (at) at.insertAdjacentHTML('afterend', h); }
    // the sidebar's
    const p = $('#edProps'); if (!p) return;
    const hint = kind === 'still' ? (st.canAnimate ? 'Animate turns this design into a video. Undo brings it back.' : '') : st.mode === 'animate' ? 'Animation, scenes, sound and captions.' : 'Layers of the open scene. Play it in Animate.';
    const still = kind === 'reel' && editable() ? `<button type="button" class="btn ghost sm vs-still" data-act="mo37Still" title="Remove the animation: the scenes become pages">${ic('image', 15)}Make it a still design</button>` : '';
    const box = `<div class="vs-modebox" id="edModeBox"><div class="vs-mb-h"><span class="vs-mb-l">Mode</span><span class="vs-mb-k">${ic(kind === 'still' ? 'image' : 'vsFilm', 12)}${kind === 'still' ? 'Still design' : 'Video'}</span></div>${seg('edModeSide')}${hint ? `<p class="vs-mb-p">${hint}</p>` : ''}${still}</div>`;
    if (side) { if (side.outerHTML !== box) side.outerHTML = box; return; }
    const tabs = p.querySelector(':scope > .tabs'); if (tabs) tabs.insertAdjacentHTML('beforebegin', box); else p.insertAdjacentHTML('afterbegin', box);
  }
  /** History next to the comments in the top bar; both light while their list is open */
  /* ---- the top bar: three zones (the design; the mode; actions). Zoom sits on the canvas, the view toggles share one menu ---- */
  /** The view toggles the editor adds to the bar, shown as one "View" menu: [selector of the original button, label] */
  const VIEW = [['#edSafe', 'Safe zones'], ['#edGrid', 'Grid overlay'], ['#edRulers', 'Rulers'], ['#edAll34', 'All pages side by side']];
  function arrangeTop() {
    const top = $('.ed-top'); if (!top) return;
    top.classList.add('vs-top');
    const stage = $('.ed-stage');
    if (stage && !$('#edZoomPill')) { // zoom next to what it changes: a pill at the canvas's bottom right
      const zs = [...top.querySelectorAll(':scope > [data-act=edZoom], :scope > #zoomTxt')];
      if (zs.length) {
        const pill = document.createElement('div'); pill.id = 'edZoomPill'; pill.className = 'vs-zoom'; pill.setAttribute('role', 'group'); pill.setAttribute('aria-label', 'Zoom');
        stage.append(pill); pill.append(...zs);
      }
    }
    if (!$('#edView')) {
      const at = $('#edSafe');
      if (at) at.insertAdjacentHTML('beforebegin', `<button class="btn ghost icon sm" id="edView" data-act="vsView" title="View options" aria-label="View options" aria-haspopup="menu">${ic('vsView', 18)}</button>`);
    }
    const v = $('#edView'); if (v) v.classList.toggle('on', VIEW.some(([q]) => { const b = $(q); return b && b.classList.contains('on'); }));
    const sv = $('#savetxt'); if (sv && !sv.title) sv.title = 'All changes saved';
    const cm = top.querySelector('[data-act=cmdk]'); if (cm && !cm.getAttribute('aria-label')) cm.setAttribute('aria-label', 'Search actions');
  }
  /** The View menu: each row presses the editor's own toggle, with a tick when it is on */
  let viewWas = false;
  addEventListener('pointerdown', (e) => { const c = document.getElementById('ctx'); viewWas = !!(c && c.dataset.owner === 'view' && e.target.closest && e.target.closest('#edView')); }, true);
  function viewMenu(btn) {
    const old = document.getElementById('ctx'); if (old) old.remove();
    if (viewWas) { viewWas = false; return; } // a second press closes it
    const rows = VIEW.map(([q, l]) => ({ b: $(q), l })).filter((r) => r.b);
    if (!rows.length) return;
    const c = document.createElement('div'); c.className = 'ctx vs-view-menu'; c.id = 'ctx'; c.dataset.owner = 'view'; c.setAttribute('role', 'menu');
    c.innerHTML = rows.map((r, i) => { const on = r.b.classList.contains('on'), svg = r.b.querySelector('svg');
      return `<button role="menuitemcheckbox" aria-checked="${on}" data-i="${i}"><span class="ci">${svg ? svg.outerHTML : ''}${esc(r.l)}</span>${on ? ic('check', 15) : ''}</button>`; }).join('');
    document.body.append(c);
    const r = btn.getBoundingClientRect(), w = c.offsetWidth;
    c.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px'; c.style.top = r.bottom + 6 + 'px';
    c.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; c.remove(); rows[+b.dataset.i].b.click(); arrangeTop(); };
    c.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); c.remove(); btn.focus(); } };
    const f = c.querySelector('button'); if (f) f.focus();
  }
  function topButtons() {
    kindBar(); modeSwitch(); arrangeTop();
    const at = $('#edCm36') || $('#edSafe');
    if (at && !$('#edHist')) at.insertAdjacentHTML('beforebegin', `<button class="btn ghost icon sm vs-hist" id="edHist" data-act="vsDoc" data-k="history" title="Version history" aria-label="Version history">${ic('history', 18)}</button>`);
    const h = $('#edHist'); if (h) { h.classList.toggle('on', ED.rtab === 'history'); h.setAttribute('aria-pressed', String(ED.rtab === 'history')); }
  }

  function select(s) {
    const kind = kindOf(ED.d), was = inspectorRoute(sel, kind, ED.tab);
    sel = s || null;
    const now = inspectorRoute(sel, kind, ED.tab);
    // the inspector is redrawn when it changes hands (a redraw resets its scroll), or for a caption host that shows the line
    if (src() && (now !== was || (now === 'caption' && INSP.caption))) ed.props();
  }

  wrapEd({
    edRail: (orig) => function () {
      const S = src(); if (!S) return orig.apply(this, arguments);
      const el = $('#edRail'); if (!el) return;
      const on = itemOf(settleTab());
      el.dataset.mode = mode();
      el.innerHTML = railFor(kindNow(), mode()).map(([k, l, i]) => `<button class="${on === k ? 'on' : ''}${isFoot(k) ? ' foot' : ''}" data-act="edTab" data-k="${k}" title="${esc(l)}"${on === k ? ' aria-current="true"' : ''}>${ic(i, 22)}<span>${esc(l)}</span></button>`).join('');
      topButtons();
    },
    edPanel: (orig) => function () {
      const S = src(); if (!S) return orig.apply(this, arguments);
      const kind = kindNow(), k = settleTab();
      watchSubs();
      if (k === 'agent') return orig.apply(this, arguments); // the agent panel as today
      let h = PANELS[k] ? PANELS[k].render(ED.d, kind) : null;
      // no shared panel: the rail items the editor already draws for the source (a reel's Templates, Motion, Audio…)
      if (h == null && S.nativePanel && S.nativePanel(k)) return orig.apply(this, arguments);
      const p = $('#edPanel'); if (!p) return;
      const label = ([...subsOf(itemOf(k)), ...railFor(kind, mode())].find((r) => r[0] === k) || [k, k])[1];
      if (h == null && S.panel) h = S.panel(k);
      if (h == null) h = `<div class="vs-soon"><h3>${esc(label)}</h3><p class="sm-t muted">${esc(SOON[k] || '')}</p></div>`;
      p.classList.remove('agent'); p.innerHTML = h;
      if (PANELS[k] && PANELS[k].drawn) PANELS[k].drawn(k);
      if (S.panelDrawn) S.panelDrawn(k);
    },
    edProps: (orig) => function () {
      const S = src(); if (!S) return orig.apply(this, arguments);
      const el = $('#edProps'); if (!el) return;
      const kind = kindOf(ED.d);
      // History and Comments belong to the document: the editor draws them whatever the kind, under a header with a close button
      if (isDocTab(ED.rtab)) { const r = orig.apply(this, arguments); finishProps(el, kind); return r; }
      ED.rtab = propTabs(mode(), ED.rtab).find((t) => t[2])[0]; // a tab the mode lacks: its first one
      const r = inspectorRoute(sel, kind, ED.tab);
      let h = r === 'caption' && INSP.caption ? INSP.caption(sel, ED.d) : null;
      if (h == null && S.inspector) h = S.inspector(sel); // the caption tabs gave way (a reel's selected layer): the source's inspector
      if (h == null && S.nativeInspector) { const o = orig.apply(this, arguments); finishProps(el, kind); return o; } // a reel or a still: the editor's properties
      el.innerHTML = h || '';
      finishProps(el, kind);
    },
    edStage: (orig) => function () {
      const r = orig.apply(this, arguments), S = src();
      if (mounted && mounted !== S) { const m = mounted; mounted = null; reset(); m.unmount(); }
      if (S) { mounted = S; S.mount($('.ed-stage')); }
      if (S && mode() === 'design' && ready(S.player) && S.player.playing()) S.player.pause(); // Design shows the editing canvas
      return r;
    },
    edPages: (orig) => function () {
      const host = $('#edPages'); if (!host) return;
      const S = src(), kind = ED.d ? kindOf(ED.d) : 'still';
      if (handsBack(S, 'nativePages') || dockState(mode()) === 'pages') {
        host.classList.remove('ft10'); delete host.dataset.kind;
        const r = orig.apply(this, arguments);
        if (S) pagesExtras(host, kind);
        return r;
      }
      host.classList.add('ft10'); host.dataset.kind = kindOf(ED.d);
      // the timeline stays mounted while the bottom area is redrawn (every mutate): its zoom and scroll survive an edit
      if (tl && tlHost && tlHost.parentNode === host && host.querySelector('.ft-tp')) {
        refresh(); if (ready(S.player)) tick(S.player.time(), S.player.playing()); // an edit can change the length
        return;
      }
      host.innerHTML = transportHTML(S); mountTimeline(S, host);
    },
  });

  /* ---- actions and keys ---- */
  const P = () => { const S = src(); return S && ready(S.player) ? S.player : null; };
  const _tab = ACT.edTab;
  /* the comment button (top bar) also opens the comment list while comment mode is on */
  const _cm = ACT.cm36Mode;
  if (_cm) ACT.cm36Mode = function () {
    const r = _cm.apply(this, arguments), b = $('#edCm36');
    if (ED.d && b && b.classList.contains('on') && ED.rtab !== 'comments') { ED.rtab = 'comments'; ed.props(); }
    return r;
  };
  Object.assign(ACT, {
    vsPlay: () => { const p = P(); if (p) p.toggle(); },
    /* History (top bar): open it in the inspector, or close it back to Design */
    vsDoc: (a) => { if (!ED.d || !a || !a.dataset) return; ED.rtab = docToggle(ED.rtab, a.dataset.k); ed.props(); },
    /* the Design / Animate switch (top bar) */
    vsMode: (a) => { if (a && a.dataset) setMode(a.dataset.v); },
    /* the View menu (top bar): safe zones, grid, rulers, all pages side by side */
    vsView: (a) => viewMenu(a),
    vsBack: () => { const p = P(); if (p) p.seek(Math.max(0, p.time() - 5000)); },
    vsFwd: () => { const p = P(); if (p) p.seek(p.time() + 5000); },
    /* any panel key, old ones too, opens a panel that exists; on a reel a key of the other mode switches mode first.
       Scenes opens a video's inspector (its Look), Captions and Styles the caption one; another panel lets go of a selection those made */
    edTab: function (a) {
      if (!src() || !a || !a.dataset) return _tab.apply(this, arguments);
      const kind = kindNow(), r = panelFor(kind, mode(), a.dataset.k);
      if (r.mode !== mode()) { ED.tab = r.tab; setMode(r.mode); }
      const out = _tab.call(this, { dataset: { k: r.tab } }), k = ED.tab;
      if (k === 'scenes' && kind === 'video') select({ kind: 'video' });
      else if (k === 'captions' || k === 'styles') select({ kind: 'caption' });
      else if (sel && sel.kind === 'caption' && !sel.id) select(null);
      return out;
    },
  });
  /* Space play / pause, J / L 5 s back / forward, K pause, ← / → one frame. Capture phase: ahead of the editor's own keys (Space pans, L draws a line).
     Space plays or pauses wherever the focus is, a focused button too (#vsLoop, + Scene, Before / After), except in a text field */
  let spaceEaten = false;
  addEventListener('keyup', (e) => { if (e.key === ' ' && spaceEaten) { spaceEaten = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  addEventListener('keydown', (e) => {
    const p = P();
    if (!p || !keysOn(mode()) || !document.body.classList.contains('in-editor') || ED.editing || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = ((t && t.tagName) || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || (t && t.isContentEditable) || (t && t.closest && t.closest('[role=menu]')) || document.querySelector('.modal-bg, #cmdk')) return;
    const fr = () => (p.frameMs ? p.frameMs() : 1000 / 30), k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const act = { ' ': () => p.toggle(), k: () => p.pause(), j: () => p.seek(Math.max(0, p.time() - 5000)), l: () => p.seek(p.time() + 5000),
      ArrowLeft: () => { p.pause(); p.seek(Math.max(0, p.time() - fr())); }, ArrowRight: () => { p.pause(); p.seek(p.time() + fr()); } }[k];
    if (!act) return;
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && (ED.sel || (ED.ms && ED.ms.length))) return; // a reel's selected layer: the arrows nudge it
    e.preventDefault(); e.stopImmediatePropagation();
    if (k === ' ') spaceEaten = true; // a focused button would also click on keyup
    if (k === ' ' && e.repeat) return;
    act();
  }, true);

  const VS = {
    railFor, mode, setMode,
    /** The open design's rail: [[key, label, icon]] */
    rail: () => railFor(kindNow(), mode()),
    register(kind, source) { SRC[kind] = source; },
    /** A shared panel for rail item `key` (both kinds): render(d, kind) -> html, or null to fall back to the source's panel; drawn() after it is in the page */
    panel(key, render, drawn) { PANELS[key] = { render, drawn }; },
    /** A shared inspector for a route ('caption'): render(sel, d) -> html, or null to fall back to the source's inspector */
    inspector(route, render) { INSP[route] = render; },
    select,
    selection: () => sel,
    source: src,
    tick, refresh, setPeaks, reset,
  };
  return VS;
}
