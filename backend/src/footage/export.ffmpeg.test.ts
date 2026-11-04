import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concatText } from './export.service';
import { buildExportArgs } from './ffmpeg';
import { loadShared } from './shared';

/* Real ffmpeg: the overlay concat keeps exact ms, and a caption change lands on the frame the preview shows it. Skipped without ffmpeg. */
const has = (b: string) => spawnSync(b, ['-version'], { stdio: 'ignore' }).status === 0;
const real = has('ffmpeg') && has('ffprobe');
const ff = (...a: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });

describe.skipIf(!real)('export overlay timing (real ffmpeg)', () => {
  let dir: string;
  const png = (name: string, color: string) => { const p = join(dir, name); ff('-f', 'lavfi', '-i', `color=c=${color}:s=64x64,format=rgba`, '-frames:v', '1', p); return p; };
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'export-ff-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the concat keeps each change to the millisecond (1.033 / 0.017 / 0.050 / 1.0 s)', () => {
    const files = ['red', 'green', 'blue', 'white'].map((c) => png(`${c}.png`, c));
    const list = join(dir, 'c.txt');
    writeFileSync(list, concatText([1033, 17, 50, 1000].map((dur, k) => ({ file: files[k], dur }))));
    const out = execFileSync('ffprobe', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-show_entries', 'stream=time_base:frame=pts_time', '-of', 'csv=p=0'], { encoding: 'utf8' });
    const rows = out.trim().split('\n').map((s) => s.trim());
    const pts = rows.filter((r) => /^\d+\.\d+$/.test(r)).map(Number);
    expect(rows).toContain('1/1000');
    const want = [0, 1.033, 1.05, 1.1, 2.1];
    expect(pts).toHaveLength(want.length);
    pts.forEach((p, k) => expect(Math.abs(p - want[k])).toBeLessThanOrEqual(0.001));
  });

  it('at 30 fps a change at t first shows on frame ceil(t·fps): the first frame whose time is ≥ t, as in the preview', async () => {
    const { look } = await loadShared();
    const src = join(dir, 'src.mp4'), cube = join(dir, 'id.cube'), list = join(dir, 'o.txt'), out = join(dir, 'out.mp4');
    ff('-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', src);
    writeFileSync(cube, look.writeCube(look.identityCube(2)));
    const blank = png('blank.png', 'black@0.0'), red = png('red.png', 'red');
    // red from 1010 ms (between frames 30 and 31) to 1500 ms (frame 45 exactly), and from 2000 ms (frame 60 exactly)
    writeFileSync(list, concatText([{ file: blank, dur: 1010 }, { file: red, dur: 490 }, { file: blank, dur: 500 }, { file: red, dur: 1000 }]));
    const args = buildExportArgs({ src, probe: { dur: 3, w: 64, h: 64, rotation: 0, fps: 30, hdr: null, audio: false }, cube, concat: list, out, w: 64, h: 64, fps: 30 });
    execFileSync('ffmpeg', args, { stdio: 'ignore' });
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
    const n = raw.length / (64 * 64 * 3), isRed = (k: number) => raw[k * 64 * 64 * 3 + (32 * 64 + 32) * 3] > 128;
    expect(n).toBe(90); // 3 s at 30 fps: the overlay (which runs longer) does not lengthen the video
    const on = Array.from({ length: n }, (_, k) => isRed(k));
    const want = (k: number) => (k >= Math.ceil(1.010 * 30) && k < Math.ceil(1.5 * 30)) || k >= Math.ceil(2.0 * 30);
    expect(on.map((v, k) => (v === want(k) ? '' : k)).filter((x) => x !== '')).toEqual([]);
    expect([on[30], on[31], on[44], on[45], on[59], on[60]]).toEqual([false, true, true, false, false, true]);
  });

  it('a source that is not exactly 30 fps (30.004, like a phone) shows the change on its first frame at or after t', async () => {
    const { look } = await loadShared();
    const src = join(dir, 'src2.mp4'), cube = join(dir, 'id2.cube'), list = join(dir, 'o2.txt'), out = join(dir, 'out2.mp4');
    ff('-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30.004:d=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-video_track_timescale', '30004', src);
    writeFileSync(cube, look.writeCube(look.identityCube(2)));
    const blank = png('blank2.png', 'black@0.0'), red = png('red2.png', 'red');
    writeFileSync(list, concatText([{ file: blank, dur: 1420 }, { file: red, dur: 1580 }]));
    execFileSync('ffmpeg', buildExportArgs({ src, probe: { dur: 3, w: 64, h: 64, rotation: 0, fps: 30.004, hdr: null, audio: false }, cube, concat: list, out, w: 64, h: 64, fps: 30 }), { stdio: 'ignore' });
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
    const n = raw.length / (64 * 64 * 3), first = Array.from({ length: n }, (_, k) => raw[k * 64 * 64 * 3 + (32 * 64 + 32) * 3] > 128).indexOf(true);
    expect(first).toBe(Math.ceil(1.420 * 30.004)); // source frame 43 (pts 1.43314 ≥ 1.420); a 30 fps overlay grid would give 44
  });
});
