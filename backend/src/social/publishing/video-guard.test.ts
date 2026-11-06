import { describe, expect, it, vi } from 'vitest';

// the schema classes need decorator metadata, which vitest does not emit: only their names are used here
vi.mock('../schemas/design.schema', () => ({ SocialDesign: { name: 'SocialDesign' } }));
vi.mock('../schemas/post.schema', () => ({ SocialPost: { name: 'SocialPost' } }));
vi.mock('../schemas/brand.schema', () => ({ SocialBrand: { name: 'SocialBrand' } }));
vi.mock('../schemas/workspace.schema', () => ({ SocialWorkspace: { name: 'SocialWorkspace' }, WORKSPACE_ID: 'ws' }));
vi.mock('./connection.schema', () => ({ SocialMedia: { name: 'SocialMedia' } }));
vi.mock('../calendar/calendar.service', () => ({ CalendarService: class {} }));
vi.mock('../markets/markets.service', () => ({ MarketsService: class {} }));
import { isVideoDesign, VIDEO_NOT_SCHEDULABLE } from './post-state';
import { PublisherService } from './publisher.service';
import { LiveRenderService } from './live-render.service';

const q = (v: any) => { const o: any = { select: () => o, sort: () => o, lean: async () => v }; return o; };

describe('footage designs are never published as images', () => {
  it('isVideoDesign and the message', () => {
    expect(isVideoDesign({ footage: { src: 'a' } })).toBe(true);
    expect(isVideoDesign({ pages: [] })).toBe(false);
    expect(isVideoDesign(null)).toBe(false);
    expect(VIDEO_NOT_SCHEDULABLE).toBe("Scheduling videos isn't available yet. Download the video and post it from your phone.");
  });

  it('the publisher fails the post with the message, posts nothing and does not retry', async () => {
    const post = { brandId: 'b', id: 'p1', d: 'd1', pf: ['ig'], status: 'Scheduled', publish: { state: 'pending', attempts: 0 } };
    const updates: any[] = [];
    const posts: any = {
      findOne: vi.fn((f: any) => q(f.id === 'p1' ? post : null)),
      findOneAndUpdate: vi.fn(() => q(post)),
      updateOne: vi.fn(async (_f: any, u: any) => { updates.push(u.$set); Object.assign(post, u.$set); }),
      exists: vi.fn(async () => true),
    };
    const designs: any = { findOne: vi.fn(() => q({ id: 'd1', name: 'Clip', footage: { src: 'a'.repeat(24) }, pages: [{}] })) };
    const media: any = { find: vi.fn(() => q([{ _id: 'm1', data: Buffer.from('x'), mime: 'image/jpeg' }])) };
    const publish = vi.fn();
    const conns: any = { linked: vi.fn(), provider: () => ({ publish }), markError: vi.fn(), apiUrl: 'http://x' };
    const svc = new PublisherService(posts, designs, media, {} as any, conns);
    await svc.publish('b', 'p1');
    expect(publish).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: 'Failed', publish: { state: 'failed', nextTry: null, lastError: VIDEO_NOT_SCHEDULABLE } });
  });

  it('the live render refuses a footage design instead of rendering it', async () => {
    const posts: any = { findOne: () => q({ id: 'p1', d: 'd1' }) };
    const designs: any = { findOne: () => q({ id: 'd1', footage: { src: 'a'.repeat(24) }, pages: [{}] }) };
    const cfg: any = { get: () => '' };
    const svc = new LiveRenderService(posts, designs, {} as any, {} as any, {} as any, {} as any, {} as any, cfg);
    await expect(svc.renderPost('b', 'p1')).rejects.toThrow(VIDEO_NOT_SCHEDULABLE);
  });
});
