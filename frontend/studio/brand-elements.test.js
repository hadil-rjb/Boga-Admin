import { describe, it, expect } from 'vitest';
import { backgroundOf, extractBackgrounds, coverLayers, themeOf, MAX_BACKGROUNDS } from './brand-elements.js';

const S = [1080, 1350];
const L = (id, type, o = {}) => ({ id, type, name: type, x: 0, y: 0, w: 100, h: 100, ...o });
const dims = (r) => ({ '4:5': [1080, 1350], '9:16': [1080, 1920], '1:1': [1080, 1080] }[r]);

describe('backgroundOf', () => {
  it('takes the bottom layers with their groups, up to the first text', () => {
    const layers = [
      L('bg', 'rect', { name: 'Background', w: 1080, h: 1350, fill: '#1B55EC' }),
      L('g1', 'image', { name: 'BG 2', x: -900, y: -900, w: 3000, h: 3000, blend: 'plus-lighter' }),
      L('grp', 'group'), L('e1', 'ellipse', { pid: 'grp', blend: 'overlay' }), L('e2', 'ellipse', { pid: 'grp', blend: 'overlay' }),
      L('t', 'text', { text: 'Hello' }), L('after', 'image', { blend: 'overlay' }),
    ];
    expect(backgroundOf(layers, S).map((l) => l.id)).toEqual(['bg', 'g1', 'grp', 'e1', 'e2']);
  });
  it('stops at the logo, a group holding text, or a subject picture', () => {
    expect(backgroundOf([L('g', 'image', { blend: 'overlay' }), L('logo', 'group', { name: 'Logo' })], S).map((l) => l.id)).toEqual(['g']);
    expect(backgroundOf([L('g', 'image', { blend: 'overlay' }), L('card', 'group'), L('tx', 'text', { pid: 'card' })], S).map((l) => l.id)).toEqual(['g']);
    expect(backgroundOf([L('g', 'image', { blend: 'overlay' }), L('gold', 'image', { x: 200, y: 300, w: 600, h: 600 })], S).map((l) => l.id)).toEqual(['g']);
    // an unnamed group of vector paths at the top: the logo
    expect(backgroundOf([L('g', 'image', { blend: 'overlay' }), L('grp', 'group', { name: 'Group 2', x: 79, y: 99, w: 294, h: 57 }), L('p', 'path', { pid: 'grp', w: 17, h: 22 })], S).map((l) => l.id)).toEqual(['g']);
  });
  it('keeps a full-bleed photo, and finds nothing in a flat colour', () => {
    expect(backgroundOf([L('ph', 'image', { x: 0, y: -100, w: 1080, h: 1620 }), L('t', 'text')], S).map((l) => l.id)).toEqual(['ph']);
    expect(backgroundOf([L('bg', 'rect', { w: 1080, h: 1350, fill: '#000' }), L('t', 'text')], S)).toEqual([]);
  });
});

describe('extractBackgrounds', () => {
  const glow = (c) => [L('bg', 'rect', { w: 1080, h: 1350, fill: c }), L('g', 'image', { blend: 'plus-lighter', fill: 'url(x.jpg)' }), L('t', 'text')];
  it('offers each template and version once, with theme and category', () => {
    const ts = [{ id: 't1', name: 'News 1', category: 'News', ratio: '4:5', bg: '#1B55EC', layers: glow('#1B55EC'),
      versions: [{ id: 'v1', name: 'Black', bg: '#0F0F0F', layers: glow('#0F0F0F') }, { id: 'v2', name: 'Blue copy', bg: '#1B55EC', layers: glow('#1B55EC') }] }];
    const out = extractBackgrounds(ts, dims);
    expect(out.map((b) => [b.id, b.name, b.theme])).toEqual([['bg-t1', 'News 1', 'blue'], ['bg-t1__v1', 'News 1 · Black', 'dark']]);
    expect(out[0]).toMatchObject({ category: 'News', ratio: '4:5', from: 't1' });
  });
  it('stays under the limit', () => {
    const ts = Array.from({ length: 50 }, (_, i) => ({ id: 't' + i, name: 'T', ratio: '4:5', bg: '#000', layers: [L('g', 'image', { blend: 'overlay', x: i })] }));
    expect(extractBackgrounds(ts, dims)).toHaveLength(MAX_BACKGROUNDS);
  });
});

describe('themeOf', () => {
  it('reads light, blue and dark', () => {
    expect(themeOf('#F3F3F3')).toBe('light');
    expect(themeOf('#1B55EC')).toBe('blue');
    expect(themeOf('#0F0F0F')).toBe('dark');
    expect(themeOf('#F7633B')).toBe('accent');
    expect(themeOf('#252525')).toBe('dark');
    expect(themeOf('linear-gradient(red, blue)')).toBe('dark');
  });
});

describe('coverLayers', () => {
  it('scales uniformly to cover the new canvas, centred', () => {
    const [a] = coverLayers([L('c', 'ellipse', { x: 0, y: 0, w: 1080, h: 1080, r: 10 })], [1080, 1350], [1080, 1920]);
    // 1920 / 1350 ≈ 1.4222: the circle stays round, the width overflows evenly on both sides
    expect(a.w).toBe(a.h);
    expect(a.w).toBeCloseTo(1536, 0);
    expect(a.x).toBeCloseTo(-228, 0);
    expect(a.r).toBeCloseTo(14.2, 1);
  });
});

import { learnThemeMap, pickThemeBackground, mapColors, normColor } from './brand-elements.js';
describe('learnThemeMap', () => {
  const page = (bg, ink, card) => ({ bg, layers: [L('t1', 'text', { name: 'Headline', color: ink }), L('c', 'rect', { name: 'Card', fill: card }), L('m', 'rect', { name: 'Mask', fill: '#123456', mask: true })] });
  it('learns what each colour becomes in the other theme, from versions of one layout', () => {
    const blue = page('#1B55EC', '#FFFFFF', 'rgba(255, 255, 255, 0.1)'), light = page('#F3F3F3', '#1E1E1E', 'rgba(0,0,0,0.05)');
    const m = learnThemeMap([{ id: 't', ...blue, versions: [{ id: 'v', ...light }] }]);
    expect(m['dark>light'].get('#ffffff')).toBe('#1e1e1e');
    expect(m['dark>light'].get('rgba(255,255,255,0.1)')).toBe('rgba(0,0,0,0.05)');
    expect(m['dark>light'].get('#1b55ec')).toBe('#f3f3f3');
    expect(m['light>dark'].get('#1e1e1e')).toBe('#ffffff');
    expect(m['dark>light'].has('#123456')).toBe(false); // masks only shape
  });
  it('takes the colour the brand used most often', () => {
    const v = (ink) => ({ id: 'v' + ink, bg: '#F3F3F3', layers: [L('t', 'text', { name: 'H', color: ink })] });
    const m = learnThemeMap([{ id: 't', bg: '#0F0F0F', layers: [L('t', 'text', { name: 'H', color: '#fff' })], versions: [v('#111111'), v('#222222'), v('#222222')] }]);
    expect(m['dark>light'].get('#ffffff')).toBe('#222222');
  });
});
describe('pickThemeBackground', () => {
  const bgs = [{ id: 'a', theme: 'blue', from: 't1', category: 'News', ratio: '4:5' }, { id: 'b', theme: 'light', from: 't2', category: 'Q&A', ratio: '4:5' }, { id: 'c', theme: 'light', from: 't1', category: 'News', ratio: '9:16' }, { id: 'd', theme: 'light', from: 't1', category: 'News', ratio: '4:5' }, { id: 'e', theme: 'dark', from: 't3', ratio: '4:5' }];
  it('prefers the same template, then its size; then the category; dark prefers near-black over blue', () => {
    expect(pickThemeBackground(bgs, 'light', { from: 't1', ratio: '4:5' }).id).toBe('d');
    expect(pickThemeBackground(bgs, 'light', { category: 'Q&A' }).id).toBe('b');
    expect(pickThemeBackground(bgs, 'dark', {}).id).toBe('e');
    expect(pickThemeBackground([], 'dark', {})).toBe(null);
    expect(pickThemeBackground([{ id: 'p', theme: 'photo' }, { id: 'o', theme: 'accent' }], 'dark', {})).toBe(null);
  });
});
describe('mapColors', () => {
  it('maps learned colours and passes the others to the fallback', () => {
    const m = new Map([['#ffffff', '#1e1e1e']]);
    expect(mapColors('linear-gradient(#FFF, #F7633B)', m, () => 'X')).toBe('linear-gradient(#1e1e1e, X)');
    expect(normColor('rgba(0, 0, 0, .5)')).toBe('rgba(0,0,0,.5)');
  });
});
