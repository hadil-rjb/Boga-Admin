import { describe, it, expect } from 'vitest';
import { DEFAULT_STYLE, FONT_STACKS, group, retext, split, merge, lineAt, activeWord, layout, draw, animAt } from './captions.js';

const W = (t, s, e) => ({ t, s, e });
const fakeCtx = new Proxy({ measureText: (s) => ({ width: s.length * 10 }) }, {
  get: (o, k) => (k in o ? o[k] : () => {}),
  set: (o, k, v) => { o[k] = v; return true; },
});

describe('captions', () => {
  it('groups by maxWords', () => { expect(group([W('a',0,100),W('b',100,200),W('c',200,300),W('d',300,400)], { ...DEFAULT_STYLE, maxWords: 3 }).map((l) => l.words.length)).toEqual([3, 1]); });
  it('breaks on a 350 ms pause', () => { expect(group([W('a',0,100),W('b',450,500)], DEFAULT_STYLE)).toHaveLength(2); });
  it('breaks after punctuation', () => { expect(group([W('a.',0,100),W('b',100,200)], DEFAULT_STYLE)).toHaveLength(2); });
  it('retext keeps timings of unchanged words', () => { const l = retext({ id:'x', start:0, end:300, words:[W('one',0,100),W('two',100,200),W('three',200,300)] }, 'one 2 three'); expect(l.words.map((w) => [w.t, w.s, w.e])).toEqual([['one',0,100],['2',100,200],['three',200,300]]); });
  it('retext to empty yields a line with no words that lineAt skips', () => { const l = retext({ id:'x', start:0, end:100, words:[W('a',0,100)] }, '  '); expect(lineAt([l], 50)).toBeNull(); });
  it('split and merge round-trip', () => { const l = group([W('a',0,100),W('b',100,200)], { ...DEFAULT_STYLE, maxWords: 9 })[0]; const [x, y] = split(l, 100); expect(merge(x, y).words).toEqual(l.words); });
  it('activeWord follows time', () => { const l = { words: [W('a',0,100),W('b',100,200)] }; expect([activeWord(l, 50), activeWord(l, 150), activeWord(l, 250)]).toEqual([0, 1, -1]); });
  it('Arabic line with digits lays out right to left', () => { const L = layout(fakeCtx, { words: [W('نسبة',0,1),W('25%',1,2),W('في',2,3),W('Q3',3,4)] }, DEFAULT_STYLE, 1080, 1920); expect(L.words.slice().sort((a, b) => b.x - a.x).map((w) => w.i)).toEqual([0, 1, 2, 3]); });
  it('Latin line lays out left to right and is centered', () => { const L = layout(fakeCtx, { words: [W('ab',0,1),W('cd',1,2)] }, DEFAULT_STYLE, 1000, 1000); expect(L.words[0].x).toBeLessThan(L.words[1].x); expect(L.x + L.w / 2).toBeCloseTo(500); });
  it('draw runs on a fake ctx and exposes the font stack', () => { expect(() => draw(fakeCtx, [{ id: 'x', start: 0, end: 100, words: [W('a',0,100)] }], DEFAULT_STYLE, 50, 1080, 1920)).not.toThrow(); expect(FONT_STACKS['sans-bold']).toBe('"Cairo", "Noto Sans Arabic", "Inter", sans-serif'); });
  const recCtx = () => { const fonts = []; const c = new Proxy({ measureText: (s) => ({ width: s.length * 10 }) }, {
    get: (o, k) => (k in o ? o[k] : () => {}),
    set: (o, k, v) => { if (k === 'font') fonts.push(v); o[k] = v; return true; },
  }); return { c, fonts }; };
  const one = [{ id: 'x', start: 0, end: 500, words: [W('a', 0, 500)] }];
  it('display font stack reaches ctx.font', () => { const { c, fonts } = recCtx(); draw(c, one, { ...DEFAULT_STYLE, font: 'display' }, 50, 1080, 1920); expect(fonts.every((f) => f.includes('"Lalezar"'))).toBe(true); expect(fonts.length).toBeGreaterThan(0); });
  it('style.family overrides ahead of the stack', () => { const { c, fonts } = recCtx(); draw(c, one, { ...DEFAULT_STYLE, family: '"MyFont"' }, 50, 1080, 1920); expect(fonts.every((f) => f.includes('px "MyFont", "Cairo"'))).toBe(true); });
  it('every stack starts with an Arabic-capable family', () => { expect(Object.keys(FONT_STACKS).sort()).toEqual(['display', 'sans', 'sans-bold', 'serif']); for (const v of Object.values(FONT_STACKS)) expect(v).toMatch(/^"(Cairo|Noto Sans Arabic|Amiri|Lalezar)"/); });
  it('pop scales the active word briefly', () => { const l = one[0]; const st = { ...DEFAULT_STYLE, anim: 'pop' }; expect(animAt(st, l, 0, 66).scale).toBeGreaterThan(1); expect(animAt(st, l, 0, 200).scale).toBe(1); });
  it('fade ramps alpha over 133 ms', () => { const l = one[0]; const st = { ...DEFAULT_STYLE, anim: 'fade' }; expect(animAt(st, l, 0, 0).alpha).toBe(0); expect(animAt(st, l, 0, 133).alpha).toBe(1); expect(animAt(DEFAULT_STYLE, l, 0, 0)).toEqual({ alpha: 1, scale: 1 }); });
  it('lines=2 wraps a long line, lines=1 does not', () => {
    const line = { words: ['alpha', 'bravo', 'charlie', 'delta'].map((t, i) => W(t, i, i + 1)) };
    const ys = (st) => new Set(layout(fakeCtx, line, st, 200, 1000).words.map((x) => x.y)).size;
    expect(ys({ ...DEFAULT_STYLE, lines: 2 })).toBe(2);
    expect(ys({ ...DEFAULT_STYLE, lines: 1 })).toBe(1);
    const L = layout(fakeCtx, line, { ...DEFAULT_STYLE, lines: 2 }, 200, 1000);
    expect(L.words.slice(0, 2).every((x) => x.y === L.words[0].y)).toBe(true);
  });
  it('RTL wrapped rows keep word 0 right-most on row 1', () => {
    const line = { words: ['مرحبا', 'بكم', 'في', 'برنامجنا'].map((t, i) => W(t, i, i + 1)) };
    const L = layout(fakeCtx, line, { ...DEFAULT_STYLE, lines: 2 }, 200, 1000);
    expect(L.words[0].x).toBeGreaterThan(L.words[1].x);
  });
});
