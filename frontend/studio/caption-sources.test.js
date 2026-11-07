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
});
