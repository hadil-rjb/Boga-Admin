import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { videoProblem, isVideoPost, videoBlocked, NO_CLIP, videoKey, overall, prepareVideo, VIDEO_LIMITS } from './post-video.js';

describe('per-network limits (same as the server)', () => {
  it('match backend/src/social/publishing/post-video.ts', () => {
    const be = readFileSync(new URL('../../backend/src/social/publishing/post-video.ts', import.meta.url), 'utf8');
    for (const [k, L] of Object.entries(VIDEO_LIMITS)) expect(be).toContain(`${k}: { minMs: `), expect(be).toContain(`name: "${L.name}"`);
    const v = { durationMs: 180_000, size: 0 };
    expect(videoProblem('x', v)).toBe('X takes videos up to 2 min: this one is 3 min.');
    expect(be).toContain('`${L.name} takes videos up to ${secs(L.maxMs)}: this one is ${secs(v.durationMs)}.`');
  });
  it('a 20 s reel fits everywhere; size is checked once known', () => {
    for (const n of Object.keys(VIDEO_LIMITS)) expect(videoProblem(n, { durationMs: 20_000 })).toBeNull();
    expect(videoProblem('tg', { durationMs: 20_000, size: 80 * 1024 ** 2 })).toBe('Telegram takes videos up to 50 MB: this one is 80 MB.');
  });
});

describe('video designs', () => {
  it('clips and animated designs are videos', () => {
    expect(isVideoPost({ footage: { src: 'a' } })).toBe(true);
    expect(isVideoPost({ motion: {} })).toBe(true);
    expect(isVideoPost({ pages: [] })).toBe(false);
  });
  it('a clip without a file is blocked with what to do', () => {
    expect(videoBlocked({ footage: { src: null } })).toBe(NO_CLIP);
    expect(videoBlocked({ footage: { src: 'a' } })).toBeNull();
    expect(videoBlocked({ motion: {} })).toBeNull();
  });
  it('the key changes with what the video shows, not with its name', () => {
    const d = { name: 'A', ratio: '9:16', motion: { fps: 30 }, pages: [{ bg: '#000', layers: [], scene: { dur: 5000 } }] };
    const k = videoKey(d);
    expect(videoKey({ ...d, name: 'B' })).toBe(k);
    expect(videoKey({ ...d, pages: [{ ...d.pages[0], scene: { dur: 6000 } }] })).not.toBe(k);
    const c = { footage: { src: 'a', look: { strength: 1 } }, captions: { on: true, lines: [] } };
    expect(videoKey({ ...c, captions: { on: false, lines: [] } })).not.toBe(videoKey(c));
  });
  it('overall progress walks through the steps', () => {
    expect(overall('footage', 'export', 0.5)).toBeCloseTo(0.45);
    expect(overall('footage', 'attach', 0)).toBeCloseTo(0.9);
    expect(overall('motion', 'record', 1)).toBeCloseTo(0.65);
    expect(overall('motion', 'process', 1)).toBeCloseTo(1);
  });
});

describe('prepareVideo', () => {
  it('a clip: exports on the server, waits, then attaches the export to the post', async () => {
    let polls = 0;
    const api = vi.fn(async (path) => {
      if (path === '/footage/export') return { jobId: 'J' };
      if (path === '/footage/export/J') return ++polls < 2 ? { state: 'running', progress: 0.5 } : { state: 'done' };
      return { id: 'p1', media: { video: { id: 'v' } } };
    });
    const steps = [];
    const st = await prepareVideo({ footage: { src: 'f', out: { w: 1080, h: 1920 } } }, {
      api, postPath: '/b/posts/p1', post: { id: 'p1' }, hash: 'H', pollMs: 1,
      exportSizes: () => [{ w: 1080, h: 1920 }], exportPayload: (d, s) => ({ w: s.w }), onProgress: (s, p) => steps.push(s),
    });
    expect(api.mock.calls[0]).toEqual(['/footage/export', { method: 'POST', body: { w: 1080 } }]);
    expect(api.mock.calls.at(-1)).toEqual(['/b/posts/p1/video/footage', { method: 'POST', body: { jobId: 'J', hash: 'H', post: { id: 'p1' } } }]);
    expect(steps).toContain('attach');
    expect(st.media.video.id).toBe('v');
  });
  it('a failed export says why', async () => {
    const api = async (path) => (path === '/footage/export' ? { jobId: 'J' } : { state: 'failed', error: 'No disk space' });
    await expect(prepareVideo({ footage: { src: 'f' } }, { api, postPath: '/p', exportSizes: () => [{}], exportPayload: () => ({}), pollMs: 1 })).rejects.toThrow('No disk space');
  });
  it('an animated design: records, uploads in chunks, then completes', async () => {
    const blob = new Blob([new Uint8Array(20)]);
    const api = vi.fn(async (path) => (path.endsWith('/video/upload') ? { uploadId: 'U', chunk: 8 } : { ok: true }));
    const record = vi.fn(async () => blob);
    await prepareVideo({ motion: {}, pages: [] }, { api, postPath: '/b/posts/p1', post: { id: 'p1' }, hash: 'H', record, mimes: () => [['video/mp4;codecs=avc1', 'mp4']], fps: 30 });
    expect(record.mock.calls[0][1]).toMatchObject({ s: 1, fps: 30, mime: 'video/mp4;codecs=avc1' });
    const puts = api.mock.calls.filter(([, o]) => o && o.method === 'PUT');
    expect(puts.map(([p]) => p)).toEqual(['/b/posts/p1/video/upload/U/0', '/b/posts/p1/video/upload/U/1', '/b/posts/p1/video/upload/U/2']);
    expect(puts.every(([, o]) => o.raw)).toBe(true);
    expect(api.mock.calls.at(-1)).toEqual(['/b/posts/p1/video/upload/U/complete', { method: 'POST', body: { parts: 3, hash: 'H' } }]);
  });
  it('a browser that can’t record says so', async () => {
    await expect(prepareVideo({ motion: {}, pages: [] }, { api: vi.fn(), mimes: () => [], record: vi.fn() })).rejects.toThrow(/can’t record video/);
  });
  it('a clip without a file is refused before any call', async () => {
    const api = vi.fn();
    await expect(prepareVideo({ footage: { src: null } }, { api })).rejects.toThrow(NO_CLIP);
    expect(api).not.toHaveBeenCalled();
  });
});
