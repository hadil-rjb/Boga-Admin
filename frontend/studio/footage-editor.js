/* ============================================================
   Footage editor: a design with `d.footage` takes over the editor (as v37 does for `d.motion`).
   Center: the player (footage-player.js) at the output aspect ratio, letterboxed, with a Before/After split.
   Bottom: the transport (play, time, scrub, Before/After). Left: Subtitles. Right: Look.
   While the server transcribes and grades, the panels show skeletons; a failed step shows its error and Retry.
   installFootageEditor(ctx, FT) is called by installFootage. The pure helpers at the top are unit-tested.
   Section 1: pure helpers. 2: session (polling, results, player). 3: drawing. 4: actions and keys.
   ============================================================ */
import { apiUrl } from '../lib/api';
import { group, retext, retime, addLine, split, merge, lineAt, layout, DEFAULT_STYLE, FONT_STACKS } from './captions.js';
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
export function analysisPatch(ft, { id, words, refStyle, refNote, hasCube }) {
  const out = {};
  // styleFrom says where the style came from; a style the user already owns (or a look's) is never replaced
  if (ft.captions.style == null && refStyle) { out.style = refStyle; out.styleFrom = refNote ? 'default' : 'reference'; }
  if (!(ft.captions.lines || []).length && Array.isArray(words) && words.length) out.lines = group(words, out.style || ft.captions.style || DEFAULT_STYLE);
  if (hasCube && !ft.look.lut) out.lut = lookPath(id);
  return Object.keys(out).length ? out : null;
}
export function applyPatch(ft, p) {
  if (p.style) { ft.captions.style = p.style; if (p.styleFrom) ft.captions.styleFrom = p.styleFrom; }
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


/* ---- Look panel: grade sliders, subtitle style edits, brand looks ---- */
const clampN2 = (v, a, b) => Math.min(Math.max(v, a), b);
/** The grade sliders' integer ranges: strength 0..100 (value 0..1), the others -100..100 (value -1..1) */
export const GRADE_KEYS = { strength: [0, 100], exposure: [-100, 100], temp: [-100, 100], sat: [-100, 100] };
export const GRADE_RESET = { strength: 1, exposure: 0, temp: 0, sat: 0 };
/** A grade value as the slider's integer */
export function gradeToSlider(key, v) {
  const [a, b] = GRADE_KEYS[key], x = v == null && key === 'strength' ? 1 : +v || 0;
  return clampN2(Math.round(x * 100), a, b) + 0;
}
/** A slider's integer as the grade value */
export function sliderToGrade(key, n) {
  const [a, b] = GRADE_KEYS[key];
  return (clampN2(Math.round(+n || 0), a, b) + 0) / 100;
}
/** The look object with one slider applied (never mutates) */
export const gradePatch = (look, key, n) => ({ ...look, [key]: sliderToGrade(key, n) });
export const FONT_LABELS = { 'sans-bold': 'Bold sans', sans: 'Sans', serif: 'Serif', display: 'Display' };
export const FONT_KEYS = Object.keys(FONT_STACKS);
export const HL_MODES = [['box', 'Box'], ['color', 'Color'], ['scale', 'Scale'], ['none', 'None']];
export const ANIMS = [['none', 'None'], ['pop', 'Pop'], ['fade', 'Fade']];
export const WEIGHTS = [[400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']];
export const Y_MIN = 0.05, Y_MAX = 0.95;
export const clampY = (y) => Math.round(clampN2(+y || 0, Y_MIN, Y_MAX) * 1000) / 1000;
/** A value for <input type=color> (#rrggbb), or the fallback when the style holds anything else (rgba, names) */
export function colorHex(v, fallback = '#ffffff') {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim());
  if (!m) return fallback;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return '#' + h.toLowerCase();
}
/** Words per line of a style (1..8; the default when unset) */
export const maxWordsOf = (style) => clampN2(Math.round(+(style && style.maxWords) || DEFAULT_STYLE.maxWords), 1, 8);
/**
 * One edit of the subtitle style, as a new style (a missing style starts from the default). Units are the controls':
 * size and y in percent of the video height (size 2..10, y 5..95), strokeWidth in thousandths of the height (1..20),
 * strokeOn / shadowOn booleans, colors as #rrggbb. Unknown keys and unusable values change nothing.
 */
export function styleEdit(style, key, v) {
  const s = JSON.parse(JSON.stringify(style || DEFAULT_STYLE)), num = +v;
  const hl = () => (s.highlight = { ...DEFAULT_STYLE.highlight, ...(s.highlight || {}) });
  const hex = (x) => /^#[0-9a-f]{6}$/i.test(String(x));
  switch (key) {
    case 'font': if (FONT_STACKS[v]) s.font = v; break;
    case 'size': if (isFinite(num)) s.size = Math.round(clampN2(num, 2, 10) * 10) / 1000; break;
    case 'weight': if (isFinite(num) && num >= 100 && num <= 900) s.weight = Math.round(num / 100) * 100; break;
    case 'color': if (hex(v)) s.color = v; break;
    case 'strokeOn': s.stroke = v ? (s.stroke || { color: '#000000', width: 0.004 }) : null; break;
    case 'strokeColor': if (hex(v)) s.stroke = { width: 0.004, ...(s.stroke || {}), color: v }; break;
    case 'strokeWidth': if (isFinite(num)) s.stroke = { color: '#000000', ...(s.stroke || {}), width: clampN2(num, 1, 20) / 1000 }; break;
    case 'shadowOn': s.shadow = v ? (s.shadow || { ...DEFAULT_STYLE.shadow }) : null; break;
    case 'hlMode': if (['box', 'color', 'scale', 'none'].includes(v)) hl().mode = v; break;
    case 'hlColor': if (hex(v)) hl().color = v; break;
    case 'hlText': if (hex(v)) hl().text = v; break;
    case 'y': if (isFinite(num)) s.y = clampY(num / 100); break;
    case 'anim': if (['none', 'pop', 'fade'].includes(v)) s.anim = v; break;
    default: break;
  }
  return s;
}
/** Where the subtitle style came from: the stored origin, else guessed (a style without one came from the reference or the look) */
export function styleOrigin(captions, hasRef) {
  const c = captions || {};
  if (['reference', 'look', 'default', 'custom'].includes(c.styleFrom)) return c.styleFrom;
  return c.style ? (hasRef ? 'reference' : 'look') : 'default';
}
/** The panel's sentence about the style's origin */
export const ORIGIN_COPY = {
  reference: 'Subtitles use the style read from the reference.',
  look: 'Subtitles use the brand look’s style.',
  default: 'Subtitles use the default style.',
  custom: 'Subtitles use your own style.',
};
/** Seconds into a video of `dur` seconds at which the reference thumbnail is taken: frame 30 of the 60 sampled frames */
export const thumbTime = (dur) => Math.max(0, (29.5 / 60) * (+dur || 0));
/** Thumbnail size: 160 px wide */
export const thumbSize = (vw, vh) => ({ w: 160, h: Math.max(1, Math.round((160 * (+vh || 9)) / (+vw || 16))) });
/** The stored brand look */
export function lookRecord({ id, name, lut, captionStyle, refThumb, now = new Date() }) {
  const nm = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Brand look';
  return { id, name: nm, lut, captionStyle: JSON.parse(JSON.stringify(captionStyle || DEFAULT_STYLE)), refThumb: refThumb || null, createdAt: new Date(now).toISOString() };
}
/**
 * Applies a brand look to a footage doc (in place): its cube, its subtitle style (origin 'look') and, when `lines` are given
 * (regrouped by the caller because the look's words per line differ), the new lines. Returns whether the lines need regrouping.
 */
export function applyLookTo(ft, look, lines) {
  const was = maxWordsOf(ft.captions.style);
  ft.look.lut = look.lut; ft.lookId = look.id;
  if (look.captionStyle) { ft.captions.style = JSON.parse(JSON.stringify(look.captionStyle)); ft.captions.styleFrom = 'look'; }
  if (lines) ft.captions.lines = lines;
  return !!look.captionStyle && maxWordsOf(look.captionStyle) !== was;
}

const PEAK_BUCKETS = 2000;
const GOOGLE_FONTS = 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cairo:wght@400;600;700;800;900&family=Lalezar&family=Noto+Naskh+Arabic:wght@400;700&family=Noto+Sans+Arabic:wght@400;600;700;800&display=swap';

export function installFootageEditor(ctx, FT) {
  const { ED, ACT, api, toast, ic, IC, esc, mutate, save, canEdit, wrapEd, ed, brand } = ctx;
  Object.assign(IC, { ftCmp10: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/><path d="M7 9l-2 3 2 3M17 9l2 3-2 3"/>' });
  const $ = (s, r = document) => r.querySelector(s);
  const isFt = (d) => !!(d && d.footage);
  /** The open footage design's session */
  let F = null;

  /* ---------- 2. session ---------- */
  function start(d) {
    stop();
    F = { d, id: d.footage.src, ref: d.footage.ref, rec: null, refRec: null, cube: null, cubes: {}, cubeBad: {}, timer: 0, player: null, split: null, dur: 0, lastRefresh: 0, applied: false, err: null, note: null, gen: 0, sig: '', peaks: null, ac: new AbortController(), retx: false, drag: null };
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
    const patch = analysisPatch(cur, { id: S.id, words, refStyle, refNote: S.refRec && S.refRec.captionNote, hasCube: !!S.cube }) || {};
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
    ensureCube(F, ft.look.lut);
    F.player.setLook(ft.look); F.player.setCaptions(ft.captions); F.player.setSplit(F.split);
  }
  /** A brand look's cube ('looks/<id>.cube') is fetched once; the player picks it up when it arrives (a failure is remembered, not retried) */
  function ensureCube(S, lut) {
    const m = /^looks\/([\w-]{1,64})\.cube$/.exec(lut || '');
    if (!m || S.cubes[lut] || S.cubeBad[lut] || S.cubeBusy === lut) return;
    S.cubeBusy = lut;
    api(`/footage/looks/${m[1]}`, { text: true }).then((t) => { S.cubes[lut] = parseCube(t); }).catch(() => { S.cubeBad[lut] = true; S.note = 'This brand look’s colour grade could not be loaded.'; })
      .finally(() => { if (S.cubeBusy === lut) S.cubeBusy = null; if (alive(S)) { sync(); redraw(); } });
  }

  function mountPlayer() {
    const S = F, box = $('#ftBox'); if (!box || !S.rec || !S.rec.proxyUrl) return;
    const ft = S.d.footage;
    S.player = createPlayer(box, {
      proxyUrl: apiUrl(S.rec.proxyUrl), out: ft.out, look: ft.look, captions: ft.captions,
      cube: (lut) => (lut === lookPath(S.id) ? S.cube : S.cubes[lut] || null),
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
    const S = F, n = Math.min(8, Math.max(1, Math.round(+inp.value) || 0)), ft = ED.d.footage, was = maxWordsOf(ft.captions.style);
    inp.value = n; if (n === was) return;
    ask('Change words per line?', 'This replaces your line breaks', 'Replace', async () => {
      try {
        const words = await api(`/footage/${S.id}/words`);
        if (!alive(S)) return;
        if (!Array.isArray(words) || !words.length) { inp.value = was; toast('There are no words to group yet.'); return; }
        mutate(() => { const c = ED.d.footage.captions; c.style = { ...(c.style || DEFAULT_STYLE), maxWords: n }; c.styleFrom = 'custom'; c.lines = group(words, c.style); }); save();
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
    const busyT = A.busy(A.transcribe);
    return `<div class="ft-foot"><button class="btn secondary sm" data-act="ftAdd">${ic('plus', 15)}Add a line at the playhead</button>
      <button class="btn ghost sm" data-act="ftRetx" ${busyT || !F.rec ? 'disabled' : ''}>${ic('refresh', 15)}Re-transcribe</button></div>`;
  }

  /* ---------- Look panel ---------- */
  const optHTML = (list, cur) => list.map(([v, l]) => `<option value="${esc(String(v))}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const rgHTML = (attr, key, label, min, max, step, val, dis) => `<label class="ft-rg"><span>${label}</span><input type="range" ${attr}="${key}" min="${min}" max="${max}" step="${step}" value="${val}" style="--p:${((val - min) / (max - min)) * 100}%" ${dis}><output>${val}</output></label>`;
  const colorHTML = (key, label, val, dis) => `<label class="ft-rg ft-cl"><span>${label}</span><input type="color" data-ft-s="${key}" value="${colorHex(val)}" ${dis}></label>`;
  const swHTML = (key, label, on, dis) => `<label class="ft-rg ft-sw"><span>${label}</span><input type="checkbox" data-ft-s="${key}" ${on ? 'checked' : ''} ${dis}></label>`;
  const selHTML = (key, label, list, cur, dis) => `<label class="ft-rg ft-se"><span>${label}</span><select class="field" data-ft-s="${key}" ${dis}>${optHTML(list, cur)}</select></label>`;
  const brandLooks = () => (Array.isArray(brand().looks) ? brand().looks : []).filter((l) => l && l.id);

  function gradeHTML(ft, A, src, dis) {
    if (A.grade.state === 'failed') return failBox(A.grade.error || 'The colour grade could not be matched.', F.id, 'grade');
    if (A.busy(A.grade) || !F.rec) return `<p class="xs-t muted">Matching the colours of ${src}…${pct(A.grade)}</p>${skel(3)}`;
    const own = ft.look.lut === lookPath(F.id), applied = brandLooks().find((l) => l.lut === ft.look.lut);
    const msg = own && F.cube ? `The colours match ${src}. Use <b>Before / After</b> under the video to compare.`
      : !own && ft.look.lut ? `Using the brand look ${applied ? `“${esc(applied.name)}”` : ''}.` : esc(F.note || 'No colour grade yet.');
    const L = ft.look, g = (k) => gradeToSlider(k, L[k]);
    return `<p class="sm-t ${own && F.cube || ft.look.lut ? '' : 'muted'}">${msg}</p>
      ${rgHTML('data-ft-g', 'strength', 'Strength', 0, 100, 1, g('strength'), dis)}${rgHTML('data-ft-g', 'exposure', 'Exposure', -100, 100, 1, g('exposure'), dis)}
      ${rgHTML('data-ft-g', 'temp', 'Temperature', -100, 100, 1, g('temp'), dis)}${rgHTML('data-ft-g', 'sat', 'Saturation', -100, 100, 1, g('sat'), dis)}
      ${dis ? '' : `<button class="btn ghost sm ft-reset" data-act="ftGradeReset">${ic('refresh', 14)}Reset grade</button>`}`;
  }

  function styleHTML(ft, A, dis) {
    const st = ft.captions.style || DEFAULT_STYLE, hl = { ...DEFAULT_STYLE.highlight, ...(st.highlight || {}) }, origin = styleOrigin(ft.captions, !!F.ref);
    if (F.ref && !ft.captions.style && (A.busy(A.style) || !F.refRec)) return `<p class="xs-t muted">Reading the subtitle style…</p>${skel(2)}`;
    let top = '';
    if (F.ref && !ft.captions.style && A.style.state === 'failed') top = failBox(A.style.error || 'The subtitle style could not be read.', F.ref, 'caption-style');
    else top = `<p class="sm-t">${ORIGIN_COPY[origin]}</p>`;
    const note = F.refRec && F.refRec.captionNote; if (note && (origin === 'default' || origin === 'reference')) top += `<div class="note">${ic('alert', 15)}<span>${esc(note)}</span></div>`;
    const wc = WEIGHTS.some(([w]) => w === st.weight) ? WEIGHTS : [...WEIGHTS, [st.weight, String(st.weight)]];
    const has = (ft.captions.lines || []).length, size = Math.round(st.size * 1000) / 10, y = Math.round(st.y * 100);
    return `${top}${selHTML('font', 'Font', FONT_KEYS.map((k) => [k, FONT_LABELS[k]]), st.font, dis)}
      ${rgHTML('data-ft-s', 'size', 'Size', 2, 10, 0.5, clampN2(size, 2, 10), dis)}
      ${selHTML('weight', 'Weight', wc, st.weight, dis)}${colorHTML('color', 'Text color', st.color, dis)}
      ${swHTML('strokeOn', 'Stroke', !!st.stroke, dis)}${st.stroke ? `${colorHTML('strokeColor', 'Stroke color', st.stroke.color, dis)}${rgHTML('data-ft-s', 'strokeWidth', 'Stroke width', 1, 20, 1, clampN2(Math.round(st.stroke.width * 1000), 1, 20), dis)}` : ''}
      ${swHTML('shadowOn', 'Shadow', !!st.shadow, dis)}
      ${selHTML('hlMode', 'Highlight', HL_MODES, hl.mode, dis)}${hl.mode !== 'none' ? colorHTML('hlColor', 'Highlight color', hl.color, dis) : ''}${hl.mode === 'box' ? colorHTML('hlText', 'Highlight text', hl.text, dis) : ''}
      ${rgHTML('data-ft-s', 'y', 'Position', 5, 95, 1, clampN2(y, 5, 95), dis)}
      <label class="ft-rg ft-wpl"><span>Words per line</span><input type="number" min="1" max="8" step="1" value="${maxWordsOf(ft.captions.style)}" data-ft-wpl aria-label="Words per line" ${dis || !has ? 'disabled' : ''}></label>
      ${selHTML('anim', 'Animation', ANIMS, st.anim || 'none', dis)}
      ${dis ? '' : '<p class="xs-t muted">You can also drag the subtitle on the video to move it.</p>'}`;
  }

  function looksHTML(ft, dis) {
    const list = brandLooks(), own = ft.look.lut === lookPath(F.id);
    const canSave = !dis && F.cube && own;
    const save = dis ? '' : `<button class="btn secondary sm" data-act="ftSaveLook" ${canSave ? '' : 'disabled'} ${!canSave && F.cube && !own ? 'title="Undo the applied look to save the matched grade"' : ''}>${ic('plus', 15)}Save as brand look</button>`;
    const rows = list.length ? `<ul class="ft-lks">${list.map((l) => `<li class="ft-lkr${l.lut === ft.look.lut ? ' on' : ''}">${l.refThumb && /^data:image\//.test(l.refThumb) ? `<img src="${esc(l.refThumb)}" alt="" width="40" height="40">` : '<span class="ft-th"></span>'}
      <span class="ft-ln" title="${esc(l.name || l.id)}">${esc(l.name || l.id)}</span>
      ${dis ? '' : `<button class="btn secondary sm" data-act="ftApplyLook" data-id="${esc(l.id)}" ${l.lut === ft.look.lut ? 'disabled' : ''}>${l.lut === ft.look.lut ? 'In use' : 'Apply'}</button>
      <button class="btn ghost icon sm" data-act="ftDelLook" data-id="${esc(l.id)}" aria-label="Delete ${esc(l.name || l.id)}" title="Delete">${ic('trash', 15)}</button>`}</li>`).join('')}</ul>`
      : '<p class="xs-t muted">No brand looks yet. Save this grade and subtitle style to reuse them on other videos.</p>';
    return `${save}${rows}`;
  }

  function lookHTML() {
    const A = analysis(F.rec, F.refRec), ft = ED.d.footage, src = F.ref ? 'the reference video' : 'your brand look', dis = can() ? '' : 'disabled';
    return `<div class="body ft-look-p"><h3>Look</h3>
      <section class="ft-sec"><span class="label">Colour grade</span>${gradeHTML(ft, A, src, dis)}</section>
      <section class="ft-sec"><span class="label">Subtitle style</span>${styleHTML(ft, A, dis)}</section>
      <section class="ft-sec"><span class="label">Brand looks</span>${looksHTML(ft, !can())}</section></div>`;
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
    ftGradeReset: () => gradeReset(),
    ftSaveLook: () => saveLook(),
    ftApplyLook: (a) => applyLook(a.dataset.id),
    ftDelLook: (a) => deleteLook(a.dataset.id),
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
  /* ---- Look panel: live preview on `input`, one mutate() on `change` (release) ---- */
  const ctlValue = (el) => (el.type === 'checkbox' ? el.checked : el.value);
  const setOut = (el) => {
    const o = el.closest('.ft-rg') && el.closest('.ft-rg').querySelector('output'); if (o) o.textContent = el.value;
    if (el.type === 'range') el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
  };
  /** Controls that add or remove other controls: the panel is redrawn after the commit (it is also redrawn on the first edit, for the origin text), focus kept */
  const STRUCT = new Set(['strokeOn', 'hlMode']);
  function gradePreview(el) {
    if (!F || !F.player || !can()) return; setOut(el);
    F.player.setLook(gradePatch(ED.d.footage.look, el.dataset.ftG, el.value));
  }
  function gradeCommit(el) {
    if (!F || !can()) return; const k = el.dataset.ftG, ft = ED.d.footage, v = sliderToGrade(k, el.value);
    if (ft.look[k] === v) { sync(); return; }
    mutate(() => { ED.d.footage.look[k] = v; }, sync); save();
  }
  function gradeReset() {
    if (!F || !can()) return;
    mutate(() => { Object.assign(ED.d.footage.look, GRADE_RESET); }, () => { sync(); ed.props(); }); save();
  }
  function stylePreview(el) {
    if (!F || !F.player || !can()) return; setOut(el);
    const c = ED.d.footage.captions;
    F.player.setCaptions({ ...c, style: styleEdit(c.style, el.dataset.ftS, ctlValue(el)) });
  }
  function styleCommit(el) {
    if (!F || !can()) return; const k = el.dataset.ftS, c0 = ED.d.footage.captions, wasCustom = c0.styleFrom === 'custom';
    const next = styleEdit(c0.style, k, ctlValue(el));
    if (c0.style && JSON.stringify(next) === JSON.stringify(c0.style)) { sync(); return; }
    mutate(() => { const c = ED.d.footage.captions; c.style = next; c.styleFrom = 'custom'; }, () => { sync(); if (STRUCT.has(k) || !wasCustom) { ed.props(); const n = document.querySelector(`#edProps [data-ft-s="${k}"]`); if (n) n.focus(); } });
    save();
  }
  document.addEventListener('input', (e) => { const t = e.target; if (!t || !t.matches) return; if (t.matches('[data-ft-g]')) gradePreview(t); else if (t.matches('[data-ft-s]')) stylePreview(t); });
  document.addEventListener('change', (e) => { const t = e.target; if (!t || !t.matches) return; if (t.matches('[data-ft-g]')) gradeCommit(t); else if (t.matches('[data-ft-s]')) styleCommit(t); });

  /* dragging the subtitle on the video sets its height (y): preview through the player, one mutate() on release */
  function captionDrag(e) {
    if (!F || !F.player || F.split != null || !can() || e.button > 0 || F.cdrag) return;
    const fr = $('#ftFrame'), ov = fr && fr.querySelector('.ftp-o'); if (!fr || !ov || !fr.contains(e.target) || !ov.width) return;
    const ft = ED.d.footage, st = ft.captions.style || DEFAULT_STYLE, line = lineAt(ft.captions.lines || [], F.player.time()); if (!line) return;
    const r = fr.getBoundingClientRect(), W = ov.width, H = ov.height, L = layout(ov.getContext('2d'), line, st, W, H);
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height, pad = 0.025;
    if (px < L.x / W - pad || px > (L.x + L.w) / W + pad || py < L.y / H - pad || py > (L.y + L.h) / H + pad) return;
    e.preventDefault();
    const S = F, off = py - st.y, d = S.cdrag = { y: st.y, y0: st.y };
    try { fr.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    fr.classList.add('drag');
    const at = (ev) => {
      d.y = clampY((ev.clientY - r.top) / r.height - off);
      const c = ED.d.footage.captions; S.player && S.player.setCaptions({ ...c, style: { ...(c.style || DEFAULT_STYLE), y: d.y } });
      const sl = $('#edProps [data-ft-s="y"]'); if (sl) { sl.value = String(Math.round(d.y * 100)); setOut(sl); }
    };
    const done = (commit) => {
      fr.removeEventListener('pointermove', at); fr.removeEventListener('pointerup', up); fr.removeEventListener('pointercancel', cancel); fr.removeEventListener('lostpointercapture', cancel);
      fr.classList.remove('drag'); S.cdrag = null;
      if (!alive(S)) return;
      if (commit && d.y !== d.y0) {
        mutate(() => { const c = ED.d.footage.captions; c.style = { ...(c.style || DEFAULT_STYLE), y: d.y }; c.styleFrom = 'custom'; }, () => { sync(); ed.props(); }); save();
      } else { sync(); ed.props(); }
    };
    const up = () => done(true), cancel = () => done(false);
    fr.addEventListener('pointermove', at); fr.addEventListener('pointerup', up); fr.addEventListener('pointercancel', cancel); fr.addEventListener('lostpointercapture', cancel);
  }
  document.addEventListener('pointerdown', captionDrag);

  /* ---- brand looks ---- */
  /** A 160 px JPEG data URL of a video's frame 30 (null when the video cannot be read or drawn within 12 s) */
  function grabThumb(url) {
    return new Promise((resolve) => {
      const v = document.createElement('video'); let done = false, t = 0;
      const fin = (x) => { if (done) return; done = true; clearTimeout(t); v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ } resolve(x); };
      t = setTimeout(() => fin(null), 12000);
      v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'auto'; v.playsInline = true;
      v.addEventListener('error', () => fin(null));
      v.addEventListener('loadedmetadata', () => { if (!(v.duration > 0) || !isFinite(v.duration)) return fin(null); v.currentTime = Math.min(thumbTime(v.duration), Math.max(0, v.duration - 0.05)); });
      v.addEventListener('seeked', () => {
        try {
          const { w, h } = thumbSize(v.videoWidth, v.videoHeight), c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h); fin(c.toDataURL('image/jpeg', 0.7));
        } catch (e) { fin(null); }
      });
      v.src = url;
    });
  }
  const refName = (S) => String((S.refRec && S.refRec.name) || '').replace(/\.[^.]+$/, '');
  function saveLook() {
    if (!F || !can()) return; const S = F, ft = ED.d.footage;
    if (!S.cube || ft.look.lut !== lookPath(S.id)) { toast('The matched grade is not ready, or a brand look is applied.'); return; }
    const applied = brandLooks().find((l) => l.id === ft.lookId), def = (refName(S) || (applied && applied.name) || 'Brand look').slice(0, 60);
    ctx.modal(`<div class="mh"><h2>Save as brand look</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb"><label class="label" for="ftLkName">Name</label><input class="inp" id="ftLkName" maxlength="60" value="${esc(def)}" autocomplete="off">
        <p class="xs-t muted" style="margin-top:8px">Saves the matched colours and the subtitle style. Strength, exposure, temperature and saturation are not saved.</p></div>
      <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ft-ok>Save</button></div>`,
      { onMount: (bg, close) => {
        const inp = bg.querySelector('#ftLkName'), go = () => { const name = inp.value.trim() || def; close(); doSaveLook(S, name); };
        bg.querySelector('[data-ft-ok]').addEventListener('click', go);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
        inp.focus(); inp.select();
      } });
  }
  async function doSaveLook(S, name) {
    try {
      const ft = ED.d.footage, prev = brandLooks().find((l) => l.id === ft.lookId);
      const thumb = async () => {
        if (!S.ref) return prev ? prev.refThumb : null;
        let url = S.refRec && S.refRec.proxyUrl;
        try { const r = await api('/footage/' + S.ref); if (r && r.proxyUrl) url = r.proxyUrl; } catch (e) { /* use the one we have */ }
        return url ? grabThumb(apiUrl(url)) : null;
      };
      const [saved, refThumb] = await Promise.all([api('/footage/looks', { method: 'POST', body: { footageId: S.id, name } }), thumb()]);
      const rec = lookRecord({ id: saved.id, name, lut: saved.lut, captionStyle: ED.d.footage.captions.style || DEFAULT_STYLE, refThumb });
      const b = brand(); b.looks = [...(Array.isArray(b.looks) ? b.looks : []), rec]; save();
      toast(`Saved “${rec.name}”`);
      if (alive(S)) ed.props();
    } catch (e) { toast((e && e.message) || 'Could not save the brand look'); }
  }
  async function applyLook(id) {
    if (!F || !can()) return; const S = F, look = brandLooks().find((l) => l.id === id); if (!look) return;
    let cube;
    try { cube = parseCube(await api(`/footage/looks/${encodeURIComponent(id)}`, { text: true })); } catch (e) { toast('This brand look is no longer available.'); return; }
    if (!alive(S)) return;
    S.cubes[look.lut] = cube; delete S.cubeBad[look.lut];
    const cur = ED.d.footage;
    if (look.captionStyle && maxWordsOf(look.captionStyle) !== maxWordsOf(cur.captions.style) && (cur.captions.lines || []).length) {
      ask('Apply this look?', `Its subtitles use ${maxWordsOf(look.captionStyle)} words per line. This replaces your line breaks.`, 'Apply', async () => {
        let words = [];
        try { words = await api(`/footage/${S.id}/words`); } catch (e) { toast((e && e.message) || 'Could not load the words'); return; }
        if (!alive(S)) return;
        const lines = Array.isArray(words) && words.length ? group(words, look.captionStyle) : null;
        mutate(() => { applyLookTo(ED.d.footage, look, lines); }); save(); toast(`Applied “${look.name}”`);
      });
      return;
    }
    mutate(() => { applyLookTo(ED.d.footage, look); }); save(); toast(`Applied “${look.name}”`);
  }
  function deleteLook(id) {
    if (!F || !can()) return; const S = F, look = brandLooks().find((l) => l.id === id); if (!look) return;
    ask('Delete this brand look?', `“${look.name}” is removed for everyone on this brand. Videos that use it lose its colour grade when reopened.`, 'Delete', async () => {
      try { await api(`/footage/looks/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) { if (!e || e.status !== 404) { toast((e && e.message) || 'Could not delete the brand look'); return; } }
      const b = brand(); b.looks = brandLooks().filter((l) => l.id !== id); save(); toast('Brand look deleted');
      if (alive(S)) ed.props();
    });
  }

  /** Tasks 11-13: after changing d.footage outside mutate(), make the player and panels follow */
  FT.sync = () => { sync(); redraw(); };
  /** The open footage session (player, records) or null */
  FT.session = () => F;
}
