import { describe, expect, it } from 'vitest';
import { boxOf, unionBox, connectorPts, edgePoint, pathFrom, readingOrder, captionOf, toLayers, notesToPages } from './canvas-model.js';

const sticky = (id, x, y, text) => ({ id, k: 'sticky', x, y, w: 200, h: 200, text });

describe('canvas geometry', () => {
  it('joins the edges of two attached elements', () => {
    const a = sticky('a', 0, 0, ''), b = sticky('b', 400, 0, '');
    const m = new Map([[a.id, a], [b.id, b]]);
    const [[ax, ay], [bx, by]] = connectorPts({ k: 'connector', a: { id: 'a' }, b: { id: 'b' } }, m);
    expect([ax, ay]).toEqual([206, 100]);
    expect([bx, by]).toEqual([394, 100]);
    expect(boxOf({ k: 'connector', a: { id: 'a' }, b: { x: 600, y: 300 } }, m)).toMatchObject({ x: expect.any(Number), w: expect.any(Number) });
  });
  it('stops at the target when it is inside the box', () => {
    expect(edgePoint({ x: 0, y: 0, w: 100, h: 100 }, 60, 50)).toEqual([60, 50]);
  });
  it('builds a path box around a stroke, with room for its width', () => {
    const p = pathFrom([10, 10, 50, 30], '#000', 4);
    expect(p).toMatchObject({ k: 'path', x: 8, y: 8, w: 44, h: 24 });
    expect(p.pts.slice(0, 2)).toEqual([2, 2]);
  });
  it('unions boxes', () => {
    expect(unionBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: -5, w: 5, h: 5 }])).toEqual({ x: 0, y: -5, w: 25, h: 15 });
    expect(unionBox([])).toBeNull();
  });
});

describe('canvas → studio', () => {
  const notes = [sticky('c', 240, 10, 'Third'), sticky('a', 0, 0, 'First'), sticky('b', 230, 0, 'Second'), sticky('d', 0, 260, 'Fourth')];
  it('reads notes in rows, left to right', () => {
    expect(readingOrder(notes).map((n) => n.text)).toEqual(['First', 'Second', 'Third', 'Fourth']);
    expect(captionOf(notes)).toBe('First\n\nSecond\n\nThird\n\nFourth');
  });
  it('fits the arrangement inside the page', () => {
    const L = toLayers(notes, 1080, 1350);
    expect(L[0].name).toBe('Background');
    L.slice(1).forEach((l) => {
      expect(l.x).toBeGreaterThanOrEqual(0); expect(l.y).toBeGreaterThanOrEqual(0);
      expect(l.x + l.w).toBeLessThanOrEqual(1080); expect(l.y + l.h).toBeLessThanOrEqual(1350);
    });
    expect(L.filter((l) => l.type === 'text').map((l) => l.text)).toContain('First');
  });
  it('makes one slide per note', () => {
    const P = notesToPages(notes, 1080, 1350, { bg: '#000' });
    expect(P).toHaveLength(4);
    expect(P[0].layers.find((l) => l.type === 'text').text).toBe('First');
    expect(P[3].layers.some((l) => l.text === '4 / 4')).toBe(true);
  });
});

import { generateRequest, photoLayers } from './canvas-model.js';
describe('generate design', () => {
  const els = [
    { id: 'n2', k: 'sticky', x: 230, y: 0, w: 200, h: 200, text: 'Post at 9am' },
    { id: 'n1', k: 'sticky', x: 0, y: 0, w: 200, h: 200, text: 'Create\nStory' },
    { id: 'p', k: 'image', src: 'https://x.test/a.png', x: 0, y: 300, w: 300, h: 400 },
  ];
  it('asks with the notes in order and names the photos as content', () => {
    const r = generateRequest(els, { slides: 1, label: 'Portrait 4:5' });
    expect(r.text).toContain('- Create Story\n- Post at 9am');
    expect(r.text).toContain('Use the photo already on the page');
    expect(r.note).toContain('not inspiration');
    expect(r.note).toContain('Keep this size');
    expect(r.photos).toBe(1);
  });
  it('puts the user’s words first', () => {
    expect(generateRequest(els, { extra: 'A teaser for Friday' }).text.startsWith('A teaser for Friday')).toBe(true);
  });
  it('places only the photos', () => {
    const L = photoLayers(els, 1080, 1350);
    expect(L).toHaveLength(1);
    expect(L[0]).toMatchObject({ type: 'image', name: 'From the board' });
  });
});
