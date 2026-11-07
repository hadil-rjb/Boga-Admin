/* ============================================================
   Reel source: motion designs (reels, stories, animated posts) in the Video Studio shell (video-studio.js).
   The motion editor (engine.js, v37 / v38) keeps the scenes, the canvas, its panels, the Scene / layer properties and
   the export; it hands the shell `M` (RT.moReel): its player, the scene blocks and audio clips as timeline html, the
   layers of the open scene. This file registers the `reel` source:
   - tracks: Scenes, Captions (the voice-over lines, on / off with the Audio panel's captions switch), Voice, Music,
     then a Layers row that folds the open scene's layer lanes (folded by default, remembered in boga.mo37Folded);
   - panels: Captions, Styles and Script are the shell's; every other rail item keeps the editor's own panel;
   - the inspector stays the editor's (Scene / Animation properties);
   - transport extras: "back to editing" while the canvas shows a preview, loop, and + Scene (the library, aimed at the end).
   captionBlocks is pure and unit-tested; installReelSource touches no DOM until the shell draws.
   ============================================================ */
import { timeline } from './motion.js';
import { audioOf, voOf, LEAD } from './audio.js';

/** Rail items whose panel belongs to the shell (the caption panels); the rest are the motion editor's */
const SHELL_PANELS = new Set(['captions', 'styles', 'script']);
const FOLD_KEY = 'boga.mo37Folded';

/**
 * The captions of a reel as timeline blocks, one per scene with a voice-over line: while its clip plays (plus a 400 ms
 * tail, inside its scene), or the whole scene when the line has no clip yet (as AUD.captionAt shows them).
 */
export function captionBlocks(d) {
  if (!d || !Array.isArray(d.pages)) return [];
  const tl = timeline(d.pages), a = audioOf(d), tr = a.track && a.track.src && a.track.dur ? a.track : null;
  return tl.scenes.map((s) => {
    const vo = voOf(d.pages[s.i]), text = vo && String(vo.text || '').trim(); if (!text) return null;
    const sEnd = s.start + s.dur;
    let start = s.start, end = sEnd;
    if (vo.src && vo.dur) { start = s.start + LEAD; end = Math.min(start + vo.dur + 400, sEnd); }
    else if (tr) { start = Math.max(start, tr.at || 0); end = Math.min(end, (tr.at || 0) + tr.dur + 400); }
    return end > start ? { i: s.i, start, end, text } : null;
  }).filter(Boolean);
}

export function installReelSource(ctx) {
  const { ED, ACT, VS, M, ic, esc, canEdit } = ctx;
  let folded = true; try { folded = localStorage.getItem(FOLD_KEY) !== '0'; } catch (e) { /* no storage: folded */ }
  const isReel = () => !!(ED.d && ED.d.motion && !ED.d.footage);
  const pc = (v) => Math.max(0, Math.min(100, +v || 0)).toFixed(3) + '%';

  function captionsHTML() {
    const d = ED.d, total = timeline(d.pages).total; if (!total) return '';
    return captionBlocks(d).map((b) => `<div class="vs-tl-cap" data-i="${b.i}" style="left:${pc((b.start / total) * 100)};width:${pc(((b.end - b.start) / total) * 100)}" title="${esc(b.text)}"><span dir="auto">${esc(b.text)}</span></div>`).join('');
  }
  function tracks() {
    if (!isReel()) return [];
    const a = audioOf(ED.d), clips = () => M.clipsHTML();
    const out = [
      { id: 'scenes', icon: ic('film37', 14), label: 'Scenes', height: 58, html: (pps) => M.scenesHTML(pps) },
      { id: 'captions', icon: ic('vsCc', 14), label: 'Captions', hidden: !a.captions, html: captionsHTML },
      { id: 'voice', icon: ic('mic38', 14), label: 'Voice', toggle: null, html: () => clips().voice },
      { id: 'music', icon: ic('music38', 14), label: 'Music', toggle: null, html: () => clips().music },
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
    if (id === 'captions' && canEdit() && ACT.au38Cc) ACT.au38Cc(); // the Audio panel's captions switch: preview and export
  }
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

  let shown = null; // the design the timeline was drawn for: another reel starts a fresh timeline (zoom, scroll)
  const source = {
    mount() { if (shown !== ED.d) { if (shown) VS.reset(); shown = ED.d; } },
    unmount() { M.player.pause(); shown = null; },
    player: M.player,
    tracks,
    panel: () => null,
    nativePanel: (k) => !SHELL_PANELS.has(k),
    nativeInspector: true,
    transportExtra,
    canEdit: () => canEdit(),
    onToggle,
  };
  M.onTime = (ms, playing) => { if (isReel()) VS.tick(ms, playing); };
  VS.register('reel', source);
  return source;
}
