/* ============================================================
   Word timings checked against the voice itself.
   Whisper's word times drift, most of all after a silence: a word can start half a second after the voice does (a
   clip at 0:29 had "فهذه" at 29.5 s, the voice back at 29.0 s). The caption then shows late, and "Remove pauses",
   which cuts between words, cuts into the start of the word. The cleaned voice (voice.wav: the noise removed) is
   silent between words, so its loudness tells where speech really is: each word's start moves back to where the voice
   comes in, and its end forward to where it stops, never past the neighbouring words.
   Also: terms Whisper splits at a symbol ("S" + "&P") are joined back ("S&P").
   Pure helpers (the transcribe step in jobs.service.ts reads the WAV and calls them).
   ============================================================ */
import type { Word } from "./jobs.service";

/** Loudness frames of the envelope, ms */
export const FRAME_MS = 10;
/** How far a word edge may move to meet the voice, ms */
export const REACH_MS = 700;

/** Loudness (dB, RMS) of every 10 ms of 16-bit mono PCM at `rate` Hz */
export function envelope(pcm: Int16Array, rate: number): Float32Array {
  const n = Math.max(1, Math.round((rate * FRAME_MS) / 1000)), frames = Math.floor(pcm.length / n), out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let k = f * n; k < (f + 1) * n; k++) { const v = pcm[k] / 32768; s += v * v; }
    out[f] = 10 * Math.log10(s / n + 1e-12);
  }
  return out;
}

/** The samples of a 16-bit PCM WAV (the "data" chunk) and its rate; null for anything else */
export function readWav(buf: Buffer): { pcm: Int16Array; rate: number } | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12, rate = 0, bits = 0, ch = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
    if (id === "fmt ") { ch = buf.readUInt16LE(body + 2); rate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); }
    if (id === "data") {
      if (bits !== 16 || ch !== 1 || !rate) return null;
      const end = Math.min(buf.length, body + size), bytes = buf.subarray(body, end - ((end - body) % 2));
      return { pcm: new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)), rate };
    }
    off = body + size + (size % 2);
  }
  return null;
}

/**
 * The loudness above which a frame is speech: halfway (in dB) between the quiet floor (10th percentile) and the
 * voice (90th percentile), never under −45 dB. Clean voice: silence near −50, speech −10 to −25. null when the two are
 * less than 12 dB apart: no silence to tell speech from (all talk, or noise left in), so nothing is moved.
 */
export function speechLevel(env: Float32Array): number | null {
  if (!env.length) return null;
  const s = Float32Array.from(env).sort(), q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  if (q(0.9) - q(0.1) < 12) return null;
  return Math.max(-45, (q(0.1) + q(0.9)) / 2);
}

/**
 * Words with their edges moved onto the voice: a start inside speech walks back while the voice goes on (a late
 * start), a start in silence walks forward to where the voice comes in (an early one); ends the same way, the other
 * direction. At most REACH_MS, and never into the previous or next word.
 */
export function snapWords(words: Word[], env: Float32Array, level: number | null = speechLevel(env)): Word[] {
  if (!words.length || !env.length || level === null) return words;
  const loud = (ms: number) => { const f = Math.floor(ms / FRAME_MS); return f >= 0 && f < env.length && env[f] > level; };
  const reach = REACH_MS;
  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i < out.length; i++) {
    const w = out[i], lo = i > 0 ? out[i - 1].e : 0, hi = i < out.length - 1 ? words[i + 1].s : Infinity;
    // start
    let s = w.s;
    if (loud(s)) { while (s - FRAME_MS >= Math.max(lo, w.s - reach) && loud(s - FRAME_MS)) s -= FRAME_MS; }
    else { let t = s; while (t < Math.min(w.e, w.s + reach) && !loud(t)) t += FRAME_MS; if (t < w.e) s = t; }
    // end
    let e = Math.max(w.e, s + 1);
    if (loud(e - FRAME_MS)) { while (e + FRAME_MS <= Math.min(hi, w.e + reach) && loud(e)) e += FRAME_MS; }
    else { let t = e; while (t - FRAME_MS > Math.max(s, w.e - reach) && !loud(t - FRAME_MS)) t -= FRAME_MS; if (t > s) e = t; }
    w.s = Math.round(s); w.e = Math.max(w.s + 1, Math.round(e));
  }
  return out;
}

/** Terms Whisper split at a symbol, joined back: "S" + "&P" -> "S&P", "COVID" + "-19" -> "COVID-19" */
export function joinSplitTerms(words: Word[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev && /[A-Za-z0-9]$/.test(prev.t) && /^[&\-./'’+][A-Za-z0-9]/.test(w.t) && w.s - prev.e < 250) {
      out[out.length - 1] = { t: prev.t + w.t, s: prev.s, e: Math.max(prev.e, w.e), p: Math.min(prev.p, w.p) };
    } else out.push(w);
  }
  return out;
}
