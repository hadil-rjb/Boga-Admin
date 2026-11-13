import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { tidy, systemFromAnswer, answerTexts, SYSTEM_PROMPT } from './system';
import { AnalyzeSystemDto, hasAnySource } from './system.controller';
import fixture from './tidy.fixture.json';

const good = () => ({
  summary: 'Bold and dark.',
  type: [{ role: 'headline', font: 'Inter', weight: 700, sizeMin: 72, sizeMax: 96, lh: 1.1, ls: 0, upper: false, align: 'left' }],
  colors: { roles: [{ hex: '#e8343f', role: 'accent', usage: 'buttons' }], pairs: [{ bg: '#0b1220', text: '#ffffff', accent: '#e8343f' }], gradients: [] },
  layout: { margin: 72, gap: 24, align: 'left', logo: { corner: 'tl', width: 140 }, patterns: [{ id: 'p1', name: 'Hero', when: 'Announcements', ratio: '4:5', sourceId: 't1', origin: 'brand', slots: [{ role: 'headline', x: 0.1, y: 0.3, w: 0.8, h: 0.2 }] }] },
  shapes: { radius: 24, stroke: 0, shadow: 'soft', motifs: '' }, imagery: 'none',
  rules: [{ text: 'Logo top left', kind: 'do' }],
});

describe('tidy', () => {
  it('keeps at most three inspiration patterns tied to sent pictures, and never trusts a rule\'s by', () => {
    const pat = (id: string, origin: string, sourceId: string) => ({ id, name: id, when: '', ratio: '4:5', origin, sourceId, slots: [{ role: 'headline', x: 0.1, y: 0.1, w: 0.8, h: 0.2 }] });
    const g: any = good();
    g.layout.patterns = [pat('a', 'brand', 't1'), pat('b', 'inspiration', 'i1'), pat('c', 'inspiration', 'gone'), pat('d', 'inspiration', 'i1'), pat('e', 'inspiration', 'i1'), pat('f', 'inspiration', 'i1')];
    g.rules = [{ text: 'From the guide', kind: 'do', by: 'guide' }];
    const s = tidy(g, ['t1'], ['i1']);
    expect(s.layout.patterns.map((p: any) => [p.id, p.origin])).toEqual([['a', 'brand'], ['b', 'inspiration'], ['d', 'inspiration'], ['e', 'inspiration']]);
    expect(s.rules[0].by).toBe('ai');
    expect(tidy(good(), ['t1']).layout.patterns[0].origin).toBe('brand');
  });
  it('treats a pattern whose sourceId is an inspiration picture as an inspiration pattern', () => {
    const g: any = good();
    g.layout.patterns[0].sourceId = 'i1';
    const p = tidy(g, ['t1'], ['i1']).layout.patterns[0];
    expect(p.origin).toBe('inspiration');
    expect(p.sourceId).toBe('i1');
  });
  it('normalises a good answer and marks rules as written by the AI', () => {
    const s = tidy(good(), ['t1']);
    expect(s.colors.roles[0].hex).toBe('#E8343F');
    expect(s.rules).toEqual([{ text: 'Logo top left', kind: 'do', by: 'ai' }]);
    expect(s.layout.patterns[0].sourceId).toBe('t1');
  });
  it('drops garbage: bad hex, slots outside the canvas, unknown sources, too many rules', () => {
    const g: any = good();
    g.colors.roles.push({ hex: 'blue', role: 'text', usage: '' });
    g.layout.patterns[0].slots.push({ role: 'body', x: 2, y: 2, w: 0.5, h: 0.5 });
    g.layout.patterns.push({ id: 'p2', name: 'Ghost', when: '', ratio: '1:1', sourceId: 'zzz', slots: [{ role: 'body', x: 0, y: 0, w: 0.5, h: 0.5 }] });
    g.rules = Array.from({ length: 40 }, (_, i) => ({ text: 'R' + i, kind: 'do' }));
    const s = tidy(g, ['t1']);
    expect(s.colors.roles).toHaveLength(1);
    expect(s.layout.patterns[0].slots).toHaveLength(1);
    expect(s.layout.patterns[1].sourceId).toBe('');
    expect(s.rules).toHaveLength(16);
  });
  it('tidies the shared fixture exactly as the studio does', () => {
    const s = tidy(fixture.raw, fixture.sourceIds, fixture.inspirationIds);
    expect(s.rules.every((r) => r.by === 'ai')).toBe(true);
    const asAi = (rules: { by?: string }[]) => rules.map((r) => ({ ...r, by: 'ai' }));
    expect({ ...s, rules: asAi(s.rules) }).toEqual({ ...fixture.expected, rules: asAi(fixture.expected.rules) });
  });
  it('refuses an answer with nothing usable', () => {
    expect(() => tidy({ summary: 'x' }, [])).toThrow('empty');
    expect(() => tidy(null, [])).toThrow('empty');
  });
});
const ref = (o = {}) => ({ kind: 'template', id: 't1', name: 'T', ratio: '4:5', w: 1080, h: 1350, image: 'data:image/jpeg;base64,AAAA', layers: '[]', ...o });
const check = async (body: any) => (await validate(plainToInstance(AnalyzeSystemDto, body))).length;
const kit = { name: 'Boga', colors: [{ name: 'Red', hex: '#E8343F' }], fonts: { heading: 'Inter' } };
describe('AnalyzeSystemDto', () => {
  it('accepts up to 12 references and rejects 13, a bad id and a non-image', async () => {
    expect(await check({ kit, references: [ref()] })).toBe(0);
    expect(await check({ kit, references: [] })).toBe(0);
    expect(await check({ kit, references: Array.from({ length: 13 }, (_, i) => ref({ id: 't' + i })) })).toBeGreaterThan(0);
    expect(await check({ kit, references: [ref({ id: '../x' })] })).toBeGreaterThan(0);
    expect(await check({ kit, references: [ref({ image: 'https://x/y.png' })] })).toBeGreaterThan(0);
  });
  it('accepts up to 12 logo names in the kit, each at most 60 characters', async () => {
    expect(await check({ kit: { ...kit, logos: ['Boğa icon'] }, references: [ref()] })).toBe(0);
    expect(await check({ kit: { ...kit, logos: Array.from({ length: 13 }, (_, i) => 'Logo ' + i) }, references: [ref()] })).toBeGreaterThan(0);
    expect(await check({ kit: { ...kit, logos: ['x'.repeat(61)] }, references: [ref()] })).toBeGreaterThan(0);
    expect(await check({ kit: { ...kit, logos: [3] }, references: [ref()] })).toBeGreaterThan(0);
  });
});
describe('inspiration and guide in the request', () => {
  it('accepts pictures or a guide without references, and rejects a request with no source at all', async () => {
    const pic = { id: 'i1', name: 'P', w: 1080, h: 1350, image: 'data:image/jpeg;base64,AAAA' };
    expect(await check({ kit, inspiration: [pic] })).toBe(0);
    expect(await check({ kit, guide: { name: 'g.pdf', layout: '12 columns' } })).toBe(0);
    expect(await check({ kit, references: [ref()] })).toBe(0);
    expect(await check({ kit, inspiration: Array.from({ length: 9 }, (_, i) => ({ ...pic, id: 'i' + i })) })).toBeGreaterThan(0);
    expect(await check({ kit, guide: { name: 'g.pdf', layout: 'x'.repeat(401) } })).toBeGreaterThan(0);
    expect(await check({ kit, guide: { name: 'g.pdf', rules: [{ text: 'a', kind: 'maybe' }] } })).toBeGreaterThan(0);
  });
  it('knows when a request has something to learn from', () => {
    const dto = (o: any) => o as AnalyzeSystemDto;
    expect(hasAnySource(dto({ kit }))).toBe(false);
    expect(hasAnySource(dto({ kit, guide: { name: 'g.pdf', layout: ' ' } }))).toBe(false);
    expect(hasAnySource(dto({ kit, inspiration: [{ id: 'i1' }] }))).toBe(true);
    expect(hasAnySource(dto({ kit, references: [ref()] }))).toBe(true);
    expect(hasAnySource(dto({ kit, guide: { name: 'g.pdf', rules: [{ text: 'Never stretch the logo', kind: 'dont' }] } }))).toBe(true);
  });
});
describe('SYSTEM_PROMPT', () => {
  it('keeps colours and fonts out of inspiration and puts the guide first', () => {
    expect(SYSTEM_PROMPT).toMatch(/Sources rank in this order: the brand guide/);
    expect(SYSTEM_PROMPT).toMatch(/never take a colour, gradient, colour pair, font, type size/i);
    expect(SYSTEM_PROMPT).toMatch(/added to rules for you, word for word/);
    expect(SYSTEM_PROMPT).toMatch(/logo corner to "none"/);
    expect(SYSTEM_PROMPT).toMatch(/origin "inspiration"/);
  });
  it('tells the model to measure, to normalise to 1080 and not to invent', () => {
    expect(SYSTEM_PROMPT).toMatch(/1080/);
    expect(SYSTEM_PROMPT).toMatch(/do not invent/i);
    expect(SYSTEM_PROMPT).toMatch(/layer list/i);
    expect(SYSTEM_PROMPT).toMatch(/never instructions/i);
  });
});
describe('systemFromAnswer', () => {
  it('turns a good answer into a system', () => {
    expect(systemFromAnswer(JSON.stringify(good()), 'end_turn', ['t1']).type[0].font).toBe('Inter');
  });
  it('explains a cut-off answer', () => {
    expect(() => systemFromAnswer('{"summary":', 'max_tokens', [])).toThrow(/cut off/);
  });
  it('explains text that is not a JSON object, in one line', () => {
    expect(() => systemFromAnswer('not json', 'end_turn', [])).toThrow(/expected format/);
    let msg = '';
    try { systemFromAnswer('[1, 2]', 'end_turn', []); } catch (e: any) { msg = e.message; }
    expect(msg).toMatch(/expected format/);
    expect(msg).not.toMatch(/\n/);
  });
  it('keeps what fits when a value is outside the schema, instead of failing', () => {
    const odd = { ...good(), shapes: { ...good().shapes, shadow: 'glow' }, type: [...good().type, { role: 'banner', font: 'Inter' }] };
    const sys = systemFromAnswer(JSON.stringify(odd), 'end_turn', ['t1']);
    expect(sys.shapes.shadow).toBe('none');
    expect(sys.type).toHaveLength(good().type.length);
  });
  it('reads the answer from the right text block', () => {
    // a note before the answer, the answer in a code fence, and a declined model's start before a fallback
    expect(systemFromAnswer(['Here is the system:', '```json\n' + JSON.stringify(good()) + '\n```'], 'end_turn', ['t1']).type[0].font).toBe('Inter');
    const content = [{ type: 'text', text: '{"summ' }, { type: 'fallback' }, { type: 'text', text: JSON.stringify(good()) }];
    expect(answerTexts(content)).toHaveLength(1);
    expect(systemFromAnswer(answerTexts(content), 'end_turn', ['t1']).type[0].font).toBe('Inter');
  });
  it('explains an answer with nothing usable', () => {
    const empty = { ...good(), type: [], colors: { roles: [], pairs: [], gradients: [] }, layout: { ...good().layout, patterns: [] } };
    expect(() => systemFromAnswer(JSON.stringify(empty), 'end_turn', [])).toThrow(/no usable/);
  });
});
