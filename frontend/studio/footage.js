/* ============================================================
   Footage style match: copy a reference video's look and subtitles onto a raw clip.
   installFootage(ctx) is called once from the engine and registers the footage actions.
   Sections: 1. helpers, 2. upload modal and design creation, 3. actions and the FT object.
   The footage editor (player, panels, transport) lives in footage-editor.js. No DOM use at module level.
   ============================================================ */
import { uploadFootage, isVideoFile, isAbort } from './upload.js';
import { installFootageEditor } from './footage-editor.js';
import { CAPTIONS_DEFAULT } from './caption-store.js';
import { apiUrl } from '../lib/api';

/* ---------- 1. helpers ---------- */
const DEFAULT_SIZE = { w: 1080, h: 1920 };
/** Card thumbnail frame: 20% into the video, 3 s at most (skips a black first frame) */
export const posterTime = (dur) => Math.max(0, Math.min(3, (+dur || 0) * 0.2));
/** "2:43" */
export const fmtDur = (ms) => { const s = Math.max(0, Math.round((+ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/**
 * A video's poster frame as a JPEG data URL (`width` px wide) and its length in ms, or null when the browser
 * cannot decode it in time. Used for the design cards; persist.ts uploads the data URL as an asset on sync.
 */
export function grabPoster(url, { width = 360, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const v = document.createElement('video'); let done = false;
    const fin = (x) => { if (done) return; done = true; clearTimeout(t); v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ } resolve(x); };
    const t = setTimeout(() => fin(null), timeout);
    if (!/^(blob|data):/.test(url)) v.crossOrigin = 'anonymous';
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.addEventListener('error', () => fin(null));
    v.addEventListener('loadedmetadata', () => { if (!(v.duration > 0) || !isFinite(v.duration)) return fin(null); v.currentTime = posterTime(v.duration); });
    v.addEventListener('seeked', () => {
      try {
        const vw = v.videoWidth, vh = v.videoHeight; if (!vw || !vh) return fin(null);
        const w = Math.min(width, vw), h = Math.max(1, Math.round((w * vh) / vw)), c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        fin({ src: c.toDataURL('image/jpeg', 0.78), dur: Math.round(v.duration * 1000) });
      } catch (e) { fin(null); } // a cross-origin frame without CORS taints the canvas
    });
    v.src = url;
  });
}
const fileLabel = (f) => `${f.name} · ${f.size >= 1e9 ? (f.size / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(f.size / 1e6)) + ' MB'}`;
const baseName = (n) => String(n || 'Video').replace(/\.[^.]+$/, '');
/** Output canvas: the reference's display size when probed (even numbers, 4 digits at most), else a vertical video */
export function outSize(probe) {
  const w = Math.round(+(probe && probe.w) / 2) * 2, h = Math.round(+(probe && probe.h) / 2) * 2;
  return w >= 2 && h >= 2 && w <= 9999 && h <= 9999 ? { w, h } : { ...DEFAULT_SIZE };
}
/** The reference's probe (`meta` on the record) lands a moment after /complete (a queued job): poll once a second, up to 20 s. Resolves null on timeout, failure or abort. */
export async function readProbe(api, id, { signal, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 20 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (signal && signal.aborted) return null;
    try {
      const rec = await api('/footage/' + id, { signal });
      if (rec && rec.meta && rec.meta.w) return rec.meta; // the record exposes the probe result as `meta`
      if (rec && rec.status === 'failed') return null;
    } catch (e) { if (isAbort(e)) return null; }
    await sleep(1000);
  }
  return null;
}
/** Scheduling posts images only: a footage design (a video) would go out as its black background page */
export const SCHEDULE_VIDEO = "Scheduling videos isn't available yet. Download the video and post it from your phone.";
export const isFootageDesign = (d) => !!(d && d.footage);
/** Every Schedule entry point calls this first: true (after the toast) when the design is a video and must not be scheduled */
export function blockSchedule(d, toast) {
  if (!isFootageDesign(d)) return false;
  if (toast) toast(SCHEDULE_VIDEO);
  return true;
}
export const READY_IN_STUDIO = 'Your video is ready in Studio.';
export const UPLOAD_STOPPED = 'Upload stopped. Drop the same files again to pick up where you left off.';
/**
 * What closing the upload modal does. 'stop': uploads are still running, abort them (they resume when the same files are dropped).
 * 'finish': both uploads are complete, so the design is still created (without opening it). 'none': nothing was started.
 */
/** The upload modal's Start needs only the original: the reference and the brand look are optional */
export const canStart = (st) => !st.busy && !!st.original;
export const closeAction = ({ busy, uploaded }) => (!busy ? 'none' : uploaded ? 'finish' : 'stop');
/** The footage part of a new design (its captions live on `d.captions`, see footageCaptions) */
export function footageDoc({ src, ref = null, lookId = null, size }) {
  const { w, h } = size || DEFAULT_SIZE;
  return { src, ref, lookId, look: { lut: null, strength: 1, exposure: 0, temp: 0, sat: 0 }, out: { w, h, fps: 30 }, export: null };
}
/** The captions of a new footage design: a design made from a brand look starts with that look's caption style */
export function footageCaptions({ lang = null, style = null } = {}) {
  const c = { ...CAPTIONS_DEFAULT, lines: [], style: style ? JSON.parse(JSON.stringify(style)) : null, lang };
  if (style) c.styleFrom = 'look';
  return c;
}

export function installFootage(ctx) {
  const { ACT, api, modal, toast, ic, esc, save, uid, brand, canEdit, createDesign, ensureRatio, BG, RATIOS } = ctx;
  const FT = { ctx };
  /** A standard ratio with the same size ('9:16' for 1080×1920) instead of a custom one */
  const ratioFor = (size) => (RATIOS && Object.keys(RATIOS).find((k) => RATIOS[k][0] === size.w && RATIOS[k][1] === size.h)) || ensureRatio(`${size.w}x${size.h}`);
  /** Puts the poster on the design's page (every thumbnail of the app draws it) and the length on the footage */
  const setPoster = (d, shot) => { if (!d || !d.pages || !d.pages[0] || !shot) return false; d.pages[0].poster = shot.src; if (d.footage) d.footage.dur = shot.dur; return true; };
  /* Designs made before thumbnails existed (or whose local file could not be decoded) get theirs from the proxy, one at a time */
  const posterTried = new Set(); let posterQ = Promise.resolve();
  FT.needsPoster = (d) => !!(d && d.footage && d.footage.src && d.pages && d.pages[0] && !(d.pages[0].poster && d.footage.dur));
  /** Resolves true once `d` has a new poster (saved), false when there is nothing to do or it could not be made */
  FT.ensurePoster = (d, proxyUrl) => {
    if (!FT.needsPoster(d) || posterTried.has(d.id)) return Promise.resolve(false);
    posterTried.add(d.id);
    const run = async () => {
      try {
        let url = proxyUrl;
        if (!url) { const rec = await api('/footage/' + d.footage.src); if (!rec || !rec.proxyUrl) { posterTried.delete(d.id); return false; } url = apiUrl(rec.proxyUrl); }
        const shot = await grabPoster(url);
        if (!shot || !FT.needsPoster(d)) return false;
        setPoster(d, shot); save(); return true;
      } catch (e) { return false; }
    };
    return (posterQ = posterQ.then(run, run));
  };

  /* ---------- 2. upload modal and design creation ---------- */
  function openNew(mode = 'match') {
    if (canEdit && !canEdit()) return;
    const plain = mode === 'caption';
    const looks = plain ? [] : (Array.isArray(brand().looks) ? brand().looks : []).filter((l) => l && l.id);
    const st = { original: null, ref: null, lookId: null, busy: false, uploaded: false, closed: false, ac: null, probeAc: null };
    const zone = (k, title, hint) => `<div class="ft-zone"><b class="ft-zt">${title}</b>
      <label class="ft-drop" data-ft-drop="${k}" tabindex="0"><input type="file" accept="video/mp4,video/quicktime,video/*,.mp4,.mov,.m4v" hidden data-ft-file="${k}">
      <span class="ft-di">${ic('upload', 22)}</span><span class="ft-dt">${hint}</span><small class="ft-fn" data-ft-name="${k}"></small></label>
      <div class="prog-w ft-pw" data-ft-pw="${k}" hidden><div class="prog"><i style="width:0%"></i></div><span class="prog-pct">0%</span></div></div>`;
    const lookList = looks.length ? `<div class="ft-looks"><div class="au-or"><span>or</span></div><b class="ft-zt">Use a brand look</b>
      <div class="ft-lk">${looks.map((l) => `<button type="button" class="ft-look" data-ft-look="${esc(l.id)}" aria-pressed="false">${esc(l.name || l.id)}</button>`).join('')}</div></div>` : '';
    modal(`<div class="mh"><h2>${plain ? 'Caption a video' : 'Match a reference'}</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb ft-mb">${zone('original', 'Your video', 'Drop the raw clip (MP4 or MOV, up to 2 GB)')}
        ${plain ? '' : zone('ref', 'Reference (optional)', 'Drop an edited video to copy its look and captions')}${lookList}
        <p class="ft-err" data-ft-err role="alert" hidden></p></div>
      <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ft-start disabled>Start</button></div>`,
      { onClose: () => {
        const a = closeAction(st); st.closed = true;
        if (a === 'stop' && st.ac) { st.ac.abort(); toast(UPLOAD_STOPPED); }
        else if (a === 'finish' && st.probeAc) st.probeAc.abort(); // no wait for the reference's size: the design takes the default one
      }, onMount: (bg, close) => wire(bg, close, st) });
  }

  function wire(bg, close, st) {
    const $ = (s) => bg.querySelector(s), $$ = (s) => [...bg.querySelectorAll(s)];
    const start = $('[data-ft-start]'), err = $('[data-ft-err]');
    const say = (m, info) => { err.textContent = m || ''; err.hidden = !m; err.classList.toggle('ft-info', !!info); };
    const refresh = () => { start.disabled = !canStart(st); };
    const progress = (k, v) => { const w = $(`[data-ft-pw="${k}"]`); if (!w) return; w.hidden = false; const p = Math.round(v * 100); w.querySelector('i').style.width = p + '%'; w.querySelector('.prog-pct').textContent = p + '%'; };
    function pick(k, f) {
      if (st.busy || !f) return;
      if (!isVideoFile(f)) return say('Choose a video file (MP4 or MOV)');
      say(''); st[k === 'original' ? 'original' : 'ref'] = f;
      $(`[data-ft-name="${k}"]`).textContent = fileLabel(f);
      $(`[data-ft-drop="${k}"]`).classList.add('has');
      if (k === 'ref') { st.lookId = null; $$('[data-ft-look]').forEach((b) => b.setAttribute('aria-pressed', 'false')); }
      refresh();
    }
    $$('[data-ft-drop]').forEach((el) => {
      const k = el.dataset.ftDrop;
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
      el.addEventListener('dragleave', () => el.classList.remove('over'));
      el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); pick(k, e.dataTransfer.files[0]); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.querySelector('input').click(); } });
    });
    $$('[data-ft-file]').forEach((inp) => inp.addEventListener('change', () => { const f = inp.files[0]; inp.value = ''; pick(inp.dataset.ftFile, f); }));
    $$('[data-ft-look]').forEach((b) => b.addEventListener('click', () => {
      if (st.busy) return;
      const on = st.lookId !== b.dataset.ftLook; st.lookId = on ? b.dataset.ftLook : null;
      $$('[data-ft-look]').forEach((x) => x.setAttribute('aria-pressed', String(on && x === b)));
      if (on) { st.ref = null; $('[data-ft-drop="ref"]').classList.remove('has'); $('[data-ft-name="ref"]').textContent = ''; }
      refresh();
    }));
    start.addEventListener('click', async () => {
      if (st.busy) return;
      st.busy = true; st.uploaded = false; say(''); refresh(); start.textContent = 'Uploading…';
      // the card's thumbnail, from the local file while it uploads (a codec the browser can't play falls back to the proxy later)
      const localUrl = URL.createObjectURL(st.original), posterP = grabPoster(localUrl, { timeout: 10000 }).finally(() => URL.revokeObjectURL(localUrl));
      const ac = st.ac = new AbortController(), signal = ac.signal;
      try {
        // the spoken language is left to Whisper's auto-detect: the brand's language is the copy's, not the speaker's,
        // and forcing it (e.g. 'en' on Arabic speech) makes Whisper output an English translation instead of a transcript
        const brandId = brand().id, lang = null;
        // the first failure aborts the sibling; Start only comes back once both have settled
        const run = (file, role, k) => uploadFootage(file, { role, brand: brandId, api, signal, onProgress: (v) => progress(k, v) }).catch((e) => { ac.abort(); throw e; });
        const res = await Promise.allSettled([run(st.original, 'original', 'original'), ...(st.ref ? [run(st.ref, 'reference', 'ref')] : [])]);
        const bad = res.filter((r) => r.status === 'rejected').map((r) => r.reason);
        if (bad.length) throw bad.find((e) => !isAbort(e)) || bad[0];
        const [orig, ref] = res.map((r) => r.value);
        // both files are on the server: from here closing the modal no longer stops anything, the design is still created
        st.uploaded = true;
        await api(`/footage/${orig.id}/pair`, { method: 'POST', body: { ...(ref ? { ref: ref.id } : st.lookId ? { lookId: st.lookId } : {}), ...(lang ? { lang } : {}) } });
        let probe = null;
        if (ref && !st.closed) {
          start.textContent = 'Reading the reference…'; say('Reading the reference…', true);
          st.probeAc = new AbortController();
          probe = await readProbe(api, ref.id, { signal: st.probeAc.signal });
          if (!st.closed) say('');
        }
        const d = createFootageDesign({ original: st.original, src: orig.id, ref: ref ? ref.id : null, lookId: ref ? null : st.lookId, lang, probe });
        if (setPoster(d, await posterP)) save();
        st.busy = false;
        if (st.closed) { toast(READY_IN_STUDIO); return; }
        close(); FT.open(d);
      } catch (e) {
        st.busy = false; st.ac = null; start.textContent = 'Start'; refresh();
        if (isAbort(e)) return;
        const m = (e && e.message) || 'The upload failed. Try again, dropping the same files resumes it.';
        if (!st.closed) say(m); else if (st.uploaded) toast(m);
      }
    });
  }

  function createFootageDesign({ original, src, ref, lookId, lang, probe }) {
    const size = outSize(probe), r = ratioFor(size);
    const saved = lookId && (Array.isArray(brand().looks) ? brand().looks : []).find((l) => l && l.id === lookId);
    const d = createDesign({
      name: `${baseName(original.name)} · ${ref || lookId ? 'matched' : 'captioned'}`, ratio: r,
      mutate: (d) => { d.pages = [{ id: uid(), bg: '#000000', layers: [BG(size.w, size.h, '#000000')] }]; d.footage = footageDoc({ src, ref, lookId, size }); d.captions = footageCaptions({ lang, style: saved && saved.captionStyle }); d.named = true; },
    });
    save();
    return d;
  }

  /* ---------- 3. actions and the FT object ---------- */
  /** Opens a footage design in the editor; footage-editor.js takes the editor over for designs with d.footage */
  FT.open = (d) => { location.hash = '#/editor/' + d.id; };
  installFootageEditor(ctx, FT);
  FT.newVideo = () => openNew('caption');
  ACT.ftNew = () => openNew();
  return FT;
}
