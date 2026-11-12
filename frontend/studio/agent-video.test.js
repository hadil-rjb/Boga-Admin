import { describe, expect, it } from 'vitest';
import { captionEdits, linesIn, gradeInput, audioInput, analysisState, videoCtx } from './agent-video.js';

const W = (t, s, e) => ({ t, s, e });
const L = () => [
  { id: 'a', start: 0, end: 1500, words: [W('Hello', 0, 500), W('wrold', 500, 1000), W('today', 1000, 1500)] },
  { id: 'b', start: 2000, end: 3000, words: [W('second', 2000, 3000)] },
  { id: 'c', start: 3500, end: 4500, words: [W('third', 3500, 4500)] },
];
const text = (l) => l.words.map((w) => w.t).join(' ');
describe('captionEdits', () => {
  it('fixes text and keeps the timing of unchanged words', () => {
    const r = captionEdits(L(), [{ action: 'text', id: 'a', text: 'Hello world today' }], 10000);
    expect(text(r.lines[0])).toBe('Hello world today'); expect(r.lines[0].words[0]).toEqual(W('Hello', 0, 500)); expect(r.done).toHaveLength(1);
  });
  it('splits at a word, merges with the next line, deletes', () => {
    let r = captionEdits(L(), [{ action: 'split', id: 'a', atWord: 2 }], 10000);
    expect(r.lines.map(text)).toEqual(['Hello wrold', 'today', 'second', 'third']); expect(r.added).toHaveLength(1);
    r = captionEdits(L(), [{ action: 'merge', id: 'b' }], 10000); expect(r.lines.map(text)).toEqual(['Hello wrold today', 'second third']);
    r = captionEdits(L(), [{ action: 'delete', id: 'c' }], 10000); expect(r.lines).toHaveLength(2);
  });
  it('applies in order and skips edits whose line is gone, naming them', () => {
    const r = captionEdits(L(), [{ action: 'delete', id: 'b' }, { action: 'text', id: 'b', text: 'x' }, { action: 'text', id: 'c', text: 'Third' }], 10000);
    expect(r.lines.map(text)).toEqual(['Hello wrold today', 'Third']); expect(r.notes[0]).toMatch(/b: no such line/);
  });
  it('refuses a split outside the line, a merge of the last line, an unknown action', () => {
    const r = captionEdits(L(), [{ action: 'split', id: 'a', atWord: 3 }, { action: 'split', id: 'a', atWord: 0 }, { action: 'merge', id: 'c' }, { action: 'spin', id: 'a' }], 10000);
    expect(r.lines).toEqual(L()); expect(r.notes).toHaveLength(4);
  });
  it('keeps a retime between its neighbours and inside the video', () => {
    let r = captionEdits(L(), [{ action: 'retime', id: 'b', start: 1, end: 4 }], 10000);
    expect([r.lines[1].start, r.lines[1].end]).toEqual([1500, 3500]); expect(r.notes[0]).toMatch(/clamped/);
    r = captionEdits(L(), [{ action: 'retime', id: 'c', start: 9, end: 12 }], 10000);
    expect([r.lines[2].start, r.lines[2].end]).toEqual([9000, 10000]);
    r = captionEdits(L(), [{ action: 'retime', id: 'b', start: 3, end: 2 }], 10000); expect(r.notes[0]).toMatch(/end/);
  });
  it('adds a line in a gap, and refuses one with no room', () => {
    let r = captionEdits(L(), [{ action: 'add', start: 5, end: 6, text: 'four' }], 10000);
    expect(r.lines.map(text)).toEqual(['Hello wrold today', 'second', 'third', 'four']); expect(r.added).toHaveLength(1);
    r = captionEdits(L(), [{ action: 'add', start: 1.55, end: 1.6, text: 'x' }], 10000); expect(r.notes[0]).toMatch(/room/);
  });
  it('clips long text and caps the batch at 100 edits', () => {
    const r = captionEdits(L(), [{ action: 'text', id: 'a', text: 'w '.repeat(400) }], 10000);
    expect(text(r.lines[0]).length).toBeLessThanOrEqual(300);
    expect(captionEdits(L(), Array.from({ length: 120 }, () => ({ action: 'text', id: 'a', text: 'Hi' })), 10000).notes.join(' ')).toMatch(/100/);
  });
  it('never changes the lines it was given', () => { const l = L(); captionEdits(l, [{ action: 'delete', id: 'a' }], 10000); expect(l).toEqual(L()); });
});
describe('linesIn', () => {
  it('lists the lines overlapping a range in seconds, capped', () => {
    expect(linesIn(L(), 1.8, 3.6, 200)).toEqual([{ id: 'b', start: 2, end: 3, text: 'second' }, { id: 'c', start: 3.5, end: 4.5, text: 'third' }]);
    expect(linesIn(L(), undefined, undefined, 2)).toHaveLength(2);
  });
});
describe('gradeInput', () => {
  const ctx = { looks: [{ id: 'lk1', name: 'Warm' }], matched: true };
  it('maps slider units to stored values and clamps', () => {
    const r = gradeInput({}, { temp: 20, exposure: 300, strength: 50 }, ctx);
    expect(r.values.exposure).toBe(gradeInput({}, { exposure: 100 }, ctx).values.exposure); expect(r.notes.join(' ')).toMatch(/exposure/);
    expect(Object.keys(r.values).sort()).toEqual(['exposure', 'strength', 'temp']);
  });
  it('accepts matched, none or a brand look, and refuses the rest', () => {
    expect(gradeInput({}, { look: 'lk1' }, ctx).look).toBe('lk1');
    expect(gradeInput({}, { look: 'none' }, ctx).values.strength).toBe(0);
    expect(gradeInput({}, { look: 'matched' }, { ...ctx, matched: false }).notes[0]).toMatch(/matched/);
    expect(gradeInput({}, { look: 'teal' }, ctx).notes[0]).toMatch(/lk1/);
  });
});
describe('audioInput', () => {
  const A = { vol: 1, music: { src: 'm', name: 'Chill', vol: 0.6, duck: true } };
  it('sets volumes in 0–100, ducking, and removes music', () => {
    expect(audioInput(A, { originalVolume: 40, music: { volume: 30, ducking: false } }, { hasMusic: true }).audio).toEqual({ vol: 0.4, music: { src: 'm', name: 'Chill', vol: 0.3, duck: false } });
    expect(audioInput(A, { music: { remove: true } }, { hasMusic: true }).audio.music).toBe(null);
  });
  it('asks to compose by mood, refuses unknown moods and settings on no music', () => {
    expect(audioInput(A, { music: { compose: 'chill', volume: 50 } }, { hasMusic: true }).compose).toBe('chill');
    expect(audioInput(A, { music: { compose: 'jazz' } }, { hasMusic: true }).notes[0]).toMatch(/upbeat, chill, corporate, cinematic/);
    expect(audioInput({ vol: 1, music: null }, { music: { volume: 20 } }, { hasMusic: false }).notes[0]).toMatch(/no music/i);
  });
});
describe('analysisState', () => {
  it('reads the server record', () => {
    expect(analysisState(null, null).state).toBe('no video');
    expect(analysisState({ status: 'ready', jobs: { transcribe: { state: 'running', progress: 0.4 } } }, null)).toEqual({ state: 'running', label: 'transcribing 40%' });
    expect(analysisState({ status: 'failed', jobs: { transcribe: { state: 'failed', error: 'x' } } }, null)).toEqual({ state: 'failed', label: 'transcribe failed' });
    expect(analysisState({ status: 'ready', jobs: { transcribe: { state: 'done' }, grade: { state: 'done' } } }, null)).toEqual({ state: 'ready', label: 'ready' });
  });
});
describe('videoCtx', () => {
  it('summarises the video in the model\'s units', () => {
    const d = { footage: { src: 'f1', dur: 42300, out: { w: 1080, h: 1920 }, lookId: 'lk1', look: { lut: 'looks/lk1.cube', strength: 0.8, exposure: 0, temp: 0.15, sat: -0.05 }, audio: { vol: 0.5, music: { name: 'Chill', vol: 0.6, duck: true } } } };
    const v = videoCtx({ d, caps: { on: true, preset: 'viral-yellow', lang: 'en', lines: L() }, style: { font: 'sans-bold', size: 0.058, maxWords: 3 }, state: { state: 'ready', label: 'ready' }, looks: [{ id: 'lk1', name: 'Warm' }], matched: true, maxLines: 2 });
    expect(v.seconds).toBe(42.3); expect(v.size).toBe('1080×1920'); expect(v.analysis).toBe('ready');
    expect(v.captions).toMatchObject({ on: true, preset: 'viral-yellow', language: 'en', lines: 3 });
    expect(v.lines).toHaveLength(2); expect(v.moreLines).toBe(true);
    expect(v.grade).toEqual({ kind: 'brand look', look: 'Warm', strength: 80, exposure: 0, temp: 15, sat: -5, matchedAvailable: true });
    expect(v.audio).toEqual({ originalVolume: 50, music: { name: 'Chill', volume: 60, ducking: true } });
    expect(v.brandLooks).toEqual([{ id: 'lk1', name: 'Warm' }]);
  });
});

describe('review fixes', () => {
  it('keeps a video editable when only a side step failed, and names the step', () => {
    const rec = { status: 'ready', jobs: { transcribe: { state: 'done' }, grade: { state: 'failed', error: 'x' } } };
    expect(analysisState(rec, null)).toEqual({ state: 'ready', label: 'ready (grade failed)' });
  });
  it('names the failed step in the context when the whole analysis failed', () => {
    const d = { footage: { src: 'f1', dur: 1000, out: { w: 1, h: 1 }, look: {} } };
    expect(videoCtx({ d, caps: { lines: [] }, style: {}, state: { state: 'failed', label: 'proxy failed' }, looks: [], matched: false, maxLines: 5 }).analysis).toBe('failed: proxy failed');
  });
  it('turns "no colour grade" into neutral sliders with no strength (a state the editor keeps), letting given sliders win', () => {
    const r = gradeInput({}, { look: 'none' }, { looks: [], matched: false });
    expect(r.look).toBeUndefined(); expect(r.values).toEqual({ strength: 0, exposure: 0, temp: 0, sat: 0 });
    expect(gradeInput({}, { look: 'none', temp: 10 }, { looks: [], matched: false }).values.temp).toBe(0.1);
  });
});
