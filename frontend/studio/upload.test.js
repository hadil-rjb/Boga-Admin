import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadFootage } from './upload.js';

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
