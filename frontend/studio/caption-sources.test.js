import { describe, it, expect } from 'vitest';
import { voiceoverWords, alignScript, spreadScript, linesFromScript, parseSubtitles, toSrt, needsRebuild, voSig } from './caption-sources.js';

const style = { maxWords: 5, maxChars: 40 };
const pg = (text, dur) => ({ scene: { vo: { text, dur, src: 'x.mp3' } } });

describe('caption-sources', () => {
  it('times voice-over words inside their scene', () => {
    const pages = [pg('hello there friend', 2000), pg('good bye now', 2000)];
    const tl = { scenes: [{ i: 0, start: 0, dur: 3000 }, { i: 1, start: 3000, dur: 3000 }], total: 6000 };
    const w = voiceoverWords(pages, tl);
    expect(w[0].s).toBe(150);
    expect(w[w.length - 1].e).toBe(3000 + 150 + 2000);
  });
  it('aligns an Arabic script with diacritics to speech words', () => {
    const speech = [{ t: 'صباح', s: 0, e: 400 }, { t: 'الخير', s: 400, e: 900 }];
    const r = alignScript('صَبَاحُ الخَيْرِ!', speech);
    expect(r.matched).toBe(1);
    expect(r.words.map((w) => w.s)).toEqual([0, 400]);
  });
  it('falls back to spreading under 40% matches', () => {
    expect(linesFromScript('a b c d e', { speechWords: [{ t: 'x', s: 0, e: 100 }], start: 0, end: 5000, style }).spread).toBe(true);
  });
  it('keeps script line breaks as caption breaks', () => {
    const r = linesFromScript('one two\nthree', { speechWords: [], start: 0, end: 3000, style });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1].words.map((w) => w.t)).toEqual(['three']);
  });
  it('spreads by characters', () => {
    const r = spreadScript('ab cdef', 0, 600);
    expect(r.words.map((w) => [w.s, w.e])).toEqual([[0, 200], [200, 600]]);
  });
  it('parses SRT with BOM, CRLF, ids and <i> tags', () => {
    const t = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> world\r\n\r\n';
    expect(parseSubtitles(t)[0]).toMatchObject({ start: 1000, end: 2500 });
    expect(parseSubtitles(t)[0].words.map((w) => w.t)).toEqual(['Hello', 'world']);
  });
  it('parses VTT with header, NOTE blocks and dot milliseconds', () => {
    const l = parseSubtitles('WEBVTT\n\nNOTE x\n\n00:01.000 --> 00:02.000\nHi');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ start: 1000, end: 2000 });
  });
  it('throws on a file with no cues', () => {
    expect(() => parseSubtitles('hello')).toThrow('This file has no readable captions');
  });
  it('toSrt round-trips through parseSubtitles', () => {
    const src = parseSubtitles('1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n2\n01:00:03,250 --> 01:00:04,000\nBye');
    const back = parseSubtitles(toSrt(src));
    expect(back.map((l) => [l.start, l.end, l.words.map((w) => w.t).join(' ')])).toEqual(src.map((l) => [l.start, l.end, l.words.map((w) => w.t).join(' ')]));
  });
  it('needsRebuild only for manual captions whose voice-over changed', () => {
    const pages = [pg('hello', 1000)];
    expect(needsRebuild({ source: 'voiceover', voSig: 'zzz' }, pages)).toBe(false);
    expect(needsRebuild({ source: 'manual', voSig: voSig(pages) }, pages)).toBe(false);
    expect(needsRebuild({ source: 'manual', voSig: voSig(pages) }, [pg('hello world', 1000)])).toBe(true);
  });
  it('splits cues on whitespace-only separator lines', () => {
    const l = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nA\n \t\n2\n00:00:03,000 --> 00:00:04,000\nB\n');
    expect(l.map((x) => x.start)).toEqual([1000, 3000]);
  });
  it('gives every aligned word a positive duration and non-decreasing times', () => {
    const sp = [{ t: 'a', s: 0, e: 100 }, { t: 'b', s: 100, e: 200 }, { t: 'c', s: 200, e: 300 }];
    const r = alignScript('a x b y c z w', sp);
    let ps = -1;
    for (const w of r.words) { expect(w.e).toBeGreaterThan(w.s); expect(w.s).toBeGreaterThanOrEqual(ps); ps = w.s; }
    const o = alignScript('a b', [{ t: 'a', s: 0, e: 500 }, { t: 'b', s: 300, e: 400 }]);
    expect(o.words[1].s).toBeGreaterThanOrEqual(o.words[0].s);
  });
  it('handles a script longer than the speech and an empty script', () => {
    const r = alignScript('a b c d e f', [{ t: 'a', s: 0, e: 100 }, { t: 'b', s: 100, e: 200 }]);
    expect(r.words).toHaveLength(6);
    expect(r.words.every((w) => w.e > w.s)).toBe(true);
    expect(alignScript('', [{ t: 'a', s: 0, e: 1 }])).toEqual({ words: [], matched: 0, breaks: [] });
  });
  it('does not match punctuation-only tokens and keeps Arabic-Indic digits', () => {
    expect(alignScript('- ! ?', [{ t: '-', s: 0, e: 1 }, { t: '!', s: 1, e: 2 }]).matched).toBe(0);
    expect(alignScript('\u0661', [{ t: '\u0662', s: 0, e: 1 }]).matched).toBe(0);
  });
  it('needsRebuild is false without a stored signature; voSig ignores pages without voice-over', () => {
    const pages = [pg('hello', 1000)];
    expect(needsRebuild({ source: 'manual' }, pages)).toBe(false);
    expect(voSig([...pages, { scene: {} }])).toBe(voSig(pages));
  });
  it('voSig changes when a scene is retimed, so dragging a scene length needs a rebuild', () => {
    const pages = [{ scene: { dur: 3000 } }, pg('hello', 1000)];
    const sig = voSig(pages);
    const longer = [{ scene: { dur: 4500 } }, pg('hello', 1000)]; // scene before the voice-over moves it later
    expect(voSig(longer)).not.toBe(sig);
    const own = [{ scene: { dur: 3000 } }, { scene: { ...pg('hello', 1000).scene, dur: 6000 } }]; // the voice-over scene itself gets longer
    expect(voSig(own)).not.toBe(voSig([{ scene: { dur: 3000 } }, { scene: { ...pg('hello', 1000).scene, dur: 5000 } }]));
    expect(needsRebuild({ source: 'manual', voSig: sig }, longer)).toBe(true);
    expect(needsRebuild({ source: 'manual', voSig: sig }, [{ scene: { dur: 3000 } }, pg('hello', 1000)])).toBe(false);
  });
  it('parses VTT cue settings, hourless times and multi-line text', () => {
    const l = parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000 align:start position:0%\nline one\nline two\n');
    expect(l[0]).toMatchObject({ start: 1000, end: 2000 });
    expect(l[0].words.map((w) => w.t)).toEqual(['line', 'one', 'line', 'two']);
  });
});
