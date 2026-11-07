import { describe, it, expect } from 'vitest';
import { tickStep, nextZoom, clampDrag, MIN_LINE_MS } from './timeline.js';

describe('ruler', () => {
  it('tickStep keeps major ticks at least 64 px apart', () => {
    expect(tickStep(40)).toBe(2);
    expect(tickStep(160)).toBe(0.5);
    expect(tickStep(10)).toBe(10);
    expect(tickStep(0.01)).toBe(600);
  });
});

describe('zoom', () => {
  // 800 px view, 60 s video: "fit" is 13.3 px/s
  it('nextZoom from fit goes to the first step wider than fit', () => {
    expect(nextZoom(null, 1, 800, 60000)).toBe(20);
    expect(nextZoom(20, 1, 800, 60000)).toBe(40);
    expect(nextZoom(160, 1, 800, 60000)).toBe(160); // the last step stays
  });
  it('nextZoom out goes to the previous step, or to fit (null) below fit', () => {
    expect(nextZoom(40, -1, 800, 60000)).toBe(20);
    expect(nextZoom(20, -1, 800, 60000)).toBe(null);
    expect(nextZoom(null, -1, 800, 60000)).toBe(null);
  });
  it('nextZoom keeps the zoom without a view or a duration', () => {
    expect(nextZoom(40, 1, 0, 60000)).toBe(40);
    expect(nextZoom(null, 1, 800, 0)).toBe(null);
  });
});

describe('caption drag', () => {
  const L = (id, start, end) => ({ id, start, end, words: [] });
  const ls = [L('a', 0, 1000), L('b', 1500, 2500), L('c', 3000, 4000)];
  it('clampDrag keeps 200 ms and the neighbours', () => {
    expect(MIN_LINE_MS).toBe(200);
    expect(clampDrag(ls, 1, 'start', 900)).toEqual({ start: 1000, end: 2500 });
    expect(clampDrag(ls, 1, 'start', 2490)).toEqual({ start: 2300, end: 2500 });
    expect(clampDrag(ls, 1, 'end', 1510)).toEqual({ start: 1500, end: 1700 });
    expect(clampDrag(ls, 1, 'end', 9000)).toEqual({ start: 1500, end: 3000 });
    expect(clampDrag(ls, 1, 'start', 1200)).toEqual({ start: 1200, end: 2500 });
  });
  it('clampDrag moves the block without changing its length and stops at neighbours and the video ends', () => {
    expect(clampDrag(ls, 1, 'move', 1700)).toEqual({ start: 1700, end: 2700 });
    expect(clampDrag(ls, 1, 'move', 0)).toEqual({ start: 1000, end: 2000 });
    expect(clampDrag(ls, 1, 'move', 5000)).toEqual({ start: 2000, end: 3000 });
    expect(clampDrag(ls, 0, 'move', -300)).toEqual({ start: 0, end: 1000 });
    expect(clampDrag(ls, 2, 'move', 9000, 4500)).toEqual({ start: 3500, end: 4500 });
    expect(clampDrag(ls, 2, 'end', 9000, 4500)).toEqual({ start: 3000, end: 4500 });
  });
});
