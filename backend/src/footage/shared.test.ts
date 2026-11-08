import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadShared } from './shared';

describe('shared modules', () => {
  it('backend copy of look.js is byte-identical to the frontend source', () => {
    const a = readFileSync(join(__dirname, 'shared', 'look.mjs'));
    const b = readFileSync(join(__dirname, '..', '..', '..', 'frontend', 'studio', 'look.js'));
    expect(a.equals(b)).toBe(true);
  });
  it('loadShared exposes look.identityCube', async () => {
    const { look } = await loadShared();
    expect(typeof look.identityCube).toBe('function');
    expect(look.identityCube(3).size).toBe(3);
  });
  it('backend copy of captions.js is byte-identical to the frontend source', () => {
    const a = readFileSync(join(__dirname, 'shared', 'captions.mjs'));
    const b = readFileSync(join(__dirname, '..', '..', '..', 'frontend', 'studio', 'captions.js'));
    expect(a.equals(b)).toBe(true);
  });
  it('loadShared exposes captions.DEFAULT_STYLE', async () => {
    const { captions } = await loadShared();
    expect(captions.DEFAULT_STYLE.maxWords).toBe(3);
  });
});
