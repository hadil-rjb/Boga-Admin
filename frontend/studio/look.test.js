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
