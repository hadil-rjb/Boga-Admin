/** Pure helpers: ffprobe JSON parser and ffmpeg argument builders. No process spawning here (see jobs.service.ts). */

export type Probe = { dur: number; w: number; h: number; rotation: 0 | 90 | 180 | 270; fps: number; hdr: 'hlg' | 'pq' | null; audio: boolean };

const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const rate = (s: any) => { const [a, b] = String(s ?? '').split('/').map(Number); return b ? a / b : Number.isFinite(a) ? a : 0; };

/** ffprobe `-show_streams -show_format` JSON → what the pipeline needs. w/h are the display size after rotation. */
export function parseProbe(json: any): Probe {
  const streams: any[] = json?.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('No video stream found in this file');
  // display matrix rotation is counter-clockwise degrees (-90 means rotate 90 clockwise to display upright)
  const side = (v.side_data_list ?? []).find((s: any) => s.rotation !== undefined);
  const raw = num(side?.rotation ?? v.tags?.rotate, 0);
  const rotation = ((((-raw) % 360) + 360) % 360) as Probe['rotation'];
  const swap = rotation === 90 || rotation === 270;
  const sw = num(v.width), sh = num(v.height);
  const trc = String(v.color_transfer ?? '');
  return {
    dur: num(json?.format?.duration, num(v.duration)),
    w: swap ? sh : sw,
    h: swap ? sw : sh,
    rotation: [0, 90, 180, 270].includes(rotation) ? rotation : 0,
    fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate),
    hdr: trc === 'arib-std-b67' ? 'hlg' : trc === 'smpte2084' ? 'pq' : null,
    audio: streams.some((s) => s.codec_type === 'audio'),
  };
}

export const RGB_TO_709 = 'out_color_matrix=bt709:out_range=tv';
const ROTATE: Record<number, string> = { 90: 'transpose=1', 270: 'transpose=2', 180: 'hflip,vflip' };

/**
 * 720p SDR H.264 proxy. -noautorotate + explicit transpose keeps the rotation under our control (the display matrix is dropped).
 * HLG is mapped to Rec.709 by a 3D LUT in float RGB (this ffmpeg build has no zscale).
 */
export function buildProxyArgs(src: string, out: string, p: Probe, hlgCube: string): string[] {
  const vf: string[] = [];
  if (ROTATE[p.rotation]) vf.push(ROTATE[p.rotation]);
  vf.push(p.w >= p.h ? 'scale=720:-2' : 'scale=-2:720'); // long side (display orientation) to 720
  if (p.hdr === 'hlg') vf.push('format=gbrpf32le', `lut3d=file=${hlgCube}:interp=tetrahedral`);
  // float/RGB -> YUV must use the BT.709 matrix, else the bt709 tags lie (default is BT.601)
  vf.push(`scale=${RGB_TO_709}`, 'format=yuv420p', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'); // frame props win over encoder flags
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-noautorotate', '-display_rotation', '0', '-i', src, // no display matrix may survive: the pixels are already rotated
   
    '-map', '0:v:0', ...(p.audio ? ['-map', '0:a:0?'] : []), '-sn', '-dn',
    '-vf', vf.join(','),
    '-c:v', 'libx264', '-crf', '23', '-g', '15', '-preset', 'veryfast',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...(p.audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    '-movflags', '+faststart', '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats', out,
  ];
}

/** 60 PNG frames, 256 px wide, evenly spread over the proxy */
export function buildFramesArgs(proxy: string, outPattern: string, durSec: number): string[] {
  const fps = 60 / Math.max(durSec, 0.1);
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', proxy, '-an', '-vf', `fps=${+fps.toFixed(6)},scale=256:-2:in_color_matrix=bt709:in_range=tv`, '-frames:v', '60', outPattern];
}

/** The caption crop band: the detected text band plus 5 % of the frame height on each side, as fractions of the full frame height */
export function cropBand(band: [number, number]): [number, number] {
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return [r(Math.max(0, band[0] - 0.05)), r(Math.min(1, band[1] + 0.05))];
}

/**
 * One ffmpeg run, one input per frame time: a full-resolution crop of the caption band of each (c0.jpg, c1.jpg ...)
 * and the first frame as a whole, 540 px tall (full.jpg). JPEG quality about 3 (-q:v).
 */
export function buildCaptionCropArgs(proxy: string, times: number[], band: [number, number], outDir: string): string[] {
  const [y0, y1] = cropBand(band), h = Math.round((y1 - y0) * 10000) / 10000;
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const t of times) args.push('-ss', t.toFixed(3), '-i', proxy);
  times.forEach((_, k) => args.push('-map', `${k}:v:0`, '-frames:v', '1', '-vf', `crop=iw:ih*${h}:0:ih*${y0}`, '-q:v', '3', `${outDir}/c${k}.jpg`));
  args.push('-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=-2:540', '-q:v', '3', `${outDir}/full.jpg`);
  return args;
}

/** `out_time_us=N` line from `-progress` → 0..1 (null for any other line) */
export function parseProgress(line: string, durMs: number): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)\s*$/.exec(line.trim());
  if (!m || !(durMs > 0)) return null;
  return Math.min(1, Math.max(0, Number(m[1]) / 1000 / durMs));
}
