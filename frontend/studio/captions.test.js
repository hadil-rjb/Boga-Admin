import { describe, it, expect } from 'vitest';
import { DEFAULT_STYLE, FONT_STACKS, group, retext, retime, addLine, split, merge, lineAt, activeWord, layout, draw, animAt, changeTimes, withDefaults } from './captions.js';

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
  it('fade ramps alpha over 133 ms', () => { const l = one[0]; const st = { ...DEFAULT_STYLE, anim: 'fade' }; expect(animAt(st, l, 0, 0).alpha).toBe(0); expect(animAt(st, l, 0, 133).alpha).toBe(1); expect(animAt(DEFAULT_STYLE, l, 0, 0)).toEqual({ alpha: 1, scale: 1, dy: 0, visible: true, highlight: false }); });
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
  it('retime scales words into the new range', () => { expect(retime({ id:'x', start:0, end:200, words:[W('a',0,100),W('b',100,200)] }, 1000, 1400).words.map((w) => [w.s, w.e])).toEqual([[1000,1200],[1200,1400]]); });
  it('retime of a zero-length line only shifts', () => { const l = retime({ id:'x', start:50, end:50, words:[W('a',50,50)] }, 100, 300); expect([l.start, l.end]).toEqual([100, 300]); expect(l.words[0].s).toBe(100); });
  it('addLine fits before the next line', () => { const ls = addLine([{ id:'n', start:1000, end:2000, words:[W('z',1000,2000)] }], 500); expect(ls[0]).toMatchObject({ start: 500, end: 1000 }); });
  it('addLine is 1500 ms when there is room, carries the text and keeps order', () => {
    const ls = addLine([{ id:'a', start:0, end:400, words:[W('x',0,400)] }, { id:'n', start:5000, end:6000, words:[W('z',5000,6000)] }], 1000, 'hello world');
    expect(ls.map((l) => l.id)[0]).toBe('a'); expect(ls[2].id).toBe('n');
    expect(ls[1]).toMatchObject({ start: 1000, end: 2500 }); expect(ls[1].words.map((w) => w.t)).toEqual(['hello', 'world']);
  });
  it('addLine inside a line starts after it, and with no room changes nothing', () => {
    const a = [{ id:'a', start:0, end:1000, words:[W('x',0,1000)] }, { id:'n', start:1100, end:2000, words:[W('z',1100,2000)] }];
    expect(addLine(a, 500)).toBe(a);
    expect(addLine([a[0]], 500)[1]).toMatchObject({ start: 1000, end: 2500 });
  });
  it('changeTimes covers line and word boundaries', () => {
    const lines = [{ id: 'x', start: 100, end: 700, words: [W('a', 100, 400), W('b', 400, 700)] }];
    expect(changeTimes(lines, DEFAULT_STYLE, 2000)).toEqual([0, 100, 400, 700]);
    expect(changeTimes([{ id: 'y', start: 100, end: 300, words: [W('a', 120, 300)] }], DEFAULT_STYLE, 2000)).toEqual([0, 100, 120, 300]);
  });
  it('changeTimes adds 4 ramp steps after each word start when animated, and stays inside the clip', () => {
    const lines = [{ id: 'x', start: 100, end: 700, words: [W('a', 100, 400), W('b', 400, 700)] }, { id: 'e', start: 900, end: 1000, words: [] }];
    expect(changeTimes(lines, { ...DEFAULT_STYLE, anim: 'pop' }, 600)).toEqual([0, 100, 133, 167, 200, 233, 400, 433, 467, 500, 533]);
  });
  it('changeTimes samples the fade ramp from the line start, even before the first word', () => {
    const lines = [{ id: 'x', start: 100, end: 700, words: [W('a', 300, 700)] }];
    const t = changeTimes(lines, { ...DEFAULT_STYLE, anim: 'fade' }, 2000);
    for (const v of [100, 133, 167, 200, 233]) expect(t).toContain(v);
    expect(t).toEqual([0, 100, 133, 167, 200, 233, 300, 333, 367, 400, 433, 700]);
    expect(changeTimes(lines, { ...DEFAULT_STYLE, anim: 'pop' }, 2000)).not.toContain(133);
  });
});

describe('style fields', () => {
  const rec = (lines, style, ms, w, h) => {
    const calls = [];
    const c = new Proxy({ measureText: (s) => ({ width: s.length * 10 }) }, {
      get: (o, k) => (k in o ? o[k] : (...a) => { calls.push([k, ...a]); }),
      set: (o, k, v) => { calls.push(['set', k, v]); o[k] = v; return true; },
    });
    draw(c, lines, style, ms, w, h); return calls;
  };
  const l1 = [{ id: 'x', start: 0, end: 500, words: [W('ab', 0, 250), W('cd', 250, 500)] }];
  const l2 = [{ id: 'x', start: 0, end: 500, words: ['alpha', 'bravo', 'charlie', 'delta'].map((t, i) => W(t, i * 100, i * 100 + 100)) }];
  const BOX = { ...DEFAULT_STYLE, box: { color: 'rgba(0,0,0,.6)', pad: 0.02, radius: 0.3 } };
  // Golden call lists recorded from draw() BEFORE the style-field change (legacy styles, no new fields).
  const GOLDEN = {
    plain: [
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["save"],
      ["set","textAlign","left"],
      ["set","textBaseline","middle"],
      ["set","globalAlpha",1],
      ["set","shadowColor","rgba(0,0,0,.55)"],
      ["set","shadowBlur",6],
      ["set","shadowOffsetY",2],
      ["set","fillStyle","#E8B54A"],
      ["beginPath"],
      ["moveTo",477.70000000000005,627.5],
      ["arcTo",500.40000000000003,627.5,500.40000000000003,672.5,8.1],
      ["arcTo",500.40000000000003,672.5,469.6,672.5,8.1],
      ["arcTo",469.6,672.5,469.6,627.5,8.1],
      ["arcTo",469.6,627.5,500.40000000000003,627.5,8.1],
      ["closePath"],
      ["fill"],
      ["save"],
      ["translate",485,650],
      ["scale",1,1],
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["set","fillStyle","#1A1A1A"],
      ["fillText","ab",-10,0],
      ["restore"],
      ["save"],
      ["translate",515,650],
      ["scale",1,1],
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["set","fillStyle","#FFFFFF"],
      ["fillText","cd",-10,0],
      ["restore"],
      ["restore"],
    ],
    box: [
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["save"],
      ["set","textAlign","left"],
      ["set","textBaseline","middle"],
      ["set","globalAlpha",1],
      ["set","fillStyle","rgba(0,0,0,.6)"],
      ["beginPath"],
      ["moveTo",448.5,607.5],
      ["arcTo",565,607.5,565,692.5,13.5],
      ["arcTo",565,692.5,435,692.5,13.5],
      ["arcTo",435,692.5,435,607.5,13.5],
      ["arcTo",435,607.5,565,607.5,13.5],
      ["closePath"],
      ["fill"],
      ["set","shadowColor","rgba(0,0,0,.55)"],
      ["set","shadowBlur",6],
      ["set","shadowOffsetY",2],
      ["save"],
      ["translate",485,650],
      ["scale",1,1],
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["set","fillStyle","#FFFFFF"],
      ["fillText","ab",-10,0],
      ["restore"],
      ["set","fillStyle","#E8B54A"],
      ["beginPath"],
      ["moveTo",507.70000000000005,627.5],
      ["arcTo",530.4,627.5,530.4,672.5,8.1],
      ["arcTo",530.4,672.5,499.6,672.5,8.1],
      ["arcTo",499.6,672.5,499.6,627.5,8.1],
      ["arcTo",499.6,627.5,530.4,627.5,8.1],
      ["closePath"],
      ["fill"],
      ["save"],
      ["translate",515,650],
      ["scale",1,1],
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["set","fillStyle","#1A1A1A"],
      ["fillText","cd",-10,0],
      ["restore"],
      ["restore"],
    ],
    wrap: [
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["save"],
      ["set","textAlign","left"],
      ["set","textBaseline","middle"],
      ["set","globalAlpha",1],
      ["set","shadowColor","rgba(0,0,0,.55)"],
      ["set","shadowBlur",6],
      ["set","shadowOffsetY",2],
      ["save"],
      ["translate",70,621.875],
      ["scale",1,1],
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["set","fillStyle","#FFFFFF"],
      ["fillText","alpha",-25,0],
      ["restore"],
      ["set","fillStyle","#E8B54A"],
      ["beginPath"],
      ["moveTo",107.69999999999999,599.375],
      ["arcTo",160.39999999999998,599.375,160.39999999999998,644.375,8.1],
      ["arcTo",160.39999999999998,644.375,99.6,644.375,8.1],
      ["arcTo",99.6,644.375,99.6,599.375,8.1],
      ["arcTo",99.6,599.375,160.39999999999998,599.375,8.1],
      ["closePath"],
      ["fill"],
      ["save"],
      ["translate",130,621.875],
      ["scale",1,1],
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["set","fillStyle","#1A1A1A"],
      ["fillText","bravo",-25,0],
      ["restore"],
      ["save"],
      ["translate",70,678.125],
      ["scale",1,1],
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["set","fillStyle","#FFFFFF"],
      ["fillText","charlie",-35,0],
      ["restore"],
      ["save"],
      ["translate",140,678.125],
      ["scale",1,1],
      ["set","font","800 45px \"Cairo\", \"Noto Sans Arabic\", \"Inter\", sans-serif"],
      ["set","fillStyle","#FFFFFF"],
      ["fillText","delta",-25,0],
      ["restore"],
      ["restore"],
    ],
  };
  it('legacy styles render byte-identical draw calls (plain, box, 2-row wrap)', () => {
    expect(rec(l1, DEFAULT_STYLE, 100, 1000, 1000)).toEqual(GOLDEN.plain);
    expect(rec(l1, BOX, 300, 1000, 1000)).toEqual(GOLDEN.box);
    expect(rec(l2, { ...DEFAULT_STYLE, lines: 2 }, 150, 200, 1000)).toEqual(GOLDEN.wrap);
  });
  it('withDefaults fills every new field and keeps explicit ones', () => {
    expect(withDefaults({})).toMatchObject({ ls: 0, lh: 1.15, x: 0.5, align: 'center', boxOpacity: 1, anim: 'none', animSpeed: 1, offset: 0, minDur: 600, gap: 0 });
    expect(withDefaults({ ls: 2, x: 0.2 })).toMatchObject({ ls: 2, x: 0.2, lh: 1.15 });
  });
  const line = { words: [W('ab', 0, 1), W('cd', 1, 2), W('ef', 2, 3)] };
  it('x and align move the block', () => {
    const L1 = layout(fakeCtx, line, { ...DEFAULT_STYLE, x: 0.25, align: 'left' }, 1000, 1000);
    expect(L1.x).toBeCloseTo(250, 0);
    const L2 = layout(fakeCtx, line, { ...DEFAULT_STYLE, x: 0.75, align: 'right' }, 1000, 1000);
    expect(L2.x + L2.w).toBeCloseTo(750, 0);
    const L3 = layout(fakeCtx, line, { ...DEFAULT_STYLE, x: 0.25, align: 'center' }, 1000, 1000);
    expect(L3.x + L3.w / 2).toBeCloseTo(250, 0);
  });
  it('ls widens every word gap', () => {
    const a = layout(fakeCtx, line, DEFAULT_STYLE, 1000, 1000);
    const b = layout(fakeCtx, line, { ...DEFAULT_STYLE, ls: 0.5 }, 1000, 1000);
    expect(b.w - a.w).toBeCloseTo(0.5 * DEFAULT_STYLE.size * 1000 * 2, 5);
  });
  it('lh scales row height on 2-line wraps (default keeps 1.25)', () => {
    const l = { words: ['alpha', 'bravo', 'charlie', 'delta'].map((t, i) => W(t, i, i + 1)) };
    const px = DEFAULT_STYLE.size * 1000;
    expect(layout(fakeCtx, l, { ...DEFAULT_STYLE, lines: 2 }, 200, 1000).h).toBeCloseTo(2 * px * 1.25, 5);
    expect(layout(fakeCtx, l, { ...DEFAULT_STYLE, lines: 2, lh: 2 }, 200, 1000).h).toBeCloseTo(2 * px * (1.25 * 2) / 1.15, 5);
  });
  it('offset delays the line', () => {
    const n = (st, ms) => rec(l1, st, ms, 1000, 1000).length;
    const S = { ...DEFAULT_STYLE, offset: 500 };
    expect(n(S, 100)).toBe(0);
    expect(n(S, 600)).toBeGreaterThan(0);
  });
  it('boxOpacity multiplies the box alpha', () => {
    const alphaAtBox = (st) => { const c = rec(l1, st, 50, 1000, 1000); return c.slice(0, c.findIndex((x) => x[0] === 'fill')).filter((x) => x[1] === 'globalAlpha').pop()[2]; };
    expect(alphaAtBox({ ...BOX, boxOpacity: 0.4 })).toBeCloseTo(0.4);
    expect(alphaAtBox(BOX)).toBe(1);
  });
});

describe('animations', () => {
  const ln = { id: 'x', start: 100, end: 2000, words: [W('a', 200, 600), W('b', 600, 1000), W('c', 1000, 1400)] };
  const st = (anim, extra) => ({ ...DEFAULT_STYLE, anim, ...extra });
  const D = 133;
  it('karaoke: every word visible, highlight fills as words start', () => {
    const f = (ms) => [0, 1, 2].map((i) => animAt(st('karaoke'), ln, i, ms));
    expect(f(599).map((a) => a.highlight)).toEqual([true, false, false]);
    expect(f(600 + D / 2).map((a) => a.highlight)).toEqual([true, true, false]);
    expect(f(1000 + 3 * D).map((a) => a.highlight)).toEqual([true, true, true]);
    expect(f(199).map((a) => a.highlight)).toEqual([false, false, false]);
    expect(f(199).every((a) => a.visible && a.alpha === 1 && a.dy === 0)).toBe(true);
  });
  it('word: visible only from w.s', () => {
    const v = (ms) => animAt(st('word'), ln, 1, ms).visible;
    expect([v(599), v(600 + D / 2), v(600 + 3 * D)]).toEqual([false, true, true]);
  });
  it('typewriter: visible from w.s, alpha ramps 0 to 1', () => {
    const a = (ms) => animAt(st('typewriter'), ln, 1, ms);
    expect(a(599).visible).toBe(false);
    expect(a(600).visible).toBe(true);
    expect(a(600).alpha).toBe(0);
    expect(a(600 + D / 2).alpha).toBeCloseTo(0.5);
    expect(a(600 + 3 * D).alpha).toBe(1);
  });
  it('bounce: dy -0.25 before, overshoots, settles to 0 after 2 ramps', () => {
    const a = (ms) => animAt(st('bounce'), ln, 1, ms);
    expect(a(599).dy).toBeCloseTo(-0.25);
    expect(a(600 + D / 2).dy).toBeLessThan(0);
    expect(a(600 + D / 2).dy).toBeGreaterThan(-0.25);
    expect(a(600 + 3 * D).dy).toBe(0);
    const peak = Math.max(...Array.from({ length: 27 }, (_, k) => a(600 + k * 10).dy));
    expect(peak).toBeGreaterThan(0);
    expect(a(599).visible && a(599).alpha === 1).toBe(true);
  });
  it('slide: line level dy 0.6 to 0 and alpha 0 to 1 after line.start', () => {
    const a = (ms, i = 0) => animAt(st('slide'), ln, i, ms);
    expect(a(99)).toMatchObject({ dy: 0.6, alpha: 0, visible: true });
    expect(a(100 + D / 2).dy).toBeCloseTo(0.3);
    expect(a(100 + D / 2).alpha).toBeCloseTo(0.5);
    expect(a(100 + 3 * D)).toMatchObject({ dy: 0, alpha: 1 });
    expect(a(100 + D / 2, 2).dy).toBeCloseTo(a(100 + D / 2, 0).dy);
  });
  it('animSpeed scales the ramp and is clamped to 0.5-2', () => {
    expect(animAt(st('typewriter', { animSpeed: 2 }), ln, 1, 600 + D / 4).alpha).toBeCloseTo(0.5);
    expect(animAt(st('typewriter', { animSpeed: 100 }), ln, 1, 600 + D / 4).alpha).toBeCloseTo(0.5);
    expect(animAt(st('typewriter', { animSpeed: 0.5 }), ln, 1, 600 + D).alpha).toBeCloseTo(0.5);
    expect(animAt(st('typewriter', { animSpeed: 0.01 }), ln, 1, 600 + D).alpha).toBeCloseTo(0.5);
  });
  const one1 = { id: 'o', start: 100, end: 900, words: [W('a', 300, 900)] };
  it('changeTimes: 4 ramp steps after each word start for typewriter and bounce', () => {
    for (const a of ['typewriter', 'bounce']) {
      const t = changeTimes([one1], st(a), 2000);
      for (const v of [333, 367, 400, 433]) expect(t).toContain(v);
    }
    expect(changeTimes([one1], st('typewriter'), 2000)).toEqual([0, 100, 300, 333, 367, 400, 433, 900]);
  });
  it('changeTimes: slide steps after line.start, karaoke and word add none', () => {
    expect(changeTimes([one1], st('slide'), 2000)).toEqual([0, 100, 133, 167, 200, 233, 300, 900]);
    expect(changeTimes([one1], st('karaoke'), 2000)).toEqual([0, 100, 300, 900]);
    expect(changeTimes([one1], st('word'), 2000)).toEqual([0, 100, 300, 900]);
  });
  it('changeTimes: animSpeed 2 halves the ramp', () => {
    expect(changeTimes([one1], st('typewriter', { animSpeed: 2 }), 2000)).toEqual([0, 100, 300, 317, 333, 350, 367, 900]);
  });
  it('changeTimes honours style.offset (clamped, integer, sorted)', () => {
    const t = changeTimes([one1], st('none', { offset: 500 }), 1200);
    expect(t).toEqual([0, 600, 800]);
    expect(changeTimes([one1], st('none', { offset: -150 }), 2000)).toEqual([0, 150, 750]);
    expect(changeTimes([one1], DEFAULT_STYLE, 2000)).toEqual([0, 100, 300, 900]);
  });
  const calls = (style, ms) => { const out = []; const c = new Proxy({ measureText: (s) => ({ width: s.length * 10 }) }, {
    get: (o, k) => (k in o ? o[k] : (...a) => { out.push([k, ...a]); }),
    set: (o, k, v) => { out.push(['set', k, v]); o[k] = v; return true; },
  }); draw(c, [ln], style, ms, 1000, 1000); return out; };
  const texts = (c) => c.filter((x) => x[0] === 'fillText').map((x) => x[1]);
  it('draw skips invisible words for word and typewriter', () => {
    expect(texts(calls(st('word'), 650))).toEqual(['a', 'b']);
    expect(texts(calls(st('typewriter'), 650))).toEqual(['a', 'b']);
    expect(texts(calls(st('none'), 650))).toEqual(['a', 'b', 'c']);
  });
  it('draw fills karaoke words progressively with highlight colours', () => {
    const fills = (ms) => calls(st('karaoke'), ms).filter((x) => x[0] === 'set' && x[1] === 'fillStyle').map((x) => x[2]);
    const hl = DEFAULT_STYLE.highlight;
    expect(fills(650).filter((c) => c === hl.text)).toHaveLength(2);
    expect(fills(1100).filter((c) => c === hl.text)).toHaveLength(3);
  });
  it('draw applies dy for bounce', () => {
    const y = (ms) => calls(st('bounce'), ms).filter((x) => x[0] === 'translate')[2][2];
    expect(y(599)).toBeLessThan(y(1000 + 3 * D));
  });
});
