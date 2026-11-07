import { describe, it, expect } from 'vitest';
import { CAPTIONS_DEFAULT, kindOf, capsOf, migrateCaptions, styleOf, classicStyle } from './caption-store.js';
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
    expect(d.captions).toEqual({ on: true, lines, style: { size: 9 }, preset: null, source: 'speech', lang: 'fr', voSig: null, styleFrom: 'look' });
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
  it('pristine d.captions is replaced by legacy footage captions', () => {
    const lines = [{ id: 1 }];
    const d = { captions: capsOf({}), footage: { captions: { lines, style: null, lang: 'en' } } };
    expect(migrateCaptions(d)).toBe(true);
    expect(d.captions.lines).toBe(lines);
    expect(d.captions.source).toBe('speech');
    expect(d.footage.captions).toBeUndefined();
  });
  it('non-pristine d.captions wins', () => {
    const d = { captions: { ...CAPTIONS_DEFAULT, preset: 'x', lines: [{ id: 9 }] }, footage: { captions: { lines: [{ id: 1 }], style: null } } };
    migrateCaptions(d);
    expect(d.captions.preset).toBe('x');
    expect(d.captions.lines).toEqual([{ id: 9 }]);
    expect(d.footage.captions).toBeUndefined();
  });
  it('pristine d.captions on a reel takes audio.captions', () => {
    const d = { motion: {}, audio: { captions: false }, captions: capsOf({}) };
    expect(migrateCaptions(d)).toBe(true);
    expect(d.captions.on).toBe(false);
    expect(d.captions.source).toBe('voiceover');
    expect('captions' in d.audio).toBe(false);
  });
  it('legacy captions without lines/style leave source null', () => {
    const d = { footage: { captions: {} } };
    migrateCaptions(d);
    expect(d.captions.source).toBeNull();
    expect(d.captions.lines).toEqual([]);
    expect(d.captions.style).toBeNull();
  });
  it('a saved reel whose captions were on keeps the classic look', () => {
    const d = { motion: { fmt: 'reel' }, ratio: '9:16', audio: { captions: true } };
    expect(migrateCaptions(d, { font: 'Poppins' })).toBe(true);
    const st = d.captions.style;
    expect(d.captions.styleFrom).toBe('classic');
    expect(d.captions.preset).toBe(null);
    expect(st).toMatchObject({ font: 'sans-bold', family: 'Poppins', weight: 700, color: '#FFFFFF', stroke: null, shadow: null, y: 0.72, lines: 2 });
    expect(st.highlight.mode).toBe('none');
    expect(st.box.color).toBe('rgba(0,0,0,.62)');
    expect(st.box.radius).toBe(0.4);
    // 4.6 % of the width as a share of the height; the side padding (2 × pad) is 0.55 em
    expect(st.size).toBeCloseTo(0.046 * 9 / 16, 4);
    expect((2 * st.box.pad) / st.size).toBeCloseTo(0.55, 3);
  });
  it('the classic look sits lower off portrait and has no family without a brand font', () => {
    const d = { motion: {}, ratio: '1920x1080', audio: { captions: true } };
    migrateCaptions(d);
    expect(d.captions.style.y).toBe(0.82);
    expect(d.captions.style.family).toBe(null);
    expect(d.captions.style.size).toBeCloseTo(0.046 * 16 / 9, 4);
    expect(classicStyle({ ratio: '1:1' }).y).toBe(0.82);
  });
  it('reels whose captions were off, new reels and kept styles get no classic style', () => {
    const off = { motion: {}, audio: { captions: false } }; migrateCaptions(off);
    expect(off.captions.style).toBe(null); expect(off.captions.styleFrom).toBeUndefined();
    const fresh = { motion: {} }; migrateCaptions(fresh);
    expect(fresh.captions).toBeUndefined();
    const kept = { motion: {}, audio: { captions: true }, captions: { ...CAPTIONS_DEFAULT, lines: [], style: null } };
    migrateCaptions(kept);
    expect(kept.captions.styleFrom).toBe('classic');
  });
  it('styleOf', () => {
    expect(styleOf({})).toEqual(expect.objectContaining(DEFAULT_STYLE));
    expect(styleOf({ captions: { style: { size: 7 } } }).size).toBe(7);
  });
});
