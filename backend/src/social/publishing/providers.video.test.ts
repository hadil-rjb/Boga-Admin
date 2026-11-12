import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { facebook, instagram } from './providers/meta';
import { tiktok } from './providers/tiktok';
import { linkedin } from './providers/linkedin';
import { x } from './providers/x';
import { telegram } from './providers/telegram';
import type { PublishInput } from './providers/types';

/** Every network's video path against a fake API: which calls, in which order, with which fields */
type Call = { url: string; method: string; body: any; headers: any };
let calls: Call[] = [];
const json = (o: any, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', ...h } });
function fake(route: (c: Call) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (u: any, init: any = {}) => {
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<blob ${(v as Blob).size}>`]))
      : init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : typeof init.body === 'string' ? JSON.parse(init.body) : init.body ? `<bytes ${init.body.byteLength}>` : undefined;
    const c = { url: String(u), method: init.method || 'GET', body, headers: init.headers || {} };
    calls.push(c);
    return route(c);
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls = []; });

let path = '';
const SIZE = 5 * 1024 * 1024 + 10; // two X segments (4 MB each)
beforeAll(() => { path = join(mkdtempSync(join(tmpdir(), 'pv-')), 'v.mp4'); writeFileSync(path, Buffer.alloc(SIZE, 1)); });
const input = (o: Partial<PublishInput> = {}): PublishInput => ({
  text: 'New reel\nWith a second line', images: [], story: false,
  video: { url: 'https://api.example.com/api/social/video/abc.mp4', path, mime: 'video/mp4', size: SIZE, width: 1080, height: 1920, durationMs: 20_000 }, ...o,
});
const env = (o: Record<string, string> = {}) => (k: string) => ({ META_POLL_MS: '1', TIKTOK_POLL_MS: '1', ...o } as any)[k];

describe('video publishing per network', () => {
  it('Instagram: checks the URL, creates a Reel from video_url, waits, publishes', async () => {
    let polls = 0;
    fake((c) => {
      if (c.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'video/mp4' } });
      if (c.url.includes('/media_publish')) return json({ id: 'M1' });
      if (c.url.includes('/media') && c.method === 'POST') return json({ id: 'C1' });
      if (c.url.includes('/C1?')) return json({ status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' });
      return json({ permalink: 'https://instagram.com/reel/1' });
    });
    const r = await instagram(env()).publish({ tokens: { accessToken: 't' }, account: {} as any, extra: { igUserId: 'IG' } }, input());
    const create = calls.find((c) => c.url.endsWith('/IG/media'))!;
    expect(create.body).toMatchObject({ media_type: 'REELS', video_url: 'https://api.example.com/api/social/video/abc.mp4', caption: 'New reel\nWith a second line', share_to_feed: 'true' });
    expect(polls).toBe(3);
    expect(r).toMatchObject({ id: 'M1', url: 'https://instagram.com/reel/1' });
  });

  it('Instagram: a 9:16 video Story uses media_type STORIES', async () => {
    fake((c) => (c.method === 'HEAD' ? new Response(null, { status: 200, headers: { 'content-type': 'video/mp4' } }) : c.url.includes('/media_publish') ? json({ id: 'M2' }) : json({ id: 'C2' })));
    await instagram(env()).publish({ tokens: { accessToken: 't' }, account: {} as any, extra: { igUserId: 'IG' } }, input({ story: true }));
    expect(calls.find((c) => c.url.endsWith('/IG/media'))!.body).toMatchObject({ media_type: 'STORIES', video_url: expect.any(String) });
  });

  it('Instagram refuses a localhost video URL with a clear message', async () => {
    fake(() => json({}));
    await expect(instagram(env()).publish({ tokens: { accessToken: 't' }, account: {} as any, extra: { igUserId: 'IG' } }, input({ video: { ...input().video!, url: 'http://localhost:4000/api/social/video/a.mp4' } })))
      .rejects.toThrow(/PUBLIC_API_URL/);
  });

  it('Facebook: one /videos call on graph-video with file_url and the caption', async () => {
    fake(() => json({ id: 'V1' }));
    const r = await facebook(env()).publish({ tokens: { accessToken: 't' }, account: {} as any, extra: { pageId: 'P' } }, input());
    expect(calls[0].url).toMatch(/^https:\/\/graph-video\.facebook\.com\/v[\d.]+\/P\/videos$/);
    expect(calls[0].body).toMatchObject({ file_url: 'https://api.example.com/api/social/video/abc.mp4', description: 'New reel\nWith a second line' });
    expect(r.url).toBe('https://www.facebook.com/P/videos/V1');
  });

  it('TikTok: video init with PULL_FROM_URL, then the status until published', async () => {
    let n = 0;
    fake((c) => {
      if (c.url.includes('creator_info')) return json({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'], creator_username: 'me' }, error: { code: 'ok' } });
      if (c.url.includes('/video/init/')) return json({ data: { publish_id: 'PB' }, error: { code: 'ok' } });
      return json({ data: ++n < 2 ? { status: 'PROCESSING_DOWNLOAD' } : { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [77] }, error: { code: 'ok' } });
    });
    const r = await tiktok(env()).publish({ tokens: { accessToken: 't' }, account: {} as any, extra: {} }, input());
    const init = calls.find((c) => c.url.includes('/video/init/'))!;
    expect(init.body.source_info).toEqual({ source: 'PULL_FROM_URL', video_url: 'https://api.example.com/api/social/video/abc.mp4' });
    expect(init.body.post_info).toMatchObject({ title: 'New reel\nWith a second line', privacy_level: 'PUBLIC_TO_EVERYONE' });
    expect(r).toMatchObject({ id: '77', url: 'https://www.tiktok.com/@me/video/77' });
  });

  it('LinkedIn: initialize with the size, PUT each part, finalize with the ETags, wait, post with the video', async () => {
    let st = 0;
    fake((c) => {
      if (c.url.includes('action=initializeUpload')) return json({ value: { video: 'urn:li:video:V', uploadToken: 'TK', uploadInstructions: [{ uploadUrl: 'https://up/1', firstByte: 0, lastByte: 4194303 }, { uploadUrl: 'https://up/2', firstByte: 4194304, lastByte: SIZE - 1 }] } });
      if (c.url.startsWith('https://up/')) return new Response(null, { status: 200, headers: { etag: `"e${c.url.slice(-1)}"` } });
      if (c.url.includes('action=finalizeUpload')) return json({});
      if (c.url.includes('/rest/videos/')) return json({ status: ++st < 2 ? 'PROCESSING' : 'AVAILABLE' });
      return json({}, { 'x-restli-id': 'urn:li:share:S' });
    });
    process.env.LINKEDIN_POLL_MS = '1';
    const r = await linkedin(env()).publish({ tokens: { accessToken: 't' }, account: {} as any, extra: { author: 'urn:li:person:A' } }, input());
    expect(calls.find((c) => c.url.includes('initializeUpload'))!.body.initializeUploadRequest).toMatchObject({ owner: 'urn:li:person:A', fileSizeBytes: SIZE });
    expect(calls.filter((c) => c.url.startsWith('https://up/')).map((c) => c.body)).toEqual(['<bytes 4194304>', `<bytes ${SIZE - 4194304}>`]);
    expect(calls.find((c) => c.url.includes('finalizeUpload'))!.body.finalizeUploadRequest).toEqual({ video: 'urn:li:video:V', uploadToken: 'TK', uploadedPartIds: ['e1', 'e2'] });
    expect(calls.find((c) => c.url.endsWith('/rest/posts'))!.body.content).toEqual({ media: { id: 'urn:li:video:V' } });
    expect(r.id).toBe('urn:li:share:S');
  });

  it('X: initialize, append 4 MB segments, finalize, wait for processing, then the post', async () => {
    let st = 0;
    fake((c) => {
      if (c.url.endsWith('/initialize')) return json({ data: { id: 'MID' } });
      if (c.url.endsWith('/append')) return json({});
      if (c.url.endsWith('/finalize')) return json({ data: { id: 'MID', processing_info: { state: 'pending', check_after_secs: 0 } } });
      if (c.url.includes('command=STATUS')) return json({ data: { processing_info: { state: ++st < 2 ? 'in_progress' : 'succeeded' } } });
      return json({ data: { id: 'T1' } });
    });
    process.env.X_POLL_MS = '1';
    const r = await x(env()).publish({ tokens: { accessToken: 't' }, account: { handle: '@me' } as any, extra: {} }, input());
    expect(calls.find((c) => c.url.endsWith('/initialize'))!.body).toEqual({ media_type: 'video/mp4', total_bytes: SIZE, media_category: 'tweet_video' });
    expect(calls.filter((c) => c.url.endsWith('/append')).map((c) => c.body.segment_index)).toEqual(['0', '1']);
    expect(calls.find((c) => c.url.endsWith('/2/tweets'))!.body).toEqual({ text: 'New reel\nWith a second line', media: { media_ids: ['MID'] } });
    expect(r.url).toBe('https://x.com/me/status/T1');
  });

  it('Telegram: sendVideo with the file, streaming on, size and caption', async () => {
    fake(() => json({ ok: true, result: { message_id: 9 } }));
    const r = await telegram(env()).publish({ tokens: { accessToken: 'BOT' }, account: {} as any, extra: { chatId: '-100', username: 'chan' } }, input());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/botBOT\/sendVideo$/);
    expect(calls[0].body).toMatchObject({ chat_id: '-100', video: `<blob ${SIZE}>`, supports_streaming: 'true', width: '1080', height: '1920', duration: '20', caption: 'New reel\nWith a second line' });
    expect(r.url).toBe('https://t.me/chan/9');
  });
});
