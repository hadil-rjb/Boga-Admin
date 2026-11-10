import { describe, it, expect } from 'vitest';
import { pickSources, sourceSig, MAX_SOURCES, tidySystem, mergeRules, forAgent, LIMITS } from './design-system.js';

const tpl = (id, at) => ({ id, name: 'T ' + id, ratio: '4:5', bg: '#000', layers: [], at });
const des = (id, status, at) => ({ id, name: 'D ' + id, ratio: '1:1', status, at, pages: [{ bg: '#fff', layers: [] }] });

describe('pickSources', () => {
  it('takes templates first, newest first, then approved or published designs, never drafts', () => {
    const brand = { templates: [tpl('t1', 1), tpl('t2', 5)] };
    const designs = [des('d1', 'Draft', 9), des('d2', 'Approved', 3), des('d3', 'Scheduled', 8), des('d4', 'Draft', 7)];
    const posts = [{ d: 'd4', status: 'Published' }, { d: 'd3', status: 'Scheduled' }];
    expect(pickSources(brand, designs, posts).map((s) => s.id)).toEqual(['t2', 't1', 'd4', 'd2']);
  });
  it('caps at 12 and returns [] for a brand with nothing to learn from', () => {
    const brand = { templates: Array.from({ length: 20 }, (_, i) => tpl('t' + i, i)) };
    expect(pickSources(brand, [], [])).toHaveLength(MAX_SOURCES);
    expect(pickSources({ templates: [] }, [des('d1', 'Draft', 1)], [])).toEqual([]);
    expect(pickSources({}, undefined, undefined)).toEqual([]);
  });
  it('flags live pages and carries kind, name and ratio', () => {
    const s = pickSources({ templates: [{ ...tpl('t1', 1), live: { kind: 'calendar' } }] }, [], [])[0];
    expect(s).toMatchObject({ kind: 'template', id: 't1', name: 'T t1', ratio: '4:5', live: true });
  });
});
describe('sourceSig', () => {
  it('changes when a source is edited, added or removed', () => {
    const a = [{ id: 't1', at: 1 }, { id: 'd2', at: 3 }];
    expect(sourceSig(a)).toBe('t1:1|d2:3');
    expect(sourceSig([{ id: 't1', at: 2 }, { id: 'd2', at: 3 }])).not.toBe(sourceSig(a));
    expect(sourceSig([])).toBe('');
    expect(sourceSig(undefined)).toBe('');
  });
});

const base = () => ({
  summary: ' Bold and dark. ',
  type: [{ role: 'headline', font: 'Plus Jakarta Sans', weight: 700, sizeMin: 96, sizeMax: 72, lh: 1.05, ls: -1, upper: false, align: 'left' }, { role: 'nope', font: 'X', weight: 400, sizeMin: 10, sizeMax: 12 }],
  colors: { roles: [{ hex: 'e8343f', role: 'accent', usage: 'buttons' }, { hex: 'red', role: 'text', usage: '' }], pairs: [{ bg: '#0b1220', text: '#ffffff', accent: '#E8343F' }, { bg: 'zzz', text: '#fff' }], gradients: [] },
  layout: { margin: 9999, gap: 24, align: 'left', logo: { corner: 'tl', width: 140 }, patterns: [
    { id: 'p1', name: 'Hero', when: 'Announcements', ratio: '4:5', sourceId: 't1', slots: [{ role: 'headline', x: 0.1, y: 0.3, w: 1.4, h: 0.2 }, { role: 'ghost', x: 0, y: 0, w: 1, h: 1 }] },
    { id: 'p2', name: 'Empty', when: '', ratio: '1:1', sourceId: 'gone', slots: [{ role: 'body', x: 0.5, y: 0.5, w: 0.001, h: 0.2 }] }] },
  shapes: { radius: 24, stroke: 0, shadow: 'soft', motifs: 'pills' }, imagery: 'none',
  rules: Array.from({ length: 40 }, (_, i) => ({ text: 'Rule ' + i, kind: i % 2 ? 'do' : 'dont', by: 'ai' })),
});

describe('tidySystem', () => {
  it('keeps only valid values and applies every limit', () => {
    const s = tidySystem(base(), ['t1']);
    expect(s.summary).toBe('Bold and dark.');
    expect(s.type).toHaveLength(1);
    expect(s.type[0]).toMatchObject({ role: 'headline', sizeMin: 72, sizeMax: 96 });
    expect(s.colors.roles).toEqual([{ hex: '#E8343F', role: 'accent', usage: 'buttons' }]);
    expect(s.colors.pairs).toEqual([{ bg: '#0B1220', text: '#FFFFFF', accent: '#E8343F' }]);
    expect(s.layout.margin).toBe(300);
    expect(s.layout.patterns).toHaveLength(1);
    expect(s.layout.patterns[0].slots).toEqual([{ role: 'headline', x: 0.1, y: 0.3, w: 0.9, h: 0.2 }]);
    expect(s.rules).toHaveLength(LIMITS.rules);
  });
  it('returns null for something that is not a system, and survives missing sections', () => {
    expect(tidySystem(null)).toBeNull();
    expect(tidySystem('x')).toBeNull();
    const s = tidySystem({});
    expect(s).toMatchObject({ summary: '', type: [], colors: { roles: [], pairs: [], gradients: [] }, rules: [] });
    expect(s.layout.patterns).toEqual([]);
  });
});
describe('mergeRules', () => {
  it('keeps the user\'s rules, replaces the AI\'s, and drops duplicates', () => {
    const old = [{ text: 'Never centre body text', kind: 'dont', by: 'user' }, { text: 'Old AI rule', kind: 'do', by: 'ai' }];
    const fresh = [{ text: 'never centre body text', kind: 'dont', by: 'ai' }, { text: 'Logo top left', kind: 'do', by: 'ai' }];
    expect(mergeRules(old, fresh).map((r) => r.text)).toEqual(['Never centre body text', 'Logo top left']);
  });
});
describe('forAgent', () => {
  it('drops bookkeeping, stays under 6,000 characters, and is null without a system', () => {
    const s = { ...tidySystem(base(), ['t1']), v: 1, at: 5, model: 'm', sig: 'x', sources: [{ id: 't1' }] };
    const a = forAgent(s);
    expect(a).not.toHaveProperty('sig');
    expect(a).not.toHaveProperty('sources');
    expect(a.type).toHaveLength(1);
    expect(JSON.stringify(a).length).toBeLessThan(6000);
    expect(forAgent(undefined)).toBeNull();
  });
});
describe('forAgent at every limit', () => {
  it('drops patterns from the end until the system fits', () => {
    const L = (n, c = 'x') => c.repeat(n);
    const slots = Array.from({ length: 10 }, () => ({ role: 'headline', x: 0.123456, y: 0.123456, w: 0.5, h: 0.5 }));
    const big = {
      summary: L(300),
      type: Array.from({ length: 6 }, () => ({ role: 'body', font: L(80), weight: 400, sizeMin: 10, sizeMax: 20 })),
      colors: { roles: Array.from({ length: 9 }, () => ({ hex: '#123456', role: 'text', usage: L(40) })), pairs: [], gradients: [] },
      layout: { patterns: Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, name: L(80), when: L(300), ratio: '4:5', slots })) },
      rules: Array.from({ length: 20 }, (_, i) => ({ text: L(60) + i, kind: 'do', by: 'ai' })),
    };
    const s = tidySystem(big);
    expect(s.layout.patterns).toHaveLength(LIMITS.patterns);
    const a = forAgent(s);
    expect(JSON.stringify(a).length).toBeLessThan(6000);
    expect(a.layout.patterns.length).toBeLessThan(LIMITS.patterns);
    expect(s.layout.patterns).toHaveLength(LIMITS.patterns);
  });
});
