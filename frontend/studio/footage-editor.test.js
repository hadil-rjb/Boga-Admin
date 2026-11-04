import { describe, it, expect } from 'vitest';
import { coverCrop, fitBox, canvasSize, fmtMs } from './footage-player.js';
import { clampDrag, peakBuckets, fitPeaks, rangeLabel, lineText, analysis, analysisPatch, applyPatch, firstFailed, lookPath, shouldRefreshProxy, stepInfo, urlExpiry,
  gradeToSlider, sliderToGrade, gradePatch, GRADE_RESET, styleEdit, styleOrigin, ORIGIN_COPY, clampY, colorHex, maxWordsOf, thumbTime, thumbSize, lookRecord, applyLookTo } from './footage-editor.js';
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

describe('grade sliders', () => {
  it('map to integers: strength 0..100, the others -100..100', () => {
    expect(gradeToSlider('strength', 1)).toBe(100); expect(gradeToSlider('strength', 0)).toBe(0); expect(gradeToSlider('strength', undefined)).toBe(100);
    expect(gradeToSlider('exposure', -0.5)).toBe(-50); expect(gradeToSlider('sat', 2)).toBe(100); expect(gradeToSlider('temp', -3)).toBe(-100);
    expect(gradeToSlider('strength', -1)).toBe(0);
    expect(sliderToGrade('strength', 100)).toBe(1); expect(sliderToGrade('strength', 0)).toBe(0); expect(sliderToGrade('strength', 150)).toBe(1); expect(sliderToGrade('strength', -5)).toBe(0);
    expect(sliderToGrade('exposure', -100)).toBe(-1); expect(sliderToGrade('temp', '25')).toBe(0.25); expect(sliderToGrade('sat', 0)).toBe(0);
    expect(Object.is(sliderToGrade('sat', -0.2), 0)).toBe(true); // no negative zero
  });
  it('round-trips every slider step', () => { for (const k of ['strength', 'exposure']) for (let n = k === 'strength' ? 0 : -100; n <= 100; n++) expect(gradeToSlider(k, sliderToGrade(k, n))).toBe(n); });
  it('gradePatch changes one value without mutating; reset restores the defaults', () => {
    const look = { lut: 'x', strength: 1, exposure: 0, temp: 0, sat: 0 }, p = gradePatch(look, 'exposure', 40);
    expect(p).toEqual({ lut: 'x', strength: 1, exposure: 0.4, temp: 0, sat: 0 }); expect(look.exposure).toBe(0);
    expect({ ...p, ...GRADE_RESET }).toEqual(look);
  });
});

describe('subtitle style edits', () => {
  it('start from the default style when there is none, and never mutate', () => {
    const before = JSON.stringify(DEFAULT_STYLE), s = styleEdit(null, 'font', 'serif');
    expect(s.font).toBe('serif'); expect(s.color).toBe(DEFAULT_STYLE.color); expect(JSON.stringify(DEFAULT_STYLE)).toBe(before);
    const own = { ...DEFAULT_STYLE, color: '#111111' }; styleEdit(own, 'color', '#222222'); expect(own.color).toBe('#111111');
  });
  it('font accepts only the four stacks; size, weight, y and colors are validated and clamped', () => {
    expect(styleEdit(null, 'font', 'comic').font).toBe('sans-bold');
    expect(styleEdit(null, 'size', 6).size).toBe(0.06); expect(styleEdit(null, 'size', 99).size).toBe(0.1); expect(styleEdit(null, 'size', 0).size).toBe(0.02); expect(styleEdit(null, 'size', 'x').size).toBe(DEFAULT_STYLE.size);
    expect(styleEdit(null, 'weight', '700').weight).toBe(700);
    expect(styleEdit(null, 'y', 80).y).toBe(0.8); expect(styleEdit(null, 'y', 1).y).toBe(0.05); expect(styleEdit(null, 'y', 100).y).toBe(0.95);
    expect(styleEdit(null, 'color', '#abcdef').color).toBe('#abcdef'); expect(styleEdit(null, 'color', 'red').color).toBe('#FFFFFF');
    expect(styleEdit(null, 'nope', 1)).toEqual(DEFAULT_STYLE);
  });
  it('stroke and shadow switch on with defaults and keep their values while on', () => {
    const on = styleEdit(null, 'strokeOn', true); expect(on.stroke).toEqual({ color: '#000000', width: 0.004 });
    const w = styleEdit(on, 'strokeWidth', 12); expect(w.stroke).toEqual({ color: '#000000', width: 0.012 });
    expect(styleEdit(w, 'strokeColor', '#ff0000').stroke).toEqual({ color: '#ff0000', width: 0.012 });
    expect(styleEdit(w, 'strokeOn', false).stroke).toBeNull();
    expect(styleEdit(null, 'shadowOn', false).shadow).toBeNull(); expect(styleEdit(styleEdit(null, 'shadowOn', false), 'shadowOn', true).shadow).toEqual(DEFAULT_STYLE.shadow);
  });
  it('highlight: mode, colors; none keeps the colors for later', () => {
    const a = styleEdit(null, 'hlColor', '#00ff00'); expect(a.highlight).toEqual({ ...DEFAULT_STYLE.highlight, color: '#00ff00' });
    const b = styleEdit(a, 'hlMode', 'none'); expect(b.highlight.mode).toBe('none'); expect(b.highlight.color).toBe('#00ff00');
    expect(styleEdit(b, 'hlMode', 'glow').highlight.mode).toBe('none');
    expect(styleEdit(null, 'hlText', '#000000').highlight.text).toBe('#000000');
    expect(styleEdit({ ...DEFAULT_STYLE, highlight: null }, 'hlMode', 'scale').highlight).toEqual({ ...DEFAULT_STYLE.highlight, mode: 'scale' });
    expect(styleEdit(null, 'anim', 'pop').anim).toBe('pop'); expect(styleEdit(null, 'anim', 'spin').anim).toBe('none');
  });
  it('clampY, colorHex, maxWordsOf', () => {
    expect(clampY(0)).toBe(0.05); expect(clampY(2)).toBe(0.95); expect(clampY(0.6504)).toBe(0.65);
    expect(colorHex('#ABC')).toBe('#aabbcc'); expect(colorHex('rgba(0,0,0,.5)', '#123456')).toBe('#123456'); expect(colorHex(null)).toBe('#ffffff');
    expect(maxWordsOf(null)).toBe(DEFAULT_STYLE.maxWords); expect(maxWordsOf({ maxWords: 20 })).toBe(8); expect(maxWordsOf({ maxWords: 2 })).toBe(2);
  });
});

describe('where the subtitle style came from (styleFrom)', () => {
  const words = [W('a', 0, 300), W('b', 300, 600)], id = 'a'.repeat(24), refStyle = { ...DEFAULT_STYLE, maxWords: 2 };
  it('the reference style marks styleFrom reference, or default when the reference fell back (captionNote)', () => {
    expect(analysisPatch(ft(), { id, words, refStyle, hasCube: false }).styleFrom).toBe('reference');
    expect(analysisPatch(ft(), { id, words, refStyle, refNote: 'Could not read it', hasCube: false }).styleFrom).toBe('default');
    expect(applyPatch(ft(), analysisPatch(ft(), { id, words, refStyle, hasCube: false })).captions.styleFrom).toBe('reference');
  });
  it('a style the user owns is never replaced, so styleFrom stays custom (e.g. after a words-per-line edit materialised the default)', () => {
    const f = ft({ captions: { style: { ...DEFAULT_STYLE, maxWords: 4 }, styleFrom: 'custom', lines: [], lang: 'ar' } });
    const p = analysisPatch(f, { id, words, refStyle, hasCube: false });
    expect(p.style).toBeUndefined(); expect(p.styleFrom).toBeUndefined();
    expect(applyPatch(f, p).captions.styleFrom).toBe('custom'); expect(f.captions.style.maxWords).toBe(4);
  });
  it('styleOrigin: the stored origin, else guessed from the style and the reference', () => {
    expect(styleOrigin({ style: null }, true)).toBe('default'); expect(styleOrigin({ style: DEFAULT_STYLE }, true)).toBe('reference'); expect(styleOrigin({ style: DEFAULT_STYLE }, false)).toBe('look');
    for (const k of ['reference', 'look', 'default', 'custom']) expect(styleOrigin({ style: DEFAULT_STYLE, styleFrom: k }, true)).toBe(k);
    expect(styleOrigin({ style: DEFAULT_STYLE, styleFrom: 'bogus' }, false)).toBe('look'); expect(styleOrigin(undefined, false)).toBe('default');
    expect(ORIGIN_COPY.custom).toBe('Subtitles use your own style.');
  });
});

describe('brand looks', () => {
  it('thumbnail time is frame 30 of 60 and the size is 160 px wide', () => {
    expect(thumbTime(60)).toBeCloseTo(29.5, 9); expect(thumbTime(0)).toBe(0); expect(thumbSize(1080, 1920)).toEqual({ w: 160, h: 284 }); expect(thumbSize(0, 0).w).toBe(160);
  });
  it('lookRecord has the stored shape, a clean name and its own copy of the style', () => {
    const style = { ...DEFAULT_STYLE }, r = lookRecord({ id: 'ab12', name: '  Warm   glow ', lut: 'looks/ab12.cube', captionStyle: style, refThumb: 'data:image/jpeg;base64,xx', now: new Date('2026-11-04T10:00:00Z') });
    expect(r).toEqual({ id: 'ab12', name: 'Warm glow', lut: 'looks/ab12.cube', captionStyle: DEFAULT_STYLE, refThumb: 'data:image/jpeg;base64,xx', createdAt: '2026-11-04T10:00:00.000Z' });
    expect(r.captionStyle).not.toBe(style); expect(lookRecord({ id: 'x', name: '   ', lut: 'l' }).name).toBe('Brand look'); expect(lookRecord({ id: 'x', name: 'n'.repeat(90), lut: 'l' }).name).toHaveLength(60);
    expect(lookRecord({ id: 'x', name: 'n', lut: 'l' }).refThumb).toBeNull();
  });
  const look = { id: 'ab12', name: 'Warm', lut: 'looks/ab12.cube', captionStyle: { ...DEFAULT_STYLE, color: '#00ff00', maxWords: 2 } };
  it('applying sets the cube, lookId, the style (origin look) and reports when the words per line changed', () => {
    const f = ft({ look: { lut: lookPath('a'.repeat(24)), strength: 0.5, exposure: 0.2, temp: 0, sat: 0 } });
    expect(applyLookTo(f, look)).toBe(true);
    expect(f.look).toEqual({ lut: 'looks/ab12.cube', strength: 0.5, exposure: 0.2, temp: 0, sat: 0 }); expect(f.lookId).toBe('ab12');
    expect(f.captions.style).toEqual(look.captionStyle); expect(f.captions.style).not.toBe(look.captionStyle); expect(f.captions.styleFrom).toBe('look');
  });
  it('same words per line: no regroup; given lines are stored; a look without a style keeps the current one', () => {
    const f = ft({ captions: { style: { ...DEFAULT_STYLE, maxWords: 2 }, styleFrom: 'custom', lines: [], lang: 'ar' } }), lines = [{ id: 'l', start: 0, end: 1, words: [] }];
    expect(applyLookTo(f, look, lines)).toBe(false); expect(f.captions.lines).toBe(lines);
    const g = ft({ captions: { style: DEFAULT_STYLE, styleFrom: 'custom', lines: [], lang: 'ar' } });
    expect(applyLookTo(g, { id: 'q', name: 'n', lut: 'looks/q.cube' })).toBe(false); expect(g.captions.styleFrom).toBe('custom'); expect(g.look.lut).toBe('looks/q.cube');
  });
});
