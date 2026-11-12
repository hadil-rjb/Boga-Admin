import { describe, it, expect } from 'vitest';
import { previewKind, loopTime, liveSize, DWELL_MS } from './card-preview.js';

describe('previewKind', () => {
  it('an uploaded video plays its file, an animated design its scenes, a still nothing', () => {
    expect(previewKind({ footage: { src: 'abc' }, pages: [{}] })).toBe('video');
    expect(previewKind({ motion: { fps: 30 }, pages: [{}, {}] })).toBe('reel');
    expect(previewKind({ pages: [{}, {}, {}] })).toBe(null);
    expect(previewKind(null)).toBe(null);
  });
  it('a video design with no file yet has nothing to play', () => {
    expect(previewKind({ footage: { src: '' }, pages: [{}] })).toBe(null);
  });
});

describe('loopTime', () => {
  it('wraps around the length, so the preview loops', () => {
    expect(loopTime(0, 6000)).toBe(0); expect(loopTime(2500, 6000)).toBe(2500); expect(loopTime(6500, 6000)).toBe(500); expect(loopTime(18000, 6000)).toBe(0);
  });
  it('copes with no length and a negative clock', () => {
    expect(loopTime(500, 0)).toBe(0); expect(loopTime(-20, 6000)).toBe(0);
  });
});

describe('liveSize', () => {
  it('the canvas matches the thumbnail in device pixels, capped so a hover stays cheap', () => {
    expect(liveSize(190, 190, 2)).toEqual({ w: 380, h: 380 });
    expect(liveSize(120.4, 214.2, 1)).toEqual({ w: 120, h: 214 });
    const big = liveSize(400, 400, 3); expect(big.w).toBeLessThanOrEqual(640); expect(big.w).toBe(big.h);
  });
  it('never returns an empty canvas', () => { expect(liveSize(0, 0, 1)).toEqual({ w: 2, h: 2 }); });
});

describe('dwell', () => {
  it('waits a moment before playing, so passing over a card does not start it', () => {
    expect(DWELL_MS).toBeGreaterThanOrEqual(120); expect(DWELL_MS).toBeLessThanOrEqual(400);
  });
});
