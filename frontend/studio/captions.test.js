import { describe, it, expect } from 'vitest';
import { DEFAULT_STYLE, FONT_STACKS, group, retext, split, merge, lineAt, activeWord, layout, draw } from './captions.js';

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
});
