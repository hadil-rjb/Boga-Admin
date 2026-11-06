/* A background music bed written for one video, in the browser (Web Audio, no service): its length, a tempo that follows
   how fast the scenes change, and a mood. Chords, bass, an arpeggio and light drums, mixed and faded. Same seed, same
   track: a "new variation" is a new seed. */

export const MOODS = {
  upbeat: { name: 'Upbeat', bpm: 118, scale: 'major', prog: [0, 4, 5, 3], drums: 'pop', arp: 8, pad: 0.16 },
  chill: { name: 'Chill', bpm: 84, scale: 'major', prog: [0, 5, 3, 4], drums: 'soft', arp: 4, pad: 0.2, sev: true },
  corporate: { name: 'Corporate', bpm: 104, scale: 'major', prog: [0, 5, 3, 4], drums: 'light', arp: 8, pad: 0.17 },
  cinematic: { name: 'Cinematic', bpm: 88, scale: 'minor', prog: [0, 5, 2, 6], drums: 'none', arp: 4, pad: 0.24 },
};
/** A mood for the video: from the script's tone when it says one, else from how fast the scenes change */
export function moodFor(tone, avgSceneMs) {
  const t = String(tone || '').toLowerCase();
  if (/energ|play/.test(t)) return 'upbeat';
  if (/calm/.test(t)) return 'chill';
  if (/expert/.test(t)) return 'corporate';
  return avgSceneMs < 2600 ? 'upbeat' : avgSceneMs > 4500 ? 'chill' : 'corporate';
}

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const rng = (seed) => { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

/** Renders the bed: { seconds, mood, pace (average scene length, ms), seed } → AudioBuffer (stereo, 44.1 kHz) */
export async function compose({ seconds, mood = 'corporate', pace = 3500, seed = 1 }) {
  const M = MOODS[mood] || MOODS.corporate, rnd = rng(seed), sr = 44100, len = Math.max(3, seconds) + 0.6;
  const ctx = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
  // tempo: a little faster for quick cuts, slower for long scenes
  const bpm = Math.round(M.bpm * Math.min(1.12, Math.max(0.9, 3500 / Math.max(1500, pace)))), beat = 60 / bpm, bar = beat * 4;
  const root = 48 + [0, 2, 3, 5, 7, 9][Math.floor(rnd() * 6)], sc = SCALES[M.scale];
  const note = (deg, oct = 0) => root + sc[((deg % 7) + 7) % 7] + 12 * (Math.floor(deg / 7) + oct);
  const chord = (deg) => [note(deg), note(deg + 2), note(deg + 4), ...(M.sev ? [note(deg + 6)] : [])];

  // mix: a soft compressor and the master fades
  const master = ctx.createGain(), comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
  master.connect(comp).connect(ctx.destination);
  master.gain.setValueAtTime(0, 0); master.gain.linearRampToValueAtTime(0.9, 1.2);
  master.gain.setValueAtTime(0.9, Math.max(1.3, len - 2.2)); master.gain.linearRampToValueAtTime(0, len - 0.1);
  const pan = (v) => { const p = ctx.createStereoPanner(); p.pan.value = v; p.connect(master); return p; };
  const busL = pan(-0.25), busR = pan(0.25), busC = pan(0);

  const tone = (type, f, t, dur, vol, out, { attack = 0.01, cutoff = 0, detune = 0 } = {}) => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.value = f; o.detune.value = detune;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    if (cutoff) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; o.connect(lp).connect(g); } else o.connect(g);
    g.connect(out); o.start(t); o.stop(t + dur + 0.05);
  };
  const noiseBuf = ctx.createBuffer(1, sr, sr); { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; }
  const noise = (t, dur, vol, type, freq) => {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noiseBuf; f.type = type; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur); s.connect(f).connect(g).connect(busC); s.start(t); s.stop(t + dur + 0.05);
  };
  const kick = (t, vol) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.32); o.connect(g).connect(busC); o.start(t); o.stop(t + 0.35); };

  const bars = Math.ceil(len / bar);
  for (let b = 0; b < bars; b++) {
    const t0 = b * bar, deg = M.prog[b % M.prog.length], last = b === bars - 1, notes = chord(last ? 0 : deg);
    // pad: two detuned voices per note, slow attack
    notes.forEach((n, k) => { tone('sawtooth', hz(n + 12), t0, bar * 1.05, M.pad / notes.length, k % 2 ? busL : busR, { attack: 0.5, cutoff: 1400, detune: -7 }); tone('sawtooth', hz(n + 12), t0, bar * 1.05, M.pad / notes.length, k % 2 ? busR : busL, { attack: 0.5, cutoff: 1400, detune: 7 }); });
    // bass: root on the beats (cinematic: one long note)
    if (M.drums === 'none') tone('sine', hz(note(last ? 0 : deg, -1)), t0, bar, 0.32, busC, { attack: 0.3 });
    else for (let q = 0; q < 4; q++) tone('triangle', hz(note(last ? 0 : deg, -1)), t0 + q * beat, beat * 0.9, 0.28, busC, { attack: 0.01, cutoff: 600 });
    // arpeggio: chord tones, plucked
    const steps = M.arp, step = bar / steps;
    for (let s = 0; s < steps && !last; s++) { const n = notes[(s + (rnd() < 0.2 ? 1 : 0)) % notes.length] + 24; tone('triangle', hz(n), t0 + s * step, step * 1.6, 0.07, s % 2 ? busL : busR, { attack: 0.005, cutoff: 3200 }); }
    // drums
    if (M.drums !== 'none' && b > 0 && !last) for (let q = 0; q < 4; q++) {
      const t = t0 + q * beat;
      if (M.drums === 'pop' || q % 2 === 0) kick(t, M.drums === 'soft' ? 0.35 : 0.55);
      if (q % 2 === 1) noise(t, 0.18, M.drums === 'soft' ? 0.08 : 0.16, 'bandpass', 1800);
      for (let h = 0; h < 2; h++) noise(t + h * beat / 2, 0.05, M.drums === 'soft' ? 0.025 : 0.045, 'highpass', 7000);
    }
  }
  return ctx.startRendering();
}
