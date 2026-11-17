import { describe, expect, it } from 'vitest';
import { applyFixes, fixPrompt, parseFixes } from './transcript-fix';

const W = (t: string, s: number, e: number, p = 0.9) => ({ t, s, e, p });
const words = [W('أمريكا', 0, 500), W('سبيس', 500, 800, 0.6), W('أكس', 800, 1000, 0.4), W('تمكن', 1000, 1400)];

describe('transcript fixes', () => {
  it('numbers the words from the offset, with context', () => {
    const p = fixPrompt(words.slice(1, 3), 1, 'أمريكا', 'تمكن', 'ar');
    expect(p).toContain('1:سبيس 2:أكس');
    expect(p).toContain('Context before (do not fix): أمريكا');
  });
  it('keeps only well-formed, ordered fixes inside the chunk', () => {
    const f = parseFixes({ fixes: [{ from: 1, to: 2, text: ' SpaceX ' }, { from: 2, to: 3, text: 'x' }, { from: 3, to: 3, text: '' }, { from: 9, to: 9, text: 'y' }, { from: 0, to: 20, text: 'z' }] }, 0, 3);
    expect(f).toEqual([{ from: 1, to: 2, text: 'SpaceX' }]);
    expect(parseFixes(null, 0, 3)).toEqual([]);
  });
  it('replaces a span and keeps its time; several words share it by length', () => {
    expect(applyFixes(words, [{ from: 1, to: 2, text: 'SpaceX' }])).toEqual([W('أمريكا', 0, 500), W('SpaceX', 500, 1000, 0.4), W('تمكن', 1000, 1400)]);
    const two = applyFixes(words, [{ from: 1, to: 2, text: 'Space XX' }]);
    expect(two.map((w) => [w.t, w.s, w.e])).toEqual([['أمريكا', 0, 500], ['Space', 500, 857], ['XX', 857, 1000], ['تمكن', 1000, 1400]]);
  });
  it('no fixes: the same words', () => { expect(applyFixes(words, [])).toBe(words); });
});

describe('the verbatim guard', () => {
  const S = (t: string, p = 0.95) => t.split(' ').map((x, i) => W(x, i * 100, i * 100 + 90, p));
  it('English terms for their Arabic spelling pass; a translation does not', async () => {
    const { verbatim } = await import('./transcript-fix');
    expect(verbatim(S('سبيس أكس', 0.3), 'SpaceX')).toBe(true);
    expect(verbatim(S('البرتفوليو'), 'الـ portfolio')).toBe(true);
    expect(verbatim(S('الديفلاطمنت'), 'الـ development')).toBe(true);
    expect(verbatim(S('الطاقة'), 'energy')).toBe(false);
  });
  it('a misheard word that sounds alike passes; a synonym never does', async () => {
    const { verbatim } = await import('./transcript-fix');
    expect(verbatim(S('راكل', 0.4), 'راكب')).toBe(true);
    expect(verbatim(S('بأصص طافة', 0.5), 'بقصص تافهة')).toBe(true);
    expect(verbatim(S('مشنهاك', 0.5), 'مشان هيك')).toBe(true);
    expect(verbatim(S('الأشعة'), 'الطاقة')).toBe(false); // clear word, other meaning
    expect(verbatim(S('الأشعة', 0.3), 'الطاقة')).toBe(false); // unsure, still not what was heard
    expect(verbatim(S('شي'), 'شيء')).toBe(true); // one sound: spelling only
    expect(verbatim(S('سريعة'), 'بطيئة')).toBe(false);
  });
});

describe('two passes checking each other', () => {
  it('alternatives: where the second pass heard other words, matched by letters', async () => {
    const { alternatives } = await import('./transcript-fix');
    const main = 'بتقدر تحمل 12 راكل أو إلى'.split(' ').map((t, i) => W(t, i, i + 1));
    const other = 'وبتقدر تحمل 12 راكب، أو إلى'.split(' ').map((t, i) => W(t, i, i + 1));
    expect(alternatives(main, other)).toEqual([{ from: 0, to: 0, text: 'وبتقدر' }, { from: 3, to: 3, text: 'راكب،' }]);
    expect(alternatives(main, main)).toEqual([]);
  });
  it('a fix that takes the other pass\'s words passes the guard even when it sounds far', async () => {
    const { guardFixes } = await import('./transcript-fix');
    const ws = 'كانت سابقا تقذي'.split(' ').map((t, i) => W(t, i, i + 1, 0.9));
    const fix = { from: 2, to: 2, text: 'تكلفنا' };
    expect(guardFixes(ws, [fix])).toEqual([]);
    expect(guardFixes(ws, [fix], [{ from: 2, to: 2, text: 'تكلفنا' }])).toEqual([fix]);
  });
});
