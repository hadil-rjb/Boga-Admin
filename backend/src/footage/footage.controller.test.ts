import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachment, CHUNK_SIZE, FootageController } from './footage.controller';
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
let root: string, model: ReturnType<typeof fakeModel>, ctl: FootageController, enqueue: any, wake: any, refs: any;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'footage-')); process.env.FOOTAGE_DIR = root; process.env.JWT_SECRET = 'test-secret-0123456789abcdef';
  model = fakeModel(); enqueue = vi.fn(); refs = { used: async () => new Set<string>() };
  wake = vi.fn(async () => undefined);
  ctl = new FootageController(model as any, new FootageStore(), refs, { enqueue, wake } as any, {} as any);
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
    expect(wake).toHaveBeenCalledWith(id); // waiting originals are told the reference is gone
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

describe('pair', () => {
  const mk = async (role: string, status = 'processing') => { const { id } = await ctl.create(user, dto({ role, name: role + '.mp4' })); model.rows.find((r: any) => r._id === id).status = status; return id; };
  it('stores the pair on the original and requests transcribe and grade', async () => {
    const o = await mk('original'), r = await mk('reference');
    const rec = await ctl.pair(o, { ref: r, lang: 'ar' });
    expect(model.rows.find((x: any) => x._id === o).pair).toEqual({ ref: r, lang: 'ar' });
    expect(enqueue.mock.calls).toEqual([[o, 'transcribe'], [o, 'grade']]);
    expect(rec.pair).toEqual({ ref: r, lang: 'ar' });
  });
  it('a brand look without a reference, language left to auto-detect; a ready original goes back to processing', async () => {
    const o = await mk('original', 'ready');
    await ctl.pair(o, { lookId: 'brand-1' });
    const row = model.rows.find((x: any) => x._id === o);
    expect(row.pair).toEqual({ lookId: 'brand-1' }); expect(row.status).toBe('processing');
  });
  it('rejects bad pairings', async () => {
    const o = await mk('original'), r = await mk('reference'), up = await mk('original', 'uploading');
    await expect(ctl.pair(o, {})).rejects.toMatchObject({ status: 400 });
    await expect(ctl.pair(r, { lookId: 'x' })).rejects.toMatchObject({ status: 400 }); // a reference cannot be paired
    await expect(ctl.pair(o, { ref: o })).rejects.toMatchObject({ status: 400 });
    await expect(ctl.pair(o, { ref: 'f'.repeat(24) })).rejects.toMatchObject({ status: 400 });
    await expect(ctl.pair(up, { ref: r })).rejects.toMatchObject({ status: 409 });
    await expect(ctl.pair('nope', { ref: r })).rejects.toMatchObject({ status: 404 });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('validates ids, look id and language in the DTO', async () => {
    const { validate } = await import('class-validator'); const { plainToInstance } = await import('class-transformer');
    const bad = async (o: any) => (await validate(plainToInstance((await import('./footage.controller')).PairFootageDto, o))).length;
    expect(await bad({ ref: 'a'.repeat(24), lookId: 'a-b_1', lang: 'ar' })).toBe(0);
    expect(await bad({ ref: '../x' })).toBe(1); expect(await bad({ lookId: '../x' })).toBe(1); expect(await bad({ lookId: 'x'.repeat(65) })).toBe(1);
    expect(await bad({ lang: 'ARA' })).toBe(1); expect(await bad({ lang: 'e' })).toBe(1);
  });
});

describe('editor data: words, look, retry', () => {
  const mk = async (role: string, extra: any = {}) => { const { id } = await ctl.create(user, dto({ role, name: role + Math.random() + '.mp4' })); Object.assign(model.rows.find((r: any) => r._id === id), { status: 'processing', ...extra }); return id; };
  it('words: [] when absent or unreadable, the array otherwise; 404 for an unknown id', async () => {
    const id = await mk('original');
    expect(await ctl.words(id)).toEqual([]);
    await fs.mkdir(join(root, id), { recursive: true });
    await fs.writeFile(join(root, id, 'words.json'), '{not json');
    expect(await ctl.words(id)).toEqual([]);
    await fs.writeFile(join(root, id, 'words.json'), JSON.stringify([{ t: 'مرحبا', s: 0, e: 400, p: 0.9 }]));
    expect(await ctl.words(id)).toEqual([{ t: 'مرحبا', s: 0, e: 400, p: 0.9 }]);
    await expect(ctl.words('f'.repeat(24))).rejects.toMatchObject({ status: 404 });
    await expect(ctl.words('../x')).rejects.toMatchObject({ status: 404 });
  });
  it('look: the cube text, 404 while absent', async () => {
    const id = await mk('original');
    await expect(ctl.look(id)).rejects.toMatchObject({ status: 404 });
    await fs.mkdir(join(root, id), { recursive: true });
    await fs.writeFile(join(root, id, 'look.cube'), 'LUT_3D_SIZE 2\n0 0 0\n');
    expect(await ctl.look(id)).toBe('LUT_3D_SIZE 2\n0 0 0\n');
  });
  it('retry re-requests a failed step and puts a finished record back to processing', async () => {
    const id = await mk('original', { status: 'ready', pair: { lookId: 'l1' }, jobs: { transcribe: { state: 'done' }, grade: { state: 'failed', error: 'x' } } });
    const rec = await ctl.retry(id, { step: 'grade' });
    expect(enqueue.mock.calls).toEqual([[id, 'grade']]);
    expect(rec.status).toBe('processing');
  });
  it('retrying a fatal step of a paired original also requests its unfinished transcribe and grade', async () => {
    // the transcribe the pair requested stays persisted queued after the fatal failure, but no runner holds it any more
    const id = await mk('original', { status: 'failed', error: 'boom', pair: { lookId: 'l1' }, jobs: { proxy: { state: 'failed' }, transcribe: { state: 'queued' }, grade: { state: 'done' } } });
    await ctl.retry(id, { step: 'proxy' });
    expect(enqueue.mock.calls).toEqual([[id, 'proxy'], [id, 'transcribe']]);
    expect(model.rows.find((r: any) => r._id === id)).toMatchObject({ status: 'processing', error: null });
  });
  it('a step already queued or running is left alone', async () => {
    const id = await mk('original', { pair: { lookId: 'l1' }, jobs: { grade: { state: 'running' } } });
    await ctl.retry(id, { step: 'grade' });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('rejects steps that do not apply', async () => {
    const o = await mk('original'), r = await mk('reference'), up = await mk('original', { status: 'uploading' });
    await expect(ctl.retry(o, { step: 'grade' })).rejects.toMatchObject({ status: 400 }); // not paired
    await expect(ctl.retry(r, { step: 'transcribe' })).rejects.toMatchObject({ status: 400 });
    await expect(ctl.retry(o, { step: 'caption-style' })).rejects.toMatchObject({ status: 400 });
    await expect(ctl.retry(up, { step: 'probe' })).rejects.toMatchObject({ status: 409 });
    await expect(ctl.retry(o, { step: 'nope' as any })).rejects.toMatchObject({ status: 400 });
    await expect(ctl.retry('f'.repeat(24), { step: 'probe' })).rejects.toMatchObject({ status: 404 });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('the DTO only accepts pipeline steps', async () => {
    const { validate } = await import('class-validator'); const { plainToInstance } = await import('class-transformer');
    const { RetryFootageDto } = await import('./footage.controller');
    expect((await validate(plainToInstance(RetryFootageDto, { step: 'caption-style' }))).length).toBe(0);
    expect((await validate(plainToInstance(RetryFootageDto, { step: 'rm -rf' }))).length).toBe(1);
  });
});

describe('brand looks', () => {
  const mk = async () => { const { id } = await ctl.create(user, dto({ name: 'o' + Math.random() + '.mp4' })); return id; };
  const cubeOf = async (id: string) => { await fs.mkdir(join(root, id), { recursive: true }); await fs.writeFile(join(root, id, 'look.cube'), 'LUT_3D_SIZE 2\n0 0 0\n'); };
  it('saves the matched grade under a fresh id, which can be read back and deleted', async () => {
    const f = await mk(); await cubeOf(f);
    const r = await ctl.saveLook({ footageId: f, name: 'Warm' });
    expect(r.id).toMatch(/^[0-9a-f]{16}$/); expect(r.lut).toBe(`looks/${r.id}.cube`);
    expect(await fs.readFile(join(root, 'looks', `${r.id}.cube`), 'utf8')).toBe('LUT_3D_SIZE 2\n0 0 0\n');
    expect(await ctl.getLook(r.id)).toBe('LUT_3D_SIZE 2\n0 0 0\n');
    expect((await ctl.saveLook({ footageId: f })).id).not.toBe(r.id);
    expect(await ctl.removeLook(r.id)).toEqual({ ok: true });
    await expect(fs.stat(join(root, 'looks', `${r.id}.cube`))).rejects.toThrow();
    await expect(ctl.getLook(r.id)).rejects.toMatchObject({ status: 404 });
    expect(await ctl.removeLook(r.id)).toEqual({ ok: true }); // already gone: nothing to do
  });
  it('404 when the footage is unknown or has no grade yet', async () => {
    const f = await mk();
    await expect(ctl.saveLook({ footageId: f })).rejects.toMatchObject({ status: 404 });
    await expect(ctl.saveLook({ footageId: 'f'.repeat(24) })).rejects.toMatchObject({ status: 404 });
    await expect(fs.stat(join(root, 'looks'))).rejects.toThrow(); // nothing was created
  });
  it('rejects ids that could leave the looks folder', async () => {
    for (const bad of ['../x', '..%2Fx', 'a/b', '', 'x'.repeat(65), '.hidden']) {
      await expect(ctl.getLook(bad)).rejects.toMatchObject({ status: 404 });
      await expect(ctl.removeLook(bad)).rejects.toMatchObject({ status: 404 });
    }
    await fs.writeFile(join(root, 'secret.cube'), 'x');
    await expect(ctl.getLook('../secret')).rejects.toMatchObject({ status: 404 });
    expect(await fs.readFile(join(root, 'secret.cube'), 'utf8')).toBe('x');
  });
  it('validates the DTO', async () => {
    const { validate } = await import('class-validator'); const { plainToInstance } = await import('class-transformer');
    const bad = async (o: any) => (await validate(plainToInstance((await import('./footage.controller')).SaveLookDto, o))).length;
    expect(await bad({ footageId: 'a'.repeat(24), name: 'Warm' })).toBe(0);
    expect(await bad({ footageId: '../x' })).toBe(1); expect(await bad({ footageId: 'a'.repeat(24), name: 'x'.repeat(81) })).toBe(1);
  });
});

describe('export endpoints', () => {
  it('a bad payload is a 400 with the reason, nothing starts', async () => {
    const start = vi.fn();
    const c = new FootageController(model as any, new FootageStore(), refs, { enqueue, wake } as any, { start } as any);
    await expect(c.exportStart({ designId: 'd', footage: { src: 'a'.repeat(24), look: { lut: '../../etc/passwd' } }, w: 1080, h: 1920, fps: 30 })).rejects.toMatchObject({ status: 400, message: 'Invalid colour grade' });
    await expect(c.exportStart({ designId: 'd', footage: { src: 'a'.repeat(24) }, w: 1080, h: 1920, fps: 29 })).rejects.toMatchObject({ status: 400 });
    expect(start).not.toHaveBeenCalled();
    start.mockResolvedValue({ jobId: 'c'.repeat(24), state: 'queued' });
    expect(await c.exportStart({ designId: 'd', footage: { src: 'a'.repeat(24) }, w: 1080, h: 1920, fps: 30 })).toEqual({ jobId: 'c'.repeat(24), state: 'queued' });
  });
  it('an unknown job is a 404', async () => {
    const c = new FootageController(model as any, new FootageStore(), refs, { enqueue, wake } as any, { status: async () => null } as any);
    await expect(c.exportStatus('c'.repeat(24))).rejects.toMatchObject({ status: 404 });
  });
  it('?dl= serves the export as a named attachment', async () => {
    const id = (await ctl.create(user, dto())).id;
    await fs.mkdir(join(root, id, 'exports'), { recursive: true }); await fs.writeFile(join(root, id, 'exports', 'j1.mp4'), 'mp4data');
    const res = fakeRes(); await ctl.exported(id, 'j1', signFile(id, 'exports/j1.mp4').split('t=')[1], { headers: {} }, res, 'مرحبا "x".mp4'); await res.done;
    expect(res.headers['Content-Disposition']).toBe(attachment('مرحبا "x".mp4'));
    expect(attachment('مرحبا "x".mp4')).toBe(`attachment; filename="- -x-.mp4"; filename*=UTF-8''${encodeURIComponent('مرحبا -x-.mp4')}`);
    expect(attachment("it's (1)")).toBe("attachment; filename=\"it's (1).mp4\"; filename*=UTF-8''it%27s%20%281%29.mp4");
  });
});
