import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runProcess } from '../../footage/jobs.service';
import { PostVideoStore } from './post-video.store';

/** The real ffmpeg: a browser-style WebM recording, uploaded in chunks, comes out as an H.264 + AAC MP4 with faststart */
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!hasFfmpeg)('PostVideoStore (ffmpeg)', () => {
  let store: PostVideoStore, webm = '';
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'pvs-'));
    process.env.SOCIAL_VIDEO_DIR = join(dir, 'store');
    const jobs: any = { runner: (c: string, a: string[], o: any) => runProcess(c, a, o), withFfmpeg: (fn: () => Promise<any>) => fn() };
    store = new PostVideoStore(jobs);
    webm = join(dir, 'rec.webm');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libvpx', '-b:v', '500k', '-c:a', 'libopus', '-shortest', webm]);
  }, 60_000); // ffmpeg under a busy test run

  it('joins the chunks and re-encodes to an MP4 every network takes', async () => {
    const bytes = readFileSync(webm), half = Math.ceil(bytes.length / 2);
    const { uploadId } = await store.begin('b', 'p1');
    await store.chunk('b', 'p1', uploadId, 1, bytes.subarray(half));
    await store.chunk('b', 'p1', uploadId, 0, bytes.subarray(0, half));
    const v = await store.complete('b', 'p1', uploadId, 2);
    expect(v).toMatchObject({ mime: 'video/mp4', width: 360, height: 640 });
    expect(v.durationMs).toBeGreaterThan(3500);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', store.path(v.id)]).toString());
    expect(probe.streams.map((s: any) => s.codec_name).sort()).toEqual(['aac', 'h264']);
    expect(probe.streams.find((s: any) => s.codec_type === 'video').pix_fmt).toBe('yuv420p');
    expect(await store.exists(v.id)).toBe(true);
    await store.remove(v.id);
    expect(await store.exists(v.id)).toBe(false);
  }, 60_000);

  it("another post can't use this upload, and missing parts are refused", async () => {
    const { uploadId } = await store.begin('b', 'p1');
    await expect(store.chunk('b', 'p2', uploadId, 0, Buffer.from('x'))).rejects.toThrow('Unknown upload');
    await store.chunk('b', 'p1', uploadId, 0, Buffer.from('x'));
    await expect(store.complete('b', 'p1', uploadId, 2)).rejects.toThrow(/missing/);
  });

  it('ids are checked: no path outside the folder', () => {
    expect(() => store.path('../../etc/passwd')).toThrow();
  });
});
