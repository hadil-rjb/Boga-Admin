import { describe, expect, it, vi } from 'vitest';

// the schema classes need decorator metadata, which vitest does not emit: only their names are used here
vi.mock('../schemas/design.schema', () => ({ SocialDesign: { name: 'SocialDesign' } }));
vi.mock('../schemas/post.schema', () => ({ SocialPost: { name: 'SocialPost' } }));
vi.mock('../schemas/brand.schema', () => ({ SocialBrand: { name: 'SocialBrand' } }));
vi.mock('../schemas/workspace.schema', () => ({ SocialWorkspace: { name: 'SocialWorkspace' }, WORKSPACE_ID: 'ws' }));
vi.mock('./connection.schema', () => ({ SocialMedia: { name: 'SocialMedia' } }));
vi.mock('../calendar/calendar.service', () => ({ CalendarService: class {} }));
vi.mock('../markets/markets.service', () => ({ MarketsService: class {} }));
vi.mock('./post-video.store', () => ({ PostVideoStore: class {} }));
vi.mock('../../footage/footage.store', () => ({ FootageStore: class {} }));
import { isVideoDesign, mediaReady, mergePost, VIDEO_NOT_READY } from './post-state';
import { PublisherService } from './publisher.service';
import { LiveRenderService } from './live-render.service';

const q = (v: any) => { const o: any = { select: () => o, sort: () => o, lean: async () => v }; return o; };
const VID = 'b'.repeat(24);

function setup(design: any, postExtra: any = {}, nets = ['ig']) {
  const post: any = { brandId: 'b', id: 'p1', d: 'd1', pf: nets, status: 'Scheduled', publish: { state: 'pending', attempts: 0 }, cap: 'Hello', ...postExtra };
  const updates: any[] = [];
  const posts: any = {
    findOne: vi.fn((f: any) => q(f.id === 'p1' ? post : null)),
    findOneAndUpdate: vi.fn(() => q(post)),
    updateOne: vi.fn(async (_f: any, u: any) => { updates.push(u.$set); Object.assign(post, u.$set); }),
    exists: vi.fn(async () => true),
  };
  const designs: any = { findOne: vi.fn(() => q(design)) };
  const media: any = { find: vi.fn(() => q([])) };
  const publish = vi.fn(async () => ({ id: 'r1', url: 'https://x/r1' }));
  const conns: any = { linked: vi.fn(), provider: () => ({ publish }), markError: vi.fn(), apiUrl: 'https://api.example.com/api' };
  const videos: any = { exists: vi.fn(async () => true), path: (id: string) => `/videos/${id}.mp4`, remove: vi.fn() };
  const svc = new PublisherService(posts, designs, media, {} as any, conns, videos, {} as any);
  return { svc, post, updates, publish, videos };
}
const clip = { id: 'd1', name: 'Clip', ratio: '9:16', footage: { src: 'a'.repeat(24) }, pages: [{}] };
const ready = { media: { ids: [], video: { id: VID, mime: 'video/mp4', size: 5e6, durationMs: 20_000, width: 1080, height: 1920 } } };

describe('video posts', () => {
  it('clips and animated designs are videos; a post is ready with its slides or its video', () => {
    expect(isVideoDesign({ footage: { src: 'a' } })).toBe(true);
    expect(isVideoDesign({ motion: { fmt: 'reel' } })).toBe(true);
    expect(isVideoDesign({ pages: [] })).toBe(false);
    expect(mediaReady({ ids: ['1'] })).toBe(true);
    expect(mediaReady({ ids: [], video: { id: VID } })).toBe(true);
    expect(mediaReady({ ids: [] })).toBe(false);
  });

  it('rescheduling a video post arms it again, like an image post', () => {
    const out = mergePost({ status: 'Draft', date: '2026-11-10', time: '09:00', media: ready.media, publish: { state: 'idle' } }, { id: 'p1', status: 'Scheduled', date: '2026-11-10', time: '09:00' });
    expect(out.publish.state).toBe('pending');
    expect(out.media.video.id).toBe(VID);
  });

  it('publishes the MP4 (public URL and local file) instead of the pages, as a Reel on Instagram', async () => {
    const { svc, publish, updates } = setup(clip, ready);
    await svc.publish('b', 'p1');
    expect(publish).toHaveBeenCalledTimes(1);
    const input: any = (publish.mock.calls[0] as any[])[1];
    expect(input.images).toEqual([]);
    expect(input.video).toMatchObject({ url: `https://api.example.com/api/social/video/${VID}.mp4`, path: `/videos/${VID}.mp4`, durationMs: 20_000, width: 1080 });
    expect(input.story).toBe(false);
    expect(updates.at(-1)).toMatchObject({ status: 'Published', publish: { state: 'published' } });
  });

  it('a 9:16 video marked as a Story goes to Instagram as a Story', async () => {
    const { svc, publish } = setup(clip, { ...ready, igStory: true });
    await svc.publish('b', 'p1');
    expect(((publish.mock.calls[0] as any[])[1] as any).story).toBe(true);
  });

  it('an animated design publishes its video too', async () => {
    const { svc, publish } = setup({ id: 'd1', name: 'Reel', ratio: '9:16', motion: { fmt: 'reel' }, pages: [{}] }, ready);
    await svc.publish('b', 'p1');
    expect(((publish.mock.calls[0] as any[])[1] as any).video.url).toContain(VID);
  });

  it('no prepared video: the post fails with what to do, posts nothing and does not retry', async () => {
    const { svc, publish, updates } = setup(clip);
    await svc.publish('b', 'p1');
    expect(publish).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: 'Failed', publish: { state: 'failed', nextTry: null, lastError: VIDEO_NOT_READY } });
  });

  it("a network that can't take the video is skipped with the reason, the others still get it", async () => {
    const long = { media: { ids: [], video: { ...ready.media.video, durationMs: 180_000 } } };
    const { svc, publish, updates } = setup(clip, long, ['x', 'ig']);
    await svc.publish('b', 'p1');
    expect(publish).toHaveBeenCalledTimes(1); // Instagram only
    const last = updates.at(-1);
    expect(last.publish.state).toBe('partial');
    expect(last.publish.results.x).toMatchObject({ ok: false, error: 'X takes videos up to 2 min: this one is 3 min.' });
  });

  it('only limits failed: no retry', async () => {
    const long = { media: { ids: [], video: { ...ready.media.video, durationMs: 180_000 } } };
    const { svc, updates } = setup(clip, long, ['x']);
    await svc.publish('b', 'p1');
    expect(updates.at(-1)).toMatchObject({ status: 'Failed', publish: { state: 'failed', nextTry: null } });
  });

  it('the live render leaves a video post alone', async () => {
    const posts: any = { findOne: () => q({ id: 'p1', d: 'd1' }) };
    const designs: any = { findOne: () => q(clip) };
    const cfg: any = { get: () => '' };
    const svc = new LiveRenderService(posts, designs, {} as any, {} as any, {} as any, {} as any, {} as any, cfg);
    await expect(svc.renderPost('b', 'p1')).resolves.toBeNull();
  });
});

describe('video sweep', () => {
  it('removes old unused videos and day-old uploads, keeps what posts use and fresh files', async () => {
    const now = 10 * 24 * 3600_000, old = now - 2 * 3600_000, fresh = now - 60_000;
    const removed: string[] = [], dropped: string[] = [];
    const videos: any = {
      inventory: async () => ({ videos: [{ id: 'a'.repeat(24), at: old }, { id: 'b'.repeat(24), at: old }, { id: 'c'.repeat(24), at: fresh }], uploads: [{ uploadId: 'd'.repeat(24), at: now - 25 * 3600_000 }, { uploadId: 'e'.repeat(24), at: fresh }] }),
      remove: async (id: string) => { removed.push(id); }, dropUpload: async (u: string) => { dropped.push(u); },
    };
    const posts: any = { distinct: async () => ['b'.repeat(24)] };
    const svc = new PublisherService(posts, {} as any, {} as any, {} as any, {} as any, videos, {} as any);
    expect(await svc.sweepVideos(now)).toBe(2);
    expect(removed).toEqual(['a'.repeat(24)]);
    expect(dropped).toEqual(['d'.repeat(24)]);
  });
});
