/* ============================================================
   Footage editor: a design with `d.footage` takes over the editor (as v37 does for `d.motion`).
   Center: the player (footage-player.js) at the output aspect ratio, letterboxed, with a Before/After split.
   Bottom: the transport (play, time, scrub, Before/After). Left: Subtitles. Right: Look.
   While the server transcribes and grades, the panels show skeletons; a failed step shows its error and Retry.
   installFootageEditor(ctx, FT) is called by installFootage. The pure helpers at the top are unit-tested.
   Section 1: pure helpers. 2: session (polling, results, player). 3: drawing. 4: actions and keys.
   ============================================================ */
import { apiUrl } from '../lib/api';
import { group, retext, retime, addLine, split, merge, DEFAULT_STYLE } from './captions.js';
import { parseCube } from './look.js';
import { createPlayer, fitBox, fmtMs } from './footage-player.js';

/* ---------- 1. pure helpers ---------- */
const BUSY = ['queued', 'running'];
const STEPS = ['probe', 'proxy', 'frames', 'transcribe', 'grade', 'caption-style'];
/** Where the editor keeps the matched grade: a marker for the original's look.cube (the export reads the same file) */
export const lookPath = (id) => `footage/${id}/look.cube`;
/** One pipeline step of a record: { state, progress, error } (state undefined when never requested) */
export function stepInfo(rec, step) {
  const j = (rec && rec.jobs && rec.jobs[step]) || {};
  return { state: j.state, progress: +j.progress || 0, error: j.error || null };
}
/** The first failed step in pipeline order, or null */
export function firstFailed(rec) { return STEPS.find((s) => stepInfo(rec, s).state === 'failed') || null; }
/**
 * What the editor shows and whether polling can stop. `rec` is the original, `ref` the reference (null for a brand look).
 * settled: the original is ready or failed, and the reference (when there is one) is ready or failed too.
 */
export function analysis(rec, ref) {
  const recDone = !!rec && ['ready', 'failed'].includes(rec.status);
  const refDone = !ref || ['ready', 'failed'].includes(ref.status);
  const style = ref ? stepInfo(ref, 'caption-style') : { state: 'skipped', progress: 0, error: null };
  return {
    transcribe: stepInfo(rec, 'transcribe'), grade: stepInfo(rec, 'grade'), style,
    proxy: stepInfo(rec, 'proxy'), failed: !!rec && rec.status === 'failed', error: (rec && rec.error) || null,
    busy: (s) => BUSY.includes(s.state) || (s.state === undefined && !!rec && !recDone),
    settled: recDone && refDone,
  };
}
/**
 * The server's results that the design still lacks: subtitles grouped from the words (only when there are no lines yet),
 * the reference's subtitle style (only when none is set) and the grade marker (only when no look is set). null when nothing changes.
 */
export function analysisPatch(ft, { id, words, refStyle, hasCube }) {
  const out = {};
  if (ft.captions.style == null && refStyle) out.style = refStyle;
  if (!(ft.captions.lines || []).length && Array.isArray(words) && words.length) out.lines = group(words, out.style || ft.captions.style || DEFAULT_STYLE);
  if (hasCube && !ft.look.lut) out.lut = lookPath(id);
  return Object.keys(out).length ? out : null;
}
export function applyPatch(ft, p) {
  if (p.style) ft.captions.style = p.style;
  if (p.lines) ft.captions.lines = p.lines;
  if (p.lut) ft.look.lut = p.lut;
  return ft;
}
/** Seconds since epoch at which a signed `?t=<exp>.<mac>` URL expires, or null */
export const urlExpiry = (url) => { const m = /[?&]t=(\d+)\./.exec(String(url || '')); return m ? +m[1] : null; };
/**
 * The video failed: fetch a fresh signed URL? Yes when the link is (about to be) expired, or on a network / source error
 * (a 403 shows up as one of those), but not twice within 30 s (a broken file would loop).
 */
export function shouldRefreshProxy(err, url, nowSec, lastSec = 0) {
  if (lastSec && nowSec - lastSec < 30) return false;
  const exp = urlExpiry(url);
  if (exp != null && exp <= nowSec + 60) return true;
  return !!err && (err.code === 2 || err.code === 4);
}

/* ---- subtitle lane: drag constraints and waveform peaks ---- */
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
/** `n` peak buckets (max absolute sample each, 0..1) of decoded samples */
export function peakBuckets(samples, n) {
  const out = new Float32Array(Math.max(0, n | 0)), len = samples.length;
  if (!len || !out.length) return out;
  for (let b = 0; b < out.length; b++) {
    const from = Math.floor((b * len) / out.length), to = Math.max(from + 1, Math.floor(((b + 1) * len) / out.length));
    let m = 0; for (let k = from; k < to && k < len; k++) { const v = Math.abs(samples[k]); if (v > m) m = v; }
    out[b] = Math.min(1, m);
  }
  return out;
}
/** The fixed peak array shown at `w` pixels: the max of the buckets each pixel covers (one peak per pixel) */
export function fitPeaks(peaks, w) {
  const n = Math.max(0, w | 0), out = new Float32Array(n);
  if (!peaks || !peaks.length || !n) return out;
  for (let x = 0; x < n; x++) {
    const from = Math.floor((x * peaks.length) / n), to = Math.max(from + 1, Math.floor(((x + 1) * peaks.length) / n));
    let m = 0; for (let k = from; k < to && k < peaks.length; k++) if (peaks[k] > m) m = peaks[k];
    out[x] = m;
  }
  return out;
}
/** "0:12.4 – 0:14.1" */
export const rangeLabel = (l) => `${fmtMs(l.start)} – ${fmtMs(l.end)}`;
/** The text of a line as the field shows it */
export const lineText = (l) => (l.words || []).map((w) => w.t).join(' ');

const PEAK_BUCKETS = 2000;
const GOOGLE_FONTS = 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cairo:wght@400;600;700;800;900&family=Lalezar&family=Noto+Naskh+Arabic:wght@400;700&family=Noto+Sans+Arabic:wght@400;600;700;800&display=swap';

export function installFootageEditor(ctx, FT) {
  const { ED, ACT, api, toast, ic, IC, esc, mutate, save, canEdit, wrapEd, ed } = ctx;
  Object.assign(IC, { ftCmp10: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/><path d="M7 9l-2 3 2 3M17 9l2 3-2 3"/>' });
  const $ = (s, r = document) => r.querySelector(s);
  const isFt = (d) => !!(d && d.footage);
  /** The open footage design's session */
  let F = null;

  /* ---------- 2. session ---------- */
  function start(d) {
    stop();
    F = { d, id: d.footage.src, ref: d.footage.ref, rec: null, refRec: null, cube: null, timer: 0, player: null, split: null, dur: 0, lastRefresh: 0, applied: false, err: null, note: null, gen: 0, sig: '', peaks: null, ac: new AbortController(), retx: false, drag: null };
    ED.tab = 'ftSubs';
    loadFonts();
    ed.rail(); ed.panel(); // edAll draws the panels before the stage: show the footage panels right away
    poll();
  }
  function stop() {
    if (!F) return;
    clearTimeout(F.timer); F.gen++;
    if (F.player) F.player.destroy();
    F.ro && F.ro.disconnect(); F.lro && F.lro.disconnect(); F.ac.abort();
    F = null;
  }
  const alive = (S) => F === S && ED.d === S.d && document.body.classList.contains('in-editor');

  async function poll() {
    const S = F; if (!S) return; const gen = S.gen; clearTimeout(S.timer);
    try {
      const [rec, refRec] = await Promise.all([api('/footage/' + S.id), S.ref ? api('/footage/' + S.ref).catch(() => null) : null]);
      if (!alive(S) || gen !== S.gen) return;
      S.rec = rec; S.refRec = refRec; S.err = null;
    } catch (e) {
      if (!alive(S) || gen !== S.gen) return;
      S.err = e && e.status === 404 ? 'This video is no longer available.' : 'Could not reach the server. Retrying…';
      if (e && e.status === 404) { redraw(); return; }
    }
    if (S.rec && S.rec.proxyUrl && !S.player) mountPlayer();
    const A = analysis(S.rec, S.refRec);
    if (A.settled && !S.applied) { S.applied = true; await results(S); }
    if (!alive(S) || gen !== S.gen) return;
    redraw();
    if (!A.settled) S.timer = setTimeout(poll, 2000);
  }

  /** Loads the words and the cube once the analysis is over, and commits what the design still lacks in one undoable step */
  async function results(S) {
    const A = analysis(S.rec, S.refRec), ft = S.d.footage;
    const redo = S.retx && A.transcribe.state === 'done';
    const needWords = (redo || !(ft.captions.lines || []).length) && A.transcribe.state === 'done';
    const wantCube = A.grade.state === 'done' && (!ft.look.lut || ft.look.lut === lookPath(S.id));
    const [words, cubeText] = await Promise.all([
      needWords ? api(`/footage/${S.id}/words`).catch(() => []) : [],
      wantCube ? api(`/footage/${S.id}/look`, { text: true }).catch(() => null) : null,
    ]);
    if (!alive(S)) return;
    const cur = ED.d.footage; // an undo during the requests replaces the object
    if (cubeText) { try { S.cube = parseCube(cubeText); } catch (e) { S.cube = null; S.note = 'The colour grade file could not be read.'; } }
    const refStyle = S.refRec && S.refRec.captionStyle ? S.refRec.captionStyle : null;
    const patch = analysisPatch(cur, { id: S.id, words, refStyle, hasCube: !!S.cube }) || {};
    if (redo) { // Re-transcribe: the new words replace the edited lines
      S.retx = false;
      patch.lines = group(Array.isArray(words) ? words : [], patch.style || cur.captions.style || DEFAULT_STYLE);
      if (!patch.lines.length) toast('No speech was found in this video.');
    }
    if (Object.keys(patch).length) { mutate(() => applyPatch(ED.d.footage, patch)); save(); }
    sync();
  }

  /** The player follows the design (after results, undo, redo) */
  function sync() {
    if (!F || !F.player) return;
    const ft = ED.d.footage;
    F.player.setLook(ft.look); F.player.setCaptions(ft.captions); F.player.setSplit(F.split);
  }

  function mountPlayer() {
    const S = F, box = $('#ftBox'); if (!box || !S.rec || !S.rec.proxyUrl) return;
    const ft = S.d.footage;
    S.player = createPlayer(box, {
      proxyUrl: apiUrl(S.rec.proxyUrl), out: ft.out, look: ft.look, captions: ft.captions,
      cube: (lut) => (lut === lookPath(S.id) ? S.cube : null),
      onTime: (ms, playing) => transport(ms, playing),
      onReady: (dur) => { S.dur = dur; transport(S.player.time(), S.player.playing()); lane(); loadPeaks(S); },
      onError: (err) => refreshProxy(S, err),
    });
    S.player.setSplit(S.split);
  }
  async function refreshProxy(S, err) {
    const now = Math.floor(Date.now() / 1000);
    if (!alive(S) || !shouldRefreshProxy(err, S.player && S.player.video.src, now, S.lastRefresh)) { if (alive(S)) { S.err = 'The video could not be played.'; drawStage(); } return; }
    S.lastRefresh = now;
    try { const rec = await api('/footage/' + S.id); if (alive(S) && rec.proxyUrl) { S.rec = rec; S.player.setSrc(apiUrl(rec.proxyUrl)); } } catch (e) { /* the next error shows the message */ }
  }

  let fontsLoaded = false;
  function loadFonts() {
    if (fontsLoaded) return; fontsLoaded = true;
    if (!document.querySelector('link[data-ft-fonts]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = GOOGLE_FONTS; l.dataset.ftFonts = '1'; document.head.append(l);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => F && F.player && F.player.redraw());
    if (document.fonts) document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', () => F && F.player && F.player.redraw());
  }

  /* ---------- 3. drawing ---------- */
  const skel = (n = 3) => `<div class="ft-sk" aria-busy="true">${Array.from({ length: n }, (_, i) => `<span class="skel" style="width:${90 - i * 17}%"></span>`).join('')}</div>`;
  const failBox = (msg, id, step) => `<div class="note warn ft-fail" role="alert">${ic('alert', 16)}<span>${esc(msg || 'This step failed.')}</span>${canEdit && !canEdit() ? '' : `<button class="btn secondary sm" data-act="ftRetry" data-id="${esc(id)}" data-step="${esc(step)}">${ic('refresh', 14)}Retry</button>`}</div>`;
  const pct = (s) => (s.state === 'running' && s.progress ? ` ${Math.round(s.progress * 100)}%` : '');

  /** Only redraws the panels when what they show changed (polling every 2 s must not reset scroll or focus) */
  function redraw() {
    if (!F) return;
    const A = analysis(F.rec, F.refRec), ft = ED.d.footage;
    const sig = JSON.stringify([F.err, F.note, F.rec && F.rec.status, F.rec && F.rec.jobs, F.refRec && F.refRec.status, F.refRec && F.refRec.jobs && F.refRec.jobs['caption-style'], A.settled, ft.captions.lines.length, !!F.cube]);
    if (sig === F.sig) return; F.sig = sig;
    drawStage(); ed.panel(); ed.props();
  }

  function drawStage() {
    const stage = $('.ed-stage'), edEl = $('.ed'); if (!stage || !F) return;
    stage.classList.add('ft10'); edEl && edEl.classList.add('ft10');
    let el = $('#ftStage');
    if (!el) {
      F.ro && F.ro.disconnect();
      el = document.createElement('div'); el.id = 'ftStage'; el.className = 'ft-stage';
      el.innerHTML = '<div class="ft-frame" id="ftFrame"><div class="ft-box" id="ftBox"></div><div class="ft-split" id="ftSplit" hidden><i></i><span class="ft-sl">Before</span><span class="ft-sr">After</span></div></div><div class="ft-msg" id="ftMsg" hidden></div><div class="ft-prog" id="ftProg" hidden></div>';
      stage.insertBefore(el, $('#edPages'));
      F.ro = new ResizeObserver(layout); F.ro.observe(el);
    }
    layout();
    if (!F.player && F.rec && F.rec.proxyUrl) mountPlayer();
    const A = analysis(F.rec, F.refRec), msg = $('#ftMsg'), prog = $('#ftProg');
    let m = '';
    if (F.err && (!F.rec || !F.player || /played/.test(F.err))) m = `<p>${esc(F.err)}</p>`;
    else if (A.failed) m = failBox(A.error || 'This video could not be processed.', F.id, firstFailed(F.rec) || 'probe');
    else if (!F.player) m = `<div class="ft-wait">${skel(2)}<p>Preparing your video…${pct(A.proxy)}</p></div>`;
    msg.innerHTML = m; msg.hidden = !m;
    const work = [[A.transcribe, 'Transcribing'], [A.grade, 'Matching the grade'], [A.style, 'Reading the subtitle style']].filter(([s]) => BUSY.includes(s.state)).map(([s, l]) => l + pct(s));
    prog.innerHTML = work.length ? `<span class="ft-dot"></span>${esc(work.join(' · '))}…` : ''; prog.hidden = !work.length || A.failed;
    $('#ftSplit').hidden = F.split == null;
    if (F.split != null) $('#ftSplit').style.left = F.split * 100 + '%';
  }
  /** The frame: the output aspect ratio, as large as the stage allows */
  function layout() {
    const el = $('#ftStage'), fr = $('#ftFrame'); if (!el || !fr || !ED.d || !isFt(ED.d)) return;
    const { w, h } = ED.d.footage.out, r = el.getBoundingClientRect(), b = fitBox(r.width - 48, r.height - 48, w, h);
    fr.style.width = b.w + 'px'; fr.style.height = b.h + 'px';
  }

  function transport(ms, playing) {
    if (!F) return;
    const t = $('#ftT'), sc = $('#ftScrub'), pb = $('#ftPlay'), dur = F.dur || (F.player && F.player.duration()) || 0;
    if (t) t.textContent = fmtMs(ms);
    const td = $('#ftDur'); if (td) td.textContent = fmtMs(dur);
    if (sc && document.activeElement !== sc) { sc.max = String(Math.max(1, Math.round(dur))); sc.value = String(Math.round(ms)); }
    if (sc) sc.style.setProperty('--p', dur ? (ms / dur) * 100 + '%' : '0%');
    if (pb && pb.dataset.on !== String(!!playing)) { pb.dataset.on = String(!!playing); pb.innerHTML = ic(playing ? 'pause37' : 'play37', 16); pb.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)'); }
    const hd = $('#ftHead'); if (hd && dur) hd.style.left = Math.min(100, Math.max(0, (ms / dur) * 100)) + '%';
    hilite(ms, playing);
  }
  /** The subtitle row being spoken */
  let lastRow = null;
  function hilite(ms, playing) {
    const lines = ED.d && ED.d.footage ? ED.d.footage.captions.lines : [];
    const i = lines.findIndex((l) => ms >= l.start && ms < l.end), id = i >= 0 ? lines[i].id : null;
    if (id === lastRow) return; lastRow = id;
    document.querySelectorAll('#edPanel .ft-row.on').forEach((x) => x.classList.remove('on'));
    if (id) { const r = document.querySelector(`#edPanel .ft-row[data-id="${CSS.escape(id)}"]`); if (r) { r.classList.add('on'); if (playing && !r.contains(document.activeElement)) r.scrollIntoView({ block: 'nearest' }); } }
  }

  /* ---------- timeline lane: waveform and one block per subtitle ---------- */
  const pc = (v) => Math.max(0, Math.min(100, +v || 0)).toFixed(3);
  function blockHTML(l, i, dur) {
    const left = pc((l.start / dur) * 100), w = pc(((l.end - l.start) / dur) * 100), ro = canEdit && !canEdit();
    return `<div class="ft-blk${ro ? ' ro' : ''}" data-i="${i | 0}" data-id="${esc(l.id)}" style="left:${left}%;width:${w}%" title="${esc(rangeLabel(l))}">${ro ? '' : '<i class="ft-h s" data-edge="start"></i>'}<span dir="auto">${esc(lineText(l))}</span>${ro ? '' : '<i class="ft-h e" data-edge="end"></i>'}</div>`;
  }
  function blocksHTML() {
    const dur = F && F.dur; if (!dur || !ED.d || !isFt(ED.d)) return '';
    return (ED.d.footage.captions.lines || []).map((l, i) => blockHTML(l, i, dur)).join('');
  }
  /** Redraws the blocks (after an edit, undo or redo) and the waveform */
  function lane() { const b = $('#ftBlks'); if (!b || !F) return; b.innerHTML = blocksHTML(); drawWave(); }
  function laneInit() {
    F && F.lro && F.lro.disconnect();
    const el = $('#ftLane'); if (!el || !F) return;
    if (typeof ResizeObserver !== 'undefined') { F.lro = new ResizeObserver(() => drawWave()); F.lro.observe(el); }
    drawWave();
  }
  function drawWave() {
    const cv = $('#ftWave'), el = $('#ftLane'); if (!cv || !el || !F) return;
    const r = el.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext('2d'); c.clearRect(0, 0, w, h);
    if (!F.peaks) return;
    const px = fitPeaks(F.peaks, w); // one peak per device pixel column
    c.fillStyle = getComputedStyle(el).getPropertyValue('--ft-wave').trim() || 'rgba(100,116,139,.5)';
    const mid = h / 2;
    for (let x = 0; x < w; x++) { const a = Math.max(1, px[x] * h * 0.9); c.fillRect(x, mid - a / 2, 1, a); }
  }
  /** Decodes the proxy's audio once (lazily, after the player is ready) into 2000 fixed peak buckets; without it the lane has no waveform */
  async function loadPeaks(S) {
    if (S.peaks || S.peaksBusy || !S.rec || !S.rec.proxyUrl) return; S.peaksBusy = true;
    const AC = window.AudioContext || window.webkitAudioContext; let actx = null;
    try {
      if (!AC) return;
      const res = await fetch(apiUrl(S.rec.proxyUrl), { signal: S.ac.signal });
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      if (!alive(S)) return;
      actx = new AC();
      const audio = await actx.decodeAudioData(buf);
      if (!alive(S)) return;
      S.peaks = peakBuckets(audio.getChannelData(0), PEAK_BUCKETS);
      for (let ch = 1; ch < audio.numberOfChannels; ch++) { const o = peakBuckets(audio.getChannelData(ch), PEAK_BUCKETS); for (let k = 0; k < o.length; k++) if (o[k] > S.peaks[k]) S.peaks[k] = o[k]; }
      drawWave();
    } catch (e) { /* no audio track, no decoder or the request stopped: the lane stays without a waveform */ } finally { actx && actx.close && actx.close().catch(() => {}); }
  }

  /* ---------- editing: every change is one mutate() ---------- */
  const can = () => !canEdit || canEdit();
  const lineIdx = (id) => ED.d.footage.captions.lines.findIndex((l) => l.id === id);
  /** Applies fn(lines) -> new lines in one undoable step */
  function editLines(fn, redraw) {
    if (!F || !can()) return;
    mutate(() => { const c = ED.d.footage.captions; c.lines = fn(c.lines || []); }, redraw); save();
  }
  /** After a text edit the rows keep focus: only the preview and the lane follow */
  const light = () => { sync(); lane(); };
  function commitText(inp) {
    if (!F || !can()) return;
    const i = lineIdx(inp.dataset.ftText); if (i < 0) return;
    const cur = ED.d.footage.captions.lines[i];
    if (inp.value.trim().split(/\s+/).filter(Boolean).join(' ') === lineText(cur)) { inp.value = lineText(cur); return; }
    editLines((ls) => ls.map((l, k) => (k === i ? retext(l, inp.value) : l)), light);
  }
  function openMenu(btn, rows) {
    document.querySelectorAll('#ctx').forEach((x) => x.remove());
    const r = btn.getBoundingClientRect(), c = document.createElement('div'); c.className = 'ctx'; c.id = 'ctx'; c.setAttribute('role', 'menu');
    c.innerHTML = rows.map((x, k) => `<button role="menuitem" data-k="${k}" class="${x[2] || ''}" ${x[3] ? 'disabled' : ''}><span class="ci">${x[0]}</span></button>`).join('');
    document.body.append(c);
    const hh = c.offsetHeight, ww = c.offsetWidth;
    c.style.left = Math.max(8, Math.min(r.right - ww, innerWidth - ww - 8)) + 'px';
    c.style.top = (r.bottom + 6 + hh < innerHeight ? r.bottom + 6 : Math.max(8, r.top - hh - 6)) + 'px';
    const gone = (ev) => { if (!c.contains(ev.target)) { c.remove(); removeEventListener('pointerdown', gone, true); } };
    c.onclick = (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { c.remove(); removeEventListener('pointerdown', gone, true); rows[+b.dataset.k][1](); } };
    c.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { c.remove(); removeEventListener('pointerdown', gone, true); btn.focus(); } };
    setTimeout(() => addEventListener('pointerdown', gone, true));
    const f = c.querySelector('button:not(:disabled)'); f && f.focus();
  }
  function rowMenu(btn) {
    if (!F || !can()) return;
    const id = btn.dataset.id, i = lineIdx(id), ls = ED.d.footage.captions.lines; if (i < 0) return;
    openMenu(btn, [
      ['Split at playhead', () => splitAt(id)],
      ['Merge with next', () => { const k = lineIdx(id); if (k >= 0 && k < ED.d.footage.captions.lines.length - 1) editLines((a) => [...a.slice(0, k), merge(a[k], a[k + 1]), ...a.slice(k + 2)]); }, '', i >= ls.length - 1],
      ['Delete', () => editLines((a) => a.filter((l) => l.id !== id)), 'dl'],
    ]);
  }
  function splitAt(id) {
    const t = F.player ? F.player.time() : 0, i = lineIdx(id), l = ED.d.footage.captions.lines[i];
    if (!l || !(t > l.start && t < l.end) || !l.words.some((w) => w.s >= t) || !l.words.some((w) => w.s < t)) { toast('Move the playhead inside the subtitle, between two words, to split it.'); return; }
    editLines((a) => [...a.slice(0, i), ...split(a[i], t), ...a.slice(i + 1)]);
  }
  function addAtPlayhead() {
    if (!F || !can()) return;
    const before = ED.d.footage.captions.lines || [], after = addLine(before, F.player ? Math.round(F.player.time()) : 0);
    if (after === before) { toast('There is no room for a line here. Move the playhead to a gap.'); return; }
    const old = new Set(before.map((l) => l.id)), fresh = after.find((l) => !old.has(l.id));
    editLines(() => after);
    const inp = fresh && document.querySelector(`#edPanel [data-ft-text="${CSS.escape(fresh.id)}"]`);
    if (inp) { inp.focus(); inp.scrollIntoView({ block: 'nearest' }); }
  }
  /** A small confirmation: onOk runs on the button, onNo on any other way out */
  function ask(title, text, okLabel, onOk, onNo) {
    let ok = false;
    ctx.modal(`<div class="mh"><h2>${esc(title)}</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb"><p class="sm-t">${esc(text)}</p></div>
      <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ft-ok>${esc(okLabel)}</button></div>`,
      { onClose: () => { if (!ok && onNo) onNo(); }, onMount: (bg, close) => { const b = bg.querySelector('[data-ft-ok]'); b.addEventListener('click', () => { ok = true; close(); onOk(); }); b.focus(); } });
  }
  function regroup(inp) {
    if (!F || !can()) return;
    const S = F, n = Math.min(8, Math.max(1, Math.round(+inp.value) || 0)), ft = ED.d.footage, was = Math.round(+(ft.captions.style && ft.captions.style.maxWords) || DEFAULT_STYLE.maxWords);
    inp.value = n; if (n === was) return;
    ask('Change words per line?', 'This replaces your line breaks', 'Replace', async () => {
      try {
        const words = await api(`/footage/${S.id}/words`);
        if (!alive(S)) return;
        if (!Array.isArray(words) || !words.length) { inp.value = was; toast('There are no words to group yet.'); return; }
        mutate(() => { const c = ED.d.footage.captions; c.style = { ...(c.style || DEFAULT_STYLE), maxWords: n }; c.lines = group(words, c.style); }); save();
      } catch (e) { inp.value = was; toast((e && e.message) || 'Could not load the words'); }
    }, () => { inp.value = was; });
  }
  function retranscribe() {
    if (!F || !can()) return; const S = F;
    ask('Re-transcribe?', 'This replaces your edited subtitles', 'Re-transcribe', async () => {
      try {
        await api(`/footage/${S.id}/retry`, { method: 'POST', body: { step: 'transcribe' } });
        if (!alive(S)) return;
        toast('Transcribing again'); S.retx = true; S.applied = false; S.err = null; S.sig = ''; S.gen++; poll();
      } catch (e) { toast((e && e.message) || 'Could not start the transcription'); }
    });
  }

  /* dragging a block edge, or the block: preview through the player, one mutate() on release */
  function dragStart(e) {
    if (!F || !can() || e.button > 0 || F.drag) return;
    const blk = e.target.closest('.ft-blk'), lnEl = $('#ftLane'); if (!lnEl) return;
    if (!blk) { // an empty spot of the lane: seek there
      if (e.target.closest('#ftLane') && F.dur && F.player) { const r = lnEl.getBoundingClientRect(); F.player.seek(((e.clientX - r.left) / r.width) * F.dur); }
      return;
    }
    const ls = ED.d.footage.captions.lines, i = lineIdx(blk.dataset.id); if (i < 0 || !F.dur) return;
    e.preventDefault();
    const S = F, h = e.target.closest('.ft-h'), edge = h ? h.dataset.edge : 'move', r = lnEl.getBoundingClientRect(), orig = ls[i];
    const d = S.drag = { i, id: orig.id, edge, x0: e.clientX, pid: e.pointerId, orig, to: { start: orig.start, end: orig.end }, moved: false, blk };
    blk.classList.add('drag');
    try { blk.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    const at = (ev) => {
      const dx = ((ev.clientX - d.x0) / r.width) * S.dur;
      if (Math.abs(ev.clientX - d.x0) > 2) d.moved = true;
      d.to = clampDrag(ls, i, edge, edge === 'end' ? orig.end + dx : edge === 'start' ? orig.start + dx : orig.start + dx, S.dur);
      const l = retime(orig, d.to.start, d.to.end), cap = ED.d.footage.captions;
      blk.style.left = pc((d.to.start / S.dur) * 100) + '%'; blk.style.width = pc(((d.to.end - d.to.start) / S.dur) * 100) + '%';
      S.player && S.player.setCaptions({ ...cap, lines: cap.lines.map((x, k) => (k === i ? l : x)) });
    };
    const done = (commit) => {
      blk.removeEventListener('pointermove', at); blk.removeEventListener('pointerup', up); blk.removeEventListener('pointercancel', cancel); blk.removeEventListener('lostpointercapture', cancel);
      blk.classList.remove('drag'); S.drag = null;
      if (!alive(S)) return;
      const changed = d.to.start !== orig.start || d.to.end !== orig.end;
      if (commit && changed) editLines((a) => a.map((x) => (x.id === d.id ? retime(x, d.to.start, d.to.end) : x)));
      else { sync(); lane(); if (commit && !d.moved && S.player) S.player.seek(orig.start); }
    };
    const up = () => done(true), cancel = () => done(false);
    blk.addEventListener('pointermove', at); blk.addEventListener('pointerup', up); blk.addEventListener('pointercancel', cancel); blk.addEventListener('lostpointercapture', cancel);
  }

  function pagesHTML() {
    const ms = F && F.player ? F.player.time() : 0, dur = F ? F.dur : 0, on = F && F.split != null, playing = !!(F && F.player && F.player.playing());
    return `<div class="ft-tp">
      <button class="mo-play" id="ftPlay" data-act="ftPlay" data-on="${playing}" aria-label="${playing ? 'Pause' : 'Play'} (Space)" title="Play / pause (Space, K)" ${F && F.player ? '' : 'disabled'}>${ic(playing ? 'pause37' : 'play37', 16)}</button>
      <span class="mo-time"><b id="ftT">${fmtMs(ms)}</b><span> / <span id="ftDur">${fmtMs(dur)}</span></span></span>
      <input type="range" class="ft-scrub" id="ftScrub" min="0" max="${Math.max(1, Math.round(dur))}" step="1" value="${Math.round(ms)}" aria-label="Playback position" ${F && F.player ? '' : 'disabled'}>
      <button class="btn ${on ? 'secondary on' : 'ghost'} sm ft-ba" data-act="ftSplit" aria-pressed="${on}" title="Compare with the original (drag the line)">${ic('ftCmp10', 15)}Before / After</button>
      <span class="ft-keys xs-t muted" title="J / L: 5 s back / forward · ← / →: one frame">J K L · ← →</span>
    </div>
    <div class="ft-lane" id="ftLane" aria-label="Subtitle timeline"><canvas id="ftWave" aria-hidden="true"></canvas><div class="ft-blks" id="ftBlks">${blocksHTML()}</div><i class="ft-head" id="ftHead" style="left:${F && F.dur ? Math.min(100, (ms / F.dur) * 100) : 0}%"></i></div>`;
  }

  function subsHTML() {
    const A = analysis(F.rec, F.refRec), ft = ED.d.footage, lines = ft.captions.lines || [];
    let body;
    if (lines.length) body = `<div class="ft-rows">${lines.map((l) => rowHTML(l)).join('')}</div>`;
    else if (A.transcribe.state === 'failed') body = failBox(A.transcribe.error || 'The speech could not be transcribed.', F.id, 'transcribe');
    else if (A.busy(A.transcribe) || !F.rec) body = `<p class="xs-t muted">Listening to your video…${pct(A.transcribe)}</p>${skel(6)}`;
    else if (A.transcribe.state === 'skipped') body = '<p class="sm-t muted">This video has no sound, so there is nothing to subtitle.</p>';
    else body = '<p class="sm-t muted">No speech was found in this video.</p>';
    return `<h3>Subtitles</h3>${body}${footHTML(ft, A)}`;
  }
  /** One subtitle: the time (seeks), the text (editable) and its menu. Every design value goes through esc() or a number. */
  function rowHTML(l) {
    const ro = canEdit && !canEdit() ? 'readonly' : '';
    return `<div class="ft-row" data-id="${esc(l.id)}"><button class="ft-t" data-act="ftSeek" data-ms="${+l.start || 0}" title="Go to this subtitle">${esc(rangeLabel(l))}</button>
      <input class="ft-in" dir="auto" data-ft-text="${esc(l.id)}" value="${esc(lineText(l))}" placeholder="Type the subtitle" aria-label="Subtitle text" spellcheck="false" ${ro}>
      ${ro ? '' : `<button class="btn ghost icon sm ft-more" data-act="ftMore" data-id="${esc(l.id)}" aria-haspopup="menu" aria-label="Subtitle actions" title="More">${ic('more', 16)}</button>`}</div>`;
  }
  function footHTML(ft, A) {
    if (canEdit && !canEdit()) return '';
    const has = (ft.captions.lines || []).length, mw = Math.min(8, Math.max(1, Math.round(+(ft.captions.style && ft.captions.style.maxWords) || DEFAULT_STYLE.maxWords)));
    const busyT = A.busy(A.transcribe);
    return `<div class="ft-foot"><button class="btn secondary sm" data-act="ftAdd">${ic('plus', 15)}Add a line at the playhead</button>
      <label class="ft-wpl"><span>Words per line</span><input type="number" min="1" max="8" step="1" value="${mw}" data-ft-wpl aria-label="Words per line" ${has ? '' : 'disabled'}></label>
      <button class="btn ghost sm" data-act="ftRetx" ${busyT || !F.rec ? 'disabled' : ''}>${ic('refresh', 15)}Re-transcribe</button></div>`;
  }

  function lookHTML() {
    const A = analysis(F.rec, F.refRec), ft = ED.d.footage, src = F.ref ? 'the reference video' : 'your brand look';
    let grade;
    if (A.grade.state === 'failed') grade = failBox(A.grade.error || 'The colour grade could not be matched.', F.id, 'grade');
    else if (A.busy(A.grade) || !F.rec) grade = `<p class="xs-t muted">Matching the colours of ${src}…${pct(A.grade)}</p>${skel(3)}`;
    else if (F.cube) grade = `<p class="sm-t">The colours match ${src}. Use <b>Before / After</b> under the video to compare.</p>`;
    else grade = `<p class="sm-t muted">${esc(F.note || 'No colour grade yet.')}</p>`;
    let style = '';
    if (F.ref) {
      if (A.style.state === 'failed') style = failBox(A.style.error || 'The subtitle style could not be read.', F.ref, 'caption-style');
      else if (A.busy(A.style) || !F.refRec) style = `<p class="xs-t muted">Reading the subtitle style…</p>${skel(2)}`;
      else style = `<p class="sm-t">${ft.captions.style && !(F.refRec && F.refRec.captionNote) ? 'Subtitles use the style read from the reference.' : 'Subtitles use the default style.'}</p>`;
      const note = F.refRec && F.refRec.captionNote; if (note) style +=`<div class="note">${ic('alert', 15)}<span>${esc(note)}</span></div>`;
    } else style = `<p class="sm-t">${ft.captions.style ? 'Subtitles use the brand look’s style.' : 'Subtitles use the default style.'}</p>`;
    return `<div class="body ft-look-p"><h3>Look</h3><section class="ft-sec"><span class="label">Colour grade</span>${grade}</section><section class="ft-sec"><span class="label">Subtitle style</span>${style}</section></div>`;
  }

  wrapEd({
    edStage: (orig) => function () {
      const r = orig.apply(this, arguments);
      if (!isFt(ED.d)) { if (F) stop(); const st = $('#ftStage'); st && st.remove(); $('.ed-stage') && $('.ed-stage').classList.remove('ft10'); $('.ed') && $('.ed').classList.remove('ft10'); return r; }
      if (!F || F.d !== ED.d || (F.player && !document.body.contains(F.player.video))) start(ED.d);
      drawStage(); sync();
      return r;
    },
    edRail: (orig) => function () {
      if (!isFt(ED.d)) return orig.apply(this, arguments);
      const el = $('#edRail'); if (el) el.innerHTML = `<button class="on" data-act="edTab" data-k="ftSubs" title="Subtitles">${ic('type', 22)}<span>Subtitles</span></button>`;
    },
    edPanel: (orig) => function () {
      if (!isFt(ED.d) || !F) return orig.apply(this, arguments);
      const p = $('#edPanel'); if (!p) return; p.classList.remove('agent'); p.innerHTML = subsHTML(); lastRow = null; if (F.player) hilite(F.player.time());
    },
    edProps: (orig) => function () {
      if (!isFt(ED.d) || !F) return orig.apply(this, arguments);
      const el = $('#edProps'); if (el) el.innerHTML = lookHTML();
    },
    edPages: (orig) => function () {
      const host = $('#edPages'); if (!host) return;
      if (!isFt(ED.d)) { host.classList.remove('ft10'); return orig.apply(this, arguments); }
      host.classList.add('ft10'); host.innerHTML = pagesHTML(); laneInit();
    },
  });
  /* leaving the editor (or opening another design) stops the video */
  addEventListener('hashchange', () => setTimeout(() => { if (F && !alive(F)) stop(); }));

  /* ---------- 4. actions and keys ---------- */
  const setSplit = (x) => { if (!F) return; F.split = x; F.player && F.player.setSplit(x); drawStage(); const b = $('[data-act=ftSplit]'); if (b) { b.setAttribute('aria-pressed', String(x != null)); b.className = `btn ${x != null ? 'secondary on' : 'ghost'} sm ft-ba`; } };
  Object.assign(ACT, {
    ftPlay: () => F && F.player && F.player.toggle(),
    ftSplit: () => setSplit(F && F.split == null ? 0.5 : null),
    ftMore: (a) => rowMenu(a),
    ftAdd: () => addAtPlayhead(),
    ftRetx: () => retranscribe(),
    ftSeek: (a) => { if (F && F.player) { F.player.seek(+a.dataset.ms); } },
    ftRetry: async (a) => {
      if (!F || a.disabled) return; const S = F; a.disabled = true;
      try {
        const id = a.dataset.id, step = a.dataset.step;
        // a grade that failed because the reference could not be read: run the reference again first
        if (step === 'grade' && S.refRec && S.refRec.status === 'failed') { const rs = firstFailed(S.refRec); if (rs) await api(`/footage/${S.ref}/retry`, { method: 'POST', body: { step: rs } }); }
        await api(`/footage/${id}/retry`, { method: 'POST', body: { step } });
        if (!alive(S)) return;
        toast('Trying again'); S.applied = false; S.err = null; S.sig = ''; S.gen++; poll();
      } catch (e) { a.disabled = false; toast((e && e.message) || 'Could not retry'); }
    },
  });
  document.addEventListener('focusout', (e) => { if (e.target && e.target.matches && e.target.matches('[data-ft-text]')) commitText(e.target); });
  document.addEventListener('change', (e) => { if (e.target && e.target.matches && e.target.matches('[data-ft-wpl]')) regroup(e.target); });
  document.addEventListener('keydown', (e) => {
    const t = e.target; if (!F || !t || !t.matches || !t.matches('[data-ft-text]')) return;
    if (e.key === 'Enter') { e.preventDefault(); t.blur(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const l = ED.d.footage.captions.lines.find((x) => x.id === t.dataset.ftText); t.value = l ? lineText(l) : ''; t.blur(); }
  }, true);
  document.addEventListener('pointerdown', dragStart);
  document.addEventListener('input', (e) => { if (e.target && e.target.id === 'ftScrub' && F && F.player) F.player.seek(+e.target.value); });
  /* the split line: drag anywhere on the frame while Before / After is on */
  document.addEventListener('pointerdown', (e) => {
    if (!F || F.split == null || e.button !== 0) return; const fr = $('#ftFrame'); if (!fr || !fr.contains(e.target)) return;
    e.preventDefault(); const r = fr.getBoundingClientRect(), at = (ev) => setSplit(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)));
    at(e); const up = () => { removeEventListener('pointermove', at); removeEventListener('pointerup', up); };
    addEventListener('pointermove', at); addEventListener('pointerup', up);
  });
  /* Space play / pause, J / L 5 s back / forward, K pause, ← / → one frame. Capture phase: ahead of the editor's own keys (Space pans, L draws a line) */
  addEventListener('keydown', (e) => {
    if (!F || !F.player || !isFt(ED.d) || !document.body.classList.contains('in-editor') || ED.editing || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = (t.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || t.isContentEditable || document.querySelector('.modal-bg, #cmdk')) return;
    const P = F.player, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const act = { ' ': () => P.toggle(), k: () => P.pause(), j: () => P.seek(P.time() - 5000), l: () => P.seek(P.time() + 5000),
      ArrowLeft: () => { P.pause(); P.seek(P.time() - P.frameMs()); }, ArrowRight: () => { P.pause(); P.seek(P.time() + P.frameMs()); } }[k];
    if (!act || (k === ' ' && tag === 'button' && t.dataset.act !== 'ftPlay')) return;
    e.preventDefault(); e.stopImmediatePropagation(); act();
  }, true);
  /** Tasks 11-13: after changing d.footage outside mutate(), make the player and panels follow */
  FT.sync = () => { sync(); redraw(); };
  /** The open footage session (player, records) or null */
  FT.session = () => F;
}
