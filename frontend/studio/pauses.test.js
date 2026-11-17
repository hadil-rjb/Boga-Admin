import { describe, it, expect } from 'vitest';
import { pausesOf, pauseCuts, cutAt, cutTotal, editedMs, keepFrames, keptFrames, LEAD, TAIL, PAUSE_DEFAULT_MS } from './pauses.js';

const W = (s, e) => ({ t: 'w', s, e });

describe('pausesOf', () => {
  it('defaults to off at 600 ms and clamps the length', () => {
    expect(pausesOf(undefined)).toEqual({ on: false, min: PAUSE_DEFAULT_MS });
    expect(pausesOf({ on: true, min: 50 })).toEqual({ on: true, min: 300 });
    expect(pausesOf({ on: true, min: 99999 })).toEqual({ on: true, min: 2000 });
    expect(pausesOf({ on: 1, min: 'x' })).toEqual({ on: true, min: PAUSE_DEFAULT_MS });
  });
});

describe('pauseCuts', () => {
  it('no words, no cuts (a video without a transcript is never cut)', () => {
    expect(pauseCuts([], 10000)).toEqual([]);
    expect(pauseCuts(null, 10000)).toEqual([]);
  });
  it('cuts the silence before the first word, between words and after the last, keeping a breath', () => {
    const cuts = pauseCuts([W(2000, 2500), W(2600, 3000), W(5000, 5400)], 9000, 600);
    expect(cuts).toEqual([[0, 2000 - LEAD], [3000 + TAIL, 5000 - LEAD], [5400 + TAIL, 9000]]);
  });
  it('leaves silences shorter than the minimum alone', () => {
    expect(pauseCuts([W(100, 500), W(1000, 1400)], 1700, 600)).toEqual([]);
    expect(pauseCuts([W(100, 500), W(1000, 1400)], 1700, 400)).toEqual([[500 + TAIL, 1000 - LEAD]]);
  });
  it('measures from the latest word end (overlapping words) and sorts unsorted input', () => {
    expect(pauseCuts([W(3000, 3200), W(0, 1000), W(200, 400)], 3200, 600)).toEqual([[1000 + TAIL, 3000 - LEAD]]);
  });
  it('drops cuts shorter than 80 ms and ignores words past the end', () => {
    expect(pauseCuts([W(0, 100), W(470, 600), W(9000, 9100)], 700, 300)).toEqual([]);
  });
});

describe('time helpers', () => {
  const cuts = [[1000, 2000], [5000, 5500]];
  it('cutAt is half-open', () => {
    expect(cutAt(cuts, 999)).toBe(null);
    expect(cutAt(cuts, 1000)).toEqual([1000, 2000]);
    expect(cutAt(cuts, 1999)).toEqual([1000, 2000]);
    expect(cutAt(cuts, 2000)).toBe(null);
    expect(cutAt(cuts, 5200)).toEqual([5000, 5500]);
  });
  it('cutTotal and editedMs', () => {
    expect(cutTotal(cuts)).toBe(1500);
    expect(editedMs(cuts, 8000)).toBe(6500);
    expect(editedMs([], 8000)).toBe(8000);
  });
});

describe('keepFrames', () => {
  it('the whole video when nothing is cut', () => {
    expect(keepFrames([], 2000, 30)).toEqual([[0, 59]]);
  });
  it('snaps cut edges to frames and keeps what is between', () => {
    // 1000..2000 ms at 30 fps = frames 30..59 cut; 5000..5500 = frames 150..164 cut; 8 s = 240 frames
    const k = keepFrames([[1000, 2000], [5000, 5500]], 8000, 30);
    expect(k).toEqual([[0, 29], [60, 149], [165, 239]]);
    expect(keptFrames(k)).toBe(240 - 30 - 15);
  });
  it('a cut at the start or to the end leaves no empty range', () => {
    expect(keepFrames([[0, 1000], [7000, 8000]], 8000, 25)).toEqual([[25, 174]]);
  });
  it('a cut shorter than half a frame disappears', () => {
    expect(keepFrames([[1000, 1010]], 2000, 30)).toEqual([[0, 59]]);
  });
});

describe('toEdited', () => {
  it('removes the cut time before ms', async () => {
    const { toEdited } = await import('./pauses.js');
    const cuts = [[1000, 2000], [5000, 5500]];
    expect(toEdited(cuts, 500)).toBe(500);
    expect(toEdited(cuts, 1500)).toBe(1000);
    expect(toEdited(cuts, 3000)).toBe(2000);
    expect(toEdited(cuts, 6000)).toBe(4500);
  });
});

describe('toSource and editPeaks', () => {
  it('toSource undoes toEdited; at a joint a start goes after the cut, an end before it', async () => {
    const { toSource, toEdited } = await import('./pauses.js');
    const cuts = [[1000, 2000], [5000, 5500]];
    for (const t of [0, 500, 2500, 4000, 6000]) expect(toSource(cuts, toEdited(cuts, t))).toBe(t);
    expect(toSource(cuts, 1000)).toBe(2000);
    expect(toSource(cuts, 1000, true)).toBe(1000);
    expect(toSource([[0, 1000]], 0)).toBe(1000);
  });
  it('editPeaks drops the cut buckets', async () => {
    const { editPeaks } = await import('./pauses.js');
    const p = Float32Array.from([1, 1, 0, 0, 1, 1, 1, 1, 1, 1]); // 10 s, silent from 2 to 4 s
    expect(Array.from(editPeaks(p, [[2000, 4000]], 10000))).toEqual(Array(10).fill(1));
    expect(editPeaks(p, [], 10000)).toBe(p);
  });
});
