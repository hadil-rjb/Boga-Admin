import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pickSources, sourceSig, sourceRev, MAX_SOURCES, tidySystem, mergeRules, forAgent, agentExtras, LIMITS, lintSlide, lintText, patternWire, MAX_INSPIRATION, MAX_INSPIRATION_PATTERNS, tidyGuideDesign, guideForRequest, gatherSources, hasSources, gatheredSig, markGuideRules, hashText } from './design-system.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../backend/src/social/design-system/tidy.fixture.json', import.meta.url), 'utf8'));

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
describe('sourceRev', () => {
  it('is a short stable string that follows the page content', () => {
    const p = { bg: '#000', layers: [{ id: 'a', type: 'text', text: 'Hi' }] };
    expect(sourceRev(p)).toMatch(/^[0-9a-z]+$/);
    expect(sourceRev(p)).toBe(sourceRev(JSON.parse(JSON.stringify(p))));
    expect(sourceRev({ ...p, layers: [{ id: 'a', type: 'text', text: 'Hello' }] })).not.toBe(sourceRev(p));
    expect(sourceRev({ ...p, bg: '#fff' })).not.toBe(sourceRev(p));
    expect(typeof sourceRev(undefined)).toBe('string');
  });
});
describe('sourceSig', () => {
  const sig = (brand, designs) => sourceSig(pickSources(brand, designs, []));
  const t = (text, at) => ({ ...tpl('t1', at), layers: [{ id: 'a', type: 'text', text }] });
  it('changes when a layer\'s text changes, and when a source is added or removed', () => {
    const a = sig({ templates: [t('Hi', 1)] }, [des('d2', 'Approved', 3)]);
    expect(sig({ templates: [t('Hello', 1)] }, [des('d2', 'Approved', 3)])).not.toBe(a);
    expect(sig({ templates: [t('Hi', 1)] }, [])).not.toBe(a);
    expect(sig({ templates: [t('Hi', 1)] }, [des('d2', 'Approved', 3), des('d3', 'Approved', 1)])).not.toBe(a);
    const d = des('d2', 'Approved', 3); d.pages[0].layers = [{ id: 'x', type: 'text', text: 'One' }];
    const d2 = des('d2', 'Approved', 3); d2.pages[0].layers = [{ id: 'x', type: 'text', text: 'Two' }];
    expect(sig({}, [d])).not.toBe(sig({}, [d2]));
  });
  it('does not change when only the save time changes', () => {
    expect(sig({ templates: [t('Hi', 1)] }, [des('d2', 'Approved', 3)])).toBe(sig({ templates: [t('Hi', 9)] }, [des('d2', 'Approved', 99)]));
    expect(sourceSig([{ id: 't1', at: 1, rev: 'r' }])).toBe(sourceSig([{ id: 't1', at: 2, rev: 'r' }]));
  });
  it('is empty for no sources', () => {
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
describe('tidySystem on the shared fixture', () => {
  it('gives the same result as the server\'s tidy', () => {
    const s = tidySystem(FIXTURE.raw, FIXTURE.sourceIds);
    expect({ ...s, rules: s.rules.map((r) => ({ ...r, by: r.by || 'ai' })) }).toEqual(FIXTURE.expected);
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
describe('agentExtras', () => {
  it('is empty without a system, so the context has no designSystem key', () => {
    expect(agentExtras(undefined)).toEqual({});
    expect(agentExtras(null)).toEqual({});
    expect(JSON.stringify({ brand: { name: 'B', ...agentExtras(undefined) } })).not.toContain('designSystem');
  });
  it('carries the system for the agent and its references with four fields each', () => {
    const s = { ...tidySystem(base(), ['t1']), v: 1, at: 5, sig: 'x', sources: [{ kind: 'template', id: 't1', name: 'T', ratio: '4:5', at: 3, rev: 'r', live: true }] };
    const x = agentExtras(s);
    expect(Object.keys(x).sort()).toEqual(['designSystem', 'references']);
    expect(x.designSystem).toEqual(forAgent(s));
    expect(x.references).toEqual([{ id: 't1', kind: 'template', name: 'T', ratio: '4:5' }]);
    expect(JSON.stringify({ brand: { name: 'B', ...x } })).toContain('"designSystem":{');
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

const brand = { colors: [{ hex: '#E8343F' }, { hex: '#0B1220' }, { hex: '#F8FAFC' }], fonts: { heading: 'Plus Jakarta Sans', body: 'Inter', arabic: 'Cairo' } };
const sys = tidySystem({
  type: [{ role: 'headline', font: 'Plus Jakarta Sans', weight: 700, sizeMin: 64, sizeMax: 110 }, { role: 'body', font: 'Inter', weight: 400, sizeMin: 28, sizeMax: 36 }],
  colors: { roles: [{ hex: '#94A3B8', role: 'muted', usage: '' }] },
  layout: { margin: 72, gap: 24, align: 'left', logo: { corner: 'tl', width: 140 }, patterns: [] },
});
const text = (o) => ({ id: 't', type: 'text', name: 'Headline', x: 80, y: 300, w: 800, h: 120, font: 'Plus Jakarta Sans', size: 80, color: '#FFFFFF', ...o });
const logo = { id: 'lg', type: 'image', name: 'Logo', x: 80, y: 80, w: 140, h: 40, fill: "url('x') center/contain no-repeat" };
const page = (...layers) => ({ bg: '#0B1220', layers: [logo, ...layers] });
const C = { w: 1080, h: 1350 };
const rules = (p, c = C, s = sys) => lintSlide(p, c, brand, s).map((i) => i.rule);

describe('lintSlide', () => {
  it('passes an on-brand slide', () => { expect(lintSlide(page(text()), C, brand, sys)).toEqual([]); });
  it('flags an off-brand font, a size outside the scale and an off-palette colour', () => {
    expect(rules(page(text({ font: 'Comic Sans MS' })))).toEqual(['font']);
    expect(rules(page(text({ size: 20 })))).toEqual(['size']);
    expect(rules(page(text({ size: 200 })))).toEqual(['size']);
    expect(rules(page(text({ color: '#22C55E' })))).toContain('colour');
    expect(rules(page(text({ color: '#E93540' })))).toEqual([]);          // within delta E 12 of the brand red
    expect(rules(page(text({ color: '#94A3B8' })))).toEqual([]);          // a system colour
  });
  it('flags text in the margin and weak contrast, using the layer under the text', () => {
    expect(rules(page(text({ x: 20 })))).toEqual(['margin']);
    expect(rules(page(text({ color: '#0B1220' })))).toEqual(['contrast']);
    const card = { id: 'c', type: 'rect', name: 'Card', x: 72, y: 280, w: 900, h: 200, fill: '#F8FAFC' };
    expect(rules(page(card, text({ color: '#0B1220' })))).toEqual([]);
    expect(rules(page(card, text({ color: '#FFFFFF' })))).toEqual(['contrast']);
    const photo = { ...card, fill: "url('p.jpg') center/cover" };
    expect(rules(page(photo, text({ color: '#0B1220' })))).toEqual([]);   // unknown backdrop: skipped
  });
  it('scales sizes and margins on a canvas that is not 1080 wide', () => {
    const wide = { w: 1920, h: 1080 };
    expect(rules(page(text({ x: 128, y: 300, w: 1000, size: 140 })), wide)).toEqual([]);
    expect(rules(page(text({ x: 100, y: 300, w: 1000, size: 140 })), wide)).toEqual(['margin']);
    expect(rules(page(text({ x: 128, y: 300, w: 1000, size: 40 })), wide)).toEqual(['size']);
  });
  it('reports a missing logo once, and ignores hidden, locked and live layers', () => {
    const noLogo = { bg: '#0B1220', layers: [text()] };
    expect(lintSlide(noLogo, C, brand, sys)).toEqual([{ layerId: '', rule: 'logo', detail: expect.any(String) }]);
    expect(rules(page(text({ font: 'Arial', hidden: true }), text({ font: 'Arial', locked: true }), text({ font: 'Arial', feed: 'price' })))).toEqual([]);
  });
  it('accepts a colour that is only in one of the system\'s pairs', () => {
    const withPair = tidySystem({ ...sys, colors: { roles: [], pairs: [{ bg: '#0B1220', text: '#FDE68A', accent: '#22C55E' }] } });
    expect(rules(page(text({ color: '#FDE68A' })), C, withPair)).toEqual([]);
    expect(rules(page({ id: 'r', type: 'rect', name: 'Pill', x: 80, y: 600, w: 200, h: 60, fill: '#22C55E' }), C, withPair)).toEqual([]);
    expect(rules(page(text({ color: '#FDE68A' })))).toContain('colour');
  });
  it('skips the font and colour rules when the brand kit and system list none', () => {
    const bare = { fonts: {}, colors: [] };
    const p = { bg: '#0B1220', layers: [text({ font: 'Comic Sans MS', color: '#22C55E' }), { id: 'r', type: 'rect', name: 'Box', x: 80, y: 600, w: 200, h: 60, fill: '#7C3AED' }] };
    expect(lintSlide(p, C, bare, null).map((i) => i.rule)).toEqual([]);
  });
  it('counts a layer filled with a brand logo as the logo, whatever its name', () => {
    const src = 'data:image/png;base64,QUJD';
    const withLogo = { ...brand, logos: [{ id: 'l1', name: 'Boğa wordmark', kind: 'wordmark', src }, { id: 'l2', name: 'Text', kind: 'text' }] };
    const mark = { id: 'm', type: 'image', name: 'Boğa wordmark', x: 80, y: 80, w: 140, h: 40, fill: `url(${src}) center/contain no-repeat` };
    expect(lintSlide({ bg: '#0B1220', layers: [mark, text()] }, C, withLogo, sys)).toEqual([]);
    expect(lintSlide({ bg: '#0B1220', layers: [{ ...mark, name: 'Picture', fill: "url('other.png') center/contain no-repeat" }, text()] }, C, withLogo, sys).map((i) => i.rule)).toEqual(['logo']);
  });
  it('counts a layer named after a brand logo as the logo once its picture is stored elsewhere', () => {
    // saved designs keep pictures as media URLs, so the fill no longer contains the kit's data URL; the agent names the layer after the kit logo
    const withLogo = { ...brand, logos: [{ id: 'l1', name: 'Boğa icon', kind: 'icon', src: 'data:image/png;base64,QUJD' }, { id: 'l2', name: '', kind: 'text' }] };
    const icon = { id: 'm', type: 'image', name: 'boğa ICON', x: 64, y: 64, w: 56, h: 56, fill: "url('http://localhost:4000/api/media/abc.png') center/contain no-repeat" };
    expect(lintSlide({ bg: '#0B1220', layers: [icon, text()] }, C, withLogo, sys)).toEqual([]);
    expect(lintSlide({ bg: '#0B1220', layers: [{ ...icon, name: '' }, text()] }, C, withLogo, sys).map((i) => i.rule)).toEqual(['logo']);
  });
  it('without a system, checks font, colour and contrast against the brand kit only', () => {
    expect(rules({ bg: '#0B1220', layers: [text({ size: 12, x: 0 })] }, C, null)).toEqual([]);
    expect(rules({ bg: '#0B1220', layers: [text({ font: 'Arial' })] }, C, null)).toEqual(['font']);
  });
});
describe('lintText', () => {
  it('says so when there is nothing, and lists issues by layer name', () => {
    expect(lintText([], () => '')).toBe('No issues.');
    expect(lintText([{ layerId: 't', rule: 'size', detail: 'Too small.' }, { layerId: '', rule: 'logo', detail: 'No logo.' }], (id) => (id === 't' ? 'Headline' : ''))).toBe('- Headline: Too small.\n- Slide: No logo.');
  });
});

describe('patternWire', () => {
  const esc = (s) => String(s).replace(/</g, '&lt;');
  it('draws one rect per slot on a canvas with the pattern\'s shape', () => {
    const svg = patternWire({ ratio: '4:5', slots: [{ role: 'headline', x: 0.1, y: 0.3, w: 0.8, h: 0.2 }, { role: 'logo', x: 0.1, y: 0.06, w: 0.2, h: 0.05 }] }, { esc });
    expect(svg).toContain('viewBox="0 0 100 125"');
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg).toContain('class="ds-slot ds-headline"');
    expect(svg).toContain('x="10" y="37.5" width="80" height="25"');
  });
  it('reads pixel ratios and falls back to 4:5', () => {
    expect(patternWire({ ratio: '1920x1080', slots: [] }, { esc })).toContain('viewBox="0 0 100 56.25"');
    expect(patternWire({ ratio: '?', slots: [] }, { esc })).toContain('viewBox="0 0 100 125"');
  });
});

const gd = () => ({ name: ' Guide 2026.pdf ', at: 5, layout: ' 12-column grid, 64 px margins ', imagery: '', logoUse: 'Clear space equals the height of the B', typography: '', rules: [{ text: ' Never stretch the logo ', kind: 'dont' }, { text: '', kind: 'do' }, { text: 'Use one accent per slide', kind: 'maybe' }] });
const pic = (id, src = 'data:image/jpeg;base64,AAA' + id) => ({ id, name: 'Pic ' + id, src, w: 1080, h: 1350, at: 1 });

describe('tidyGuideDesign', () => {
  it('trims, cuts and drops empty rules; null when the guide says nothing about design', () => {
    const g = tidyGuideDesign(gd());
    expect(g).toMatchObject({ name: 'Guide 2026.pdf', at: 5, layout: '12-column grid, 64 px margins', imagery: '', typography: '' });
    expect(g.rules).toEqual([{ text: 'Never stretch the logo', kind: 'dont' }, { text: 'Use one accent per slide', kind: 'do' }]);
    expect(tidyGuideDesign({ name: 'x.pdf', layout: ' ', imagery: '', logoUse: '', typography: '', rules: [] })).toBeNull();
    expect(tidyGuideDesign(null)).toBeNull();
    expect(tidyGuideDesign({ layout: 'x'.repeat(900) }).layout).toHaveLength(400);
    expect(tidyGuideDesign({ layout: 'a', rules: Array.from({ length: 30 }, (_, i) => ({ text: 'R' + i, kind: 'do' })) }).rules).toHaveLength(12);
  });
  it('guideForRequest drops the date and is undefined without a usable guide', () => {
    expect(guideForRequest(gd())).not.toHaveProperty('at');
    expect(guideForRequest(gd()).name).toBe('Guide 2026.pdf');
    expect(guideForRequest(undefined)).toBeUndefined();
  });
});
describe('gatherSources', () => {
  it('keeps own references, lists up to 8 pictures and the guide', () => {
    const brand = { templates: [{ id: 't1', name: 'T', ratio: '4:5', bg: '#000', layers: [] }], inspiration: Array.from({ length: 11 }, (_, i) => pic('i' + i)).concat([{ id: 'bad', name: 'no src' }]), guideDesign: gd() };
    const g = gatherSources(brand, [], []);
    expect(g.own.map((s) => s.id)).toEqual(['t1']);
    expect(g.inspiration).toHaveLength(MAX_INSPIRATION);
    expect(g.inspiration[0]).toMatchObject({ kind: 'inspiration', id: 'i0', name: 'Pic i0', ratio: '1080x1350', w: 1080, h: 1350 });
    expect(g.guide).toEqual({ name: 'Guide 2026.pdf', rev: expect.any(String) });
    expect(hasSources(g)).toBe(true);
    expect(gatherSources({ inspiration: [{ name: 'no id', src: 'data:x' }] }, [], []).inspiration).toEqual([]);
  });
  it('a brand with only pictures, or only a guide, has sources; a brand with nothing has none', () => {
    expect(hasSources(gatherSources({ inspiration: [pic('i1')] }, [], []))).toBe(true);
    expect(hasSources(gatherSources({ guideDesign: gd() }, [], []))).toBe(true);
    expect(hasSources(gatherSources({}, [], []))).toBe(false);
    expect(gatherSources({ guideDesign: { layout: '' } }, [], []).guide).toBeNull();
  });
});
describe('gatheredSig', () => {
  const own = { templates: [{ id: 't1', name: 'T', ratio: '4:5', bg: '#000', layers: [] }] };
  it('equals the phase 1 signature when the brand has no pictures and no guide', () => {
    const g = gatherSources(own, [], []);
    expect(gatheredSig(g)).toBe(sourceSig(g.own));
  });
  it('changes when a picture is added, replaced or removed, and when the guide changes or goes', () => {
    const sig = (b) => gatheredSig(gatherSources({ ...own, ...b }, [], []));
    const base = sig({ inspiration: [pic('i1')], guideDesign: gd() });
    expect(sig({ inspiration: [pic('i1'), pic('i2')], guideDesign: gd() })).not.toBe(base);
    expect(sig({ inspiration: [pic('i1', 'data:image/jpeg;base64,ZZZ')], guideDesign: gd() })).not.toBe(base);
    expect(sig({ inspiration: [], guideDesign: gd() })).not.toBe(base);
    expect(sig({ inspiration: [pic('i1')], guideDesign: { ...gd(), layout: 'Other' } })).not.toBe(base);
    expect(sig({ inspiration: [pic('i1')] })).not.toBe(base);
    expect(sig({ inspiration: [pic('i1')], guideDesign: { ...gd(), at: 99 } })).toBe(base); // reading it again changes nothing
  });
});
describe('tidySystem with inspiration and guide', () => {
  const pat = (id, origin, sourceId) => ({ id, name: id, when: '', ratio: '4:5', origin, sourceId, slots: [{ role: 'headline', x: 0.1, y: 0.1, w: 0.8, h: 0.2 }] });
  const sys = (patterns, rules = []) => ({ type: [{ role: 'headline', font: 'Inter', weight: 700, sizeMin: 60, sizeMax: 90 }], layout: { patterns }, rules });
  it('keeps at most 3 inspiration patterns, each tied to a picture that was sent', () => {
    const s = tidySystem(sys([pat('a', 'brand', 't1'), pat('b', 'inspiration', 'i1'), pat('c', 'inspiration', 'gone'), pat('d', 'inspiration', 'i2'), pat('e', 'inspiration', 'i1'), pat('f', 'inspiration', 'i2'), pat('g', 'weird', 'nope')]), ['t1'], ['i1', 'i2']);
    expect(s.layout.patterns.map((p) => [p.id, p.origin, p.sourceId])).toEqual([['a', 'brand', 't1'], ['b', 'inspiration', 'i1'], ['d', 'inspiration', 'i2'], ['e', 'inspiration', 'i1'], ['g', 'brand', '']]);
    expect(s.layout.patterns.filter((p) => p.origin === 'inspiration')).toHaveLength(MAX_INSPIRATION_PATTERNS);
  });
  it('defaults origin to brand, accepts guide rules, and passes the guide name through', () => {
    const s = tidySystem({ ...sys([{ ...pat('a', undefined, 't1') }], [{ text: 'Never stretch the logo', kind: 'dont', by: 'guide' }, { text: 'X', kind: 'do', by: 'robot' }]), guide: { name: ' Guide.pdf ' } }, ['t1']);
    expect(s.layout.patterns[0].origin).toBe('brand');
    expect(s.rules.map((r) => r.by)).toEqual(['guide', 'ai']);
    expect(s.guide).toEqual({ name: 'Guide.pdf' });
    expect(tidySystem({ ...sys([]), guide: { name: ' ' } })).not.toHaveProperty('guide');
    expect(forAgent(s)).not.toHaveProperty('guide');
    expect(forAgent(s).rules[0].by).toBe('guide');
  });
});
describe('guide rules', () => {
  const fresh = [{ text: 'never stretch the logo ', kind: 'dont', by: 'ai' }, { text: 'Logo top left', kind: 'do', by: 'ai' }];
  it('marks rules that match the guide, and unmarks them when there is no guide', () => {
    expect(markGuideRules(fresh, gd()).map((r) => r.by)).toEqual(['guide', 'ai']);
    expect(markGuideRules([{ text: 'Never stretch the logo', kind: 'dont', by: 'user' }], gd())[0].by).toBe('user');
    expect(markGuideRules([{ text: 'A', kind: 'do', by: 'guide' }], null)[0].by).toBe('ai');
    expect(markGuideRules([{ text: 'Not in the guide', kind: 'do', by: 'guide' }], gd())[0].by).toBe('ai');
    expect(fresh[0].by).toBe('ai'); // not mutated
  });
  it('orders user rules, then guide rules, then the rest, and never carries old guide rules over', () => {
    const old = [{ text: 'Mine', kind: 'do', by: 'user' }, { text: 'Old guide rule', kind: 'do', by: 'guide' }, { text: 'Old AI rule', kind: 'do', by: 'ai' }];
    const next = [{ text: 'Logo top left', kind: 'do', by: 'ai' }, { text: 'Never stretch the logo', kind: 'dont', by: 'guide' }, { text: 'mine', kind: 'do', by: 'ai' }];
    expect(mergeRules(old, next).map((r) => r.text)).toEqual(['Mine', 'Never stretch the logo', 'Logo top left']);
  });
});
