/* ============================================================
   Video Studio shell: one editor for videos (and reels next). Sources register per kind and the shell draws the rest:
   - the rail for the kind (railFor) and its side panel: a shared panel (VS.panel) first, else the source's panel,
     else the panel's title and one sentence of what it will hold;
   - the transport under the stage (back 5 s, play, forward 5 s, time, the source's extra controls, keyboard J/K/L,
     Space and the arrows), driven by `source.player`;
   - the bottom area: the source's tracks in the shared timeline (timeline.js);
   - the inspector, routed by the selection (VS.select).
   For now the shell only takes over videos (kindOf(d) === 'video'); reels and stills keep today's editor.

   A source: { mount(stage), unmount(), player, tracks() -> Track[], panel(key) -> html | null, inspector(sel) -> html | null,
   transportExtra() -> html } and, optionally, panelDrawn(key), canEdit(), onRetime(...), onSelect(id), onToggle(id)
   (the timeline's callbacks). `player`: { toggle(), play(), pause(), seek(ms), time(), duration(), playing() } and
   optionally ready() (false until the media can play) and frameMs().
   The source tells the shell about playback with VS.tick(ms, playing), new tracks with VS.refresh(), the waveform with
   VS.setPeaks(peaks), and a closed session with VS.reset().
   The pure helpers at the top are unit-tested; installVideoStudio is a DOM module.
   ============================================================ */
import { kindOf } from './caption-store.js';
import { createTimeline } from './timeline.js';
import { fmtMs } from './footage-player.js';

/* ---------- pure helpers ---------- */
const RAILS = {
  video: [['media', 'Media', 'vsFilm'], ['captions', 'Captions', 'vsCc'], ['styles', 'Styles', 'palette'], ['script', 'Script', 'doc'],
    ['audio', 'Audio', 'music38'], ['look', 'Look', 'vsLook'], ['agent', 'Agent', 'studio']],
  // the keys of the editor's existing RAIL entries are kept so their panels still work
  reel: [['templates', 'Templates', 'layout'], ['motion', 'Motion', 'film37'], ['captions', 'Captions', 'vsCc'], ['styles', 'Styles', 'palette'],
    ['script', 'Script', 'doc'], ['audio', 'Audio', 'music38'], ['elements', 'Elements', 'shapes'], ['text', 'Text', 'type'],
    ['uploads', 'Uploads', 'upload'], ['brand', 'Brand', 'palette'], ['figma', 'Figma', 'figma'], ['data', 'Live data', 'chart'],
    ['comps', 'Components', 'comp33'], ['agent', 'Agent', 'studio']],
};
/** The rail of a kind: [[key, label, icon]] (a fresh copy; empty for stills) */
export const railFor = (kind) => (RAILS[kind] || []).map((r) => [...r]);
/** The open rail item: the current tab when the kind's rail has it, else Captions */
export const railTab = (kind, tab) => (railFor(kind).some(([k]) => k === tab) ? tab : 'captions');
/**
 * Where the inspector goes for a selection: 'caption' (the caption style tabs), 'source' (the source's own inspector,
 * the video's Look) or 'scene' (a reel's scene / layer properties). Nothing selected: the source for a video, the scene for a reel.
 */
export function inspectorRoute(sel, kind) {
  const k = sel && sel.kind;
  if (k === 'caption') return 'caption';
  if (k === 'video') return 'source';
  if (k === 'scene') return 'scene';
  return kind === 'video' ? 'source' : 'scene';
}
/** The shell opens this design (videos only for now) */
export const takesOver = (d) => kindOf(d) === 'video';
/** What a rail item without a panel yet will hold: one sentence under its title */
export const SOON = {
  media: 'Your video with its name, length and size, and a way to replace it.',
  captions: 'Caption lines to read, edit, retime, split and merge.',
  styles: 'Caption style presets by category, with your saved brand styles.',
  script: 'Paste a script to time it to the speech, or open and download SRT and VTT files.',
  audio: 'The original sound’s volume, a music bed and ducking under the voice.',
  look: 'Adjust the colour grade and brand looks in the panel on the right, and match a reference here.',
};

/* ---------- DOM ---------- */
export function installVideoStudio(ctx) {
  const { ED, ACT, IC, ic, esc, wrapEd, ed } = ctx;
  Object.assign(IC, {
    vsFilm: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4"/>',
    vsCc: '<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>',
    vsLook: '<circle cx="9" cy="9" r="7"/><circle cx="15" cy="15" r="7"/>',
    vsBack5: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    vsFwd5: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    vsKbd: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  });
  const $ = (s) => document.querySelector(s);
  /** Registered sources by kind, shared panels and inspectors by key */
  const SRC = {}, PANELS = {}, INSP = {};
  /** The selection, the timeline (and its host, kept across redraws of the bottom area), the waveform, the mounted source */
  let sel = null, tl = null, tlHost = null, peaks = null, mounted = null;
  /** The source of the open design, or null when the shell does not take it over */
  const src = () => (ED.d && takesOver(ED.d) && SRC[kindOf(ED.d)]) || null;
  const ready = (P) => !!P && (!P.ready || P.ready());

  /* ---- transport ---- */
  function transportHTML(S) {
    const P = S.player, ok = ready(P), ms = ok ? P.time() : 0, dur = ok ? P.duration() : 0, playing = ok && !!P.playing(), off = ok ? '' : 'disabled';
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
    document.querySelectorAll('[data-vs-ctl]').forEach((b) => { b.disabled = !ok; });
    const pb = $('#vsPlay');
    if (pb && pb.dataset.on !== String(!!playing)) {
      const l = playing ? 'Pause (Space)' : 'Play (Space)';
      pb.dataset.on = String(!!playing); pb.innerHTML = ic(playing ? 'pause37' : 'play37', 18); pb.setAttribute('aria-label', l); pb.title = l;
    }
    if (tl) tl.setTime(ms, playing);
  }

  /* ---- timeline: mounted once per session in its host, moved back in when the bottom area is redrawn ---- */
  function mountTimeline(S, host) {
    if (!tlHost) { tlHost = document.createElement('div'); tlHost.className = 'vs-tl-host'; }
    host.append(tlHost);
    if (tl) { tl.redraw(); return; }
    const P = S.player, mine = () => src() === S;
    tl = createTimeline(tlHost, {
      dur: () => (ready(P) ? P.duration() : 0),
      time: () => (ready(P) ? P.time() : 0),
      seek: (ms) => { if (mine() && ready(P)) P.seek(ms); },
      tracks: () => (mine() ? S.tracks() : []),
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

  /* ---- inspector ---- */
  function select(s) {
    const kind = kindOf(ED.d), was = inspectorRoute(sel, kind);
    sel = s || null;
    const now = inspectorRoute(sel, kind);
    // the inspector is redrawn when it changes hands (a redraw resets its scroll), or for a caption host that shows the line
    if (src() && (now !== was || (now === 'caption' && INSP.caption))) ed.props();
  }

  wrapEd({
    edRail: (orig) => function () {
      const S = src(); if (!S) return orig.apply(this, arguments);
      const el = $('#edRail'); if (!el) return;
      const kind = kindOf(ED.d); ED.tab = railTab(kind, ED.tab);
      el.innerHTML = railFor(kind).map(([k, l, i]) => `<button class="${ED.tab === k ? 'on' : ''}" data-act="edTab" data-k="${k}" title="${esc(l)}">${ic(i, 22)}<span>${esc(l)}</span></button>`).join('');
    },
    edPanel: (orig) => function () {
      const S = src(); if (!S) return orig.apply(this, arguments);
      const kind = kindOf(ED.d); ED.tab = railTab(kind, ED.tab);
      if (ED.tab === 'agent') return orig.apply(this, arguments); // the agent panel as today
      const p = $('#edPanel'); if (!p) return;
      const k = ED.tab, label = (railFor(kind).find((r) => r[0] === k) || [k, k])[1];
      let h = PANELS[k] ? PANELS[k](ED.d, kind) : null;
      if (h == null && S.panel) h = S.panel(k);
      if (h == null) h = `<div class="vs-soon"><h3>${esc(label)}</h3><p class="sm-t muted">${esc(SOON[k] || '')}</p></div>`;
      p.classList.remove('agent'); p.innerHTML = h;
      if (S.panelDrawn) S.panelDrawn(k);
    },
    edProps: (orig) => function () {
      const S = src(); if (!S) return orig.apply(this, arguments);
      const el = $('#edProps'); if (!el) return;
      const r = inspectorRoute(sel, kindOf(ED.d));
      let h = r === 'caption' && INSP.caption ? INSP.caption(sel, ED.d) : null;
      if (h == null && S.inspector) h = S.inspector(sel); // the caption tabs come later: until then the source's inspector
      el.innerHTML = h || '';
    },
    edStage: (orig) => function () {
      const r = orig.apply(this, arguments), S = src();
      if (mounted && mounted !== S) { const m = mounted; mounted = null; reset(); m.unmount(); }
      if (S) { mounted = S; S.mount($('.ed-stage')); }
      return r;
    },
    edPages: (orig) => function () {
      const host = $('#edPages'); if (!host) return;
      const S = src();
      if (!S) { host.classList.remove('ft10'); return orig.apply(this, arguments); }
      host.classList.add('ft10');
      // the timeline stays mounted while the bottom area is redrawn (every mutate): its zoom and scroll survive an edit
      if (tl && tlHost && tlHost.parentNode === host && host.querySelector('.ft-tp')) { refresh(); return; }
      host.innerHTML = transportHTML(S); mountTimeline(S, host);
    },
  });

  /* ---- actions and keys ---- */
  const P = () => { const S = src(); return S && ready(S.player) ? S.player : null; };
  const _tab = ACT.edTab;
  Object.assign(ACT, {
    vsPlay: () => { const p = P(); if (p) p.toggle(); },
    vsBack: () => { const p = P(); if (p) p.seek(Math.max(0, p.time() - 5000)); },
    vsFwd: () => { const p = P(); if (p) p.seek(p.time() + 5000); },
    /* Look opens the video's inspector, Captions and Styles the caption one */
    edTab: function (a) {
      const r = _tab.apply(this, arguments), k = a && a.dataset && a.dataset.k;
      if (src()) { if (k === 'look') select({ kind: 'video' }); else if (k === 'captions' || k === 'styles') select({ kind: 'caption' }); }
      return r;
    },
  });
  /* Space play / pause, J / L 5 s back / forward, K pause, ← / → one frame. Capture phase: ahead of the editor's own keys (Space pans, L draws a line) */
  addEventListener('keydown', (e) => {
    const p = P();
    if (!p || !document.body.classList.contains('in-editor') || ED.editing || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = ((t && t.tagName) || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || (t && t.isContentEditable) || document.querySelector('.modal-bg, #cmdk')) return;
    const fr = () => (p.frameMs ? p.frameMs() : 1000 / 30), k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const act = { ' ': () => p.toggle(), k: () => p.pause(), j: () => p.seek(Math.max(0, p.time() - 5000)), l: () => p.seek(p.time() + 5000),
      ArrowLeft: () => { p.pause(); p.seek(Math.max(0, p.time() - fr())); }, ArrowRight: () => { p.pause(); p.seek(p.time() + fr()); } }[k];
    if (!act || (k === ' ' && tag === 'button' && !['vsPlay', 'vsBack', 'vsFwd'].includes(t.dataset.act))) return;
    e.preventDefault(); e.stopImmediatePropagation(); act();
  }, true);

  const VS = {
    railFor,
    register(kind, source) { SRC[kind] = source; },
    /** A shared panel for rail item `key` (both kinds): render(d, kind) -> html, or null to fall back to the source's panel */
    panel(key, render) { PANELS[key] = render; },
    /** A shared inspector for a route ('caption'): render(sel, d) -> html, or null to fall back to the source's inspector */
    inspector(route, render) { INSP[route] = render; },
    select,
    selection: () => sel,
    source: src,
    tick, refresh, setPeaks, reset,
  };
  return VS;
}
