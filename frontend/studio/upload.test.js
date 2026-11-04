import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadFootage } from './upload.js';
import { readProbe } from './footage.js';

const fileOf = (n, name = 'a.mp4', type = 'video/mp4') => new File([new Uint8Array(n)], name, { type });
let api;
const putIndexes = () => api.mock.calls.filter(([p, o]) => o && o.method === 'PUT').map(([p]) => +/i=(\d+)/.exec(p)[1]).sort((a, b) => a - b);

beforeEach(() => {
  api = vi.fn(async (path, o = {}) => {
    if (path === '/footage' && o.method === 'POST') return { id: 'x', chunkSize: 4, received: [] };
    if (path.endsWith('/complete')) return { id: 'x', status: 'ready' };
    return {};
  });
});

describe('uploadFootage', () => {
  it('uploads only missing chunks on resume', async () => {
    api.mockResolvedValueOnce({ id: 'x', chunkSize: 4, received: [0, 2] });
    await uploadFootage(fileOf(16), { role: 'original', brand: 'b', api });
    expect(putIndexes()).toEqual([1, 3]);
  });
  it('reports progress up to 1', async () => {
    const p = [];
    await uploadFootage(fileOf(8), { role: 'original', brand: 'b', api, onProgress: (v) => p.push(v) });
    expect(p.at(-1)).toBe(1);
  });
  it('refuses non-video files before uploading', async () => {
    await expect(uploadFootage(new File(['x'], 'a.txt', { type: 'text/plain' }), { role: 'original', brand: 'b', api })).rejects.toThrow('Choose a video file');
    expect(api).not.toHaveBeenCalled();
  });
  it('sends raw chunks, then completes and resolves the id', async () => {
    const r = await uploadFootage(fileOf(5), { role: 'reference', brand: 'b', api });
    expect(r.id).toBe('x');
    const put = api.mock.calls.find(([, o]) => o && o.method === 'PUT');
    expect(put[1].raw).toBe(true); expect(put[1].body.size).toBe(4);
    expect(api.mock.calls.at(-1)[0]).toBe('/footage/x/complete');
  });
  it('counts already received bytes in the first progress', async () => {
    api.mockResolvedValueOnce({ id: 'x', chunkSize: 4, received: [0, 1] });
    const p = []; await uploadFootage(fileOf(16), { role: 'original', brand: 'b', api, onProgress: (v) => p.push(v) });
    expect(p[0]).toBe(0.5);
  });
});

describe('uploadFootage failures', () => {
  const err = (status, message = 'x') => Object.assign(new Error(message), { status });
  const puts = () => api.mock.calls.filter(([, o]) => o && o.method === 'PUT').length;
  const noWait = () => Promise.resolve();

  it('does not retry a 409; goes to complete when the record is past uploading', async () => {
    api.mockImplementation(async (path, o = {}) => {
      if (path === '/footage') return { id: 'x', chunkSize: 4, received: [] };
      if (o.method === 'PUT') throw err(409, 'This upload is already complete');
      if (path === '/footage/x') return { id: 'x', status: 'processing' };
      if (path.endsWith('/complete')) return { id: 'x', status: 'processing' };
    });
    const r = await uploadFootage(fileOf(4), { role: 'original', brand: 'b', api, sleep: noWait });
    expect(r.id).toBe('x'); expect(puts()).toBe(1);
    expect(api.mock.calls.at(-1)[0]).toBe('/footage/x/complete');
  });
  it('fails a 409 while the record is still uploading, without retrying', async () => {
    api.mockImplementation(async (path, o = {}) => {
      if (path === '/footage') return { id: 'x', chunkSize: 4, received: [] };
      if (o.method === 'PUT') throw err(409, 'conflict');
      if (path === '/footage/x') return { id: 'x', status: 'uploading' };
    });
    await expect(uploadFootage(fileOf(4), { role: 'original', brand: 'b', api, sleep: noWait })).rejects.toThrow('conflict');
    expect(puts()).toBe(1);
  });
  it('does not retry other 4xx', async () => {
    api.mockImplementation(async (path, o = {}) => { if (path === '/footage') return { id: 'x', chunkSize: 4, received: [] }; if (o.method === 'PUT') throw err(413, 'too big'); });
    await expect(uploadFootage(fileOf(4), { role: 'original', brand: 'b', api, sleep: noWait })).rejects.toThrow('too big');
    expect(puts()).toBe(1);
  });
  it('retries a 5xx and then succeeds', async () => {
    let n = 0;
    api.mockImplementation(async (path, o = {}) => {
      if (path === '/footage') return { id: 'x', chunkSize: 4, received: [] };
      if (o.method === 'PUT' && n++ < 2) throw err(503, 'busy');
      return { id: 'x' };
    });
    await uploadFootage(fileOf(4), { role: 'original', brand: 'b', api, sleep: noWait });
    expect(puts()).toBe(3);
  });
  it('abort stops the PUTs', async () => {
    const ac = new AbortController();
    api.mockImplementation(async (path, o = {}) => {
      if (path === '/footage') return { id: 'x', chunkSize: 1, received: [] };
      if (o.method === 'PUT') ac.abort();
      return { id: 'x' };
    });
    await expect(uploadFootage(fileOf(20), { role: 'original', brand: 'b', api, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(puts()).toBeLessThanOrEqual(3);
    expect(api.mock.calls.some(([p]) => p.endsWith('/complete'))).toBe(false);
  });
});

describe('readProbe', () => {
  it('polls until the probe appears and returns it', async () => {
    let n = 0; const a = vi.fn(async () => (++n < 3 ? { status: 'processing' } : { status: 'processing', probe: { w: 720, h: 1280 } }));
    const sleep = vi.fn(async () => {});
    expect(await readProbe(a, 'r', { sleep })).toEqual({ w: 720, h: 1280 });
    expect(a).toHaveBeenCalledTimes(3); expect(sleep).toHaveBeenCalledWith(1000);
  });
  it('gives up on timeout and on a failed record', async () => {
    const a = vi.fn(async () => ({ status: 'processing' }));
    expect(await readProbe(a, 'r', { sleep: async () => {}, tries: 4 })).toBeNull(); expect(a).toHaveBeenCalledTimes(4);
    expect(await readProbe(async () => ({ status: 'failed' }), 'r', { sleep: async () => {} })).toBeNull();
  });
});
