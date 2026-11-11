import { describe, it, expect } from 'vitest';
import { buildPalette, nearestIndexer, lzw, encodeGif, gifSize, gifEstimate, GIF_FPS, GIF_SIZES } from './gif.js';

/** Solid RGBA frame */
const solid = (w, h, [r, g, b]) => { const a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < a.length; i += 4) { a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255; } return a; };

/** A reference LZW decoder for GIF image data (min code size + sub-blocks), to prove the encoder round-trips */
function unlzw(minSize, bytes) {
  const clear = 1 << minSize, eoi = clear + 1; let size = minSize + 1, dict = [], prev = null, bit = 0; const out = [];
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = null; size = minSize + 1; prev = null; };
  const read = () => { let v = 0; for (let i = 0; i < size; i++, bit++) v |= ((bytes[bit >> 3] >> (bit & 7)) & 1) << i; return v; };
  reset();
  for (;;) {
    const code = read();
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    let entry;
    if (code < dict.length) entry = dict[code]; else entry = [...prev, prev[0]];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === (1 << size) && size < 12) size++;
  }
  return out;
}
/** Joins the sub-blocks of the first image in a GIF and returns { minSize, data } */
function firstImage(gif) {
  let p = 6 + 7; const flags = gif[10]; if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
  for (;;) {
    if (gif[p] === 0x21) { p += 2; while (gif[p]) p += gif[p] + 1; p++; continue; }
    if (gif[p] === 0x2c) { p += 10; const minSize = gif[p++]; const data = []; while (gif[p]) { data.push(...gif.slice(p + 1, p + 1 + gif[p])); p += gif[p] + 1; } return { minSize, data }; }
    throw new Error('unexpected block ' + gif[p]);
  }
}

describe('buildPalette', () => {
  it('keeps the exact colours when there are few', () => {
    const f = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255]);
    const pal = buildPalette([f]);
    const cols = pal.map((c) => c.join(','));
    expect(cols).toContain('255,0,0'); expect(cols).toContain('0,0,255'); expect(cols).toContain('255,255,255');
    expect(pal.length).toBeLessThanOrEqual(256);
  });
  it('never returns more than 256 colours, and at least 2', () => {
    const f = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) { f[i * 4] = i % 256; f[i * 4 + 1] = (i * 7) % 256; f[i * 4 + 2] = (i * 13) % 256; f[i * 4 + 3] = 255; }
    expect(buildPalette([f]).length).toBeLessThanOrEqual(256);
    expect(buildPalette([solid(2, 2, [9, 9, 9])]).length).toBeGreaterThanOrEqual(2);
  });
});

describe('nearestIndexer', () => {
  it('maps a colour to the closest palette entry', () => {
    const ix = nearestIndexer([[0, 0, 0], [255, 255, 255], [255, 0, 0]]);
    expect(ix(250, 10, 10)).toBe(2); expect(ix(20, 20, 20)).toBe(0); expect(ix(240, 240, 240)).toBe(1);
  });
});

describe('lzw', () => {
  it('round-trips through a reference decoder', () => {
    const px = []; for (let i = 0; i < 5000; i++) px.push((i * i + (i >> 3)) % 17);
    const out = lzw(Uint8Array.from(px), 5);
    expect(unlzw(5, out)).toEqual(px);
  });
  it('survives a dictionary reset (more than 4096 codes)', () => {
    const px = []; let s = 1; for (let i = 0; i < 40000; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; px.push(s % 256); }
    expect(unlzw(8, lzw(Uint8Array.from(px), 8))).toEqual(px);
  });
});

describe('encodeGif', () => {
  const frames = [solid(4, 3, [255, 0, 0]), solid(4, 3, [0, 0, 255])];
  const gif = encodeGif(frames, { width: 4, height: 3, fps: 10 });
  it('is a looping GIF89a of the right size', () => {
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe('GIF89a');
    expect(gif[6] | (gif[7] << 8)).toBe(4); expect(gif[8] | (gif[9] << 8)).toBe(3);
    expect(String.fromCharCode(...gif).includes('NETSCAPE2.0')).toBe(true);
    expect(gif[gif.length - 1]).toBe(0x3b);
  });
  it('has one image per frame, each with its delay in hundredths of a second', () => {
    let images = 0, delays = [];
    for (let i = 0; i < gif.length - 8; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 4) { delays.push(gif[i + 4] | (gif[i + 5] << 8)); images++; }
    expect(images).toBe(2); expect(delays).toEqual([10, 10]);
  });
  it('the first frame decodes back to its colour', () => {
    const { minSize, data } = firstImage(gif), idx = unlzw(minSize, data);
    expect(idx).toHaveLength(12);
    const p = 13 + idx[0] * 3;
    expect([gif[p], gif[p + 1], gif[p + 2]]).toEqual([255, 0, 0]);
    expect(new Set(idx).size).toBe(1);
  });
  it('reports progress and can be told to stop', () => {
    const seen = []; encodeGif(frames, { width: 4, height: 3, fps: 10, onStep: (p) => seen.push(p) });
    expect(seen[seen.length - 1]).toBe(1);
    expect(encodeGif(frames, { width: 4, height: 3, fps: 10, signal: { stop: true } })).toBe(null);
  });
});

describe('sizes and estimates', () => {
  it('offers 10, 12 and 15 fps and 360, 540, 720 px', () => {
    expect(GIF_FPS).toEqual([10, 12, 15]); expect(GIF_SIZES).toEqual([360, 540, 720]);
  });
  it('scales the short side, never up, to even numbers', () => {
    expect(gifSize(1080, 1080, 540)).toEqual({ w: 540, h: 540, s: 0.5 });
    expect(gifSize(1080, 1920, 540)).toEqual({ w: 540, h: 960, s: 0.5 });
    expect(gifSize(400, 300, 540)).toEqual({ w: 400, h: 300, s: 1 });
  });
  it('estimates a size that grows with length, size and frame rate', () => {
    const a = gifEstimate(540, 540, 12, 3000), b = gifEstimate(540, 540, 12, 6000), c = gifEstimate(720, 720, 15, 3000);
    expect(b).toBeGreaterThan(a); expect(c).toBeGreaterThan(a); expect(a).toBeGreaterThan(0);
  });
});
