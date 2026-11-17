/* ============================================================
   Pauses: where "Remove pauses" cuts a talking video. Pure ESM, no imports: shared byte-for-byte with the API
   (backend/scripts/sync-shared.mjs copies it to backend/src/footage/shared/pauses.mjs), so the preview skips exactly
   what the export cuts.
   The cuts come from the transcript's words ({ s, e } in ms): every silence of at least `minMs` between two words (and
   before the first, after the last) is cut, leaving a short breath of LEAD ms before the next word and TAIL ms after the
   last one. No words, no cuts: a video without a transcript is never cut.
   The editor keeps the video's own clock (captions, music ducking and the timeline stay in source time); the player skips
   the cuts, the timeline hatches them and the export drops their frames and samples (keepFrames).
   ============================================================ */

export const PAUSE_DEFAULT_MS = 600;
export const PAUSE_MIN_MS = 300;
export const PAUSE_MAX_MS = 2000;
/** Kept before a word starts (Whisper starts words a little late) and after one ends */
export const LEAD = 120;
export const TAIL = 180;
/** A cut shorter than this is not worth a jump */
const SHORTEST = 80;

const clampMin = (m) => { const n = Math.round(+m); return Number.isFinite(n) ? Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, n)) : PAUSE_DEFAULT_MS; };

/** `d.footage.audio.pauses` with its defaults: { on, min } (min clamped to 300..2000 ms) */
export function pausesOf(p) {
  return { on: !!(p && p.on), min: clampMin(p && p.min != null ? p.min : PAUSE_DEFAULT_MS) };
}

/**
 * The silences to cut, [[start, end]] in ms, sorted and apart. `words` [{ s, e }] in ms (any order), `durMs` the video's
 * length, `minMs` the shortest silence that is cut.
 */
export function pauseCuts(words, durMs, minMs = PAUSE_DEFAULT_MS) {
  const dur = Math.max(0, Math.round(+durMs || 0)), min = clampMin(minMs);
  const ws = (Array.isArray(words) ? words : [])
    .map((w) => ({ s: Math.round(+(w && w.s)), e: Math.round(+(w && w.e)) }))
    .filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e) && w.s < dur)
    .map((w) => ({ s: Math.max(0, w.s), e: Math.min(dur, Math.max(w.s, w.e)) }))
    .sort((a, b) => a.s - b.s);
  if (!dur || !ws.length) return [];
  const cuts = [], add = (s, e) => { if (e - s >= SHORTEST) cuts.push([s, e]); };
  if (ws[0].s >= min) add(0, ws[0].s - LEAD);
  let end = ws[0].e;
  for (let i = 1; i < ws.length; i++) {
    if (ws[i].s - end >= min) add(end + TAIL, ws[i].s - LEAD);
    end = Math.max(end, ws[i].e);
  }
  if (dur - end >= min) add(end + TAIL, dur);
  return cuts;
}

/** The cut that `ms` falls in ([start, end), the video's end counts as inside the last cut), or null */
export function cutAt(cuts, ms) {
  for (const c of cuts || []) { if (ms < c[0]) return null; if (ms < c[1]) return c; }
  return null;
}

/** Total length removed by the cuts, ms */
export const cutTotal = (cuts) => (cuts || []).reduce((t, c) => t + (c[1] - c[0]), 0);

/** The video's length once the cuts are removed, ms */
export const editedMs = (cuts, durMs) => Math.max(0, Math.round(+durMs || 0) - cutTotal(cuts));

/**
 * The frames the export keeps at `fps`: [[first, last]] inclusive frame numbers of the constant-rate stream (frame k shows
 * k / fps s). Cut edges snap to the nearest frame, so the video and the sound (in chunks of exactly one frame) lose the
 * same frames and stay in sync. Covers the whole video when there is nothing to cut.
 */
export function keepFrames(cuts, durMs, fps) {
  const total = Math.max(1, Math.round((Math.max(0, +durMs || 0) / 1000) * fps)), at = (ms) => Math.min(total, Math.max(0, Math.round((ms / 1000) * fps)));
  const keeps = []; let from = 0;
  for (const [s, e] of cuts || []) {
    const a = at(s), b = at(e);
    if (b <= a) continue;
    if (a > from) keeps.push([from, a - 1]);
    from = Math.max(from, b);
  }
  if (from < total) keeps.push([from, total - 1]);
  return keeps;
}

/** Number of frames kept */
export const keptFrames = (keeps) => (keeps || []).reduce((n, k) => n + (k[1] - k[0] + 1), 0);

/** Where source time `ms` lands in the edited video (a time inside a cut lands where that cut was) */
export function toEdited(cuts, ms) {
  let t = ms;
  for (const [s, e] of cuts || []) { if (ms <= s) break; t -= Math.min(ms, e) - s; }
  return Math.max(0, t);
}

/**
 * Where edited time `ms` is in the source: the inverse of toEdited. At a joint (where a cut was) a start lands after the
 * cut, an end (`end` true) before it.
 */
export function toSource(cuts, ms, end = false) {
  let t = Math.max(0, +ms || 0);
  for (const [s, e] of cuts || []) { if (end ? t > s : t >= s) t += e - s; else break; }
  return t;
}

/** The waveform of the edited video: `peaks` buckets over the source (durMs long) resampled over what the cuts leave */
export function editPeaks(peaks, cuts, durMs) {
  const N = peaks ? peaks.length : 0;
  if (!N || !(cuts && cuts.length) || !(durMs > 0)) return peaks;
  const ed = editedMs(cuts, durMs), out = new Float32Array(N);
  if (!(ed > 0)) return out;
  for (let k = 0; k < N; k++) {
    const a = Math.floor((toSource(cuts, (k / N) * ed) / durMs) * N), b = Math.max(a + 1, Math.floor((toSource(cuts, ((k + 1) / N) * ed, true) / durMs) * N));
    let m = 0; for (let i = a; i < b && i < N; i++) if (peaks[i] > m) m = peaks[i];
    out[k] = m;
  }
  return out;
}
