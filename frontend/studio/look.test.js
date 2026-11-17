import { describe, it, expect } from 'vitest';
import { parseCube, writeCube, identityCube, sampleCube, tweak, bakeExport } from './look.js';

describe('look', () => {
  it('round-trips a cube', () => { const l = identityCube(5); expect(parseCube(writeCube(l)).data).toEqual(l.data); });
  it('identity samples to itself', () => { const l = identityCube(33); expect(sampleCube(l, [0.31, 0.62, 0.9])).toEqual([0.31, 0.62, 0.9].map((v) => expect.closeTo(v, 5))); });
  it('zero tweaks are identity', () => { expect(tweak([0.2, 0.5, 0.8], { exposure: 0, temp: 0, sat: 0 })).toEqual([0.2, 0.5, 0.8].map((v) => expect.closeTo(v, 6))); });
  it('sat -1 gives gray', () => { const [r, g, b] = tweak([0.9, 0.2, 0.1], { exposure: 0, temp: 0, sat: -1 }); expect(r).toBeCloseTo(g, 5); expect(g).toBeCloseTo(b, 5); });
  it('strength 0 bakes to identity', () => { const look = identityCube(9); look.data.fill(0.5); const out = bakeExport({ look, hlg: null, strength: 0, tweaks: { exposure: 0, temp: 0, sat: 0 } }); expect(Array.from(out.data)).toEqual(Array.from(identityCube(9).data).map((v) => expect.closeTo(v, 5))); });
  it('parses LUT_3D_SIZE, skips TITLE and comments', () => { expect(parseCube('TITLE "x"\n# c\nLUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(8)).size).toBe(2); });
});

describe('look filters', async () => {
  const { FILTERS, fxOf, filterParams, applyFilter, bakeExport, identityCube } = await import('./look.js');
  it('fxOf: defaults and clamps; unknown filter is none', () => {
    expect(fxOf(undefined)).toEqual({ filter: 'none', amount: 0.8, shadows: 0, highlights: 0, grain: 0, vignette: 0 });
    expect(fxOf({ filter: 'x', amount: 3, grain: -1, vignette: 0.5, shadows: 2 })).toEqual({ filter: 'none', amount: 1, shadows: 1, highlights: 0, grain: 0, vignette: 0.5 });
  });
  it('none and amount 0 leave colours as they are', () => {
    expect(applyFilter([0.3, 0.5, 0.7], filterParams({ filter: 'none' }))).toEqual([0.3, 0.5, 0.7]);
    expect(applyFilter([0.3, 0.5, 0.7], filterParams({ filter: 'warm', amount: 0 }))).toEqual([0.3, 0.5, 0.7]);
  });
  it('B&W makes grey; warm warms; cinematic pushes shadows teal and highlights orange', () => {
    const [r, g, b] = applyFilter([0.8, 0.3, 0.2], filterParams({ filter: 'bw', amount: 1 }));
    expect(Math.abs(r - g)).toBeLessThan(1e-9); expect(Math.abs(g - b)).toBeLessThan(1e-9);
    const w = applyFilter([0.5, 0.5, 0.5], filterParams({ filter: 'warm', amount: 1 })); expect(w[0]).toBeGreaterThan(w[2]);
    const sh = applyFilter([0.15, 0.15, 0.15], filterParams({ filter: 'cinematic', amount: 1 })), hi = applyFilter([0.85, 0.85, 0.85], filterParams({ filter: 'cinematic', amount: 1 }));
    expect(sh[2]).toBeGreaterThan(sh[0]); expect(hi[0]).toBeGreaterThan(hi[2]);
    expect(Object.keys(FILTERS)).toEqual(['none', 'natural', 'portrait', 'cinematic', 'warm', 'bw', 'vintage']);
  });
  it('the export LUT carries the filter', () => {
    const plain = bakeExport({ look: identityCube(5), hlg: null, strength: 0, tweaks: {} });
    const bw = bakeExport({ look: identityCube(5), hlg: null, strength: 0, tweaks: {}, fx: { filter: 'bw', amount: 1 } });
    const k = (1 * 25 + 2 * 5 + 4) * 3; // r=4, g=2, b=1 node
    expect(plain.data[k]).not.toBeCloseTo(plain.data[k + 2], 2);
    expect(bw.data[k]).toBeCloseTo(bw.data[k + 2], 6);
  });
});

describe('light balance (backlit faces, bright windows)', async () => {
  const { applyTone, bakeExport, identityCube } = await import('./look.js');
  const y = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  it('lifts a dark face, tones down a bright window, leaves black and white alone', () => {
    const face = [0.3, 0.22, 0.18], sky = [0.9, 0.92, 0.95];
    expect(y(applyTone(face, 0.6, 0))).toBeGreaterThan(y(face) * 1.4);
    expect(y(applyTone(sky, 0, 0.6))).toBeLessThan(y(sky) - 0.05);
    expect(applyTone([0, 0, 0], 1, 1)).toEqual([0, 0, 0]);
    expect(applyTone([1, 1, 1], 0, 1).map((v) => +v.toFixed(6))).toEqual([0.85, 0.85, 0.85]); // a blown-out window: toned down
    expect(applyTone([0.6, 0.45, 0.4], 0, 1)).toEqual([0.6, 0.45, 0.4]); // skin is below the highlights' knee: untouched
    expect(applyTone(face, 0, 0)).toEqual(face);
  });
  it('keeps the hue (all channels scale together) and never reverses brightness order', () => {
    const c = applyTone([0.3, 0.2, 0.1], 0.8, 0.8);
    expect(c[0] / c[2]).toBeCloseTo(3, 6);
    let prev = -1; for (let v = 0; v <= 1.0001; v += 0.02) { const o = y(applyTone([v, v, v], 1, 1)); expect(o).toBeGreaterThanOrEqual(prev - 1e-9); prev = o; }
  });
  it('the export LUT carries it', () => {
    const k = (0 * 25 + 0 * 5 + 1) * 3; // a dark red node
    const a = bakeExport({ look: identityCube(5), hlg: null, strength: 0, tweaks: {} }), b = bakeExport({ look: identityCube(5), hlg: null, strength: 0, tweaks: {}, fx: { filter: 'none', shadows: 1 } });
    expect(b.data[k]).toBeGreaterThan(a.data[k]);
  });
});
