import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FootageStore } from './footage.store';
import { FootageSweep } from './footage.sweep';

const DAY = 86_400_000, now = Date.parse('2026-11-04T00:00:00Z');
const oldUnused = '1'.repeat(24), oldUsed = '2'.repeat(24), newUnused = '3'.repeat(24);
let root: string, store: FootageStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'footage-')); process.env.FOOTAGE_DIR = root; store = new FootageStore(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('FootageSweep', () => {
  it('removes unreferenced footage older than 7 days only', async () => {
    for (const id of [oldUnused, oldUsed, newUnused]) await store.writeChunk(id, 0, Buffer.from('a'));
    const records = [
      { _id: oldUnused, createdAt: new Date(now - 8 * DAY) },
      { _id: oldUsed, createdAt: new Date(now - 8 * DAY) },
      { _id: newUnused, createdAt: new Date(now - 1 * DAY) },
    ];
    const deleted: string[] = [];
    const model: any = {
      find: (q: any) => ({ select: () => ({ lean: async () => records.filter((r) => r.createdAt < q.createdAt.$lt) }) }),
      deleteOne: async (q: any) => { deleted.push(String(q._id)); },
    };
    const sweep = new FootageSweep(model, store, { used: async () => new Set([oldUsed]) } as any);
    const removed = await sweep.run(now);
    expect(removed).toEqual([oldUnused]);
    expect(deleted).toEqual([oldUnused]);
    await expect(fs.stat(store.dir(oldUnused))).rejects.toThrow();
    await fs.stat(store.dir(oldUsed));
    await fs.stat(store.dir(newUnused));
  });
});
