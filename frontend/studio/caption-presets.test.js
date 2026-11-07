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
      expect(Object.keys(withDefaults(p.style)).every((k) => ALLOWED.has(k))).toBe(true);
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
  it('sampleLine', () => {
    const l = sampleLine('en');
    expect(l.words).toHaveLength(3);
    expect(l.start).toBe(0);
    expect(l.end).toBe(1500);
    expect(/[؀-ۿ]/.test(sampleLine('ar').words[0].t)).toBe(true);
  });
});
