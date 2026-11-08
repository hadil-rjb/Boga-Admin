import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FootageStore } from './footage.store';

const id = 'a'.repeat(24);
let root: string, store: FootageStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'footage-')); process.env.FOOTAGE_DIR = root; store = new FootageStore(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('FootageStore', () => {
  it('rejects ids that are not ObjectIds', () => {
    expect(() => store.dir('../etc')).toThrow();
    expect(() => store.dir('A'.repeat(24))).toThrow();
    expect(store.dir(id)).toBe(join(root, id));
  });
  it('assembles chunks in index order', async () => {
    await store.writeChunk(id, 1, Buffer.from('b'));
    await store.writeChunk(id, 0, Buffer.from('a'));
    await store.writeChunk(id, 10, Buffer.from('c'));
    const p = await store.assemble(id, 'mp4');
    expect(p).toBe(join(root, id, 'source.mp4'));
    expect(await fs.readFile(p, 'utf8')).toBe('abc');
    expect(await store.received(id)).toEqual([0, 1, 10]); // kept until clearChunks
    await store.clearChunks(id);
    expect(await store.received(id)).toEqual([]);
  });
  it('concurrent writes of one chunk index leave a whole chunk', async () => {
    await Promise.all([1, 2, 3, 4].map(() => store.writeChunk(id, 0, Buffer.alloc(100000, 7))));
    expect((await fs.readFile(join(root, id, 'chunks', '0'))).length).toBe(100000);
    expect(await store.received(id)).toEqual([0]);
  });
  it('lists received chunks for resume', async () => {
    await store.writeChunk(id, 0, Buffer.from('a'));
    await store.writeChunk(id, 2, Buffer.from('c'));
    expect(await store.received(id)).toEqual([0, 2]);
  });
  it('received is empty for unknown footage; remove deletes the folder', async () => {
    expect(await store.received(id)).toEqual([]);
    await store.writeChunk(id, 0, Buffer.from('a'));
    await store.remove(id);
    await expect(fs.stat(join(root, id))).rejects.toThrow();
  });
  it('rejects bad chunk indices and extensions', async () => {
    await expect(store.writeChunk(id, -1, Buffer.from('a'))).rejects.toThrow();
    await expect(store.writeChunk(id, 1.5, Buffer.from('a'))).rejects.toThrow();
    await store.writeChunk(id, 0, Buffer.from('a'));
    await expect(store.assemble(id, '../x')).rejects.toThrow();
  });
  it('file() resolves known names only', () => {
    expect(store.file(id, 'proxy.mp4')).toBe(join(root, id, 'proxy.mp4'));
    expect(store.file(id, 'exports/j1.mp4')).toBe(join(root, id, 'exports', 'j1.mp4'));
    expect(() => store.file(id, 'exports/../../x.mp4' as any)).toThrow();
  });
});
