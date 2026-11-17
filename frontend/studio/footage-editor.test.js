import { describe, it, expect } from 'vitest';
import { coverCrop, fitBox, canvasSize, fmtMs } from './footage-player.js';
import { useMatchedGrade, peakBuckets, fitPeaks, rangeLabel, lineText, analysis, analysisPatch, applyPatch, firstFailed, lookPath, shouldRefreshProxy, stepInfo, urlExpiry,
  gradeToSlider, sliderToGrade, gradePatch, GRADE_RESET, maxWordsOf, thumbTime, thumbSize, lookRecord, applyLookTo, exportSizes, exportPayload, exportName, canExport,
  canUseMatched, matchedGradePatch, LOOK_DELETED, textCommit, prepareOpen, ftAudioOf, mediaIdOf, musicRecord, speechSpans, duckAt, musicGainAt, musicTimeAt, DUCK_FLOOR, cutsFor, pausesNote, scenesPane, gradeStatus, rgIconHTML } from './footage-editor.js';
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
    expect(p).toEqual({ designId: 'd1', footage: { src: 'a'.repeat(24), look: d.footage.look, captions: { style: styleOf(d), lines: d.captions.lines }, out: d.footage.out, audio: { vol: 1, music: null } }, w: 720, h: 1280, fps: 30 });
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

describe('audio (original volume, music bed, ducking)', () => {
  const MID = 'c'.repeat(24), SRC = `https://api.x/api/media/${MID}.mp3`;
  it('ftAudioOf: defaults, clamps, and the music only with a src', () => {
    expect(ftAudioOf(ft())).toEqual({ vol: 1, music: null, denoise: false, pauses: { on: false, min: 600 } });
    expect(ftAudioOf(ft({ audio: { vol: 3, music: { src: '' } } }))).toEqual({ vol: 1, music: null, denoise: false, pauses: { on: false, min: 600 } });
    expect(ftAudioOf(ft({ audio: { vol: 0.25, music: { src: SRC, name: 'Chill' } } }))).toEqual({ vol: 0.25, music: { src: SRC, mediaId: MID, name: 'Chill', vol: 0.6, duck: true, dur: 0 }, denoise: false, pauses: { on: false, min: 600 } });
    expect(ftAudioOf(ft({ audio: { vol: -1, music: { src: SRC, vol: 0.2, duck: false, dur: 9000 } } })).music).toMatchObject({ vol: 0.2, duck: false, dur: 9000, name: 'Music' });
  });
  it('mediaIdOf reads the hosted file id; musicRecord keeps what the design stores', () => {
    expect(mediaIdOf(SRC)).toBe(MID); expect(mediaIdOf('/api/media/x.mp3')).toBeNull(); expect(mediaIdOf(null)).toBeNull();
    expect(musicRecord({ src: SRC, name: 'x'.repeat(90), dur: 4000 }, null)).toEqual({ src: SRC, mediaId: MID, name: 'x'.repeat(60), vol: 0.6, duck: true, dur: 4000 });
    expect(musicRecord({ src: SRC, name: 'New', dur: 1 }, { vol: 0.3, duck: false })).toMatchObject({ vol: 0.3, duck: false, name: 'New' });
    expect(musicRecord({ src: 'blob:x' }, null)).toBeNull();
  });
  it('the export payload carries the audio: volume, and the music as mediaId, vol, duck', () => {
    const d = { id: 'd1', name: 'x', footage: ft({ audio: { vol: 0.5, music: { src: SRC, name: 'Chill', vol: 0.3, duck: false } } }), captions: cp() };
    expect(exportPayload(d, { w: 720, h: 1280 }).footage.audio).toEqual({ vol: 0.5, music: { mediaId: MID, vol: 0.3, duck: false } });
  });
  it('speech spans: the words, merged across short gaps; lines without words count whole', () => {
    const lines = [{ start: 0, end: 2000, words: [W('a', 100, 400), W('b', 500, 900), W('c', 1500, 1900)] }, { start: 3000, end: 3600, words: [] }];
    expect(speechSpans(lines)).toEqual([[100, 900], [1500, 1900], [3000, 3600]]);
    expect(speechSpans([])).toEqual([]); expect(speechSpans(null)).toEqual([]);
  });
  it('duckAt: full under speech, a 300 ms ramp around it, 1 away from it', () => {
    const sp = [[1000, 2000]];
    expect(duckAt(1500, sp)).toBe(DUCK_FLOOR); expect(duckAt(1000, sp)).toBe(DUCK_FLOOR);
    expect(duckAt(2150, sp)).toBeCloseTo(DUCK_FLOOR + (1 - DUCK_FLOOR) * 0.5, 6);
    expect(duckAt(500, sp)).toBe(1); expect(duckAt(5000, [])).toBe(1);
    expect(DUCK_FLOOR).toBeGreaterThan(0.1); expect(DUCK_FLOOR).toBeLessThan(0.4); // about the export's 8:1 compressor on speech
  });
  it('musicGainAt: the music volume, dipped under speech only when ducking and the original can be heard', () => {
    const a = { vol: 1, music: { vol: 0.5, duck: true } }, sp = [[1000, 2000]];
    expect(musicGainAt(1500, a, sp, true)).toBeCloseTo(0.5 * DUCK_FLOOR, 6);
    expect(musicGainAt(1500, { ...a, music: { vol: 0.5, duck: false } }, sp, true)).toBe(0.5);
    expect(musicGainAt(1500, a, sp, false)).toBe(0.5); // no original sound: nothing to duck under (the export mixes the music alone)
    expect(musicGainAt(1500, { ...a, vol: 0 }, sp, true)).toBe(0.5); // original at 0: the same
    expect(musicGainAt(1500, { vol: 1, music: null }, sp, true)).toBe(0);
  });
  it('musicTimeAt: the music loops from the start of the video, as the export (aloop)', () => {
    expect(musicTimeAt(2500, 10)).toBeCloseTo(2.5); expect(musicTimeAt(12500, 10)).toBeCloseTo(2.5); expect(musicTimeAt(2500, 0)).toBeCloseTo(2.5);
  });
});

describe('the Scenes panel of an uploaded video', () => {
  const clip = '<div class="body ft-media"><h3>Media</h3><b>clip.mp4</b><button data-act="ftReplace" aria-label="Replace video"></button></div>';
  const ref = '<button data-act="ftMatchRef">Match a reference</button>';
  it('holds the clip, then the reference, under one title, and nothing about the Look', () => {
    const h = scenesPane(clip, ref);
    expect(h.match(/<h3>/g)).toHaveLength(1);
    expect(h).toContain('<h3>Scenes</h3>');
    expect(h).toContain('data-act="ftReplace"'); expect(h).toContain('Match a reference');
    expect(h.indexOf('clip.mp4')).toBeLessThan(h.indexOf('Match a reference'));
    expect(h).not.toMatch(/Colour grade|Brand looks/);
  });
  it('an empty video: the clip part asks for the video and there is no reference yet', () => {
    const h = scenesPane('<div class="body ft-media"><h3>Media</h3><button>Add your video</button></div>', '');
    expect(h).toContain('Add your video'); expect(h).toContain('<h3>Scenes</h3>');
    expect(h).not.toContain('ft-scenes-ref');
  });
  it('nothing to show yet: nothing', () => { expect(scenesPane(null, null)).toBe(null); });
});

describe('the grade status chip', () => {
  it('says where the colours come from in two or three words', () => {
    expect(gradeStatus({ own: true, cube: true, ref: true })).toEqual({ label: 'Matched to reference', tone: 'on' });
    expect(gradeStatus({ own: true, cube: true })).toEqual({ label: 'Matched to brand look', tone: 'on' });
    expect(gradeStatus({ lut: 'x.cube', applied: { name: 'Warm film' } })).toEqual({ label: 'Warm film', tone: 'on' });
    expect(gradeStatus({ lut: 'x.cube' })).toEqual({ label: 'Brand look', tone: 'on' });
    expect(gradeStatus({ adjusted: true })).toEqual({ label: 'Adjusted by hand', tone: '' });
    expect(gradeStatus({})).toEqual({ label: 'No grade', tone: '' });
  });
  it('a deleted brand look warns, whatever else is set', () => {
    expect(gradeStatus({ gone: true, lut: 'x.cube' })).toEqual({ label: 'Look deleted', tone: 'warn' });
  });
});

describe('icon slider rows', () => {
  const h = rgIconHTML('data-ft-g', 'exposure', 'Exposure', '<svg></svg>', -100, 100, 1, 20, '');
  it('show an icon, the slider and its value; the name is a tooltip and the accessible label', () => {
    expect(h).toContain('<svg></svg>'); expect(h).toContain('title="Exposure"'); expect(h).toContain('aria-label="Exposure"');
    expect(h).toContain('data-ft-g="exposure"'); expect(h).toContain('<output>+20</output>');
    expect(h).not.toContain('<span>Exposure</span>');
  });
  it('a one-sided slider has no sign and no centre mark', () => {
    const s = rgIconHTML('data-ft-g', 'strength', 'Strength', '<svg></svg>', 0, 100, 1, 100, 'disabled');
    expect(s).toContain('<output>100</output>'); expect(s).not.toContain('class="ctr"'); expect(s).toContain('disabled');
  });
});

describe('Remove pauses and Reduce noise in the design', () => {
  const words = [W('a', 2000, 2500), W('b', 5000, 5400)];
  it('ftAudioOf reads the switches; cutsFor cuts only while on', () => {
    const a = ftAudioOf(ft({ audio: { denoise: true, pauses: { on: true, min: 800 } } }));
    expect(a).toMatchObject({ denoise: true, pauses: { on: true, min: 800 } });
    expect(cutsFor(a, words, 9000)).toEqual([[0, 1880], [2680, 4880], [5580, 9000]]);
    expect(cutsFor(ftAudioOf(ft()), words, 9000)).toEqual([]);
    expect(cutsFor(a, words, 0)).toEqual([]);
  });
  it('pausesNote says what goes and the new length', () => {
    expect(pausesNote([[0, 1880], [2680, 4880], [5580, 9000]], 9000)).toBe('Removes 7.5 s in 3 places · new length 0:01.5');
    expect(pausesNote([], 9000)).toBe('No pauses that long in this video.');
  });
  it('the export carries the switches only when on', () => {
    const d = { id: 'd1', footage: ft({ audio: { denoise: true, pauses: { on: true, min: 700 } } }), captions: cp() };
    expect(exportPayload(d, { w: 1080, h: 1920 }).footage.audio).toEqual({ vol: 1, music: null, denoise: true, pauses: { min: 700 } });
    const e = { id: 'd1', footage: ft(), captions: cp() };
    expect(exportPayload(e, { w: 1080, h: 1920 }).footage.audio).toEqual({ vol: 1, music: null });
  });
});

describe('the dialect the captions were heard in', async () => {
  const { heardAs } = await import('./footage-editor.js');
  it('names the dialect, else the language, else nothing', () => {
    expect(heardAs({ lang: 'ar', dialect: 'levantine' })).toBe('Levantine Arabic');
    expect(heardAs({ lang: 'ar', dialect: null })).toBe('Arabic');
    expect(heardAs({ lang: 'en' })).toBe('English');
    expect(heardAs(null)).toBeNull();
  });
});

describe('look filters in the editor', async () => {
  const { fxPatch, swatchOf } = await import('./footage-editor.js');
  it('fxPatch changes one thing; swatches differ by filter', () => {
    expect(fxPatch({}, 'filter', 'portrait')).toEqual({ filter: 'portrait', amount: 0.8, shadows: 0.55, highlights: 0.5, grain: 0, vignette: 0 }); // its light balance comes with it
    expect(fxPatch({ fx: { filter: 'warm' } }, 'grain', '35')).toMatchObject({ filter: 'warm', grain: 0.35 });
    expect(fxPatch({ fx: { filter: 'warm', shadows: 0.2 } }, 'highlights', '70')).toMatchObject({ shadows: 0.2, highlights: 0.7 });
    expect(fxPatch({}, 'filter', 'nope').filter).toBe('none');
    expect(swatchOf('bw')).not.toBe(swatchOf('warm'));
  });
});

describe('auto light balance', async () => {
  const { autoLight, lookPixels } = await import('./footage-editor.js');
  /** A w × h frame: a near-white border (window) around a skin-coloured middle of brightness `face` 0..255 */
  const frame = (w, h, face, outer) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, inside = x > w * 0.25 && x < w * 0.75 && y > h * 0.1 && y < h * 0.6; const [r, g, b] = inside ? [face, face * 0.78, face * 0.66] : [outer, outer, outer]; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; } return d; };
  it('a backlit face gets brightened and the window toned down; a well-lit face nothing', () => {
    const a = autoLight(frame(40, 70, 90, 252), 40, 70);
    expect(a.shadows).toBeGreaterThan(0.6); expect(a.highlights).toBeGreaterThan(0.5); expect(a.highlights).toBeLessThanOrEqual(0.7);
    expect(autoLight(frame(40, 70, 190, 160), 40, 70)).toEqual({ shadows: 0, highlights: 0 });
  });
  it('a well-lit face in a dark suit against a window: the shadows lifted a little, the window toned down', () => {
    const w = 40, h = 70, d = frame(w, h, 170, 252);
    for (let y = Math.floor(h * 0.5); y < h; y++) for (let x = Math.floor(w * 0.2); x < w * 0.8; x++) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 20; }
    const a = autoLight(d, w, h);
    expect(a.shadows).toBeGreaterThan(0.2); expect(a.shadows).toBeLessThanOrEqual(0.5); expect(a.highlights).toBeGreaterThan(0.5);
  });
  it('lookPixels brightens the face and leaves skin out of the highlight pull', () => {
    const d = frame(10, 10, 90, 252);
    lookPixels(d, { exposure: 0, temp: 0, sat: 0 }, { filter: 'none', shadows: 1, highlights: 1 });
    expect(d[(3 * 10 + 5) * 4]).toBeGreaterThan(110); expect(d[0]).toBeLessThan(240);
    const skin = frame(10, 10, 170, 100); lookPixels(skin, { exposure: 0, temp: 0, sat: 0 }, { filter: 'none', shadows: 0, highlights: 1 });
    expect(skin[(3 * 10 + 5) * 4]).toBe(170); // a mid-bright face is not darkened
  });
});

describe('playing over removed pauses', async () => {
  const { jumpFor } = await import('./footage-player.js');
  const cuts = [[28600, 29030]], fr = 1000 / 30;
  it('a frame inside the cut jumps half a frame past its end', () => {
    expect(jumpFor(cuts, 28650, fr)).toBeCloseTo(29030 + fr / 2, 6);
  });
  it('the frame shown after the jump (it starts just before the end) plays on: no jump loop', () => {
    expect(jumpFor(cuts, 29000, fr)).toBeNull(); // 30 fps frame 870 covers 29.000-29.033
    expect(jumpFor(cuts, 29040, fr)).toBeNull();
    expect(jumpFor(cuts, 28000, fr)).toBeNull();
  });
});
