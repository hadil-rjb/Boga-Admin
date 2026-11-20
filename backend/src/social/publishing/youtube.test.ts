import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { youtube } from './providers/youtube';
import type { PublishInput } from './providers/types';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
const json = (o: any, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...h } });
function fake(route: (c: Call) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (u: any, init: any = {}) => {
    const b = init.body;
    const body = b instanceof URLSearchParams ? Object.fromEntries(b) : typeof b === 'string' ? JSON.parse(b) : b ? `<bytes ${b.byteLength}>` : undefined;
    const c = { url: String(u), method: init.method || 'GET', headers: init.headers || {}, body };
    calls.push(c);
    return route(c);
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls = []; });

const SIZE = 40 * 1024 * 1024; // two 32 MB chunks
let path = '';
beforeAll(() => { path = join(mkdtempSync(join(tmpdir(), 'yt-')), 'v.mp4'); writeFileSync(path, Buffer.alloc(SIZE, 1)); });
const env = (k: string) => ({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', YOUTUBE_RETRY_MS: '1' } as any)[k];
const link = { tokens: { accessToken: 'AT' }, account: {} as any, extra: { channelId: 'UC1' } };
const input = (o: Partial<PublishInput> = {}): PublishInput => ({
  text: 'My <launch> video\nMore details here', images: [], story: false,
  video: { url: 'https://api.example.com/v.mp4', path, mime: 'video/mp4', size: SIZE, width: 1920, height: 1080, durationMs: 60_000 }, ...o,
});

describe('YouTube', () => {
  it('sign-in URL: offline access, consent, upload scope, PKCE', () => {
    const u = new URL(youtube(env).authorizeUrl({ state: 'S', redirectUri: 'https://api/cb/yt', challenge: 'CH' }));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'cid', redirect_uri: 'https://api/cb/yt', state: 'S', access_type: 'offline', prompt: 'consent', code_challenge: 'CH', code_challenge_method: 'S256' });
    expect(u.searchParams.get('scope')).toContain('youtube.upload');
  });

  it('exchange: stores tokens and the channel', async () => {
    fake((c) => c.url.includes('/token') ? json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
      : json({ items: [{ id: 'UC1', snippet: { title: 'Boğa', customUrl: '@boga', thumbnails: { default: { url: 'https://img' } } } }] }));
    const l = await youtube(env).exchange({ code: 'C', redirectUri: 'https://api/cb/yt', verifier: 'V' });
    expect(calls[0].body).toMatchObject({ code: 'C', grant_type: 'authorization_code', code_verifier: 'V', client_id: 'cid', client_secret: 'sec' });
    expect(l.tokens).toMatchObject({ accessToken: 'AT', refreshToken: 'RT' });
    expect(l.account).toEqual({ id: 'UC1', name: 'Boğa', handle: '@boga', avatar: 'https://img', url: 'https://www.youtube.com/@boga' });
  });

  it('exchange: an account without a channel gets a clear message', async () => {
    fake((c) => c.url.includes('/token') ? json({ access_token: 'AT', expires_in: 3600 }) : json({ items: [] }));
    await expect(youtube(env).exchange({ code: 'C', redirectUri: 'r' })).rejects.toThrow(/no YouTube channel/);
  });

  it('refresh keeps the refresh token Google does not resend', async () => {
    fake(() => json({ access_token: 'AT2', expires_in: 3600 }));
    const t = await youtube(env).refresh!({ ...link, tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1000 } });
    expect(t).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT' });
    expect(await youtube(env).refresh!({ ...link, tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600_000 } })).toBeNull();
  });

  it('refuses image posts', async () => {
    fake(() => json({}));
    await expect(youtube(env).publish(link, input({ video: undefined, images: [{ buffer: Buffer.alloc(1), mime: 'image/jpeg', url: 'u' }] }))).rejects.toThrow(/only publishes videos/);
    expect(calls).toHaveLength(0);
  });

  it('resumable upload in chunks, title from the first line, retry on 5xx', async () => {
    let failed = false;
    fake((c) => {
      if (c.method === 'POST') return new Response(null, { status: 200, headers: { location: 'https://upload/session1' } });
      const range = c.headers['Content-Range'];
      if (range.startsWith('bytes 0-') && !failed) { failed = true; return new Response(null, { status: 503 }); }
      if (range.startsWith('bytes 0-')) return new Response(null, { status: 308, headers: { range: `bytes=0-${32 * 1024 * 1024 - 1}` } });
      return json({ id: 'VID', status: { privacyStatus: 'public' } });
    });
    const r = await youtube(env).publish(link, input());
    const start = calls[0];
    expect(start.url).toContain('uploadType=resumable');
    expect(start.headers['X-Upload-Content-Length']).toBe(String(SIZE));
    expect(start.body.snippet).toMatchObject({ title: 'My launch video', description: 'My launch video\nMore details here' });
    expect(start.body.status).toMatchObject({ privacyStatus: 'public', selfDeclaredMadeForKids: false });
    const puts = calls.filter((c) => c.method === 'PUT').map((c) => c.headers['Content-Range']);
    expect(puts).toEqual([`bytes 0-33554431/${SIZE}`, `bytes 0-33554431/${SIZE}`, `bytes 33554432-${SIZE - 1}/${SIZE}`]);
    expect(r).toEqual({ id: 'VID', url: 'https://www.youtube.com/watch?v=VID', warning: undefined });
  });

  it('a short vertical video links as a Short; a private upload warns', async () => {
    fake((c) => c.method === 'POST' ? new Response(null, { status: 200, headers: { location: 'https://upload/s' } })
      : c.headers['Content-Range'].startsWith('bytes 0-') ? new Response(null, { status: 308 }) : json({ id: 'S1', status: { privacyStatus: 'private' } }));
    const r = await youtube(env).publish(link, input({ video: { ...input().video!, width: 1080, height: 1920, durationMs: 30_000 } }));
    expect(r.url).toBe('https://www.youtube.com/shorts/S1');
    expect(r.warning).toMatch(/private/);
  });

  it('quota errors are readable', async () => {
    fake(() => json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403));
    await expect(youtube(env).publish(link, input())).rejects.toThrow(/quota/);
  });
});
