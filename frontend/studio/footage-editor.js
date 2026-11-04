/* ============================================================
   Footage editor: a design with `d.footage` takes over the editor (as v37 does for `d.motion`).
   Center: the player (footage-player.js) at the output aspect ratio, letterboxed, with a Before/After split.
   Bottom: the transport (play, time, scrub, Before/After). Left: Subtitles. Right: Look.
   While the server transcribes and grades, the panels show skeletons; a failed step shows its error and Retry.
   installFootageEditor(ctx, FT) is called by installFootage. The pure helpers at the top are unit-tested.
   Section 1: pure helpers. 2: session (polling, results, player). 3: drawing. 4: actions and keys.
   ============================================================ */
import { apiUrl } from '../lib/api';
import { group, DEFAULT_STYLE } from './captions.js';
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
    F = { d, id: d.footage.src, ref: d.footage.ref, rec: null, refRec: null, cube: null, timer: 0, player: null, split: null, dur: 0, lastRefresh: 0, applied: false, err: null, note: null, gen: 0, sig: '' };
    ED.tab = 'ftSubs';
    loadFonts();
    ed.rail(); ed.panel(); // edAll draws the panels before the stage: show the footage panels right away
    poll();
  }
  function stop() {
    if (!F) return;
    clearTimeout(F.timer); F.gen++;
    if (F.player) F.player.destroy();
    F.ro && F.ro.disconnect();
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
    const needWords = !(ft.captions.lines || []).length && A.transcribe.state === 'done';
    const wantCube = A.grade.state === 'done' && (!ft.look.lut || ft.look.lut === lookPath(S.id));
    const [words, cubeText] = await Promise.all([
      needWords ? api(`/footage/${S.id}/words`).catch(() => []) : [],
      wantCube ? api(`/footage/${S.id}/look`, { text: true }).catch(() => null) : null,
    ]);
    if (!alive(S)) return;
    const cur = ED.d.footage; // an undo during the requests replaces the object
    if (cubeText) { try { S.cube = parseCube(cubeText); } catch (e) { S.cube = null; S.note = 'The colour grade file could not be read.'; } }
    const refStyle = S.refRec && S.refRec.captionStyle ? S.refRec.captionStyle : null;
    const patch = analysisPatch(cur, { id: S.id, words, refStyle, hasCube: !!S.cube });
    if (patch) { mutate(() => applyPatch(ED.d.footage, patch)); save(); }
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
      onReady: (dur) => { S.dur = dur; transport(S.player.time(), S.player.playing()); },
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
    hilite(ms);
  }
  /** The subtitle row being spoken */
  let lastRow = null;
  function hilite(ms) {
    const lines = ED.d && ED.d.footage ? ED.d.footage.captions.lines : [];
    const i = lines.findIndex((l) => ms >= l.start && ms < l.end), id = i >= 0 ? lines[i].id : null;
    if (id === lastRow) return; lastRow = id;
    document.querySelectorAll('#edPanel .ft-row.on').forEach((x) => x.classList.remove('on'));
    if (id) { const r = document.querySelector(`#edPanel .ft-row[data-id="${CSS.escape(id)}"]`); r && r.classList.add('on'); }
  }

  function pagesHTML() {
    const ms = F && F.player ? F.player.time() : 0, dur = F ? F.dur : 0, on = F && F.split != null, playing = !!(F && F.player && F.player.playing());
    return `<div class="ft-tp">
      <button class="mo-play" id="ftPlay" data-act="ftPlay" data-on="${playing}" aria-label="${playing ? 'Pause' : 'Play'} (Space)" title="Play / pause (Space, K)" ${F && F.player ? '' : 'disabled'}>${ic(playing ? 'pause37' : 'play37', 16)}</button>
      <span class="mo-time"><b id="ftT">${fmtMs(ms)}</b><span> / <span id="ftDur">${fmtMs(dur)}</span></span></span>
      <input type="range" class="ft-scrub" id="ftScrub" min="0" max="${Math.max(1, Math.round(dur))}" step="1" value="${Math.round(ms)}" aria-label="Playback position" ${F && F.player ? '' : 'disabled'}>
      <button class="btn ${on ? 'secondary on' : 'ghost'} sm ft-ba" data-act="ftSplit" aria-pressed="${on}" title="Compare with the original (drag the line)">${ic('ftCmp10', 15)}Before / After</button>
      <span class="ft-keys xs-t muted" title="J / L: 5 s back / forward · ← / →: one frame">J K L · ← →</span>
    </div>`;
  }

  function subsHTML() {
    const A = analysis(F.rec, F.refRec), ft = ED.d.footage, lines = ft.captions.lines || [];
    let body;
    if (lines.length) body = `<div class="ft-rows">${lines.map((l) => `<button class="ft-row" data-act="ftSeek" data-ms="${l.start}" data-id="${esc(l.id)}"><small>${fmtMs(l.start)}</small><span dir="auto">${esc(l.words.map((w) => w.t).join(' '))}</span></button>`).join('')}</div>`;
    else if (A.transcribe.state === 'failed') body = failBox(A.transcribe.error || 'The speech could not be transcribed.', F.id, 'transcribe');
    else if (A.busy(A.transcribe) || !F.rec) body = `<p class="xs-t muted">Listening to your video…${pct(A.transcribe)}</p>${skel(6)}`;
    else if (A.transcribe.state === 'skipped') body = '<p class="sm-t muted">This video has no sound, so there is nothing to subtitle.</p>';
    else body = '<p class="sm-t muted">No speech was found in this video.</p>';
    return `<h3>Subtitles</h3>${body}`;
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
      host.classList.add('ft10'); host.innerHTML = pagesHTML();
    },
  });
  /* leaving the editor (or opening another design) stops the video */
  addEventListener('hashchange', () => setTimeout(() => { if (F && !alive(F)) stop(); }));

  /* ---------- 4. actions and keys ---------- */
  const setSplit = (x) => { if (!F) return; F.split = x; F.player && F.player.setSplit(x); drawStage(); const b = $('[data-act=ftSplit]'); if (b) { b.setAttribute('aria-pressed', String(x != null)); b.className = `btn ${x != null ? 'secondary on' : 'ghost'} sm ft-ba`; } };
  Object.assign(ACT, {
    ftPlay: () => F && F.player && F.player.toggle(),
    ftSplit: () => setSplit(F && F.split == null ? 0.5 : null),
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
