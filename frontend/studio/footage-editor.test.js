import { describe, it, expect } from 'vitest';
import { coverCrop, fitBox, canvasSize, fmtMs } from './footage-player.js';
import { clampDrag, peakBuckets, fitPeaks, rangeLabel, lineText, analysis, analysisPatch, applyPatch, firstFailed, lookPath, shouldRefreshProxy, stepInfo, urlExpiry } from './footage-editor.js';
import { DEFAULT_STYLE } from './captions.js';

const W = (t, s, e) => ({ t, s, e, p: 1 });
const ft = (o = {}) => ({ src: 'a'.repeat(24), ref: null, look: { lut: null, strength: 1, exposure: 0, temp: 0, sat: 0 }, captions: { style: null, lines: [], lang: 'ar' }, out: { w: 1080, h: 1920, fps: 30 }, ...o });

describe('player geometry', () => {
  it('coverCrop keeps the centre: landscape into portrait crops the sides, portrait into landscape crops top and bottom', () => {
    const a = coverCrop(1920, 1080, 1080, 1920);
    expect(a.y).toBe(0); expect(a.h).toBe(1);
    expect(a.w).toBeCloseTo((1080 / 1920) / (1920 / 1080), 9); expect(a.x).toBeCloseTo((1 - a.w) / 2, 9);
    const b = coverCrop(1080, 1920, 1920, 1080);
    expect(b.x).toBe(0); expect(b.w).toBe(1); expect(b.h).toBeCloseTo(0.31640625, 6); expect(b.y + b.h / 2).toBeCloseTo(0.5, 9);
  });
  it('coverCrop of the same aspect, and of unknown sizes, is the whole frame', () => {
    expect(coverCrop(720, 1280, 1080, 1920)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(coverCrop(0, 0, 1080, 1920)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it('fitBox letterboxes the output ratio into the stage', () => {
    expect(fitBox(1000, 800, 1080, 1920)).toEqual({ w: 450, h: 800 });
    expect(fitBox(400, 1000, 1080, 1920)).toEqual({ w: 400, h: 711 });
    expect(fitBox(0, 800, 1080, 1920)).toEqual({ w: 0, h: 0 });
  });
  it('canvasSize uses the device pixel ratio but never exceeds the output size', () => {
    expect(canvasSize(450, 800, 2, 1080, 1920)).toEqual({ w: 900, h: 1600 });
    expect(canvasSize(900, 1600, 2, 1080, 1920)).toEqual({ w: 1080, h: 1920 });
  });
  it('fmtMs', () => { expect(fmtMs(0)).toBe('0:00.0'); expect(fmtMs(62_450)).toBe('1:02.4'); expect(fmtMs(-5)).toBe('0:00.0'); });
});

describe('analysis', () => {
  const rec = (status, jobs = {}) => ({ status, jobs });
  it('is settled only when the original and the reference are ready or failed', () => {
    expect(analysis(rec('processing'), rec('ready')).settled).toBe(false);
    expect(analysis(rec('ready'), rec('processing')).settled).toBe(false);
    expect(analysis(rec('ready'), rec('failed')).settled).toBe(true);
    expect(analysis(rec('failed'), null).settled).toBe(true);
    expect(analysis(null, null).settled).toBe(false);
  });
  it('reports step states, busy and the fatal failure', () => {
    const A = analysis(rec('processing', { transcribe: { state: 'running', progress: 0.4 }, grade: { state: 'failed', error: 'boom' } }), null);
    expect(A.transcribe).toEqual({ state: 'running', progress: 0.4, error: null });
    expect(A.busy(A.transcribe)).toBe(true); expect(A.busy(A.grade)).toBe(false);
    expect(A.grade.error).toBe('boom'); expect(A.style.state).toBe('skipped');
    const B = analysis({ status: 'failed', error: 'HDR10', jobs: { proxy: { state: 'failed' } } }, null);
    expect(B.failed).toBe(true); expect(B.error).toBe('HDR10');
  });
  it('firstFailed follows the pipeline order', () => {
    expect(firstFailed({ jobs: { grade: { state: 'failed' }, proxy: { state: 'failed' } } })).toBe('proxy');
    expect(firstFailed({ jobs: { grade: { state: 'done' } } })).toBeNull();
    expect(stepInfo(null, 'grade')).toEqual({ state: undefined, progress: 0, error: null });
  });
});

describe('analysisPatch (results the design still lacks)', () => {
  const words = [W('مرحبا', 0, 300), W('بكم', 300, 600), W('في', 600, 800), W('الفيديو', 800, 1200)];
  const id = 'a'.repeat(24), refStyle = { ...DEFAULT_STYLE, maxWords: 2, color: '#F3F4F6' };
  it('fills empty lines (grouped with the reference style), a missing style and the grade marker', () => {
    const p = analysisPatch(ft(), { id, words, refStyle, hasCube: true });
    expect(p.style).toBe(refStyle); expect(p.lut).toBe(lookPath(id)); expect(p.lut).toBe(`footage/${id}/look.cube`);
    expect(p.lines.map((l) => l.words.map((w) => w.t))).toEqual([['مرحبا', 'بكم'], ['في', 'الفيديو']]); // maxWords 2 from the reference
    const d = applyPatch(ft(), p);
    expect(d.captions.lines).toHaveLength(2); expect(d.captions.style).toBe(refStyle); expect(d.look.lut).toBe(lookPath(id));
  });
  it('never replaces what the design already has', () => {
    const mine = { ...DEFAULT_STYLE, color: '#000000' }, line = { id: 'x', start: 0, end: 300, words: [W('hi', 0, 300)] };
    const f = ft({ look: { lut: 'looks/brand.cube', strength: 1, exposure: 0, temp: 0, sat: 0 }, captions: { style: mine, lines: [line], lang: 'en' } });
    expect(analysisPatch(f, { id, words, refStyle, hasCube: true })).toBeNull();
  });
  it('groups with the default style when there is none, and returns null with nothing to add', () => {
    const p = analysisPatch(ft(), { id, words, refStyle: null, hasCube: false });
    expect(p).toEqual({ lines: expect.any(Array) }); expect(p.lines[0].words).toHaveLength(3); // DEFAULT_STYLE.maxWords
    expect(analysisPatch(ft(), { id, words: [], refStyle: null, hasCube: false })).toBeNull();
  });
});

describe('expired proxy links', () => {
  const url = (exp) => `http://api/footage/x/proxy.mp4?t=${exp}.${'a'.repeat(64)}`;
  it('reads the expiry from the signed URL', () => { expect(urlExpiry(url(1234))).toBe(1234); expect(urlExpiry('http://x/y.mp4')).toBeNull(); });
  it('refreshes an expired or expiring link, and on network / source errors', () => {
    expect(shouldRefreshProxy({ code: 3 }, url(1000), 1000)).toBe(true); // expired: any error
    expect(shouldRefreshProxy({ code: 3 }, url(1050), 1000)).toBe(true); // within a minute
    expect(shouldRefreshProxy({ code: 4 }, url(9000), 1000)).toBe(true); // 403 shows up as a source error
    expect(shouldRefreshProxy({ code: 2 }, url(9000), 1000)).toBe(true);
    expect(shouldRefreshProxy({ code: 3 }, url(9000), 1000)).toBe(false); // a decode error is not a link problem
  });
  it('not twice within 30 s (a broken file would loop)', () => {
    expect(shouldRefreshProxy({ code: 4 }, url(1000), 1000, 990)).toBe(false);
    expect(shouldRefreshProxy({ code: 4 }, url(1000), 1000, 960)).toBe(true);
  });
});

describe('subtitle lane', () => {
  const L = (id, start, end) => ({ id, start, end, words: [] });
  const ls = [L('a', 0, 1000), L('b', 1500, 2500), L('c', 3000, 4000)];
  it('clampDrag keeps 200 ms and the neighbours', () => {
    expect(clampDrag(ls, 1, 'start', 900)).toEqual({ start: 1000, end: 2500 });
    expect(clampDrag(ls, 1, 'start', 2490)).toEqual({ start: 2300, end: 2500 });
    expect(clampDrag(ls, 1, 'end', 1510)).toEqual({ start: 1500, end: 1700 });
    expect(clampDrag(ls, 1, 'end', 9000)).toEqual({ start: 1500, end: 3000 });
    expect(clampDrag(ls, 1, 'start', 1200)).toEqual({ start: 1200, end: 2500 });
  });
  it('clampDrag moves the block without changing its length and stops at neighbours and the video ends', () => {
    expect(clampDrag(ls, 1, 'move', 1700)).toEqual({ start: 1700, end: 2700 });
    expect(clampDrag(ls, 1, 'move', 0)).toEqual({ start: 1000, end: 2000 });
    expect(clampDrag(ls, 1, 'move', 5000)).toEqual({ start: 2000, end: 3000 });
    expect(clampDrag(ls, 0, 'move', -300)).toEqual({ start: 0, end: 1000 });
    expect(clampDrag(ls, 2, 'move', 9000, 4500)).toEqual({ start: 3500, end: 4500 });
    expect(clampDrag(ls, 2, 'end', 9000, 4500)).toEqual({ start: 3000, end: 4500 });
  });
  it('peakBuckets takes the loudest sample of each bucket', () => {
    const p = peakBuckets(Float32Array.from([0.1, -0.5, 0.2, 0.9, -1.5, 0]), 3);
    expect(Array.from(p).map((v) => +v.toFixed(2))).toEqual([0.5, 0.9, 1]);
    expect(peakBuckets(new Float32Array(0), 4)).toHaveLength(4);
  });
  it('fitPeaks gives one value per pixel, wider or narrower than the peak array', () => {
    expect(Array.from(fitPeaks(Float32Array.from([0.2, 0.8, 0.4, 0.6]), 2))).toEqual([Math.fround(0.8), Math.fround(0.6)]);
    expect(fitPeaks(Float32Array.from([0.5, 1]), 4)).toHaveLength(4);
    expect(fitPeaks(null, 5)).toHaveLength(5);
  });
  it('labels', () => {
    expect(rangeLabel({ start: 12400, end: 14100 })).toBe('0:12.4 – 0:14.1');
    expect(lineText({ words: [{ t: 'a' }, { t: 'b' }] })).toBe('a b');
  });
});
