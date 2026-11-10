import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { tidy, systemFromAnswer, SYSTEM_PROMPT } from './system';
import { AnalyzeSystemDto } from './system.controller';

const good = () => ({
  summary: 'Bold and dark.',
  type: [{ role: 'headline', font: 'Inter', weight: 700, sizeMin: 72, sizeMax: 96, lh: 1.1, ls: 0, upper: false, align: 'left' }],
  colors: { roles: [{ hex: '#e8343f', role: 'accent', usage: 'buttons' }], pairs: [{ bg: '#0b1220', text: '#ffffff', accent: '#e8343f' }], gradients: [] },
  layout: { margin: 72, gap: 24, align: 'left', logo: { corner: 'tl', width: 140 }, patterns: [{ id: 'p1', name: 'Hero', when: 'Announcements', ratio: '4:5', sourceId: 't1', slots: [{ role: 'headline', x: 0.1, y: 0.3, w: 0.8, h: 0.2 }] }] },
  shapes: { radius: 24, stroke: 0, shadow: 'soft', motifs: '' }, imagery: 'none',
  rules: [{ text: 'Logo top left', kind: 'do' }],
});

describe('tidy', () => {
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
  it('refuses an answer with nothing usable', () => {
    expect(() => tidy({ summary: 'x' }, [])).toThrow('empty');
    expect(() => tidy(null, [])).toThrow('empty');
  });
});
describe('AnalyzeSystemDto', () => {
  const ref = (o = {}) => ({ kind: 'template', id: 't1', name: 'T', ratio: '4:5', w: 1080, h: 1350, image: 'data:image/jpeg;base64,AAAA', layers: '[]', ...o });
  const check = async (body: any) => (await validate(plainToInstance(AnalyzeSystemDto, body))).length;
  const kit = { name: 'Boga', colors: [{ name: 'Red', hex: '#E8343F' }], fonts: { heading: 'Inter' } };
  it('accepts 1 to 12 references and rejects 0, 13, a bad id and a non-image', async () => {
    expect(await check({ kit, references: [ref()] })).toBe(0);
    expect(await check({ kit, references: [] })).toBeGreaterThan(0);
    expect(await check({ kit, references: Array.from({ length: 13 }, (_, i) => ref({ id: 't' + i })) })).toBeGreaterThan(0);
    expect(await check({ kit, references: [ref({ id: '../x' })] })).toBeGreaterThan(0);
    expect(await check({ kit, references: [ref({ image: 'https://x/y.png' })] })).toBeGreaterThan(0);
  });
});
describe('SYSTEM_PROMPT', () => {
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
  it('explains text that is not JSON or does not fit the schema, in one line', () => {
    expect(() => systemFromAnswer('not json', 'end_turn', [])).toThrow(/expected format/);
    let msg = '';
    try { systemFromAnswer('{"summary":1}', 'end_turn', []); } catch (e: any) { msg = e.message; }
    expect(msg).toMatch(/expected format/);
    expect(msg).not.toMatch(/\n/);
  });
  it('explains an answer with nothing usable', () => {
    const empty = { ...good(), type: [], colors: { roles: [], pairs: [], gradients: [] }, layout: { ...good().layout, patterns: [] } };
    expect(() => systemFromAnswer(JSON.stringify(empty), 'end_turn', [])).toThrow(/no usable/);
  });
});
