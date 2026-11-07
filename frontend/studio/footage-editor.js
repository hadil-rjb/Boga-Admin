/* ============================================================
   Footage editor: a design with `d.footage` takes over the editor (as v37 does for `d.motion`).
   It is the Video Studio's `video` source (video-studio.js draws the rail, the transport, the timeline and routes the inspector).
   Stage: the player (footage-player.js) at the output aspect ratio, letterboxed, with a Before/After split (the transport's extra).
   Tracks: Video, Captions and Voice. Panels: the shared Captions panel (caption-panels.js), helped through `captions`
   (the panel's body while there are no lines, Re-transcribe, the caption inspector's live preview). Inspector: Look (the grade and
   brand looks; the caption style has its own tabs, caption-inspector.js). Dragging the caption on the frame moves it (style y).
   While the server transcribes and grades, the panels show skeletons; a failed step shows its error and Retry.
   installFootageEditor(ctx, FT) is called by installFootage. The pure helpers at the top are unit-tested.
   Section 1: pure helpers. 2: session (polling, results, player). 3: drawing. 4: actions and keys.
   ============================================================ */
import { apiUrl } from '../lib/api';
import { group, retime, DEFAULT_STYLE, FONTS_CSS } from './captions.js';
import { lineText, captionsOn, langFromLines, editStyle, fileBase } from './caption-panels.js';
import { dragCaption } from './caption-inspector.js';
import { parseCube } from './look.js';
import { capsOf, styleOf, migrateCaptions } from './caption-store.js';
import { createPlayer, fitBox, fmtMs } from './footage-player.js';
import { uploadFootage, isVideoFile, isAbort } from './upload.js';

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
/** True while some pipeline step of the record is queued or running */
const anyBusy = (rec) => !!rec && rec.status !== 'failed' && STEPS.some((s) => BUSY.includes(stepInfo(rec, s).state));
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
    // a step queued or running means more results are coming, whatever the status says (a step requested while `ready` was saved)
    settled: recDone && refDone && !anyBusy(rec) && !anyBusy(ref),
  };
}
/**
 * The server's results that the design still lacks: captions grouped from the words (only when there are no lines yet),
 * the reference's caption style (only when none is set) and the grade marker (only when no look is set). null when nothing changes.
 */
export function analysisPatch(caps, ft, { id, words, refStyle, refNote, hasCube }) {
  const out = {};
  // a style the user already owns (a preset, or any style) is never replaced
  if (caps.preset == null && caps.style == null && refStyle) { out.style = refStyle; out.styleFrom = refNote ? 'default' : 'reference'; }
  if (!(caps.lines || []).length && Array.isArray(words) && words.length) out.lines = group(words, out.style || caps.style || DEFAULT_STYLE);
  if (hasCube && !ft.look.lut) out.lut = lookPath(id);
  return Object.keys(out).length ? out : null;
}
export function applyPatch(caps, ft, p) {
  if (p.style) { caps.style = p.style; caps.preset = null; if (p.styleFrom) caps.styleFrom = p.styleFrom; }
  if (p.lines) { caps.lines = p.lines; caps.source = 'speech'; caps.voSig = null; if (!caps.lang) caps.lang = langFromLines(p.lines) || caps.lang || null; } // lines from the analysis are the speech's
  if (p.lut) ft.look.lut = p.lut;
  if ('lookId' in p) ft.lookId = p.lookId;
  return ft;
}
/** A brand look is applied while the footage has its own matched grade (grade done): the way back is offered */
export const canUseMatched = (ft, grade, id) => !!(ft && ft.look && ft.look.lut) && ft.look.lut !== lookPath(id) && !!grade && grade.state === 'done';
/** Back to the footage's own matched grade (for applyPatch), or null when it is already in use */
export function matchedGradePatch(ft, id) {
  if (!ft || !ft.look || ft.look.lut === lookPath(id)) return null;
  return { lut: lookPath(id), lookId: null };
}
/** "Use the matched grade" on the design (in place, inside mutate()): true when something changed */
export function useMatchedGrade(d, id) {
  const p = matchedGradePatch(d && d.footage, id); if (!p) return false;
  applyPatch(capsOf(d), d.footage, p);
  return true;
}
export const LOOK_DELETED = 'This brand look was deleted. Use the matched grade instead.';
/** Media → Replace video asks this first */
export const REPLACE_ASK = 'Replace this video? Captions will be made again from the new video.';
/** The Look when the grade step was skipped (a video imported without a reference or a brand look) */
export const NO_GRADE_YET = 'No colour grade yet. Match a reference or apply a brand look.';
/** "24 MB" / "1.2 GB" */
export const fmtBytes = (n) => { n = +n || 0; return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB'; };
/** Whether the footage record was paired with a reference video (Look offers "Change the reference" instead of "Match a reference") */
export const hasRefPair = (rec) => !!(rec && rec.pair && rec.pair.ref);
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

/* ---- waveform peaks (the timeline draws them in the Voice track) ---- */
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


/* the caption rows' helpers live in caption-panels.js (the shared Captions panel) */
export { textCommit, rangeLabel, lineText } from './caption-panels.js';

/* ---- Look panel: grade sliders and brand looks (the caption style edits are caption-inspector.js's setStyleField) ---- */
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
/** Words per line of a style (1..8; the default when unset) */
export const maxWordsOf = (style) => clampN2(Math.round(+(style && style.maxWords) || DEFAULT_STYLE.maxWords), 1, 8);
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
 * Applies a brand look to a footage doc (in place): its cube, its caption style (origin 'look') and, when `lines` are given
 * (regrouped by the caller because the look's words per line differ), the new lines. Returns whether the lines need regrouping.
 */
export function applyLookTo(caps, ft, look, lines) {
  const was = maxWordsOf(caps.style);
  ft.look.lut = look.lut; ft.lookId = look.id;
  if (look.captionStyle) { caps.style = JSON.parse(JSON.stringify(look.captionStyle)); caps.styleFrom = 'look'; caps.preset = null; }
  if (lines) caps.lines = lines;
  return !!look.captionStyle && maxWordsOf(look.captionStyle) !== was;
}

/* ---- Export ---- */
const even = (v) => Math.max(2, Math.round(v / 2) * 2);
/**
 * The export sizes for an output of w × h: the reference size, then the short side at 720 and at 2160 (same aspect, even
 * numbers, each side 240..3840, no duplicates). Labels like "1080 × 1920 (reference)".
 */
export function exportSizes(out) {
  const w = even(+(out && out.w) || 1080), h = even(+(out && out.h) || 1920), s = Math.min(w, h), seen = new Set(), list = [];
  for (const [k, ref] of [[1, true], [720 / s, false], [2160 / s, false]]) {
    const W = even(w * k), H = even(h * k), key = `${W}x${H}`;
    if (seen.has(key) || Math.min(W, H) < 240 || Math.max(W, H) > 3840) continue;
    seen.add(key); list.push({ w: W, h: H, label: `${W} × ${H}${ref ? ' (reference)' : ''}`, ref });
  }
  return list;
}
/** POST /footage/export body: the server reads nothing from the design store, so everything the MP4 needs travels here */
export function exportPayload(d, size) {
  const ft = d.footage, caps = capsOf(d), on = captionsOn(d), out = ft.out || {}, fps = [24, 25, 30, 60].includes(+out.fps) ? +out.fps : 30;
  return { designId: d.id, footage: { src: ft.src, look: ft.look, captions: { style: on ? styleOf(d) : null, lines: on ? caps.lines || [] : [] }, out: ft.out }, w: size.w, h: size.h, fps };
}
/** The download's file name: the design name, the size, .mp4 */
export const exportName = (d, size) => `${fileBase(d)}-${size.w}x${size.h}.mp4`;
/** Export is offered once the original is ready and the analysis has settled without a failure */
export const canExport = (rec, ref) => { const A = analysis(rec, ref); return !!rec && rec.status === 'ready' && A.settled && !A.failed; };

const PEAK_BUCKETS = 2000;
const GOOGLE_FONTS = FONTS_CSS;

/** Before the editor's first history snapshot: moves legacy footage captions onto the design. true when the design changed (save it) */
export function prepareOpen(d) { return migrateCaptions(d); }

export function installFootageEditor(ctx, FT) {
  const { ED, ACT, api, toast, ic, IC, esc, mutate, save, canEdit, ed, brand, VS } = ctx;
  Object.assign(IC, {
    ftCmp10: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/><path d="M7 9l-2 3 2 3M17 9l2 3-2 3"/>',
    ftVoice: '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
  });
  const $ = (s, r = document) => r.querySelector(s);
  const isFt = (d) => !!(d && d.footage);
  /** The open footage design's session */
  let F = null;

  /* ---------- 2. session ---------- */
  function start(d) {
    stop();
    if (VS.captionInspector) VS.captionInspector.stopRef(d); // a reference read for another design stops
    if (prepareOpen(d)) save();
    const old = $('#ftStage'); if (old) old.remove(); // a new video in the same design: the stage is made again (its size observer too)
    if (!d.footage.src && !FT.upload(d)) ED.tab = 'media'; // an empty video opens on Media (the stage shows the drop zone)
    F = { d, id: d.footage.src, ref: d.footage.ref, rec: null, refRec: null, cube: null, cubes: {}, cubeBad: {}, cubeGone: {}, timer: 0, player: null, split: null, dur: 0, lastRefresh: 0, applied: false, err: null, note: null, gen: 0, sig: '', peaks: null, ac: new AbortController(), retx: false, muted: false };
    loadFonts();
    ed.rail(); ed.panel(); // edAll draws the panels before the stage: show the footage panels right away
    poll();
  }
  function stop() {
    if (!F) return;
    clearTimeout(F.timer); F.gen++;
    VS.reset(); // the timeline goes before the player: a drag in progress is cancelled first
    if (F.player) F.player.destroy();
    F.ro && F.ro.disconnect(); F.ac.abort();
    F = null;
  }
  const alive = (S) => F === S && ED.d === S.d && document.body.classList.contains('in-editor');

  async function poll() {
    const S = F; if (!S) return; const gen = S.gen; clearTimeout(S.timer);
    if (!S.id) { redraw(); return; } // no video yet: nothing to poll until one is added
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
    const A = analysis(S.rec, S.refRec), ft = S.d.footage, caps = capsOf(S.d);
    const redo = S.retx && A.transcribe.state === 'done';
    const needWords = (redo || !(caps.lines || []).length) && A.transcribe.state === 'done';
    const wantCube = A.grade.state === 'done' && (!ft.look.lut || ft.look.lut === lookPath(S.id));
    const [words, cubeText] = await Promise.all([
      needWords ? api(`/footage/${S.id}/words`).catch(() => []) : [],
      wantCube ? api(`/footage/${S.id}/look`, { text: true }).catch(() => null) : null,
    ]);
    if (!alive(S)) return;
    const cur = ED.d.footage, curCaps = capsOf(ED.d); // an undo during the requests replaces the objects
    if (cubeText) { try { S.cube = parseCube(cubeText); } catch (e) { S.cube = null; S.note = 'The colour grade file could not be read.'; } }
    const refStyle = S.refRec && S.refRec.captionStyle ? S.refRec.captionStyle : null;
    const patch = analysisPatch(curCaps, cur, { id: S.id, words, refStyle, refNote: S.refRec && S.refRec.captionNote, hasCube: !!S.cube }) || {};
    if (redo) { // Re-transcribe: the new words replace the edited lines
      S.retx = false;
      patch.lines = group(Array.isArray(words) ? words : [], patch.style || curCaps.style || DEFAULT_STYLE);
      if (!patch.lines.length) toast('No speech was found in this video.');
    }
    if (Object.keys(patch).length) { mutate(() => applyPatch(capsOf(ED.d), ED.d.footage, patch)); save(); }
    sync();
  }

  /** The player follows the design (after results, undo, redo) */
  function sync() {
    if (!F || !F.player) return;
    const ft = ED.d.footage;
    ensureCube(F, ft.look.lut);
    F.player.setLook(ft.look); F.player.setCaptions(capsOf(ED.d)); F.player.setSplit(F.split);
  }
  /** A brand look's cube ('looks/<id>.cube') is fetched once; the player picks it up when it arrives (a failure is remembered, not retried) */
  function ensureCube(S, lut) {
    const m = /^looks\/([\w-]{1,64})\.cube$/.exec(lut || '');
    if (!m || S.cubes[lut] || S.cubeBad[lut] || S.cubeBusy === lut) return;
    S.cubeBusy = lut;
    api(`/footage/looks/${m[1]}`, { text: true }).then((t) => { S.cubes[lut] = parseCube(t); }).catch((e) => { S.cubeBad[lut] = true; if (e && e.status === 404) S.cubeGone[lut] = true; S.note = e && e.status === 404 ? LOOK_DELETED : 'This brand look’s colour grade could not be loaded.'; })
      .finally(() => { if (S.cubeBusy === lut) S.cubeBusy = null; if (alive(S)) { sync(); redraw(); } });
  }

  function mountPlayer() {
    const S = F, box = $('#ftBox'); if (!box || !S.rec || !S.rec.proxyUrl) return;
    const ft = S.d.footage;
    S.player = createPlayer(box, {
      proxyUrl: apiUrl(S.rec.proxyUrl), out: ft.out, look: ft.look, captions: capsOf(S.d),
      cube: (lut) => (lut === lookPath(S.id) ? S.cube : S.cubes[lut] || null),
      onTime: (ms, playing) => VS.tick(ms, playing),
      onReady: (dur) => { S.dur = dur; VS.tick(S.player.time(), S.player.playing()); lane(); loadPeaks(S); FT.ensurePoster && FT.ensurePoster(S.d, apiUrl(S.rec.proxyUrl)); },
      onError: (err) => refreshProxy(S, err),
    });
    S.player.setSplit(S.split);
    if (S.muted) S.player.video.muted = true;
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
    const up = FT.upload(ED.d);
    const sig = JSON.stringify([F.id, up && up.phase, up && up.err, F.refUp ? 1 : 0, F.err, F.note, F.rec && F.rec.status, F.rec && F.rec.jobs, F.refRec && F.refRec.status, F.refRec && F.refRec.jobs && F.refRec.jobs['caption-style'], A.settled, capsOf(ED.d).lines.length, !!F.cube]);
    if (sig === F.sig) return; F.sig = sig;
    drawStage(); ed.panel(); ed.props(); exportButton();
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
    if (!F.id) m = addHTML(true);
    else if (F.err && (!F.rec || !F.player || /played/.test(F.err))) m = `<p>${esc(F.err)}</p>`;
    else if (A.failed) m = failBox(A.error || 'This video could not be processed.', F.id, firstFailed(F.rec) || 'probe');
    else if (!F.player) m = `<div class="ft-wait">${skel(2)}<p>Preparing your video…${pct(A.proxy)}</p></div>`;
    msg.innerHTML = m; msg.hidden = !m; msg.classList.toggle('ft-empty', !F.id);
    const work = [[A.transcribe, 'Transcribing'], [A.grade, 'Matching the grade'], [A.style, 'Reading the caption style']].filter(([s]) => BUSY.includes(s.state)).map(([s, l]) => l + pct(s));
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

  /* ---------- the timeline (timeline.js): Video, Captions and Voice tracks ---------- */
  /** The design's poster frame as a CSS-safe URL (a data: image or an asset URL), or null */
  const posterUrl = (d) => { const p = d && d.pages && d.pages[0] && d.pages[0].poster; return typeof p === 'string' && /^(data:image\/|https?:\/\/|\/)/.test(p) && !/["\\\n\r]/.test(p) ? p : null; };
  function tlTracks() {
    if (!F || !ED.d || !isFt(ED.d)) return [];
    const caps = capsOf(ED.d), on = captionsOn(ED.d), name = (F.rec && F.rec.name) || 'Video', poster = posterUrl(ED.d);
    // the clip: the poster frame tiled along the track behind the file name (a dark overlay keeps the name readable)
    const clip = poster ? `<div class="vs-tl-clip has-poster" style="${esc(`background-image:linear-gradient(rgba(0,0,0,.5),rgba(0,0,0,.5)),url("${poster}")`)}"><span dir="auto">${esc(name)}</span></div>`
      : `<div class="vs-tl-clip"><span dir="auto">${esc(name)}</span></div>`;
    return [
      { id: 'video', icon: ic('vsFilm', 14), label: 'Video', html: () => clip },
      { id: 'captions', icon: ic('type', 14), label: 'Captions', hidden: !on, blocks: (caps.lines || []).map((l) => ({ id: l.id, start: l.start, end: l.end, text: lineText(l), on })) },
      { id: 'voice', icon: ic('ftVoice', 14), label: 'Voice', hidden: !!F.muted },
    ];
  }
  /** The timeline's callbacks (video-studio.js owns the timeline): retime a caption, show its row, hide captions or mute the preview */
  function onRetime(id, start, end, live) {
    const S = F; if (!S || !alive(S)) return;
    if (live && start == null) { sync(); return; } // a drag ended without a change: the preview shows the design again
    if (live) { const cap = capsOf(ED.d); S.player && S.player.setCaptions({ ...cap, lines: cap.lines.map((x) => (x.id === id ? retime(x, start, end) : x)) }); return; }
    VS.captions.edit((a) => a.map((x) => (x.id === id ? retime(x, start, end) : x)));
  }
  function onSelect(id) { VS.captions.reveal(id); }
  function onToggle(id) {
    const S = F; if (!S || !alive(S)) return;
    if (id === 'captions') VS.captions.toggle(); // one mutate(): preview and export
    else if (id === 'voice') { S.muted = !S.muted; if (S.player) S.player.video.muted = S.muted; lane(); } // preview only, the export keeps the sound
  }
  /** Redraws the timeline (after an edit, undo or redo) */
  const lane = () => VS.refresh();
  /** Decodes the proxy's audio once (lazily, after the player is ready) into 2000 fixed peak buckets; without it the Voice track has no waveform */
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
      VS.setPeaks(S.peaks);
    } catch (e) { /* no audio track, no decoder or the request stopped: the Voice track stays without a waveform */ } finally { actx && actx.close && actx.close().catch(() => {}); }
  }

  /* ---------- editing: every change is one mutate() (caption lines: the shared Captions panel) ---------- */
  const can = () => !canEdit || canEdit();
  /** A drag starts: the focused field commits first (its focusout handler), so the drag's own commit keeps the typed text */
  function commitFocus() { const a = document.activeElement; if (a && a !== document.body && typeof a.blur === 'function') a.blur(); }
  /** A small confirmation: onOk runs on the button, onNo on any other way out */
  function ask(title, text, okLabel, onOk, onNo) {
    let ok = false;
    ctx.modal(`<div class="mh"><h2>${esc(title)}</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb"><p class="sm-t">${esc(text)}</p></div>
      <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ft-ok>${esc(okLabel)}</button></div>`,
      { onClose: () => { if (!ok && onNo) onNo(); }, onMount: (bg, close) => { const b = bg.querySelector('[data-ft-ok]'); b.addEventListener('click', () => { ok = true; close(); onOk(); }); b.focus(); } });
  }
  function retranscribe() {
    if (!F || !can()) return; const S = F;
    ask('Re-transcribe?', 'This replaces your edited captions', 'Re-transcribe', async () => {
      try {
        await api(`/footage/${S.id}/retry`, { method: 'POST', body: { step: 'transcribe' } });
        if (!alive(S)) return;
        toast('Transcribing again'); S.retx = true; S.applied = false; S.err = null; S.sig = ''; S.gen++; poll();
      } catch (e) { toast((e && e.message) || 'Could not start the transcription'); }
    });
  }

  /** The transport's extra control: Before / After */
  function baHTML() {
    const on = !!F && F.split != null;
    return `<button class="ft-chip${on ? ' on' : ''} ft-ba" data-act="ftSplit" aria-pressed="${on}" title="Compare with the original (drag the line on the video)">${ic('ftCmp10', 16)}<span>Before / After</span></button>`;
  }

  /** The Captions panel's body while there are no lines: transcribing, failed, no sound or no speech */
  function noLinesHTML() {
    if (!F) return null;
    if (!F.id) return stepsHTML();
    const A = analysis(F.rec, F.refRec);
    if (A.transcribe.state === 'failed') return failBox(A.transcribe.error || 'The speech could not be transcribed.', F.id, 'transcribe') + altHTML();
    if (A.busy(A.transcribe) || !F.rec) return `<p class="xs-t muted">Listening to your video…${pct(A.transcribe)}</p>${skel(6)}`;
    if (A.transcribe.state === 'skipped') return '<p class="sm-t muted">This video has no sound, so there is nothing to caption.</p>' + altHTML();
    return '<p class="sm-t muted">No speech was found in this video.</p>' + altHTML();
  }
  /** Captions without speech to listen to: paste the script or open a subtitle file instead (both in the Script panel) */
  const altHTML = () => (can() ? `<div class="ft-alt"><button class="btn secondary sm" data-act="ftScript">${ic('type', 15)}Paste script</button><button class="btn secondary sm" data-act="ftSrt">${ic('upload', 15)}Open SRT or VTT</button></div>` : '');
  /** An empty video's Captions panel: 1. Add your video, 2. Add captions */
  function stepsHTML() {
    const up = FT.upload(ED.d), busy = !!(up && !up.err);
    return `<ol class="ft-steps"><li class="${busy ? '' : 'on'}"><b>Add your video</b><span class="xs-t muted">${busy ? esc(up.phase === 'uploading' ? 'Uploading your video…' : upText(up)) : 'MP4 or MOV, up to 10 min'}</span>${busy || !can() ? '' : `<button class="btn primary sm" data-act="ftPick">${ic('upload', 15)}Choose a file</button>`}</li>
      <li><b>Add captions</b><span class="xs-t muted">Auto from speech once your video is in, or paste a script, or open an SRT or VTT file.</span>${altHTML()}</li></ol>`;
  }

  /* ---------- the empty video: "Add your video" (stage and Media), the upload's progress ---------- */
  const upText = (up) => (up.phase === 'reading' ? 'Reading your video…' : up.phase === 'checking' ? 'Checking your video…' : `Uploading ${up.name}… ${Math.round(up.p * 100)}%`);
  const ACCEPT = 'video/mp4,video/quicktime,video/*,.mp4,.mov,.m4v';
  /** The drop zone (no video yet), or the upload's progress with Stop. `big`: the stage's version */
  function addHTML(big) {
    const up = FT.upload(ED.d), ro = !can();
    if (up && !up.err) {
      const p = Math.round(up.p * 100);
      return `<div class="ft-up${big ? ' big' : ''}" role="status" aria-live="polite"><b>${up.phase === 'uploading' ? 'Uploading your video' : esc(upText(up))}</b>
        <div class="prog-w"><div class="prog"><i data-ft-upbar style="width:${p}%"></i></div><span class="prog-pct" data-ft-uppct>${p}%</span></div>
        <small class="xs-t muted" dir="auto">${esc(up.name)}</small><button class="btn ghost sm" data-act="ftStopUp">Stop</button></div>`;
    }
    if (ro) return '<p class="sm-t muted">This video has no file yet.</p>';
    return `<label class="ft-add${big ? ' big' : ''}" data-ft-add tabindex="0"><input type="file" accept="${ACCEPT}" hidden data-ft-add-file>
      <span class="ft-di">${ic('upload', big ? 28 : 22)}</span><b>Add your video</b><span class="xs-t muted">MP4 or MOV, up to 10 min</span>
      <span class="btn secondary sm ft-choose">or choose a file</span>${up && up.err ? `<span class="ft-err" role="alert">${esc(up.err)}</span>` : ''}</label>`;
  }
  /** Media: the video's name, length, size and poster, and Replace video (an empty video: the drop zone) */
  function mediaHTML() {
    const d = ED.d, up = FT.upload(d);
    if (!F.id || (up && !up.err && !F.rec)) return `<div class="body ft-media"><h3>Media</h3>${addHTML(false)}</div>`;
    const rec = F.rec, poster = posterUrl(d), ms = F.dur || (rec && rec.meta && rec.meta.dur ? rec.meta.dur * 1000 : 0) || d.footage.dur || 0;
    const name = (rec && rec.name) || 'Video', busy = !!(up && !up.err);
    return `<div class="body ft-media"><h3>Media</h3>
      <div class="ft-mv">${poster ? `<img src="${esc(poster)}" alt="">` : `<span class="ft-mp">${ic('vsFilm', 22)}</span>`}
        <div class="ft-mi"><b dir="auto" title="${esc(name)}">${esc(name)}</b><span class="xs-t muted">${ms ? esc(fmtMs(ms)) : '–'}${rec && rec.size ? ' · ' + fmtBytes(rec.size) : ''}</span></div></div>
      ${busy ? addHTML(false) : can() ? `<button class="btn secondary sm" data-act="ftReplace">${ic('refresh', 15)}Replace video</button><input type="file" accept="${ACCEPT}" hidden data-ft-replace-file>` : ''}
      ${up && up.err ? `<p class="ft-err" role="alert">${esc(up.err)}</p>` : ''}</div>`;
  }
  /** Progress only: the bars move without redrawing the panels */
  function upProgress() {
    const up = FT.upload(ED.d); if (!up) return;
    const p = Math.round(up.p * 100);
    document.querySelectorAll('[data-ft-upbar]').forEach((i) => { i.style.width = p + '%'; });
    document.querySelectorAll('[data-ft-uppct]').forEach((x) => { x.textContent = p + '%'; });
  }
  FT.onUpload = (d) => { if (!F || !ED.d || ED.d.id !== d.id) return; const before = F.sig; redraw(); if (F && F.sig === before) upProgress(); };
  /** Commits the new video (footage.js FT.attach): one mutate() when the design is open, then the session starts again on it */
  FT.commit = (d, fn) => {
    if (ED.d && ED.d.id === d.id && document.body.classList.contains('in-editor')) { mutate(() => fn(ED.d)); save(); }
    else { fn(d); save(); }
  };
  function addFile(file, replace) {
    if (!F || !ED.d || !file) return;
    FT.attach(ED.d, file, { replace }).then((ok) => { if (!ok) return; toast(replace ? 'Video replaced. Making the captions again…' : 'Video added. Making the captions…'); });
  }
  /** Re-transcribe, next to Add line */
  const retxHTML = () => { const A = F && analysis(F.rec, F.refRec), off = !F || !F.rec || A.busy(A.transcribe); return `<button class="btn ghost sm" data-act="ftRetx" ${off ? 'disabled' : ''}>${ic('refresh', 15)}Re-transcribe</button>`; };

  /* ---------- Look panel ---------- */
  const rgHTML = (attr, key, label, min, max, step, val, dis) => `<label class="ft-rg"><span>${label}</span><input type="range" ${attr}="${key}" min="${min}" max="${max}" step="${step}" value="${val}" style="--p:${((val - min) / (max - min)) * 100}%" ${dis}><output>${val}</output></label>`;
  const brandLooks = () => (Array.isArray(brand().looks) ? brand().looks : []).filter((l) => l && l.id);

  function gradeHTML(ft, A, src, dis) {
    if (!F.id) return '<p class="sm-t muted">Add your video to adjust its colours.</p>';
    if (A.grade.state === 'failed') return failBox(A.grade.error || 'The colour grade could not be matched.', F.id, 'grade');
    if (A.busy(A.grade) || !F.rec) return `<p class="xs-t muted">Matching the colours of ${src}…${pct(A.grade)}</p>${skel(3)}`;
    const own = ft.look.lut === lookPath(F.id), applied = brandLooks().find((l) => l.lut === ft.look.lut), gone = !own && !!F.cubeGone[ft.look.lut];
    const msg = own && F.cube ? `The colours match ${src}. Use <b>Before / After</b> under the video to compare.`
      : gone ? esc(LOOK_DELETED)
      : !own && ft.look.lut ? `Using the brand look ${applied ? `“${esc(applied.name)}”` : ''}.` : esc(!ft.look.lut && A.grade.state === 'skipped' ? NO_GRADE_YET : F.note || 'No colour grade yet.');
    const L = ft.look, g = (k) => gradeToSlider(k, L[k]);
    // a brand look is applied (or was, and is gone): the footage's own matched grade is one click away
    const back = !dis && canUseMatched(ft, A.grade, F.id) ? `<button class="btn ${gone ? 'primary' : 'secondary'} sm ft-matched" data-act="ftUseMatched">${ic('refresh', 14)}Use the matched grade</button>` : '';
    return `${gone ? `<div class="note warn" role="alert">${ic('alert', 15)}<span>${msg}</span></div>${back}` : `<p class="sm-t ${own && F.cube || ft.look.lut ? '' : 'muted'}">${msg}</p>${back}`}
      ${rgHTML('data-ft-g', 'strength', 'Strength', 0, 100, 1, g('strength'), dis)}${rgHTML('data-ft-g', 'exposure', 'Exposure', -100, 100, 1, g('exposure'), dis)}
      ${rgHTML('data-ft-g', 'temp', 'Temperature', -100, 100, 1, g('temp'), dis)}${rgHTML('data-ft-g', 'sat', 'Saturation', -100, 100, 1, g('sat'), dis)}
      ${dis ? '' : `<button class="btn ghost sm ft-reset" data-act="ftGradeReset">${ic('refresh', 14)}Reset grade</button>`}`;
  }

  function looksHTML(ft, dis) {
    const list = brandLooks(), own = ft.look.lut === lookPath(F.id);
    const canSave = !dis && F.cube && own;
    const save = dis ? '' : `<button class="btn secondary sm" data-act="ftSaveLook" ${canSave ? '' : 'disabled'} ${!canSave && F.cube && !own ? 'title="Undo the applied look to save the matched grade"' : ''}>${ic('plus', 15)}Save as brand look</button>`;
    const rows = list.length ? `<ul class="ft-lks">${list.map((l) => `<li class="ft-lkr${l.lut === ft.look.lut ? ' on' : ''}">${l.refThumb && /^data:image\//.test(l.refThumb) ? `<img src="${esc(l.refThumb)}" alt="" width="40" height="40">` : '<span class="ft-th"></span>'}
      <span class="ft-ln" title="${esc(l.name || l.id)}">${esc(l.name || l.id)}</span>
      ${dis ? '' : `<button class="btn secondary sm" data-act="ftApplyLook" data-id="${esc(l.id)}" ${l.lut === ft.look.lut ? 'disabled' : ''}>${l.lut === ft.look.lut ? 'In use' : 'Apply'}</button>
      <button class="btn ghost icon sm" data-act="ftDelLook" data-id="${esc(l.id)}" aria-label="Delete ${esc(l.name || l.id)}" title="Delete">${ic('trash', 15)}</button>`}</li>`).join('')}</ul>`
      : '<p class="xs-t muted">No brand looks yet. Save this grade and caption style to reuse them on other videos.</p>';
    return `${save}${rows}`;
  }

  /** The Look side panel (rail): the grade in one sentence, Match a reference, brand looks. The sliders stay in the inspector. */
  function lookPanelHTML() {
    const A = analysis(F.rec, F.refRec), ft = ED.d.footage, src = F.ref ? 'the reference video' : 'your brand look', dis = !can();
    let grade;
    if (!F.id) grade = '<p class="sm-t muted">Add your video first.</p>';
    else if (A.grade.state === 'failed') grade = failBox(A.grade.error || 'The colour grade could not be matched.', F.id, 'grade');
    else if (A.busy(A.grade) || !F.rec) grade = `<p class="xs-t muted">Matching the colours of ${src}…${pct(A.grade)}</p>${skel(2)}`;
    else {
      const own = ft.look.lut === lookPath(F.id), applied = brandLooks().find((l) => l.lut === ft.look.lut);
      grade = `<p class="sm-t${ft.look.lut ? '' : ' muted'}">${own && F.cube ? `The colours match ${src}.` : !own && ft.look.lut ? `Using the brand look ${applied ? `“${esc(applied.name)}”` : ''}.` : esc(!ft.look.lut && A.grade.state === 'skipped' ? NO_GRADE_YET : 'No colour grade yet.')}</p>
        <p class="xs-t muted">Strength, exposure, temperature and saturation are in the panel on the right.</p>`;
    }
    const paired = hasRefPair(F.rec) || !!F.ref, R = F.refUp;
    const ref = R ? `<div class="ft-up" role="status"><b>Uploading the reference</b><div class="prog-w"><div class="prog"><i data-ft-refbar style="width:${Math.round(R.p * 100)}%"></i></div><span class="prog-pct" data-ft-refpct>${Math.round(R.p * 100)}%</span></div></div>`
      : dis ? '' : `<p class="xs-t muted">${paired ? 'The colours and caption style come from your reference video.' : 'Drop an edited video to copy its colours and caption style.'}</p>
        <button class="btn ${paired ? 'secondary' : 'primary'} sm" data-act="ftMatchRef" ${F.id && F.rec && !A.failed ? '' : 'disabled'}>${ic('upload', 15)}${paired ? 'Change the reference' : 'Match a reference'}</button>
        <input type="file" accept="${ACCEPT}" hidden data-ft-ref-file>`;
    return `<div class="body ft-look-p"><h3>Look</h3>
      <section class="ft-sec"><span class="label">Colour grade</span>${grade}</section>
      <section class="ft-sec"><span class="label">Reference</span>${ref}</section>
      <section class="ft-sec"><span class="label">Brand looks</span>${looksHTML(ft, dis)}</section></div>`;
  }
  /** Look → Match a reference: uploads the reference, pairs it (the server matches the grade again and reads its caption style) */
  async function matchRef(file) {
    const S = F; if (!S || !S.id || !can() || S.refUp || !file) return;
    if (!isVideoFile(file)) { toast('Choose a video file (MP4 or MOV)'); return; }
    S.refUp = { p: 0, ac: new AbortController() }; S.sig = ''; redraw();
    const bar = () => { const p = Math.round(S.refUp.p * 100); document.querySelectorAll('[data-ft-refbar]').forEach((i) => { i.style.width = p + '%'; }); document.querySelectorAll('[data-ft-refpct]').forEach((x) => { x.textContent = p + '%'; }); };
    try {
      const ref = await uploadFootage(file, { role: 'reference', brand: brand().id, api, signal: S.refUp.ac.signal, onProgress: (v) => { if (S.refUp) { S.refUp.p = v; bar(); } } });
      const lang = S.rec && S.rec.pair && S.rec.pair.lang;
      await api(`/footage/${S.id}/pair`, { method: 'POST', body: { ref: ref.id, ...(lang ? { lang } : {}) } });
      S.refUp = null;
      // the new reference's grade replaces the one in use (a brand look too: matching a reference is asking for its colours)
      const set = (dd) => { const f = dd.footage; f.ref = ref.id; f.lookId = null; f.look.lut = null; };
      if (!alive(S)) { set(S.d); save(); return; }
      mutate(() => set(ED.d)); save();
      S.ref = ref.id; S.refRec = null; S.cube = null; S.note = null; S.applied = false; S.err = null; S.sig = ''; S.gen++;
      toast('Matching the reference…'); poll();
    } catch (e) {
      S.refUp = null; if (alive(S)) { S.sig = ''; redraw(); }
      if (!isAbort(e)) toast((e && e.message) || 'The reference could not be uploaded. Try again.');
    }
  }

  function lookHTML() {
    const A = analysis(F.rec, F.refRec), ft = ED.d.footage, src = F.ref ? 'the reference video' : 'your brand look', dis = can() ? '' : 'disabled';
    return `<div class="body ft-look-p"><h3>Look</h3>
      <section class="ft-sec"><span class="label">Colour grade</span>${gradeHTML(ft, A, src, dis)}</section>
      <section class="ft-sec"><span class="label">Brand looks</span>${looksHTML(ft, !can())}</section></div>`;
  }

  /** The player as the shell drives it (transport, keys, timeline): a no-op until the video can play */
  const player = {
    ready: () => !!(F && F.player),
    toggle: () => F && F.player && F.player.toggle(),
    play: () => F && F.player && F.player.play(),
    pause: () => F && F.player && F.player.pause(),
    seek: (ms) => F && F.player && F.player.seek(ms),
    time: () => (F && F.player ? F.player.time() : 0),
    duration: () => (F ? F.dur || (F.player && F.player.duration()) || 0 : 0),
    playing: () => !!(F && F.player && F.player.playing()),
    frameMs: () => (F && F.player ? F.player.frameMs() : 1000 / 30),
  };
  VS.register('video', {
    mount() {
      if (!F || F.d !== ED.d || F.id !== (ED.d.footage.src || null) || (F.player && !document.body.contains(F.player.video))) start(ED.d);
      drawStage(); sync(); exportButton();
    },
    unmount() {
      if (F) stop(); if (VS.captionInspector) VS.captionInspector.stopRef(); const st = $('#ftStage'); st && st.remove();
      $('.ed-stage') && $('.ed-stage').classList.remove('ft10'); $('.ed') && $('.ed').classList.remove('ft10'); exportButton();
    },
    player,
    tracks: tlTracks,
    panel: (k) => (!F || F.d !== ED.d ? null : k === 'media' ? mediaHTML() : k === 'look' ? lookPanelHTML() : null),
    captions: {
      body: noLinesHTML, foot: retxHTML, light: () => sync(),
      /** the caption inspector's live preview: the player draws `style` until null puts the design's back */
      preview: (style) => { if (!F || !F.player) return; if (style) F.player.setCaptions({ ...capsOf(ED.d), style }); else sync(); },
    },
    inspector: () => (F ? lookHTML() : null),
    transportExtra: baHTML,
    canEdit: () => can(),
    onRetime, onSelect, onToggle,
  });
  /* leaving the editor (or opening another design) stops the video */
  addEventListener('hashchange', () => setTimeout(() => { if (F && !alive(F)) stop(); }));

  /* ---------- 4. actions and keys ---------- */
  const setSplit = (x) => { if (!F) return; F.split = x; F.player && F.player.setSplit(x); drawStage(); const b = $('[data-act=ftSplit]'); if (b) { b.setAttribute('aria-pressed', String(x != null)); b.classList.toggle('on', x != null); } };
  Object.assign(ACT, {
    ftSplit: () => setSplit(F && F.split == null ? 0.5 : null),
    ftRetx: () => retranscribe(),
    ftGradeReset: () => gradeReset(),
    ftSaveLook: () => saveLook(),
    ftApplyLook: (a) => applyLook(a.dataset.id),
    ftUseMatched: () => useMatched(),
    ftPick: () => { const i = $('[data-ft-add-file]'); if (i) i.click(); else ACT.edTab({ dataset: { k: 'media' } }); },
    ftStopUp: () => { if (ED.d) { FT.stopUpload(ED.d); toast('Upload stopped. Drop the same file again to pick up where it stopped.'); } },
    ftReplace: () => {
      if (!F || !can() || FT.upload(ED.d) && !FT.upload(ED.d).err) return;
      // the file picker opens from the confirm button's click (a user gesture)
      ask('Replace video', REPLACE_ASK, 'Replace', () => { const i = $('#edPanel [data-ft-replace-file]'); if (i) i.click(); });
    },
    ftMatchRef: () => { const i = $('#edPanel [data-ft-ref-file]'); if (i) i.click(); },
    ftScript: () => { ACT.edTab({ dataset: { k: 'script' } }); const t = $('#edPanel [data-sc-text]'); if (t) t.focus(); },
    ftSrt: () => { ACT.edTab({ dataset: { k: 'script' } }); const f = $('#edPanel [data-sc-file]'); if (f) f.click(); },
    ftDelLook: (a) => deleteLook(a.dataset.id),
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
  /* the split line: drag anywhere on the frame while Before / After is on */
  document.addEventListener('pointerdown', (e) => {
    if (!F || F.split == null || e.button !== 0) return; const fr = $('#ftFrame'); if (!fr || !fr.contains(e.target)) return;
    e.preventDefault(); const r = fr.getBoundingClientRect(), at = (ev) => setSplit(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)));
    at(e); const up = () => { removeEventListener('pointermove', at); removeEventListener('pointerup', up); };
    addEventListener('pointermove', at); addEventListener('pointerup', up);
  });
  /* ---- Look panel (grade): live preview on `input`, one mutate() on `change` (release) ---- */
  const setOut = (el) => {
    const o = el.closest('.ft-rg') && el.closest('.ft-rg').querySelector('output'); if (o) o.textContent = el.value;
    if (el.type === 'range') el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
  };
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
  /* ---- the empty video's drop zone (stage and Media), Replace video and Match a reference: delegated, installed once ---- */
  document.addEventListener('change', (e) => {
    const t = e.target; if (!t || !t.matches) return;
    const f = t.files && t.files[0];
    if (t.matches('[data-ft-add-file]')) { t.value = ''; addFile(f, false); }
    else if (t.matches('[data-ft-replace-file]')) { t.value = ''; addFile(f, true); }
    else if (t.matches('[data-ft-ref-file]')) { t.value = ''; matchRef(f); }
  });
  /** The drop zone under the pointer (anywhere on the stage while the video is empty) */
  const zoneOf = (e) => {
    if (!F || !e.target || !e.target.closest) return null;
    return e.target.closest('[data-ft-add]') || (!F.id && e.target.closest('#ftStage') ? $('#ftStage [data-ft-add]') : null);
  };
  // capture phase: ahead of the editor's own "drop an image on the canvas"
  document.addEventListener('dragover', (e) => { const z = zoneOf(e); if (z) { e.preventDefault(); e.stopImmediatePropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; z.classList.add('over'); } }, true);
  document.addEventListener('dragleave', (e) => { const z = zoneOf(e); if (z && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#ftStage, [data-ft-add]'))) z.classList.remove('over'); }, true);
  document.addEventListener('drop', (e) => { const z = zoneOf(e); if (!z) return; e.preventDefault(); e.stopImmediatePropagation(); z.classList.remove('over'); addFile(e.dataTransfer && e.dataTransfer.files[0], false); }, true);
  document.addEventListener('keydown', (e) => { const z = zoneOf(e); if (z && e.target === z && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); const i = z.querySelector('input'); if (i) i.click(); } });
  document.addEventListener('input', (e) => { const t = e.target; if (t && t.matches && t.matches('[data-ft-g]')) gradePreview(t); });
  document.addEventListener('change', (e) => { const t = e.target; if (t && t.matches && t.matches('[data-ft-g]')) gradeCommit(t); });

  /* dragging the caption on the video sets its height (y): preview through the player, one mutate() on release */
  function captionDrag(e) {
    if (!F || !F.player || F.split != null || !can() || e.button > 0 || F.cdrag) return;
    const fr = $('#ftFrame'), ov = fr && fr.querySelector('.ftp-o'); if (!fr || !ov || !fr.contains(e.target) || !ov.width) return;
    commitFocus(); // a caption being typed is committed before the line under the playhead is read
    if (!F || !F.player) return;
    const S = F, caps = capsOf(ED.d);
    S.cdrag = dragCaption(e, {
      frame: fr, canvas: ov, lines: caps.lines || [], style: caps.style || DEFAULT_STYLE, ms: S.player.time(),
      onMove: (style) => { if (S.player) S.player.setCaptions({ ...capsOf(ED.d), style }); },
      onEnd: (y) => {
        S.cdrag = false; if (!alive(S)) return;
        if (y != null) { mutate(() => editStyle(ED.d, { y }), () => { sync(); ed.props(); }); save(); } else { sync(); ed.props(); }
      },
    });
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
        <p class="xs-t muted" style="margin-top:8px">Saves the matched colours and the caption style. Strength, exposure, temperature and saturation are not saved.</p></div>
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
      const rec = lookRecord({ id: saved.id, name, lut: saved.lut, captionStyle: capsOf(ED.d).style || DEFAULT_STYLE, refThumb });
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
    if (look.captionStyle && maxWordsOf(look.captionStyle) !== maxWordsOf(capsOf(ED.d).style) && (capsOf(ED.d).lines || []).length) {
      ask('Apply this look?', `Its captions use ${maxWordsOf(look.captionStyle)} words per line. This replaces your line breaks.`, 'Apply', async () => {
        let words = [];
        try { words = await api(`/footage/${S.id}/words`); } catch (e) { toast((e && e.message) || 'Could not load the words'); return; }
        if (!alive(S)) return;
        const lines = Array.isArray(words) && words.length ? group(words, look.captionStyle) : null;
        mutate(() => { applyLookTo(capsOf(ED.d), ED.d.footage, look, lines); }); save(); toast(`Applied “${look.name}”`);
      });
      return;
    }
    mutate(() => { applyLookTo(capsOf(ED.d), ED.d.footage, look); }); save(); toast(`Applied “${look.name}”`);
  }
  /** Back from a brand look to the footage's own matched grade: loads its cube, then one undoable step */
  async function useMatched() {
    if (!F || !can()) return; const S = F;
    if (!S.cube) {
      let text;
      try { text = await api(`/footage/${S.id}/look`, { text: true }); } catch (e) { toast((e && e.message) || 'Could not load the matched grade'); return; }
      if (!alive(S)) return;
      try { S.cube = parseCube(text); } catch (e) { toast('The colour grade file could not be read.'); return; }
    }
    const p = matchedGradePatch(ED.d.footage, S.id); if (!p) return;
    S.note = null;
    mutate(() => { useMatchedGrade(ED.d, S.id); }, () => { sync(); S.sig = ''; redraw(); }); save();
    toast('Using the matched grade');
  }
  function deleteLook(id) {
    if (!F || !can()) return; const S = F, look = brandLooks().find((l) => l.id === id); if (!look) return;
    ask('Delete this brand look?', `“${look.name}” is removed for everyone on this brand. Videos that use it lose its colour grade when reopened.`, 'Delete', async () => {
      try { await api(`/footage/looks/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) { if (!e || e.status !== 404) { toast((e && e.message) || 'Could not delete the brand look'); return; } }
      const b = brand(); b.looks = brandLooks().filter((l) => l.id !== id); save(); toast('Brand look deleted');
      if (alive(S)) ed.props();
    });
  }

  /* ---- export: the server encodes the MP4 (export.service.ts); the modal polls it once a second ---- */
  function exportModal() {
    if (!F || !isFt(ED.d)) return;
    if (!canExport(F.rec, F.refRec)) { toast('Your video is still being prepared.'); return; }
    const d = ED.d, sizes = exportSizes(d.footage.out), dur = F.dur || (F.rec && F.rec.meta ? F.rec.meta.dur * 1000 : 0);
    const st = { timer: 0, gone: false, busy: false, url: null, size: sizes[0] };
    ctx.modal(`<div class="mh"><h2>Export video</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb ft-ex"><p class="xs-t muted">MP4 · ${esc(fmtMs(dur))} · with the colour grade and captions</p>
        <div class="ft-szs" role="radiogroup" aria-label="Size">${sizes.map((s, i) => `<label class="ft-sz"><input type="radio" name="ftSz" value="${i}" ${i ? '' : 'checked'}><span>${esc(s.label)}</span></label>`).join('')}</div>
        <div class="prog-w" data-ft-ep hidden><div class="prog"><i style="width:0%"></i></div><span class="prog-pct">0%</span></div>
        <p class="xs-t muted" data-ft-em role="status" aria-live="polite"></p></div>
      <div class="mf" data-ft-ef><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ft-go>${ic('download', 16)}Export</button></div>`, {
      onClose: () => { st.gone = true; clearTimeout(st.timer); },
      onMount: (bg, close) => {
        const $b = (s) => bg.querySelector(s), msg = (t) => { $b('[data-ft-em]').textContent = t; };
        const bar = (p) => { const w = $b('[data-ft-ep]'); w.hidden = false; const n = Math.round(Math.max(0, Math.min(1, p)) * 100); w.querySelector('i').style.width = n + '%'; w.querySelector('.prog-pct').textContent = n + '%'; };
        const lock = (on) => { st.busy = on; bg.querySelectorAll('input[name=ftSz]').forEach((x) => (x.disabled = on)); const g = $b('[data-ft-go]'); if (g) g.disabled = on; };
        const done = (url) => {
          st.url = url; bar(1); msg('Your video is ready.');
          const name = exportName(d, st.size), href = apiUrl(url) + '&dl=' + encodeURIComponent(name);
          // no Schedule here: the publisher posts images only, a video would go out as a black still (see footage.js blockSchedule)
          $b('[data-ft-ef]').innerHTML = `<button class="btn ghost" data-close>Close</button><a class="btn primary" href="${esc(href)}" download="${esc(name)}">${ic('download', 16)}Download</a>`;
        };
        const fail = (e) => { lock(false); msg((e && e.message) || 'The export failed. Try again.'); const g = $b('[data-ft-go]'); if (g) g.innerHTML = `${ic('refresh', 16)}Try again`; };
        async function poll() {
          if (st.gone) return;
          try {
            const r = await api(`/footage/export/${st.jobId}`);
            if (st.gone) return;
            if (r.state === 'done' && r.url) return done(r.url);
            if (r.state === 'failed') return fail({ message: r.error || 'The export failed. Try again.' });
            bar(r.progress || 0); msg(r.state === 'queued' ? 'Waiting for another export to finish…' : (r.progress || 0) < 0.3 ? 'Drawing the captions…' : 'Encoding the video…');
          } catch (e) { if (st.gone) return; if (e && e.status === 404) return fail({ message: 'This export was lost. Try again.' }); msg('Could not reach the server. Retrying…'); }
          st.timer = setTimeout(poll, 1000);
        }
        $b('[data-ft-go]').addEventListener('click', async () => {
          if (st.busy) return;
          const i = +((bg.querySelector('input[name=ftSz]:checked') || {}).value || 0); st.size = sizes[i] || sizes[0];
          lock(true); bar(0); msg('Starting…');
          try {
            const r = await api('/footage/export', { method: 'POST', body: exportPayload(ED.d === d ? ED.d : d, st.size) });
            if (st.gone) return;
            st.jobId = r.jobId; poll();
          } catch (e) { if (!st.gone) fail(e); }
        });
        $b('[data-ft-go]').focus();
      },
    });
  }
  /** Export opens the footage export while a footage design is open; it stays disabled until the analysis is ready */
  const origExport = ACT.edExport;
  ACT.edExport = function (a) { if (isFt(ED.d)) return exportModal(); return origExport && origExport.apply(this, arguments); };
  function exportButton() {
    const b = document.querySelector('.ed-top [data-act=edExport]'); if (!b) return;
    const on = !isFt(ED.d) || (!!F && canExport(F.rec, F.refRec));
    b.disabled = !on; b.title = on ? '' : 'Available once your video is ready';
  }

  /** Tasks 11-13: after changing d.footage outside mutate(), make the player and panels follow */
  FT.sync = () => { sync(); redraw(); };
  /** The open footage session (player, records) or null */
  FT.session = () => F;
}
