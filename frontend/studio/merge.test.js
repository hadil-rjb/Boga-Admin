import { describe, it, expect } from 'vitest';
import { merge3 } from './merge.js';

const base = { id: 'd1', name: 'Clip', upd: '1 min ago', footage: { look: { strength: 0.1, temp: 0.45 }, audio: { vol: 1 } }, captions: { lines: [{ id: 'a', t: 'old' }], on: true } };
const clone = (v) => JSON.parse(JSON.stringify(v));

describe('merge3', () => {
  it('captions edited here, colour grade edited elsewhere: both kept, no conflict', () => {
    const mine = clone(base); mine.captions.lines = [{ id: 'b', t: 'new' }]; mine.upd = 'Just now';
    const theirs = clone(base); theirs.footage.look.strength = 0.14; theirs.upd = '2 min ago';
    const r = merge3(base, mine, theirs);
    expect(r.ok).toBe(true); expect(r.theirs).toBe(true);
    expect(r.value.captions.lines).toEqual([{ id: 'b', t: 'new' }]);
    expect(r.value.footage.look).toEqual({ strength: 0.14, temp: 0.45 });
    expect(r.value.upd).toBe('Just now');
  });
  it('the same part changed differently on both sides is a conflict, with where', () => {
    const mine = clone(base); mine.footage.look.strength = 0.2;
    const theirs = clone(base); theirs.footage.look.strength = 0.3;
    expect(merge3(base, mine, theirs)).toEqual({ ok: false, path: 'footage.look.strength' });
  });
  it('the same change on both sides, or only one side changed', () => {
    const both = clone(base); both.name = 'X';
    expect(merge3(base, both, clone(both))).toMatchObject({ ok: true, value: both });
    expect(merge3(base, base, both)).toMatchObject({ ok: true, value: both, theirs: true });
    expect(merge3(base, both, base)).toMatchObject({ ok: true, value: both, theirs: false });
  });
  it('arrays are taken whole: two different edits of the caption lines conflict', () => {
    const mine = clone(base); mine.captions.lines[0].t = 'mine';
    const theirs = clone(base); theirs.captions.lines[0].t = 'theirs';
    expect(merge3(base, mine, theirs).ok).toBe(false);
  });
  it('a key added on one side and removed on the other side merge; no base means no merge', () => {
    const mine = clone(base); mine.footage.audio.denoise = true;
    const theirs = clone(base); delete theirs.captions.on;
    const r = merge3(base, mine, theirs);
    expect(r.ok).toBe(true); expect(r.value.footage.audio.denoise).toBe(true); expect('on' in r.value.captions).toBe(false);
    expect(merge3(null, mine, theirs).ok).toBe(false);
  });
});
