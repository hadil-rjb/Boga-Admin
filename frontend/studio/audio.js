/* Audio of a motion design: a music bed for the whole video and one voice-over line per scene.
   Pure data and math, no DOM. Stored as `d.audio` ({ music, duck, captions, voice, tone, language }) and
   `pg.scene.vo` ({ text, src, dur, vol, by, srcText }). A voiceover made elsewhere (e.g. with Claude Code) can also be one
   file for the whole video: `d.audio.track` ({ src, name, dur, vol, at }), playing from `at` ms. Times are in milliseconds. */

/** The voice starts a beat after its scene, so it never talks over the cut */
export const LEAD = 150;
export const AUDIO_DEFAULT = { music: null, track: null, duck: true, captions: false, voice: '', tone: 'Auto', language: '' };
export const audioOf = (d) => ({ ...AUDIO_DEFAULT, ...(d && d.audio) });
export const voOf = (pg) => (pg && pg.scene && pg.scene.vo) || null;
export const hasAudio = (d) => { const a = audioOf(d); return !!(a.music || a.track || (d.pages || []).some((pg) => (voOf(pg) || {}).src)); };

/** How well a line fits its scene: about 2.3 spoken words per second, 2.6 at most */
export function fit(text, ms) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length, max = Math.max(1, Math.floor((ms / 1000) * 2.6));
  return { words, max, ok: words <= max, ideal: Math.round((ms / 1000) * 2.3) };
}

/** Voice clips on the timeline: where each one starts, how long it plays, and whether it runs past its scene (or the video).
    A whole-video track comes first; scene clips still play on top of it. */
export function clips(pages, tl, a) {
  const tr = a && a.track && a.track.src ? [{ i: -1, src: a.track.src, start: a.track.at || 0, dur: a.track.dur || 0, end: (a.track.at || 0) + (a.track.dur || 0), vol: a.track.vol ?? 1, over: (a.track.at || 0) + (a.track.dur || 0) > tl.total + 50, track: true }] : [];
  return tr.concat(tl.scenes.map((s) => {
    const vo = voOf(pages[s.i]); if (!vo || !vo.src) return null;
    const start = s.start + LEAD, dur = Math.max(0, vo.dur || 0);
    return { i: s.i, src: vo.src, start, dur, end: start + dur, vol: vo.vol ?? 1, over: start + dur > s.start + s.dur };
  }).filter(Boolean));
}
/** Scene lengths that make the video as long as the voice: every scene keeps its share, in steps of 0.1 s */
export function fitScenes(durs, target) {
  const total = durs.reduce((n, x) => n + x, 0); if (!total || !target) return durs;
  const out = durs.map((x) => Math.max(500, Math.round((x * target) / total / 100) * 100));
  out[out.length - 1] = Math.max(500, out[out.length - 1] + Math.round((target - out.reduce((n, x) => n + x, 0)) / 100) * 100);
  return out;
}
/** Files in the order a person numbered them (voice-2 before voice-10) */
export const byName = (files) => [...files].sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }));
export const clipAt = (cl, t) => cl.find((c) => t >= c.start && t < c.end) || null;

/** Music volume at time t: fades in and out, and dips under the voice (with a short ramp so it never pumps) */
export function musicGain(t, total, a, cl) {
  const m = a.music; if (!m) return 0;
  let g = m.vol ?? 0.6;
  if (m.fadeIn !== false) g *= Math.min(1, t / 1200);
  if (m.fadeOut !== false) g *= Math.min(1, Math.max(0, (total - t) / 1500));
  if (a.duck !== false && cl.length) {
    const RAMP = 300, dist = Math.min(...cl.map((c) => (t < c.start ? c.start - t : t > c.end ? t - c.end : 0)));
    const k = dist >= RAMP ? 1 : 0.28 + 0.72 * (dist / RAMP);
    g *= k;
  }
  return Math.max(0, Math.min(1, g));
}
/** The same curve sampled for the Web Audio export (20 points a second) */
export function musicCurve(total, a, cl) {
  const n = Math.max(2, Math.ceil((total / 1000) * 20)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = musicGain((i / (n - 1)) * total, total, a, cl);
  return out;
}

/** The caption on screen at time t: the line of the scene being shown, while its voice plays (or the whole scene without audio) */
export function captionAt(pages, tl, t, a) {
  if (!a.captions) return null;
  const s = tl.scenes.find((x) => t >= x.start && t < x.start + x.dur) || tl.scenes[tl.scenes.length - 1]; if (!s) return null;
  const vo = voOf(pages[s.i]), text = vo && String(vo.text || '').trim(); if (!text) return null;
  if (vo.src && vo.dur) { const st = s.start + LEAD; if (t < st || t > st + vo.dur + 400) return null; }
  else if (a.track && a.track.src && a.track.dur && (t < (a.track.at || 0) || t > (a.track.at || 0) + a.track.dur + 400)) return null;
  return text;
}
/** Breaks a caption into lines that fit maxW, using a text measurer (canvas measureText) */
export function wrap(text, maxW, measure) {
  const out = []; let line = '';
  String(text).split(/\s+/).forEach((w) => { const t = line ? line + ' ' + w : w; if (line && measure(t) > maxW) { out.push(line); line = w; } else line = t; });
  if (line) out.push(line);
  return out.slice(0, 3);
}
export const MOODS = ['Upbeat', 'Chill', 'Corporate', 'Cinematic', 'Lo-fi', 'Inspiring'];
export const TONES = ['Auto', 'Friendly', 'Energetic', 'Expert', 'Calm', 'Playful'];
export const LANGUAGES = ['English', 'French', 'Arabic', 'Spanish', 'German', 'Turkish', 'Italian', 'Portuguese'];
export const fmtSec = (ms) => (Math.round(ms / 100) / 10).toFixed(1) + ' s';
