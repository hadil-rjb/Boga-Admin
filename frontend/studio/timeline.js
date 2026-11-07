/* ============================================================
   Timeline: the shared track timeline of the video studio (footage videos now, reels next).
   A ruler with time labels on a canvas that follows the scroll, zoom out / in / fit, a playhead that the scroll follows
   while playing, click or drag on an empty spot to seek. One row per track, each with a header (icon, name, eye).
   `captions` blocks can be moved and retimed (live preview, then one onRetime on release); `voice` shows the waveform
   given to setPeaks(); other tracks draw themselves through `html(pps)`.
   The pure helpers at the top are unit-tested; createTimeline is a DOM module.
   ============================================================ */

/* ---------- pure helpers ---------- */
/** Zoom steps in pixels per second; null fits the whole video in the view */
const ZOOMS = [10, 20, 40, 80, 160];
/** The default on a video longer than the view: subtitles stay readable */
const DEFAULT_PPS = 40;
/** Seconds between two labelled ticks of the ruler: at least 64 px apart */
export const tickStep = (pps) => [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 64) || 600;
const tickLabel = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${s % 1 ? '.5' : ''}`;
/**
 * The zoom after one step in (dir > 0) or out (dir < 0) from `cur` (null = fit), for a view of `viewPx` and a video of `durMs`.
 * In: the first step wider than now (the last step stays). Out: the previous step, or fit once a step would not fill the view.
 */
export function nextZoom(cur, dir, viewPx, durMs) {
  const dur = (+durMs || 0) / 1000; if (!(viewPx > 0) || !(dur > 0)) return cur;
  const now = cur || viewPx / dur; // "fit" as an equivalent pps
  if (dir > 0) return ZOOMS.find((z) => z > now * 1.01) || cur;
  const next = [...ZOOMS].reverse().find((z) => z < now * 0.99);
  return next && next * dur > viewPx ? next : null;
}
export const MIN_LINE_MS = 200;
const clampN = (v, a, b) => Math.min(Math.max(v, a), b);
/**
 * Where line `i` lands when an edge or the block is dragged: 'start' / 'end' take the new edge time, 'move' the new start time
 * (the length stays). At least 200 ms long, inside the video, and never over the previous or next line.
 */
export function clampDrag(lines, i, edge, ms, dur = Infinity) {
  const l = lines[i], lo = i > 0 ? lines[i - 1].end : 0, top = dur > 0 ? dur : Infinity, hi = i < lines.length - 1 ? Math.min(lines[i + 1].start, top) : top;
  const t = Math.round(+ms || 0), len = l.end - l.start;
  if (edge === 'start') return { start: clampN(t, lo, Math.max(lo, l.end - MIN_LINE_MS)), end: l.end };
  if (edge === 'end') return { start: l.start, end: clampN(t, Math.min(hi, l.start + MIN_LINE_MS), hi) };
  const s = clampN(t, lo, Math.max(lo, hi - len));
  return { start: s, end: s + len };
}

/* ---------- DOM ---------- */
const RULER = 22;
/** Row height of each kind of track (the header beside it has the same height) */
const ROW_H = { video: 30, scenes: 36, captions: 36, voice: 34, music: 30 };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (v) => Math.max(0, Math.min(100, +v || 0)).toFixed(3);
const fmt = (ms) => { const s = Math.max(0, (+ms || 0) / 1000); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const svg = (p, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICON = {
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 9.9a3 3 0 1 0 4.2 4.2"/><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13 13 0 0 1-1.7 2.7"/><path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><line x1="2" x2="22" y1="2" y2="22"/>',
};
/** Tracks without an eye: the picture itself */
const NO_EYE = new Set(['video', 'scenes']);

/**
 * Mounts the timeline in `host`. Options (a function is read on every draw, a value is fixed):
 *   dur() ms, time() ms, seek(ms), tracks() [{ id, icon (HTML), label, html?(pps), blocks?: [{ id, start, end, text, on }], hidden? }],
 *   onRetime(id, start, end, live): live = true while a caption block is dragged (preview only), false once on release when it changed,
 *   onSelect(id): a caption block was clicked without moving (the timeline also seeks to its start),
 *   onToggle(trackId): the eye of a track, canEdit(): false = read-only (blocks cannot be dragged, the lane still seeks).
 * Returns { redraw(), setTime(ms, playing), setPeaks(peaks), destroy() }.
 */
export function createTimeline(host, opts = {}) {
  const val = (x, d) => (typeof x === 'function' ? x() : x === undefined ? d : x);
  const dur = () => +val(opts.dur, 0) || 0, now = () => +val(opts.time, 0) || 0, tracks = () => val(opts.tracks, []) || [];
  const can = () => val(opts.canEdit, true) !== false;
  const st = { zoom: undefined, peaks: null, drag: null, scrubbing: false, last: undefined, ro: null, off: [] };

  host.innerHTML = `<div class="vs-tl" role="group" aria-label="Timeline">
    <div class="vs-tl-side"><div class="vs-tl-zoom" role="group" aria-label="Timeline zoom" style="height:${RULER}px">
      <button class="vs-tl-ib" data-tl-zoom="out" aria-label="Zoom out the timeline" title="Zoom out">${svg(ICON.zoomOut, 15)}</button>
      <button class="vs-tl-ib" data-tl-zoom="in" aria-label="Zoom in the timeline" title="Zoom in">${svg(ICON.zoomIn, 15)}</button>
      <button class="vs-tl-ib" data-tl-zoom="fit" aria-label="Fit the whole video" title="Fit the whole video">${svg(ICON.fit, 15)}</button>
    </div><div class="vs-tl-hds"></div></div>
    <div class="vs-tl-lane" aria-label="Click or drag to move the playhead, drag a caption to retime it">
      <canvas aria-hidden="true"></canvas>
      <div class="vs-tl-scroll"><div class="vs-tl-track">
        <div class="vs-tl-rows" style="top:${RULER}px"></div>
        <i class="vs-tl-head"></i>
      </div></div>
    </div>
  </div>`;
  const root = host.firstElementChild, q = (s) => root.querySelector(s);
  const hds = q('.vs-tl-hds'), lane = q('.vs-tl-lane'), cv = q('canvas'), sc = q('.vs-tl-scroll'), track = q('.vs-tl-track'), rows = q('.vs-tl-rows'), head = q('.vs-tl-head');

  /* ---- size and zoom ---- */
  const view = () => sc.clientWidth;
  function trackWidth() {
    const v = view(), d = dur(); if (!v || !d) return v;
    if (st.zoom === undefined) st.zoom = (d / 1000) * DEFAULT_PPS > v ? DEFAULT_PPS : null;
    return st.zoom ? Math.max(v, Math.round((d / 1000) * st.zoom)) : v;
  }
  function size() {
    track.style.width = trackWidth() + 'px';
    const fits = !st.zoom || trackWidth() <= view(), btn = (k) => q(`[data-tl-zoom=${k}]`);
    btn('out').disabled = fits; btn('fit').disabled = fits; btn('in').disabled = !dur() || st.zoom === ZOOMS[ZOOMS.length - 1];
  }
  /** Zooms around the playhead (or the view's center) */
  function setZoom(z) {
    const d = dur(); if (!d) return;
    const v = view(), before = trackWidth(), headX = (now() / d) * before;
    const anchor = headX >= sc.scrollLeft && headX <= sc.scrollLeft + v ? headX - sc.scrollLeft : v / 2, frac = (sc.scrollLeft + anchor) / before;
    st.zoom = z; size();
    sc.scrollLeft = Math.max(0, frac * trackWidth() - anchor); draw();
  }
  /** Keeps the playhead in view while playing */
  function follow(frac) {
    const tw = trackWidth(), v = view(); if (!tw || tw <= v || st.drag || st.scrubbing) return;
    const x = frac * tw;
    if (x < sc.scrollLeft || x > sc.scrollLeft + v * 0.85) sc.scrollLeft = Math.max(0, x - v * 0.15);
  }

  /* ---- rows ---- */
  const captionsOf = () => (tracks().find((t) => t.id === 'captions') || {}).blocks || [];
  function blockHTML(b, i, d, ro) {
    return `<div class="vs-tl-blk${ro ? ' ro' : ''}" data-i="${i | 0}" data-id="${esc(b.id)}" style="left:${pc((b.start / d) * 100)}%;width:${pc(((b.end - b.start) / d) * 100)}%" title="${esc(`${fmt(b.start)} – ${fmt(b.end)}`)}">${ro ? '' : '<i class="vs-tl-h s" data-edge="start"></i>'}<span dir="auto">${esc(b.text)}</span>${ro ? '' : '<i class="vs-tl-h e" data-edge="end"></i>'}</div>`;
  }
  function rowHTML(t, d, pps) {
    const h = ROW_H[t.id] || 30, ro = !can();
    let inner = '';
    if (d && t.html) inner = t.html(pps);
    else if (d && t.blocks) inner = t.blocks.map((b, i) => blockHTML(b, i, d, ro)).join('');
    return `<div class="vs-tl-row t-${esc(t.id)}${t.hidden ? ' off' : ''}" data-track="${esc(t.id)}" style="height:${h}px">${inner}</div>`;
  }
  function headerHTML(t) {
    const h = ROW_H[t.id] || 30, eye = NO_EYE.has(t.id) ? '' : `<button class="vs-tl-ib vs-tl-eye" data-tl-eye="${esc(t.id)}" aria-pressed="${!t.hidden}" aria-label="${t.hidden ? 'Show' : 'Hide'} ${esc(t.label)}" title="${t.hidden ? 'Show' : 'Hide'} ${esc(t.label)}" ${can() ? '' : 'disabled'}>${svg(t.hidden ? ICON.eyeOff : ICON.eye, 15)}</button>`;
    return `<div class="vs-tl-hd t-${esc(t.id)}${t.hidden ? ' off' : ''}" style="height:${h}px"><span class="vs-tl-ic">${t.icon || ''}</span><span class="vs-tl-lb">${esc(t.label)}</span>${eye}</div>`;
  }
  /** Redraws the headers and rows (after an edit, undo or redo), the ruler and the waveform */
  function redraw() {
    const ts = tracks(), d = dur();
    hds.innerHTML = ts.map(headerHTML).join('');
    size();
    const pps = d ? trackWidth() / (d / 1000) : 0;
    rows.innerHTML = ts.map((t) => rowHTML(t, d, pps)).join('');
    draw(); st.last = undefined; setTime(now(), false);
  }

  /* ---- canvas: the visible part of the lane, ruler on top, waveform in the voice row, both following the scroll ---- */
  function draw() {
    const r = lane.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext('2d'); if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, w, h);
    const tw = trackWidth(), d = dur(), sl = sc.scrollLeft, cs = getComputedStyle(root);
    if (!tw || !d) return;
    c.scale(dpr, dpr);
    const vw = r.width, pps = tw / (d / 1000);
    const step = tickStep(pps), minor = step / 2;
    c.fillStyle = cs.getPropertyValue('--vs-tl-tick').trim() || 'rgba(148,163,184,.5)';
    c.font = '500 10px system-ui, -apple-system, sans-serif'; c.textBaseline = 'middle';
    const first = Math.floor(sl / pps / minor) * minor;
    for (let t = first; t * pps <= sl + vw; t += minor) {
      const x = Math.round(t * pps - sl) + 0.5, major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      c.fillRect(x, major ? 4 : RULER - 6, 1, major ? RULER - 4 : 6);
      if (major) c.fillText(tickLabel(t), x + 4, 10);
    }
    c.fillRect(0, RULER, vw, 1);
    const row = rows.querySelector('.vs-tl-row[data-track=voice]');
    if (!st.peaks || !st.peaks.length || !row) return;
    const P = st.peaks, N = P.length, top = RULER + row.offsetTop + 3, rh = row.offsetHeight - 6, mid = top + rh / 2;
    c.globalAlpha = row.classList.contains('off') ? 0.35 : 1;
    c.fillStyle = cs.getPropertyValue('--vs-tl-wave').trim() || 'rgba(100,116,139,.5)';
    for (let x = 0; x < vw; x += 2) {
      const a0 = Math.floor(((sl + x) / tw) * N), a1 = Math.max(a0 + 1, Math.floor(((sl + x + 2) / tw) * N));
      let m = 0; for (let k = a0; k < a1 && k < N; k++) if (P[k] > m) m = P[k];
      const a = Math.max(1, m * rh); c.fillRect(x, mid - a / 2, 1.2, a);
    }
    c.globalAlpha = 1;
  }

  /* ---- playhead and the current caption ---- */
  function setTime(ms, playing) {
    const d = dur();
    head.style.left = d ? Math.min(100, Math.max(0, (ms / d) * 100)) + '%' : '0%';
    if (playing && d) follow(ms / d);
    const b = captionsOf().find((x) => ms >= x.start && ms < x.end), id = b ? b.id : null;
    if (id === st.last) return; st.last = id;
    rows.querySelectorAll('.vs-tl-blk.on').forEach((x) => x.classList.remove('on'));
    if (id) { const el = rows.querySelector(`.vs-tl-blk[data-id="${CSS.escape(id)}"]`); if (el) el.classList.add('on'); }
  }

  /* ---- pointer: scrub an empty spot, drag a caption block or its edges ---- */
  const listen = (el, type, fn, o) => { el.addEventListener(type, fn, o); st.off.push(() => el.removeEventListener(type, fn, o)); };
  function scrub(e) {
    e.preventDefault(); st.scrubbing = true;
    const at = (ev) => { const r = track.getBoundingClientRect(), d = dur(); if (d && r.width) opts.seek && opts.seek(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * d); };
    at(e);
    const up = () => { st.scrubbing = false; st.stopScrub = null; removeEventListener('pointermove', at); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointermove', at); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    st.stopScrub = up;
  }
  function down(e) {
    if (e.button > 0 || st.drag || !dur()) return;
    let blk = can() && e.target.closest('.vs-tl-blk');
    if (!blk) { scrub(e); return; } // an empty spot, the ruler, another track, or read-only
    e.preventDefault();
    const h = e.target.closest('.vs-tl-h'), edge = h ? h.dataset.edge : 'move', bid = blk.dataset.id;
    // a field being typed commits first (its focusout handler), which may redraw the rows: pick up the block again
    const a = document.activeElement; if (a && a !== document.body && !root.contains(a) && typeof a.blur === 'function') a.blur();
    if (!blk.isConnected) blk = rows.querySelector(`.vs-tl-blk[data-id="${CSS.escape(bid)}"]`);
    const ls = captionsOf(), i = ls.findIndex((b) => b.id === bid); if (!blk || i < 0 || !can()) return;
    const S = st.drag = { id: bid, x0: e.clientX, orig: ls[i], to: { start: ls[i].start, end: ls[i].end }, moved: false, live: false };
    const r = track.getBoundingClientRect(), d = dur(), orig = S.orig;
    blk.classList.add('drag');
    try { blk.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    const at = (ev) => {
      const dx = ((ev.clientX - S.x0) / r.width) * d;
      if (Math.abs(ev.clientX - S.x0) > 2) S.moved = true;
      S.to = clampDrag(ls, i, edge, (edge === 'end' ? orig.end : orig.start) + dx, d);
      blk.style.left = pc((S.to.start / d) * 100) + '%'; blk.style.width = pc(((S.to.end - S.to.start) / d) * 100) + '%';
      S.live = true; opts.onRetime && opts.onRetime(S.id, S.to.start, S.to.end, true);
    };
    const done = (commit) => {
      blk.removeEventListener('pointermove', at); blk.removeEventListener('pointerup', up); blk.removeEventListener('pointercancel', cancel); blk.removeEventListener('lostpointercapture', cancel);
      blk.classList.remove('drag'); st.drag = null; st.stopDrag = null;
      if (!root.isConnected) return;
      const changed = S.to.start !== orig.start || S.to.end !== orig.end;
      if (commit && changed) { opts.onRetime && opts.onRetime(S.id, S.to.start, S.to.end, false); return; }
      if (S.live && opts.onRetime) opts.onRetime(S.id, orig.start, orig.end, true); // back to the line as it is
      redraw();
      if (commit && !S.moved) { opts.seek && opts.seek(orig.start); opts.onSelect && opts.onSelect(S.id); }
    };
    const up = () => done(true), cancel = () => done(false);
    st.stopDrag = cancel;
    blk.addEventListener('pointermove', at); blk.addEventListener('pointerup', up); blk.addEventListener('pointercancel', cancel); blk.addEventListener('lostpointercapture', cancel);
  }
  function click(e) {
    const z = e.target.closest('[data-tl-zoom]');
    if (z && !z.disabled) { const k = z.dataset.tlZoom; setZoom(k === 'fit' ? null : nextZoom(st.zoom, k === 'in' ? 1 : -1, view(), dur())); return; }
    const eye = e.target.closest('[data-tl-eye]');
    if (eye && !eye.disabled && opts.onToggle) opts.onToggle(eye.dataset.tlEye);
  }
  listen(lane, 'pointerdown', down);
  listen(root, 'click', click);
  listen(sc, 'scroll', () => draw(), { passive: true });
  if (typeof ResizeObserver !== 'undefined') { st.ro = new ResizeObserver(() => { size(); draw(); }); st.ro.observe(lane); }
  redraw();

  return {
    redraw,
    setTime,
    setPeaks(p) { st.peaks = p || null; draw(); },
    destroy() {
      st.stopDrag && st.stopDrag(); st.stopScrub && st.stopScrub();
      st.ro && st.ro.disconnect(); st.off.forEach((f) => f()); st.off = [];
      host.innerHTML = '';
    },
  };
}
