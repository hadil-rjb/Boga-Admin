/* ============================================================
   Library cards: a video plays when the pointer rests on its preview (or the card's preview has keyboard focus).
   - an animated design (reel): its scenes drawn on a canvas over the thumbnail (the export's frame renderer, small);
   - an uploaded video: its file in a muted, looping <video> over the poster.
   Nothing plays for a still, on touch (no hover), or when the system asks for reduced motion. No sound: it is a preview.
   The pure helpers at the top are unit-tested; installCardPreview is a DOM module.
   ============================================================ */

/** How long the pointer rests on a card before its video starts (ms) */
export const DWELL_MS = 180;
/** What a design's card can play: 'video' (an uploaded file), 'reel' (an animated design) or null */
export function previewKind(d) {
  if (!d) return null;
  if (d.footage) return d.footage.src ? 'video' : null;
  return d.motion ? 'reel' : null;
}
/** The time to show after `elapsed` ms of a looping preview of `total` ms */
export const loopTime = (elapsed, total) => (total > 0 ? Math.max(0, elapsed) % total : 0);
/** The live canvas's pixel size for a thumbnail of w × h CSS px: device pixels, at most 640 on its long side */
export function liveSize(w, h, dpr = 1) {
  const k = Math.min(dpr || 1, 640 / Math.max(1, w, h));
  return { w: Math.max(2, Math.round(w * k)), h: Math.max(2, Math.round(h * k)) };
}

/**
 * Starts the hover previews. ctx: getD(id) -> design; reel(d, canvas, alive) draws the design's frames on `canvas` while
 * alive() (may be async); videoUrl(d) -> Promise<url | null> for an uploaded video.
 */
export function installCardPreview({ getD, reel, videoUrl }) {
  if (typeof document === 'undefined') return;
  let cur = null; // { pv, timer, live, stop }
  const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pvOf = (t) => (t && t.closest ? t.closest('.card.dc .dc-pv') : null);
  function stop() {
    if (!cur) return;
    clearTimeout(cur.timer); cur.dead = true;
    if (cur.live) cur.live.remove();
    if (cur.pv) cur.pv.classList.remove('dc-playing');
    cur = null;
  }
  function begin(job) {
    const card = job.pv.closest('.card.dc'), d = card && getD(card.dataset.id), kind = previewKind(d);
    const th = job.pv.querySelector('.dc-art > .thumb'); if (!kind || !th) return;
    const alive = () => !job.dead && !!job.live && job.live.isConnected;
    const shown = () => { if (alive()) { job.live.classList.add('on'); job.pv.classList.add('dc-playing'); } };
    if (kind === 'reel') {
      const r = th.getBoundingClientRect(), { w, h } = liveSize(r.width, r.height, window.devicePixelRatio || 1);
      const cv = document.createElement('canvas'); cv.className = 'dc-live'; cv.width = w; cv.height = h; cv.setAttribute('aria-hidden', 'true');
      job.live = cv; th.append(cv);
      Promise.resolve().then(() => reel(d, cv, alive, shown)).catch((e) => { console.error('[card preview]', e); if (job === cur) stop(); });
      return;
    }
    const v = document.createElement('video'); v.className = 'dc-live'; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('aria-hidden', 'true');
    job.live = v; th.append(v);
    v.addEventListener('playing', shown, { once: true });
    Promise.resolve(videoUrl(d)).then((url) => { if (!alive() || !url) return; v.src = url; const p = v.play(); if (p && p.catch) p.catch(() => {}); }).catch(() => { if (job === cur) stop(); });
  }
  function enter(pv) {
    if (cur && cur.pv === pv) return;
    stop();
    if (!pv || still()) return;
    const job = { pv, live: null, dead: false, timer: 0 };
    cur = job; job.timer = setTimeout(() => { if (cur === job) begin(job); }, DWELL_MS);
  }
  document.addEventListener('pointerover', (e) => { if (e.pointerType && e.pointerType !== 'mouse') return; const pv = pvOf(e.target); if (pv) enter(pv); });
  document.addEventListener('pointerout', (e) => { if (!cur) return; const to = pvOf(e.relatedTarget); if (to !== cur.pv) stop(); });
  document.addEventListener('focusin', (e) => { const pv = pvOf(e.target); if (pv && e.target.matches && e.target.matches('.pv:focus-visible')) enter(pv); });
  document.addEventListener('focusout', (e) => { if (cur && pvOf(e.target) === cur.pv && pvOf(e.relatedTarget) !== cur.pv) stop(); });
  addEventListener('hashchange', stop); addEventListener('blur', stop);
}
