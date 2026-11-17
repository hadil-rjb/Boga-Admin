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

// real encodes: several seconds each when the whole suite runs at once (the default 5 s limit cut them off)
describe.skipIf(!real)('export overlay timing (real ffmpeg)', { timeout: 60_000 }, () => {
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

  it('a music bed loops under the original, ducked, and the MP4 keeps the video length; music alone is trimmed to it', async () => {
    const { look } = await loadShared();
    const cube = join(dir, 'id3.cube'), list = join(dir, 'o3.txt'), blank = png('blank3.png', 'black@0.0');
    writeFileSync(cube, look.writeCube(look.identityCube(2)));
    writeFileSync(list, concatText([{ file: blank, dur: 3000 }]));
    const src = join(dir, 'src3.mp4'), mute = join(dir, 'src4.mp4'), music = join(dir, 'music.mp3');
    // 3 s of video with a 440 Hz tone (48 kHz), 1 s of 880 Hz music (44.1 kHz, so the graph has to resample)
    ff('-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', src);
    ff('-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', mute);
    ff('-f', 'lavfi', '-i', 'sine=f=880:r=44100:d=1', '-c:a', 'libmp3lame', music);
    const probe = (audio: boolean) => ({ dur: 3, w: 64, h: 64, rotation: 0 as const, fps: 30, hdr: null, audio });
    const len = (f: string, sel: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
    for (const [i, input, audio, duck] of [[0, src, true, true], [1, src, true, false], [2, mute, false, true]] as const) {
      const out = join(dir, `mix${i}.mp4`);
      execFileSync('ffmpeg', buildExportArgs({ src: input, probe: probe(audio), cube, concat: list, out, w: 64, h: 64, fps: 30, vol: 0.8, music: { path: music, vol: 0.6, duck } }), { stdio: 'ignore' });
      expect(Math.abs(len(out, 'a:0') - 3), `audio ${i}`).toBeLessThan(0.1);
      expect(Math.abs(len(out, 'v:0') - 3), `video ${i}`).toBeLessThan(0.05);
      // the music keeps playing in the last second (it looped): not silent there
      const err = spawnSync('ffmpeg', ['-hide_banner', '-ss', '2.2', '-i', out, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      expect(Number(/max_volume: (-?[\d.]+) dB/.exec(err)![1]), `level ${i}`).toBeGreaterThan(-30);
    }
  });

  it('Remove pauses drops the same frames from the picture and the sound; Reduce noise keeps the voice', async () => {
    const { look, pauses } = await loadShared();
    const cube = join(dir, 'id5.cube'), list = join(dir, 'o5.txt'), blank = png('blank5.png', 'black@0.0');
    writeFileSync(cube, look.writeCube(look.identityCube(2)));
    writeFileSync(list, concatText([{ file: blank, dur: 3000 }]));
    // red + tone, green + silence, blue + tone: one second each
    const src = join(dir, 'src5.mp4');
    ff('-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=lime:s=64x64:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=1',
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1',
      '-filter_complex', '[0:v][3:a][1:v][4:a][2:v][5:a]concat=n=3:v=1:a=1[v][a]', '-map', '[v]', '-map', '[a]', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', src);
    const keep = pauses.keepFrames([[1000, 2000]], 3000, 30);
    expect(keep).toEqual([[0, 29], [60, 89]]);
    const len = (f: string, sel: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
    const probe = { dur: 3, w: 64, h: 64, rotation: 0 as const, fps: 30, hdr: null, audio: true };
    for (const [i, music] of [[0, null], [1, { path: join(dir, 'music5.mp3'), vol: 0.3, duck: true }]] as const) {
      if (music) ff('-f', 'lavfi', '-i', 'sine=f=880:r=44100:d=1', '-c:a', 'libmp3lame', music.path);
      const out = join(dir, `cut${i}.mp4`);
      // with music, the isolated voice (a WAV like DeepFilterNet's) stands in for the original sound
      const voice = music ? join(dir, 'voice5.wav') : null;
      if (voice) ff('-i', src, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', voice);
      execFileSync('ffmpeg', buildExportArgs({ src, probe, cube, concat: list, out, w: 64, h: 64, fps: 30, keep, denoise: true, voice, music }), { stdio: 'ignore' });
      expect(Math.abs(len(out, 'v:0') - 2), `video ${i}`).toBeLessThan(0.05);
      expect(Math.abs(len(out, 'a:0') - 2), `audio ${i}`).toBeLessThan(0.05);
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
      const px = (k: number) => Array.from(raw.subarray(k * 64 * 64 * 3 + (32 * 64 + 32) * 3, k * 64 * 64 * 3 + (32 * 64 + 32) * 3 + 3));
      expect(raw.length / (64 * 64 * 3)).toBe(60);
      expect(px(29)[0]).toBeGreaterThan(128); // still red
      expect(px(30)[2]).toBeGreaterThan(128); // straight to blue: the green second is gone
      expect(px(30)[1]).toBeLessThan(128);
      // the tone carries on across the cut (the silent second went with the green frames), denoised but not removed
      const err = spawnSync('ffmpeg', ['-hide_banner', '-ss', '0.9', '-t', '0.2', '-i', out, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      expect(Number(/mean_volume: (-?[\d.]+) dB/.exec(err)![1]), `level ${i}`).toBeGreaterThan(-30);
    }
  });

  it('look filters: the vignette darkens the corners like the preview, grain moves from frame to frame', async () => {
    const { look } = await loadShared();
    const cube = join(dir, 'id6.cube'), list = join(dir, 'o6.txt'), blank = png('blank6.png', 'black@0.0'), src = join(dir, 'src6.mp4');
    writeFileSync(cube, look.writeCube(look.identityCube(2)));
    writeFileSync(list, concatText([{ file: blank, dur: 1000 }]));
    ff('-f', 'lavfi', '-i', 'color=c=0x808080:s=64x64:r=30:d=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', src);
    const probe = { dur: 1, w: 64, h: 64, rotation: 0 as const, fps: 30, hdr: null, audio: false };
    const grey = (out: string, k: number) => { const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 << 20 }); return raw.subarray(k * 4096, (k + 1) * 4096); };
    const vig = join(dir, 'vig.mp4');
    execFileSync('ffmpeg', buildExportArgs({ src, probe, cube, concat: list, out: vig, w: 64, h: 64, fps: 30, vignette: 1 }), { stdio: 'ignore' });
    const f = grey(vig, 0), centre = f[32 * 64 + 32], corner = f[1 * 64 + 1];
    expect(Math.abs(centre - 128)).toBeLessThan(6); // the middle untouched
    expect(corner / centre).toBeGreaterThan(0.35); expect(corner / centre).toBeLessThan(0.55); // 1 - 0.6 near the corner
    const gr = join(dir, 'grain.mp4');
    execFileSync('ffmpeg', buildExportArgs({ src, probe, cube, concat: list, out: gr, w: 64, h: 64, fps: 30, grain: 1 }), { stdio: 'ignore' });
    const a = grey(gr, 3), b = grey(gr, 4);
    let diff = 0; for (let k = 0; k < 4096; k++) diff += Math.abs(a[k] - b[k]);
    expect(diff / 4096).toBeGreaterThan(2); // noise, different on every frame
  });
});
