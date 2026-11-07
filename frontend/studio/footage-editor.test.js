import { describe, it, expect } from 'vitest';
import { coverCrop, fitBox, canvasSize, fmtMs } from './footage-player.js';
import { useMatchedGrade, peakBuckets, fitPeaks, rangeLabel, lineText, analysis, analysisPatch, applyPatch, firstFailed, lookPath, shouldRefreshProxy, stepInfo, urlExpiry,
  gradeToSlider, sliderToGrade, gradePatch, GRADE_RESET, maxWordsOf, thumbTime, thumbSize, lookRecord, applyLookTo, exportSizes, exportPayload, exportName, canExport,
  canUseMatched, matchedGradePatch, LOOK_DELETED, textCommit, prepareOpen } from './footage-editor.js';
import { CAPTIONS_DEFAULT, styleOf } from './caption-store.js';
import { DEFAULT_STYLE } from './captions.js';

const cp = (o = {}) => ({ ...CAPTIONS_DEFAULT, lang: 'ar', ...o, lines: o.lines || [] });
const W = (t, s, e) => ({ t, s, e, p: 1 });
const ft = (o = {}) => ({ src: 'a'.repeat(24), ref: null, look: { lut: null, strength: 1, exposure: 0, temp: 0, sat: 0 }, out: { w: 1080, h: 1920, fps: 30 }, ...o });

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
  it('is not settled while a step is queued or running, even when the status already says ready (race with the runner)', () => {
    expect(analysis(rec('ready', { transcribe: { state: 'queued' } }), null).settled).toBe(false);
    expect(analysis(rec('ready', { grade: { state: 'running' } }), rec('ready')).settled).toBe(false);
    expect(analysis(rec('ready'), rec('ready', { 'caption-style': { state: 'queued' } })).settled).toBe(false);
    expect(analysis(rec('ready', { transcribe: { state: 'done' }, grade: { state: 'failed' } }), null).settled).toBe(true);
    // a fatal failure leaves later steps persisted as queued: the record is still settled
    expect(analysis(rec('failed', { proxy: { state: 'failed' }, transcribe: { state: 'queued' } }), null).settled).toBe(true);
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
    const p = analysisPatch(cp(), ft(), { id, words, refStyle, hasCube: true });
    expect(p.style).toBe(refStyle); expect(p.lut).toBe(lookPath(id)); expect(p.lut).toBe(`footage/${id}/look.cube`);
    expect(p.lines.map((l) => l.words.map((w) => w.t))).toEqual([['مرحبا', 'بكم'], ['في', 'الفيديو']]); // maxWords 2 from the reference
    const c = cp(), d = applyPatch(c, ft(), p);
    expect(c.lines).toHaveLength(2); expect(c.style).toBe(refStyle); expect(d.look.lut).toBe(lookPath(id));
  });
  it('never replaces what the design already has', () => {
    const mine = { ...DEFAULT_STYLE, color: '#000000' }, line = { id: 'x', start: 0, end: 300, words: [W('hi', 0, 300)] };
    const f = ft({ look: { lut: 'looks/brand.cube', strength: 1, exposure: 0, temp: 0, sat: 0 } });
    expect(analysisPatch(cp({ style: mine, lines: [line], lang: 'en' }), f, { id, words, refStyle, hasCube: true })).toBeNull();
  });
  it('groups with the default style when there is none, and returns null with nothing to add', () => {
    const p = analysisPatch(cp(), ft(), { id, words, refStyle: null, hasCube: false });
    expect(p).toEqual({ lines: expect.any(Array) }); expect(p.lines[0].words).toHaveLength(3); // DEFAULT_STYLE.maxWords
    expect(analysisPatch(cp(), ft(), { id, words: [], refStyle: null, hasCube: false })).toBeNull();
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

describe('waveform peaks and labels', () => {
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

describe('maxWordsOf', () => {
  it('words per line of a style, 1..8, the default when unset', () => {
    expect(maxWordsOf(null)).toBe(DEFAULT_STYLE.maxWords); expect(maxWordsOf({ maxWords: 20 })).toBe(8); expect(maxWordsOf({ maxWords: 2 })).toBe(2);
  });
});

describe('where the subtitle style came from', () => {
  const words = [W('a', 0, 300), W('b', 300, 600)], id = 'a'.repeat(24), refStyle = { ...DEFAULT_STYLE, maxWords: 2 };
  it('a reference style fills a style that is not the user\'s yet', () => {
    expect(analysisPatch(cp(), ft(), { id, words, refStyle, hasCube: false }).style).toBe(refStyle);
    const c = cp(); applyPatch(c, ft(), analysisPatch(c, ft(), { id, words, refStyle, hasCube: false })); expect(c.style).toBe(refStyle);
  });
  it('styleFrom: reference, or default when the reference fell back (captionNote)', () => {
    expect(analysisPatch(cp(), ft(), { id, words, refStyle, hasCube: false }).styleFrom).toBe('reference');
    expect(analysisPatch(cp(), ft(), { id, words, refStyle, refNote: 'x', hasCube: false }).styleFrom).toBe('default');
    const c = cp(); applyPatch(c, ft(), analysisPatch(c, ft(), { id, words, refStyle, hasCube: false })); expect(c.styleFrom).toBe('reference');
  });
  it('a style copied in the inspector (Reference tab) is never replaced by the import\'s reference', () => {
    const copied = { ...DEFAULT_STYLE, color: '#00ff00' }, c = cp({ style: copied, styleFrom: 'reference' });
    const p = analysisPatch(c, ft(), { id, words, refStyle, hasCube: false }); expect(p.style).toBeUndefined();
    applyPatch(c, ft(), p); expect(c.style).toBe(copied); expect(c.lines[0].words.length).toBe(2); // grouped with the copied style
  });
  it('a style or a preset the user owns is never replaced', () => {
    const c = cp({ style: { ...DEFAULT_STYLE, maxWords: 4 } });
    const p = analysisPatch(c, ft(), { id, words, refStyle, hasCube: false });
    expect(p.style).toBeUndefined(); applyPatch(c, ft(), p); expect(c.style.maxWords).toBe(4);
    expect(analysisPatch(cp({ preset: 'neon' }), ft(), { id, words, refStyle, hasCube: false }).style).toBeUndefined();
  });
});

describe('prepareOpen', () => {
  it('moves legacy footage captions onto the design and says to save; a second call changes nothing', () => {
    const lines = [{ id: 'l', start: 0, end: 1, words: [W('a', 0, 1)] }];
    const d = { id: 'd1', footage: { ...ft(), captions: { style: null, lines, lang: 'ar' } } };
    expect(prepareOpen(d)).toBe(true);
    expect(d.captions.lines).toEqual(lines); expect(d.footage.captions).toBeUndefined();
    expect(prepareOpen(d)).toBe(false);
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
    const c = cp(); expect(applyLookTo(c, f, look)).toBe(true);
    expect(f.look).toEqual({ lut: 'looks/ab12.cube', strength: 0.5, exposure: 0.2, temp: 0, sat: 0 }); expect(f.lookId).toBe('ab12');
    expect(c.style).toEqual(look.captionStyle); expect(c.style).not.toBe(look.captionStyle);
  });
  it('same words per line: no regroup; given lines are stored; a look without a style keeps the current one', () => {
    const f = ft(), c = cp({ style: { ...DEFAULT_STYLE, maxWords: 2 } }), lines = [{ id: 'l', start: 0, end: 1, words: [] }];
    expect(applyLookTo(c, f, look, lines)).toBe(false); expect(c.lines).toBe(lines);
    const g = ft(), c2 = cp({ style: DEFAULT_STYLE });
    expect(applyLookTo(c2, g, { id: 'q', name: 'n', lut: 'looks/q.cube' })).toBe(false); expect(c2.style).toBe(DEFAULT_STYLE); expect(g.look.lut).toBe('looks/q.cube');
  });
});

describe('export', () => {
  it('sizes: the reference, then the short side at 720 and 2160', () => {
    expect(exportSizes({ w: 1080, h: 1920 }).map((s) => s.label)).toEqual(['1080 × 1920 (reference)', '720 × 1280', '2160 × 3840']);
    expect(exportSizes({ w: 1920, h: 1080 }).map((s) => s.label)).toEqual(['1920 × 1080 (reference)', '1280 × 720', '3840 × 2160']);
    expect(exportSizes({ w: 1080, h: 1350 }).map((s) => [s.w, s.h])).toEqual([[1080, 1350], [720, 900], [2160, 2700]]);
    expect(exportSizes({ w: 720, h: 1280 }).map((s) => s.label)).toEqual(['720 × 1280 (reference)', '2160 × 3840']); // no duplicate
    expect(exportSizes({ w: 1081, h: 1921 }).every((s) => s.w % 2 === 0 && s.h % 2 === 0)).toBe(true);
    expect(exportSizes({ w: 1080, h: 3000 }).map((s) => s.label)).toEqual(['1080 × 3000 (reference)', '720 × 2000']); // 2160 × 6000 is too big
  });
  it('payload carries the footage, the size and the fps', () => {
    const d = { id: 'd1', name: 'x', footage: ft(), captions: cp({ lines: [{ id: 'l', start: 0, end: 1, words: [W('a', 0, 1)] }] }) };
    const p = exportPayload(d, { w: 720, h: 1280 });
    expect(p).toEqual({ designId: 'd1', footage: { src: 'a'.repeat(24), look: d.footage.look, captions: { style: styleOf(d), lines: d.captions.lines }, out: d.footage.out }, w: 720, h: 1280, fps: 30 });
    const off = exportPayload({ ...d, captions: { ...d.captions, on: false } }, { w: 720, h: 1280 });
    expect(off.footage.captions).toEqual({ style: null, lines: [] });
    expect(exportPayload({ ...d, footage: { ...d.footage, out: { w: 1, h: 1, fps: 29 } } }, { w: 720, h: 1280 }).fps).toBe(30);
  });
  it('file name and readiness', () => {
    expect(exportName({ name: 'Interview · matched' }, { w: 1080, h: 1920 })).toBe('Interview-matched-1080x1920.mp4');
    expect(exportName({ name: 'مرحبا بكم' }, { w: 720, h: 1280 })).toBe('مرحبا-بكم-720x1280.mp4');
    expect(canExport({ status: 'ready', jobs: {} }, null)).toBe(true);
    expect(canExport({ status: 'processing', jobs: {} }, null)).toBe(false);
    expect(canExport({ status: 'ready', jobs: {} }, { status: 'processing' })).toBe(false);
    expect(canExport({ status: 'ready', jobs: { grade: { state: 'skipped' }, 'caption-style': { state: 'skipped' } } }, null)).toBe(true);
    expect(canExport(null, null)).toBe(false);
  });
});

describe('back to the matched grade', () => {
  const id = 'a'.repeat(24), done = { state: 'done' };
  it('is offered when a brand look is applied and the grade is done', () => {
    expect(canUseMatched(ft({ lookId: 'l1', look: { lut: 'looks/l1.cube', strength: 1 } }), done, id)).toBe(true);
    expect(canUseMatched(ft({ look: { lut: lookPath(id) } }), done, id)).toBe(false);
    expect(canUseMatched(ft({ look: { lut: 'looks/l1.cube' } }), { state: 'running' }, id)).toBe(false);
    expect(canUseMatched(ft({ look: { lut: 'looks/l1.cube' } }), { state: 'failed' }, id)).toBe(false);
    expect(canUseMatched(ft(), done, id)).toBe(false);
  });
  it('the patch points the look at the footage cube and clears the brand look, keeping the sliders', () => {
    const f = ft({ lookId: 'l1', look: { lut: 'looks/l1.cube', strength: 0.5, exposure: 0.2, temp: 0, sat: 0 } });
    const p = matchedGradePatch(f, id);
    expect(p).toEqual({ lut: lookPath(id), lookId: null });
    applyPatch(cp(), f, p);
    expect(f.look).toEqual({ lut: lookPath(id), strength: 0.5, exposure: 0.2, temp: 0, sat: 0 }); expect(f.lookId).toBeNull();
    expect(matchedGradePatch(f, id)).toBeNull();
  });
  it('useMatchedGrade applies the patch to the design (caps, footage) in place', () => {
    const d = { footage: ft({ lookId: 'l1', look: { lut: 'looks/l1.cube', strength: 0.5, exposure: 0, temp: 0, sat: 0 } }), captions: cp() };
    expect(useMatchedGrade(d, id)).toBe(true);
    expect(d.footage.look.lut).toBe(lookPath(id)); expect(d.footage.lookId).toBeNull();
    expect(useMatchedGrade(d, id)).toBe(false);
  });
  it('lines from the analysis are the speech\'s: source speech, no voice-over signature', () => {
    const c = cp({ source: 'manual', voSig: 'x' }), f = ft();
    applyPatch(c, f, { lines: [{ id: 'a', start: 0, end: 1, words: [] }] });
    expect(c.source).toBe('speech'); expect(c.voSig).toBeNull();
    const c2 = cp({ source: 'manual' }); applyPatch(c2, f, { lut: lookPath(id) }); expect(c2.source).toBe('manual');
  });
  it('the deleted-look note', () => expect(LOOK_DELETED).toBe('This brand look was deleted. Use the matched grade instead.'));
});

describe('textCommit (a field committed before a drag)', () => {
  const lines = [{ id: 'x', start: 0, end: 1000, words: [W('hello', 0, 400), W('there', 500, 1000)] }, { id: 'y', start: 1200, end: 2000, words: [W('bye', 1200, 2000)] }];
  it('returns the lines with the typed text, other lines untouched', () => {
    const out = textCommit(lines, 'x', 'hello  world ');
    expect(lineText(out[0])).toBe('hello world'); expect(out[0].start).toBe(0); expect(out[0].end).toBe(1000);
    expect(out[1]).toBe(lines[1]);
  });
  it('returns null when nothing changes or the line is gone', () => {
    expect(textCommit(lines, 'x', '  hello there ')).toBeNull();
    expect(textCommit(lines, 'zz', 'a')).toBeNull();
  });
});

describe('the caption language', () => {
  it('applyPatch stores the language read from the lines when none is set, and clears the preset on a new style', () => {
    const ar = [{ id: 'a', start: 0, end: 1, words: [{ t: 'مرحبا', s: 0, e: 1 }] }];
    const c = { lines: [], style: null, preset: 'x', lang: null }; applyPatch(c, { look: {} }, { lines: ar, style: { size: 0.05 } });
    expect(c.lang).toBe('ar'); expect(c.preset).toBe(null);
    const c2 = { lines: [], lang: 'en' }; applyPatch(c2, { look: {} }, { lines: ar }); expect(c2.lang).toBe('en');
  });
});

import { fmtBytes, hasRefPair, REPLACE_ASK as FE_REPLACE_ASK } from './footage-editor.js';
describe('Media and Look helpers', () => {
  it('formats a file size', () => {
    expect(fmtBytes(24e6)).toBe('24 MB');
    expect(fmtBytes(1.24e9)).toBe('1.2 GB');
    expect(fmtBytes(10)).toBe('1 MB');
  });
  it('knows a record paired with a reference (Match a reference vs Change the reference)', () => {
    expect(hasRefPair({ pair: { ref: 'r1' } })).toBe(true);
    expect(hasRefPair({ pair: { lookId: 'l1' } })).toBe(false);
    expect(hasRefPair({ pair: {} })).toBe(false);
    expect(hasRefPair(null)).toBe(false);
    expect(FE_REPLACE_ASK).toBe('Replace this video? Captions will be made again from the new video.');
  });
});
