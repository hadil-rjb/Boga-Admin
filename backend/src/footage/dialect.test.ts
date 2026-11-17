import { describe, expect, it } from 'vitest';
import { bare, detectDialect } from './dialect';

const W = (s: string) => s.split(' ').map((t) => ({ t }));

describe('detectDialect', () => {
  it('strips diacritics, punctuation and a leading و / ب', () => {
    expect(bare('هيكَ،')).toBe('هيك'); expect(bare('الـ')).toBe('ال'); expect(bare('SpaceX')).toBe('');
    expect(detectDialect(W('وهيك فشو عم بدي هلق'))?.dialect).toBe('levantine');
  });
  it('Levantine, Egyptian, Gulf and Maghrebi speech', () => {
    expect(detectDialect(W('مشان هيك عم قلكن هلق شو بدي احكي'))?.dialect).toBe('levantine');
    expect(detectDialect(W('عايز أقولكم دلوقتي حاجة مهمة أوي علشان كده'))?.dialect).toBe('egyptian');
    expect(detectDialect(W('الحين أبي أكلمكم عن شي وايد زين ترى'))?.dialect).toBe('gulf');
    expect(detectDialect(W('دابا بغيت نهضر معاكم بزاف كيفاش'))?.dialect).toBe('maghrebi');
  });
  it('formal Arabic, or too few markers: none', () => {
    expect(detectDialect(W('إن التكنولوجيا الحديثة تغير حياتنا اليومية بشكل كبير'))).toBeNull();
    expect(detectDialect(W('هيك الحياة'))).toBeNull();
  });
});
