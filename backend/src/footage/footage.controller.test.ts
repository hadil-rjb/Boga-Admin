import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, FootageController } from './footage.controller';
import { FootageStore } from './footage.store';
import { signFile } from './footage.sign';

/** Minimal in-memory stand-in for the mongoose model (each op body is synchronous, so claims are atomic like Mongo's) */
function fakeModel() {
  const rows: any[] = []; let n = 0;
  const match = (r: any, q: any) => Object.entries(q).every(([k, v]) => String(r[k]) === String(v));
  const wrap = (r: any) => r && ({ ...r, toObject: () => ({ ...r }) });
  return {
    rows,
    create: async (d: any) => { const r = { _id: (++n).toString(16).padStart(24, '0'), ...d }; rows.push(r); return wrap(r); },
    findOne: async (q: any) => wrap(rows.find((r) => match(r, q))),
    findById: async (id: string) => wrap(rows.find((r) => r._id === id)),
    findOneAndUpdate: async (q: any, u: any) => { const r = rows.find((x) => match(x, q)); if (!r) return null; Object.assign(r, u.$set); return wrap(r); },
    updateOne: async (q: any, u: any) => { const r = rows.find((x) => match(x, q)); if (r) Object.assign(r, u.$set); },
    deleteOne: async (q: any) => { const i = rows.findIndex((x) => match(x, q)); if (i >= 0) rows.splice(i, 1); },
  };
}
function fakeRes() {
  const chunks: Buffer[] = [];
  const res: any = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.headers = {}; res.code = 200;
  res.status = (c: number) => { res.code = c; return res; };
  res.set = (h: any) => { Object.assign(res.headers, h); return res; };
  res.done = new Promise<void>((r) => res.on('finish', r));
  res.body = () => Buffer.concat(chunks);
  return res;
}
const user = { user: { sub: 'u1' } };
let root: string, model: ReturnType<typeof fakeModel>, ctl: FootageController, enqueue: any, refs: any;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'footage-')); process.env.FOOTAGE_DIR = root; process.env.JWT_SECRET = 'test-secret-0123456789abcdef';
  model = fakeModel(); enqueue = vi.fn(); refs = { used: async () => new Set<string>() };
  ctl = new FootageController(model as any, new FootageStore(), refs, { enqueue } as any);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const dto = (o: any = {}) => ({ name: 'a.mp4', size: 10, mime: 'video/mp4', role: 'original', brand: 'b1', ...o });
const req = (body: any) => ({ body });

describe('create', () => {
  it('rejects non-video MIME and oversize', async () => {
    await expect(ctl.create(user, dto({ mime: 'image/png' }))).rejects.toThrow(/video/);
    await expect(ctl.create(user, dto({ size: 2 * 1024 ** 3 + 1 }))).rejects.toThrow(/2 GB/);
  });
  it('returns the id and chunk size, then resumes the same upload with its received chunks', async () => {
    const a = await ctl.create(user, dto());
    expect(a).toMatchObject({ chunkSize: CHUNK_SIZE, received: [] });
    await ctl.chunk(a.id, '0', req(Buffer.from('x')));
    const b = await ctl.create(user, dto());
    expect(b.id).toBe(a.id);
    expect(b.received).toEqual([0]);
    expect((await ctl.create(user, dto({ name: 'other.mp4' }))).id).not.toBe(a.id);
    expect((await ctl.create({ user: { sub: 'u2' } }, dto())).id).not.toBe(a.id);
  });
});

describe('chunk', () => {
  it('validates index, body and id', async () => {
    const { id } = await ctl.create(user, dto());
    await expect(ctl.chunk(id, '1', req(Buffer.from('x')))).rejects.toThrow(/index/); // size 10 -> one chunk only
    await expect(ctl.chunk(id, '-1', req(Buffer.from('x')))).rejects.toThrow(/index/);
    await expect(ctl.chunk(id, 'abc', req(Buffer.from('x')))).rejects.toThrow(/index/);
    await expect(ctl.chunk(id, '0', req(undefined))).rejects.toThrow(/raw/);
    await expect(ctl.chunk(id, '0', req(Buffer.alloc(0)))).rejects.toThrow(/raw/);
    await expect(ctl.chunk('../etc', '0', req(Buffer.from('x')))).rejects.toThrow();
  });
  it('rejects with 409 once the upload is no longer uploading', async () => {
    const { id } = await ctl.create(user, dto());
    await ctl.chunk(id, '0', req(Buffer.from('0123456789')));
    await ctl.complete(id);
    await expect(ctl.chunk(id, '0', req(Buffer.from('x')))).rejects.toMatchObject({ status: 409 });
  });
});

describe('complete', () => {
  it('assembles, sets processing, clears chunks and enqueues probe', async () => {
    const { id } = await ctl.create(user, dto());
    await ctl.chunk(id, '0', req(Buffer.from('0123456789')));
    const rec = await ctl.complete(id);
    expect(rec.status).toBe('processing');
    expect(enqueue).toHaveBeenCalledWith(id, 'probe');
    expect(await fs.readFile(join(root, id, 'source.mp4'), 'utf8')).toBe('0123456789');
    await expect(fs.stat(join(root, id, 'chunks'))).rejects.toThrow();
    expect((await ctl.complete(id)).status).toBe('processing'); // idempotent
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it('missing chunks: 400 and the upload stays resumable', async () => {
    const size = CHUNK_SIZE + 5, { id } = await ctl.create(user, dto({ size }));
    await ctl.chunk(id, '1', req(Buffer.from('12345')));
    await expect(ctl.complete(id)).rejects.toThrow(/Missing chunks/);
    expect(model.rows[0].status).toBe('uploading');
    await ctl.chunk(id, '0', req(Buffer.alloc(CHUNK_SIZE)));
    expect((await ctl.complete(id)).status).toBe('processing');
  });
  it('size mismatch: 400, source removed, chunks kept, back to uploading', async () => {
    const { id } = await ctl.create(user, dto());
    await ctl.chunk(id, '0', req(Buffer.from('short')));
    await expect(ctl.complete(id)).rejects.toThrow(/size/);
    expect(model.rows[0].status).toBe('uploading');
    await expect(fs.stat(join(root, id, 'source.mp4'))).rejects.toThrow();
    expect(await new FootageStore().received(id)).toEqual([0]);
    await ctl.chunk(id, '0', req(Buffer.from('0123456789'))); // client re-sends
    expect((await ctl.complete(id)).status).toBe('processing');
  });
  it('a failing save returns the record to uploading with chunks intact', async () => {
    const { id } = await ctl.create(user, dto());
    await ctl.chunk(id, '0', req(Buffer.from('0123456789')));
    const orig = model.updateOne.bind(model); let first = true;
    model.updateOne = async (q: any, u: any) => { if (first && u.$set.status === 'processing') { first = false; throw new Error('db down'); } return orig(q, u); };
    await expect(ctl.complete(id)).rejects.toThrow(/db down/);
    expect(model.rows[0].status).toBe('uploading');
    expect(await new FootageStore().received(id)).toEqual([0]);
    expect((await ctl.complete(id)).status).toBe('processing');
  });
  it('two concurrent completes assemble once; the loser gets 409', async () => {
    const { id } = await ctl.create(user, dto());
    await ctl.chunk(id, '0', req(Buffer.from('0123456789')));
    const spy = vi.spyOn(FootageStore.prototype, 'assemble');
    const r = await Promise.allSettled([ctl.complete(id), ctl.complete(id)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost: any = r.find((x) => x.status === 'rejected');
    expect(lost.reason.status).toBe(409);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(join(root, id, 'source.mp4'), 'utf8')).toBe('0123456789');
    spy.mockRestore();
  });
});

describe('delete', () => {
  it('409 while referenced, removes record and folder otherwise', async () => {
    const { id } = await ctl.create(user, dto());
    await ctl.chunk(id, '0', req(Buffer.from('x')));
    refs.used = async () => new Set([id]);
    await expect(ctl.remove(id)).rejects.toMatchObject({ status: 409 });
    refs.used = async () => new Set();
    await ctl.remove(id);
    expect(model.rows).toHaveLength(0);
    await expect(fs.stat(join(root, id))).rejects.toThrow();
  });
});

describe('signed file serving', () => {
  const id = 'a'.repeat(24), data = Buffer.from('0123456789'.repeat(10)); // 100 bytes
  const tok = (file: string) => signFile(id, file).split('?t=')[1];
  beforeEach(async () => {
    await fs.mkdir(join(root, id, 'exports'), { recursive: true });
    await fs.writeFile(join(root, id, 'proxy.mp4'), data);
    await fs.writeFile(join(root, id, 'exports', 'j1.mp4'), data);
  });
  const get = async (call: (res: any) => Promise<any>, range?: string) => {
    const res = fakeRes(); await call(res); if (res.code !== 416 || res.writableLength) await Promise.race([res.done, new Promise((r) => setTimeout(r, 200))]); return res;
  };
  it('200 whole file, with Accept-Ranges and video/mp4', async () => {
    const res = await get((r) => ctl.proxy(id, tok('proxy.mp4'), { headers: {} }, r));
    expect(res.code).toBe(200); expect(res.headers['Content-Type']).toBe('video/mp4'); expect(res.headers['Accept-Ranges']).toBe('bytes');
    expect(res.body().equals(data)).toBe(true);
  });
  it('206 for start-end and start- ranges', async () => {
    let res = await get((r) => ctl.proxy(id, tok('proxy.mp4'), { headers: { range: 'bytes=10-19' } }, r));
    expect(res.code).toBe(206); expect(res.headers['Content-Range']).toBe('bytes 10-19/100'); expect(res.body().equals(data.subarray(10, 20))).toBe(true);
    res = await get((r) => ctl.proxy(id, tok('proxy.mp4'), { headers: { range: 'bytes=90-' } }, r));
    expect(res.code).toBe(206); expect(res.headers['Content-Range']).toBe('bytes 90-99/100'); expect(res.body().equals(data.subarray(90))).toBe(true);
  });
  it('416 for an unsatisfiable range', async () => {
    const res = await get((r) => ctl.proxy(id, tok('proxy.mp4'), { headers: { range: 'bytes=100-' } }, r));
    expect(res.code).toBe(416); expect(res.headers['Content-Range']).toBe('bytes */100');
  });
  it('serves exports with their own signature', async () => {
    const res = await get((r) => ctl.exported(id, 'j1', tok('exports/j1.mp4'), { headers: {} }, r));
    expect(res.code).toBe(200); expect(res.body().equals(data)).toBe(true);
  });
  it('403 for missing, bad, expired or other-file tokens', async () => {
    const r = fakeRes();
    await expect(ctl.proxy(id, undefined as any, { headers: {} }, r)).rejects.toMatchObject({ status: 403 });
    await expect(ctl.proxy(id, '1.' + 'a'.repeat(64), { headers: {} }, r)).rejects.toMatchObject({ status: 403 });
    const old = signFile(id, 'proxy.mp4', 1000).split('?t=')[1];
    await expect(ctl.proxy(id, old, { headers: {} }, r)).rejects.toMatchObject({ status: 403 });
    await expect(ctl.proxy(id, tok('exports/j1.mp4'), { headers: {} }, r)).rejects.toMatchObject({ status: 403 });
    await expect(ctl.exported(id, 'j1', tok('proxy.mp4'), { headers: {} }, r)).rejects.toMatchObject({ status: 403 });
  });
  it('404 for non-whitelisted names, bad ids and missing files', async () => {
    const r = fakeRes();
    await expect(ctl.send(id, 'source.mp4', tok('source.mp4'), { headers: {} }, r)).rejects.toMatchObject({ status: 404 });
    await expect(ctl.exported(id, '../proxy', tok('exports/../proxy.mp4'), { headers: {} }, r)).rejects.toMatchObject({ status: 404 });
    await expect(ctl.proxy('../etc', 'x', { headers: {} }, r)).rejects.toMatchObject({ status: 404 });
    await expect(ctl.exported(id, 'nope', tok('exports/nope.mp4'), { headers: {} }, r)).rejects.toMatchObject({ status: 404 });
  });
});
