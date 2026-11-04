/* ============================================================
   Footage style match: copy a reference video's look and subtitles onto a raw clip.
   installFootage(ctx) is called once from the engine and registers the footage actions.
   Sections: 1. helpers, 2. upload modal and design creation, 3. actions and the FT object.
   Tasks 10-13 add the footage editor in new sections of this file. No DOM use at module level.
   ============================================================ */
import { uploadFootage, isVideoFile } from './upload.js';

/* ---------- 1. helpers ---------- */
/** The brand's language is stored as a name ('English'); the server takes ISO 639-1 */
const LANG_CODES = { english: 'en', french: 'fr', spanish: 'es', german: 'de', arabic: 'ar', italian: 'it', portuguese: 'pt' };
export const langCode = (name) => LANG_CODES[String(name || '').trim().toLowerCase()] || undefined;
const DEFAULT_SIZE = { w: 1080, h: 1920 };
const fileLabel = (f) => `${f.name} · ${f.size >= 1e9 ? (f.size / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(f.size / 1e6)) + ' MB'}`;
const baseName = (n) => String(n || 'Video').replace(/\.[^.]+$/, '');
/** Output canvas: the reference's display size when probed (even numbers, 4 digits at most), else a vertical video */
export function outSize(probe) {
  const w = Math.round(+(probe && probe.w) / 2) * 2, h = Math.round(+(probe && probe.h) / 2) * 2;
  return w >= 2 && h >= 2 && w <= 9999 && h <= 9999 ? { w, h } : { ...DEFAULT_SIZE };
}
/** The footage part of a new design */
export function footageDoc({ src, ref = null, lookId = null, lang = null, size }) {
  const { w, h } = size || DEFAULT_SIZE;
  return { src, ref, lookId, look: { lut: null, strength: 1, exposure: 0, temp: 0, sat: 0 }, captions: { style: null, lines: [], lang }, out: { w, h, fps: 30 }, export: null };
}

export function installFootage(ctx) {
  const { ACT, api, modal, ic, esc, save, uid, brand, canEdit, createDesign, ensureRatio, BG } = ctx;
  const FT = { ctx };

  /* ---------- 2. upload modal and design creation ---------- */
  function openNew() {
    if (canEdit && !canEdit()) return;
    const looks = (Array.isArray(brand().looks) ? brand().looks : []).filter((l) => l && l.id);
    const st = { original: null, ref: null, lookId: null, busy: false, closed: false };
    const zone = (k, title, hint) => `<div class="ft-zone"><b class="ft-zt">${title}</b>
      <label class="ft-drop" data-ft-drop="${k}" tabindex="0"><input type="file" accept="video/mp4,video/quicktime,video/*,.mp4,.mov,.m4v" hidden data-ft-file="${k}">
      <span class="ft-di">${ic('upload', 22)}</span><span class="ft-dt">${hint}</span><small class="ft-fn" data-ft-name="${k}"></small></label>
      <div class="prog-w ft-pw" data-ft-pw="${k}" hidden><div class="prog"><i style="width:0%"></i></div><span class="prog-pct">0%</span></div></div>`;
    const lookList = looks.length ? `<div class="ft-looks"><div class="au-or"><span>or</span></div><b class="ft-zt">Use a brand look</b>
      <div class="ft-lk">${looks.map((l) => `<button type="button" class="ft-look" data-ft-look="${esc(l.id)}" aria-pressed="false">${esc(l.name || l.id)}</button>`).join('')}</div></div>` : '';
    modal(`<div class="mh"><h2>Match a reference</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb ft-mb">${zone('original', 'Your video', 'Drop the raw clip (MP4 or MOV, up to 2 GB)')}
        ${zone('ref', 'Reference', 'Drop an edited video to copy its look and subtitles')}${lookList}
        <p class="ft-err" data-ft-err role="alert" hidden></p></div>
      <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ft-start disabled>Start</button></div>`,
      { onClose: () => { st.closed = true; }, onMount: (bg, close) => wire(bg, close, st) });
  }

  function wire(bg, close, st) {
    const $ = (s) => bg.querySelector(s), $$ = (s) => [...bg.querySelectorAll(s)];
    const start = $('[data-ft-start]'), err = $('[data-ft-err]');
    const say = (m) => { err.textContent = m || ''; err.hidden = !m; };
    const refresh = () => { start.disabled = st.busy || !st.original || !(st.ref || st.lookId); };
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
      st.busy = true; say(''); refresh(); start.textContent = 'Uploading…';
      try {
        const brandId = brand().id, lang = langCode(brand().lang);
        const ups = [uploadFootage(st.original, { role: 'original', brand: brandId, api, onProgress: (v) => progress('original', v) })];
        if (st.ref) ups.push(uploadFootage(st.ref, { role: 'reference', brand: brandId, api, onProgress: (v) => progress('ref', v) }));
        const [orig, ref] = await Promise.all(ups);
        if (st.closed) return;
        let probe = null;
        if (ref) { try { probe = (await api('/footage/' + ref.id)).probe; } catch (e) { /* not probed yet: default size */ } }
        await api(`/footage/${orig.id}/pair`, { method: 'POST', body: { ...(ref ? { ref: ref.id } : { lookId: st.lookId }), ...(lang ? { lang } : {}) } });
        if (st.closed) return;
        const d = createFootageDesign({ original: st.original, src: orig.id, ref: ref ? ref.id : null, lookId: ref ? null : st.lookId, lang, probe });
        close(); FT.open(d);
      } catch (e) {
        st.busy = false; start.textContent = 'Start'; refresh();
        if (!st.closed) say((e && e.message) || 'The upload failed. Try again, dropping the same files resumes it.');
      }
    });
  }

  function createFootageDesign({ original, src, ref, lookId, lang, probe }) {
    const size = outSize(probe), r = ensureRatio(`${size.w}x${size.h}`);
    const d = createDesign({
      name: `${baseName(original.name)} · matched`, ratio: r,
      mutate: (d) => { d.pages = [{ id: uid(), bg: '#000000', layers: [BG(size.w, size.h, '#000000')] }]; d.footage = footageDoc({ src, ref, lookId, lang, size }); d.named = true; },
    });
    save();
    return d;
  }

  /* ---------- 3. actions and the FT object ---------- */
  /** Opens a footage design in the editor (Task 10 renders the footage editor there) */
  FT.open = (d) => { location.hash = '#/editor/' + d.id; };
  ACT.ftNew = () => openNew();
  return FT;
}
