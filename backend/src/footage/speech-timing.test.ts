import { describe, expect, it } from 'vitest';
import { envelope, joinSplitTerms, readWav, snapWords, speechLevel, FRAME_MS } from './speech-timing';

const W = (t: string, s: number, e: number, p = 0.9) => ({ t, s, e, p });
/** An envelope (10 ms frames): speech (−15 dB) on the given [from, to) ms spans, silence (−55 dB) elsewhere */
const env = (ms: number, speech: [number, number][]) => Float32Array.from({ length: ms / FRAME_MS }, (_, f) => (speech.some(([a, b]) => f * FRAME_MS >= a && f * FRAME_MS < b) ? -15 : -55));

describe('word timings on the voice', () => {
  it('a word Whisper starts late after a pause moves back to where the voice comes in', () => {
    // voice 0-1000, silence 1000-1600, voice from 1600; Whisper put word 2 at 2100
    const out = snapWords([W('a', 0, 1000), W('b', 2100, 2600)], env(3000, [[0, 1000], [1600, 2600]]));
    expect(out[1].s).toBe(1600);
    expect(out[0].e).toBe(1000);
  });
  it('a start in silence moves forward to the voice; an end in silence back to it', () => {
    const out = snapWords([W('a', 200, 1300)], env(2000, [[500, 1000]]));
    expect(out[0]).toMatchObject({ s: 500, e: 1000 });
  });
  it('never past the neighbours, never more than 700 ms', () => {
    const out = snapWords([W('a', 0, 500), W('b', 500, 900)], env(2000, [[0, 1500]]));
    expect(out[0].e).toBe(500); expect(out[1].s).toBe(500);
    const far = snapWords([W('x', 2000, 2500)], env(4000, [[0, 2500]]));
    expect(far[0].s).toBe(1300);
  });
  it('speechLevel sits between the quiet and the voice; no silence at all moves nothing', () => {
    expect(speechLevel(env(1000, [[0, 500]]))).toBe(-35);
    expect(speechLevel(env(1000, [[0, 1000]]))).toBeNull();
    const ws = [W('a', 0, 500)]; expect(snapWords(ws, env(1000, [[0, 1000]]))).toBe(ws);
  });
  it('readWav + envelope: a 16-bit mono WAV', () => {
    const rate = 16000, n = rate / 10, pcm = new Int16Array(n); for (let k = 0; k < n / 2; k++) pcm[k] = Math.round(8000 * Math.sin(k / 3));
    const head = Buffer.alloc(44); head.write('RIFF', 0); head.writeUInt32LE(36 + n * 2, 4); head.write('WAVE', 8); head.write('fmt ', 12); head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(n * 2, 40);
    const w = readWav(Buffer.concat([head, Buffer.from(pcm.buffer)]))!;
    expect(w.rate).toBe(rate); expect(w.pcm.length).toBe(n);
    const e = envelope(w.pcm, rate); expect(e.length).toBe(10); expect(e[0]).toBeGreaterThan(-20); expect(e[9]).toBeLessThan(-100);
    expect(readWav(Buffer.from('nope'))).toBeNull();
  });
});

describe('split terms', () => {
  it('joins S + &P, COVID + -19; leaves separate words alone', () => {
    expect(joinSplitTerms([W('مؤشر', 0, 500), W('S', 500, 700, 0.62), W('&P', 700, 1000)])).toEqual([W('مؤشر', 0, 500), W('S&P', 500, 1000, 0.62)]);
    expect(joinSplitTerms([W('COVID', 0, 400), W('-19', 400, 800)]).map((w) => w.t)).toEqual(['COVID-19']);
    expect(joinSplitTerms([W('S', 0, 300), W('P', 300, 600)]).map((w) => w.t)).toEqual(['S', 'P']);
  });
});
