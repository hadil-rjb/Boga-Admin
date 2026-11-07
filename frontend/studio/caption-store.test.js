import { describe, it, expect } from 'vitest';
import { CAPTIONS_DEFAULT, kindOf, capsOf, migrateCaptions, styleOf } from './caption-store.js';
import { DEFAULT_STYLE } from './captions.js';

describe('caption-store', () => {
  it('kindOf', () => {
    expect(kindOf({ footage: {} })).toBe('video');
    expect(kindOf({ motion: {} })).toBe('reel');
    expect(kindOf({})).toBe('still');
  });
  it('capsOf creates defaults', () => {
    const d = {};
    const c = capsOf(d);
    expect(c).toEqual(CAPTIONS_DEFAULT);
    expect(c.lines).not.toBe(CAPTIONS_DEFAULT.lines);
    expect(capsOf(d)).toBe(c);
  });
  it('migrates footage captions', () => {
    const lines = [{ id: 1 }];
    const d = { footage: { captions: { style: { size: 9 }, lines, lang: 'fr', styleFrom: 'look' } } };
    expect(migrateCaptions(d)).toBe(true);
    expect(d.footage.captions).toBeUndefined();
    expect(d.captions).toEqual({ on: true, lines, style: { size: 9 }, preset: null, source: 'speech', lang: 'fr', voSig: null });
    expect(migrateCaptions(d)).toBe(false);
  });
  it('maps reel audio.captions', () => {
    const d = { motion: {}, audio: { captions: true } };
    expect(migrateCaptions(d)).toBe(true);
    expect(d.captions.on).toBe(true);
    expect(d.captions.source).toBe('voiceover');
    expect('captions' in d.audio).toBe(false);
    expect(migrateCaptions(d)).toBe(false);
    const e = { motion: {}, audio: { captions: false } };
    migrateCaptions(e);
    expect(e.captions.on).toBe(false);
  });
  it('keeps existing captions', () => {
    const d = { captions: { ...CAPTIONS_DEFAULT, preset: 'x' }, footage: { captions: { lines: [{}], style: null } } };
    migrateCaptions(d);
    expect(d.captions.preset).toBe('x');
    expect(d.captions.lines).toEqual([]);
    expect(d.footage.captions).toBeUndefined();
  });
  it('styleOf', () => {
    expect(styleOf({})).toEqual(expect.objectContaining(DEFAULT_STYLE));
    expect(styleOf({ captions: { style: { size: 7 } } }).size).toBe(7);
  });
});
