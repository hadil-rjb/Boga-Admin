/* ============================================================
   Reel source: motion designs (reels, stories, animated posts) in the Video Studio shell (video-studio.js).
   The motion editor (engine.js, v37 / v38) keeps the scenes, the canvas, its panels, the Scene / layer properties and
   the export; it hands the shell `M` (RT.moReel): its player, the scene blocks and audio clips as timeline html, the
   layers of the open scene. This file registers the `reel` source:
   - tracks: Scenes, Captions (d.captions lines: built from the voice-over until edited, see caption-panels.js; drag and
     resize them like a video's, the eye is captions on / off), Voice and Music (each with a session-only "Mute preview"),
     then a Layers row that folds the open scene's layer lanes (folded by default, remembered in boga.mo37Folded);
   - panels: Captions, Styles and Script are the shell's; every other rail item keeps the editor's own panel;
   - the inspector stays the editor's (Scene / Animation properties), except the shell's caption style tabs (caption-inspector.js);
   - transport extras: "back to editing" while the canvas shows a preview, loop, and + Scene (the library, aimed at the end);
   - on the preview, a press on the caption drags it up or down (dragCaption, as on a video): one mutate() on release.
   installReelSource touches no DOM until the shell draws.
   ============================================================ */
import { retime, DEFAULT_STYLE } from './captions.js';
import { captionsOn, linesOf, lineText, prepareReel, previewStyle, captionFrame, capsView, editStyle } from './caption-panels.js';
import { dragCaption } from './caption-inspector.js';

/** Rail items whose panel belongs to the shell (the caption panels); the rest are the motion editor's */
const SHELL_PANELS = new Set(['captions', 'styles', 'script']);
const FOLD_KEY = 'boga.mo37Folded';
/** The reel's caption blocks per scene (moved to caption-panels.js, where the voice-over lines are built) */
export { captionBlocks } from './caption-panels.js';

export function installReelSource(ctx) {
  const { ED, ACT, VS, M, ic, canEdit, save, mutate, ed } = ctx;
  let folded = true; try { folded = localStorage.getItem(FOLD_KEY) !== '0'; } catch (e) { /* no storage: folded */ }
  const isReel = () => !!(ED.d && ED.d.motion && !ED.d.footage);
  /** "Mute preview" on the Voice and Music rows: session state, the export keeps the sound */
  let muted = { voice: false, music: false };
  const setMuted = (id, on) => { muted = { ...muted, [id]: !!on }; if (M.setMuted) M.setMuted(id, !!on); };

  function tracks() {
    if (!isReel()) return [];
    const d = ED.d, on = captionsOn(d), clips = () => M.clipsHTML();
    const out = [
      { id: 'scenes', icon: ic('film37', 14), label: 'Scenes', height: 58, html: (pps) => M.scenesHTML(pps) },
      { id: 'captions', icon: ic('vsCc', 14), label: 'Captions', hidden: !on, blocks: linesOf(d).map((l) => ({ id: l.id, start: l.start, end: l.end, text: lineText(l), on })) },
      { id: 'voice', icon: ic('mic38', 14), label: 'Voice', toggle: 'mute', hidden: muted.voice, html: () => clips().voice },
      { id: 'music', icon: ic('music38', 14), label: 'Music', toggle: 'mute', hidden: muted.music, html: () => clips().music },
    ];
    const ly = M.layers() || [];
    if (ly.length) {
      out.push({ id: 'layers', icon: ic('layers', 14), label: `Layers · ${ly.length}`, toggle: 'fold', open: !folded, height: 26, html: () => '' });
      if (!folded) ly.forEach((l) => out.push({ id: 'ly:' + l.id, icon: ic(l.type === 'text' ? 'type' : l.type === 'image' ? 'image' : 'shapes', 13), label: l.name, toggle: null, height: 24, html: l.html }));
    }
    return out;
  }
  function onToggle(id) {
    if (id === 'layers') {
      folded = !folded; try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch (e) { /* not remembered */ }
      VS.refresh(); M.fit(); return;
    }
    if (id === 'captions') { if (canEdit() && VS.captions) VS.captions.toggle(); return; } // captions on / off: preview and export
    if (id === 'voice' || id === 'music') { setMuted(id, !muted[id]); VS.refresh(); } // preview only
  }
  /** A caption block dragged on the timeline: the preview follows while dragging, one mutate() on release */
  function onRetime(id, start, end, live) {
    if (!isReel()) return;
    if (live && start == null) { if (M.previewCaptions) M.previewCaptions(null); return; }
    if (live) { if (M.previewCaptions) M.previewCaptions(linesOf(ED.d).map((x) => (x.id === id ? retime(x, start, end) : x))); return; }
    if (M.previewCaptions) M.previewCaptions(null);
    if (VS.captions) VS.captions.edit((a) => a.map((x) => (x.id === id ? retime(x, start, end) : x)));
  }
  function onSelect(id) { if (VS.captions) VS.captions.reveal(id); }
  const loopHTML = () => { const on = !!M.loop(); return `<button class="ft-ib${on ? ' on' : ''}" id="vsLoop" data-act="mo37Loop" aria-pressed="${on}" aria-label="Loop playback" title="Loop playback">${ic('loop37', 17)}</button>`; };
  const transportExtra = () => `<button class="btn link sm mo-pv" id="mo37Pv" data-act="mo37Edit" hidden>Previewing · back to editing</button>${loopHTML()}
    <button class="ft-chip" data-act="vsAddScene" title="Add a scene at the end" ${canEdit() ? '' : 'disabled'}>${ic('plus', 15)}<span>Scene</span></button>`;
  ACT.vsAddScene = () => { if (canEdit()) M.addAtEnd(); };

  /* the transport is drawn once per session: the loop button follows its state itself */
  const _loop = ACT.mo37Loop;
  if (_loop) ACT.mo37Loop = function () {
    const r = _loop.apply(this, arguments), b = typeof document !== 'undefined' && document.getElementById('vsLoop');
    if (b) { const on = !!M.loop(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    return r;
  };

  /** The preview's caption, dragged to set its height (style y): the preview follows, one mutate() on release */
  M.viewDown = (e, view) => {
    if (!isReel() || !canEdit() || !mutate || !captionsOn(ED.d)) return false;
    const d = ED.d, t = M.player.time(), cap = captionFrame(d, t); if (!cap) return false;
    return dragCaption(e, {
      frame: view, canvas: view.querySelector('canvas.mo-capc'), lines: cap.lines, style: capsView(d).style || DEFAULT_STYLE, ms: t,
      onMove: (style) => { previewStyle(d, style); if (M.redraw) M.redraw(); },
      onEnd: (y) => {
        previewStyle(d, null);
        const done = () => { if (M.redraw) M.redraw(); if (ed) ed.props(); };
        if (y == null || ED.d !== d) { done(); return; }
        mutate(() => editStyle(ED.d, { y }), done); if (save) save(); // the preview stays open: no full redraw
      },
    });
  };

  let shown = null; // the design the timeline was drawn for: another reel starts a fresh timeline (zoom, scroll)
  const source = {
    mount() {
      if (shown !== ED.d) { if (shown) VS.reset(); shown = ED.d; setMuted('voice', false); setMuted('music', false); if (VS.captionInspector) VS.captionInspector.stopRef(ED.d); }
      if (prepareReel(ED.d) && save) save(); // the captions move to d.captions once (not an undo step)
      if (VS.captions) VS.captions.loadFonts();
    },
    unmount() { M.player.pause(); shown = null; setMuted('voice', false); setMuted('music', false); if (VS.captionInspector) VS.captionInspector.stopRef(); },
    player: M.player,
    tracks,
    panel: () => null,
    nativePanel: (k) => !SHELL_PANELS.has(k),
    nativeInspector: true,
    transportExtra,
    canEdit: () => canEdit(),
    onToggle, onRetime, onSelect,
    /** the shared Captions panel: the canvas preview follows an edit */
    captions: {
      light: () => { if (M.redraw) M.redraw(); },
      /** the caption inspector's live preview (null: back to the stored style) */
      preview: (style) => { previewStyle(ED.d, style); if (M.redraw) M.redraw(); },
    },
  };
  M.onTime = (ms, playing) => { if (isReel()) VS.tick(ms, playing); };
  VS.register('reel', source);
  return source;
}
