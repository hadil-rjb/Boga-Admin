import { describe, it, expect } from 'vitest';
import { CATEGORIES, PRESETS, presetById, applyPreset, sampleLine } from './caption-presets.js';
import { DEFAULT_STYLE, FONT_STACKS, withDefaults } from './captions.js';

const ANIMS = ['none', 'fade', 'pop', 'karaoke', 'word', 'typewriter', 'bounce', 'slide'];
const ALLOWED = new Set([...Object.keys(DEFAULT_STYLE), 'ls', 'lh', 'x', 'align', 'boxOpacity', 'anim', 'animSpeed', 'offset', 'minDur', 'gap']);

describe('caption presets', () => {
  it('has categories in order', () => {
    expect(CATEGORIES.map((c) => c.id)).toEqual(['viral', 'karaoke', 'clean', 'cinematic', 'boxed', 'neon', 'arabic']);
  });
  it('has at least 28 presets, each category >= 3, unique ids', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(28);
    for (const c of CATEGORIES) expect(PRESETS.filter((p) => p.cat === c.id).length).toBeGreaterThanOrEqual(3);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });
  it('styles are valid', () => {
    for (const p of PRESETS) {
      expect(Object.keys(p.style).every((k) => ALLOWED.has(k))).toBe(true);
      expect(Object.keys(p.style.box || {}).every((k) => ['color', 'radius', 'pad'].includes(k))).toBe(true);
      expect(Object.keys(p.style.stroke || {}).every((k) => ['color', 'width'].includes(k))).toBe(true);
      expect(Object.keys(p.style.shadow || {}).every((k) => ['color', 'blur', 'y'].includes(k))).toBe(true);
      expect(Object.keys(p.style.highlight || {}).every((k) => ['mode', 'color', 'text', 'radius'].includes(k))).toBe(true);
      expect(ANIMS).toContain(p.style.anim);
      expect(JSON.stringify(p.style).length).toBeLessThan(2000);
      expect(FONT_STACKS[p.style.font]).toBeTruthy();
    }
  });
  it('arabic presets use arabic-capable fonts', () => {
    for (const p of PRESETS.filter((x) => x.cat === 'arabic')) {
      expect(['sans-bold', 'sans']).toContain(p.style.font);
      expect(p.style.lh).toBe(1.3);
    }
  });
  it('applyPreset keeps y', () => {
    expect(applyPreset({ ...DEFAULT_STYLE, y: 0.8 }, 'clean-white').y).toBe(0.8);
    expect(presetById('clean-white').cat).toBe('clean');
    expect(applyPreset(DEFAULT_STYLE, 'nope')).toEqual(withDefaults(DEFAULT_STYLE));
  });
  it('applying any preset after any other leaks nothing', () => {
    const CARRY = ['y', 'x', 'maxWords', 'offset', 'minDur', 'gap'];
    for (const a of PRESETS) for (const b of PRESETS) {
      const prev = applyPreset(DEFAULT_STYLE, a.id);
      const got = applyPreset(prev, b.id);
      const want = applyPreset(DEFAULT_STYLE, b.id);
      for (const k of CARRY) { delete got[k]; delete want[k]; }
      expect(got).toEqual(want);
    }
  });
  it('carries position and timing unless the preset sets them', () => {
    const cur = { ...DEFAULT_STYLE, y: 0.8, x: 0.3, maxWords: 5, offset: 120 };
    const r = applyPreset(cur, 'clean-white');
    expect([r.y, r.x, r.maxWords, r.offset]).toEqual([0.8, 0.3, 5, 120]);
    expect(applyPreset(cur, 'cine-serif').y).toBe(0.86);
  });
  it('sampleLine', () => {
    const l = sampleLine('en');
    expect(l.words).toHaveLength(3);
    expect(l.start).toBe(0);
    expect(l.end).toBe(1500);
    expect(/[؀-ۿ]/.test(sampleLine('ar').words[0].t)).toBe(true);
  });
});
