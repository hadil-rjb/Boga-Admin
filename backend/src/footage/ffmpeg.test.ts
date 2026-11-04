import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFramesArgs, buildProxyArgs, parseProbe, parseProgress } from './ffmpeg';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', n), 'utf8'));
const hlg = fx('probe-hlg-1080.json'), hlg720 = fx('probe-hlg-720.json'), ref = fx('probe-ref.json');

describe('parseProbe', () => {
  it('phone HLG clip: portrait display size, rotation 90, hlg', () => expect(parseProbe(hlg)).toMatchObject({ w: 1080, h: 1920, rotation: 90, hdr: 'hlg', audio: true }));
  it('second phone clip (1280x720 stored) is portrait too', () => expect(parseProbe(hlg720)).toMatchObject({ w: 720, h: 1280, rotation: 90, hdr: 'hlg' }));
  it('reference: SDR, no rotation', () => expect(parseProbe(ref)).toMatchObject({ w: 1080, h: 1920, rotation: 0, hdr: null }));
  it('reads duration and fps', () => { const p = parseProbe(hlg); expect(p.dur).toBeCloseTo(72.82, 1); expect(p.fps).toBeCloseTo(30, 0); });
  it('maps smpte2084 to pq and rotation 90 (positive) to 270', () => {
    const j = JSON.parse(JSON.stringify(hlg)); const v = j.streams.find((s: any) => s.codec_type === 'video');
    v.color_transfer = 'smpte2084'; v.side_data_list = [{ rotation: 90 }];
    expect(parseProbe(j)).toMatchObject({ hdr: 'pq', rotation: 270 });
  });
  it('throws when there is no video stream', () => expect(() => parseProbe({ streams: [{ codec_type: 'audio' }], format: {} })).toThrow(/video/i));
});

describe('buildProxyArgs', () => {
  it('proxy args for HLG include transpose=1 and the cube', () => {
    const a = buildProxyArgs('s', 'o', parseProbe(hlg), 'c.cube').join(' ');
    expect(a).toMatch(/-noautorotate/); expect(a).toMatch(/transpose=1/); expect(a).toMatch(/lut3d=file=c.cube/);
  });
  it('proxy args for an SDR landscape file have no lut3d and no transpose', () => {
    const a = buildProxyArgs('s', 'o', { dur: 1, w: 1920, h: 1080, rotation: 0, fps: 30, hdr: null, audio: true }, 'c').join(' ');
    expect(a).not.toMatch(/lut3d|transpose/); expect(a).toMatch(/scale=720:-2|scale=-2:720|scale='min/);
  });
  it('no audio → no audio codec args', () => expect(buildProxyArgs('s', 'o', { ...parseProbe(ref), audio: false }, 'c')).not.toContain('aac'));
  it('with audio → aac 128k', () => expect(buildProxyArgs('s', 'o', parseProbe(ref), 'c').join(' ')).toMatch(/-c:a aac -b:a 128k/));
  it('rotation 270 → transpose=2, 180 → hflip,vflip', () => {
    const base = { dur: 1, w: 1080, h: 1920, fps: 30, hdr: null, audio: false } as const;
    expect(buildProxyArgs('s', 'o', { ...base, rotation: 270 }, 'c').join(' ')).toMatch(/transpose=2/);
    expect(buildProxyArgs('s', 'o', { ...base, rotation: 180 }, 'c').join(' ')).toMatch(/hflip,vflip/);
  });
  it('tone-maps in float RGB before yuv420p and scales the long side to 720', () => {
    const vf = buildProxyArgs('s', 'o', parseProbe(hlg), 'c.cube'); const f = vf[vf.indexOf('-vf') + 1];
    expect(f.indexOf('format=gbrpf32le')).toBeLessThan(f.indexOf('lut3d')); expect(f.indexOf('lut3d')).toBeLessThan(f.lastIndexOf('format=yuv420p'));
    expect(f).toMatch(/scale=/);
  });
  it('converts to YUV with the BT.709 matrix, for HDR and SDR alike', () => {
    for (const p of [parseProbe(hlg), parseProbe(ref)]) {
      const a = buildProxyArgs('s', 'o', p, 'c.cube'); const f = a[a.indexOf('-vf') + 1];
      expect(f).toMatch(/scale=out_color_matrix=bt709:out_range=tv,format=yuv420p/);
    }
  });
  it('encodes with libx264 crf 23, g 15, faststart, progress pipe', () => {
    const a = buildProxyArgs('s', 'o', parseProbe(ref), 'c').join(' ');
    expect(a).toMatch(/-c:v libx264 -crf 23 -g 15/); expect(a).toMatch(/-movflags \+faststart/); expect(a).toMatch(/-progress pipe:1 -nostats/);
  });
  it('never uses an input starting with a dash as an option', () => { const a = buildProxyArgs('/x/s.mp4', 'o', parseProbe(ref), 'c'); expect(a[a.indexOf('-i') + 1]).toBe('/x/s.mp4'); });
});

describe('buildFramesArgs', () => {
  it('samples 60 frames at 256 px wide', () => {
    const a = buildFramesArgs('p.mp4', 'f/%03d.png', 30).join(' ');
    expect(a).toMatch(/fps=2(\.0+)?,scale=256:-2:in_color_matrix=bt709/); expect(a).toMatch(/-frames:v 60/);
  });
});

describe('parseProgress', () => {
  it('parses progress', () => expect(parseProgress('out_time_us=5000000', 10000)).toBeCloseTo(0.5));
  it('clamps to 1 and ignores other lines', () => { expect(parseProgress('out_time_us=99000000', 10000)).toBe(1); expect(parseProgress('frame=12', 10000)).toBeNull(); expect(parseProgress('out_time_us=N/A', 10000)).toBeNull(); });
});
