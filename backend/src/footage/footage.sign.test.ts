import { beforeAll, describe, expect, it } from 'vitest';
import { signFile, verifyFile } from './footage.sign';

const id = 'b'.repeat(24);
const tok = (u: string) => u.split('?t=')[1];
beforeAll(() => { process.env.JWT_SECRET = 'test-secret-0123456789abcdef'; });

describe('footage.sign', () => {
  it('signs a relative URL and verifies it', () => {
    const u = signFile(id, 'proxy.mp4', 1000);
    expect(u.startsWith(`/footage/${id}/proxy.mp4?t=`)).toBe(true);
    expect(verifyFile(id, 'proxy.mp4', tok(u), 1001)).toBe(true);
  });
  it('signs exports with their path', () => {
    const u = signFile(id, 'exports/j1.mp4', 1000);
    expect(u.startsWith(`/footage/${id}/exports/j1.mp4?t=`)).toBe(true);
    expect(verifyFile(id, 'exports/j1.mp4', tok(u), 1000)).toBe(true);
  });
  it('rejects a tampered signature or expiry', () => {
    const [exp, sig] = tok(signFile(id, 'proxy.mp4', 1000)).split('.');
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    expect(verifyFile(id, 'proxy.mp4', `${exp}.${flipped}`, 1001)).toBe(false);
    expect(verifyFile(id, 'proxy.mp4', `${Number(exp) + 1000}.${sig}`, 1001)).toBe(false);
    expect(verifyFile(id, 'proxy.mp4', 'garbage', 1001)).toBe(false);
    expect(verifyFile(id, 'proxy.mp4', '', 1001)).toBe(false);
  });
  it('rejects an expired token', () => {
    const t = tok(signFile(id, 'proxy.mp4', 1000));
    expect(verifyFile(id, 'proxy.mp4', t, 1000 + 6 * 3600 + 1)).toBe(false);
    expect(verifyFile(id, 'proxy.mp4', t, 1000 + 6 * 3600 - 1)).toBe(true);
  });
  it('rejects a token made for another file or id', () => {
    const t = tok(signFile(id, 'proxy.mp4', 1000));
    expect(verifyFile(id, 'exports/j1.mp4', t, 1001)).toBe(false);
    expect(verifyFile('c'.repeat(24), 'proxy.mp4', t, 1001)).toBe(false);
  });
});
