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

/** A music bed for the export: a local audio file, its volume (0..1) and whether it dips under the original's speech */
export type ExportMusic = { path: string; vol: number; duck: boolean };
/** Kept frames of the constant-rate output, [[first, last]] inclusive (pauses.js keepFrames); null keeps everything */
export type ExportKeep = [number, number][] | null;
export type ExportArgs = { src: string; probe: Probe; cube: string; concat: string; out: string; w: number; h: number; fps: number; limitSec?: number; vol?: number; music?: ExportMusic | null; denoise?: boolean; voice?: string | null; keep?: ExportKeep; grain?: number; vignette?: number };

/**
 * "Reduce background noise" without the voice model (DeepFilterNet missing on this machine, see jobs.service.ts): a high-pass under the voice (rumble, wind, engine), then FFT denoising that tracks the noise
 * floor as it changes (tn=1). Used by the preview's clean proxy (buildCleanArgs) and the export, so both sound the same.
 */
export const DENOISE = 'highpass=f=80,afftdn=nr=15:nf=-40:tn=1';
/** The sound's rate in the export when frames are cut: one frame of video is exactly 48000 / fps samples (24, 25, 30, 60 all divide) */
export const CUT_RATE = 48000;
/** select / aselect expression keeping frames `keep` (n is the frame number, the same for the video and the frame-sized audio chunks) */
export const keepExpr = (keep: [number, number][]) => keep.map(([a, b]) => (a === b ? `eq(n,${a})` : `between(n,${a},${b})`)).join("+"); // quoted in the graph: the commas need no escaping
const cutting = (keep: ExportKeep | undefined): keep is [number, number][] => Array.isArray(keep) && keep.length > 0;

/** The original's sound for the voice model: 48 kHz mono 16-bit WAV (DeepFilterNet's rate) */
export function buildVoiceInArgs(src: string, wav: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 'wav', wav];
}

/**
 * The vignette as one frame, looped: black whose alpha is the shader's darkening (look.js vignetteAt: 0.6 × amount × a
 * smoothstep from 0.35 to 0.95 of the distance to the centre, the corners at 1). Laid over the picture it multiplies it,
 * as the shader does. Drawn once by geq, not per frame.
 */
export function vignetteSource(w: number, h: number, amount: number): string {
  const a = +Math.max(0, Math.min(1, amount)).toFixed(3);
  const t = `clip((hypot(X/W-0.5,Y/H-0.5)*1.4142-0.35)/0.6,0,1)`;
  return `color=c=black:s=${w}x${h}:d=0.04,format=rgba,geq=r=0:g=0:b=0:a='255*${a}*0.6*${t}*${t}*(3-2*${t})',loop=loop=-1:size=1:start=0`;
}

/**
 * The preview's clean proxy: the proxy's picture copied as is, with the voice the model isolated (voice.wav) or, without
 * it, the proxy's sound through DENOISE (the player swaps it in while "Reduce background noise" is on).
 */
export function buildCleanArgs(proxy: string, out: string, voice: string | null = null): string[] {
  if (voice) return ['-y', '-hide_banner', '-loglevel', 'error', '-i', proxy, '-i', voice, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', out];
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', proxy, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', DENOISE, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', out];
}

const gain = (v: number) => String(+Math.max(0, Math.min(1, v)).toFixed(3));
/**
 * The audio half of the export: extra inputs, the filtergraph chains (appended to -filter_complex), the -map and codec args.
 * - the original first goes through DENOISE (denoise) and loses the cut frames (keep: resampled to 48 kHz, split into
 *   chunks of one video frame, the same select expression as the picture, timestamps rebuilt);
 * - original only at volume 1, nothing else: a plain copy of the first audio stream (as before);
 * - original at another volume: [0:a:0]volume=V[aout];
 * - original + music: the music (input 2) looped with aloop and set to its volume; with duck, a sidechain compressor keyed by
 *   the original (before its volume, so a quiet original still ducks the music) dips it under speech; amix sums the two
 *   (normalize=0: no halving, the preview adds the two the same way), duration=first: the original sets the length;
 * - music alone (no original audio, or the original at 0): the looped music trimmed to the (cut) video;
 * - nothing to hear: -an.
 * The music is added after the cuts: it plays on under the edited video without jumps.
 * With `voice` (the model's isolated voice, a WAV of the same length) that file is the original's sound (input 2, the music
 * moves to input 3) and DENOISE is not needed.
 */
export function exportAudio(probe: Probe, vol = 1, music: ExportMusic | null = null, limitSec?: number, opts: { denoise?: boolean; voice?: string | null; keep?: ExportKeep; fps?: number } = {}): { inputs: string[]; graph: string; map: string[]; codec: string[] } {
  const orig = probe.audio && vol > 0, aac = ['-c:a', 'aac', '-b:a', '192k'];
  if (!orig && !music) return { inputs: [], graph: '', map: [], codec: ['-an'] };
  const voice = orig && opts.denoise && opts.voice ? opts.voice : null, vin = voice ? ['-i', voice] : [];
  const src = voice ? '2:a:0' : '0:a:0', mi = voice ? 3 : 2;
  const pre: string[] = [];
  if (opts.denoise && !voice) pre.push(DENOISE);
  if (cutting(opts.keep)) {
    const fps = opts.fps || 30;
    pre.push(`aresample=${CUT_RATE}:first_pts=0`, `asetnsamples=n=${CUT_RATE / fps}:p=1`, `aselect='${keepExpr(opts.keep)}'`, 'asetpts=N/SR/TB');
  }
  const a0 = pre.length ? `[${src}]${pre.join(',')},` : `[${src}]`;
  const outSec = cutting(opts.keep) ? opts.keep.reduce((n, [a, b]) => n + b - a + 1, 0) / (opts.fps || 30) : probe.dur;
  if (!music) {
    if (vol >= 1 && !pre.length) return { inputs: vin, graph: '', map: ['-map', `${src}?`], codec: aac };
    return { inputs: vin, graph: `;${a0}volume=${gain(vol)}[aout]`, map: ['-map', '[aout]'], codec: aac };
  }
  const m = `[${mi}:a:0]aloop=-1:2e9,volume=${gain(music.vol)}`;
  let graph: string;
  if (!orig) graph = `;${m},atrim=0:${+Math.min(limitSec ?? Infinity, outSec).toFixed(3)}[aout]`;
  else if (music.duck) graph = `;${a0}asplit=2[a0s][sc];[a0s]volume=${gain(vol)}[a0];${m}[m];[m][sc]sidechaincompress=threshold=0.05:ratio=8[md];[a0][md]amix=inputs=2:duration=first:normalize=0[aout]`;
  else graph = `;${a0}volume=${gain(vol)}[a0];${m}[m];[a0][m]amix=inputs=2:duration=first:normalize=0[aout]`;
  return { inputs: [...vin, '-i', music.path], graph, map: ['-map', '[aout]'], codec: aac };
}

/**
 * The export encode: the source (rotated and HDR-handled like the proxy), cover-cropped to w × h like the preview
 * (footage-player.js coverCrop: scale up to cover, centre crop), one 3D LUT (HLG→709 ∘ grade ∘ tweaks, baked by the service),
 * then the caption overlay (a concat of PNGs, one per change) on top. RGB→YUV with the BT.709 matrix on both branches, so the
 * bt709 tags are true and the subtitle colours are the preview's.
 * Timing: the overlay stream keeps the concat's exact ms timestamps (no fps filter on it). overlay pairs each source frame
 * with the latest overlay frame whose pts ≤ that frame's pts, which is what the preview does (draw at the presented frame's
 * media time). A change at t therefore first shows on the first source frame with pts ≥ t; for a constant-rate source that is
 * frame ceil(t·fps). Resampling the overlay to a fixed fps grid instead lags a frame whenever the source rate is not exactly
 * fps (phones record 30.004). `-r fps` then sets the output rate. shortest=1: the source video sets the length, never the
 * overlay (which runs a little past the end).
 */
export function buildExportArgs({ src, probe, cube, concat, out, w, h, fps, limitSec, vol = 1, music = null, denoise = false, voice = null, keep = null, grain = 0, vignette = 0 }: ExportArgs): string[] {
  const v: string[] = [];
  if (ROTATE[probe.rotation]) v.push(ROTATE[probe.rotation]);
  v.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`, 'format=rgb48le', `lut3d=file=${cube}:interp=tetrahedral`, `scale=${RGB_TO_709}`, 'format=yuv420p');
  const o = ['format=rgba', `scale=${RGB_TO_709}`, 'format=yuva420p'];
  const A = exportAudio(probe, vol, music, limitSec, { denoise, voice, keep, fps });
  // Remove pauses: the source on the fps grid first (frame n shows n / fps; before the overlay, which ends the stream with
  // shortest=1 and would cost fps its last frame), then the kept frames selected after the captions, timestamps rebuilt
  if (cutting(keep)) v.unshift(`fps=${fps}`);
  const cut = cutting(keep) ? `,select='${keepExpr(keep)}',setpts=N/${fps}/TB` : '';
  // film grain and vignette (look filters), under the captions, drawn as the preview shader does (look.js GLSL_FILTER)
  let fxg = '';
  if (grain > 0) v.push(`noise=c0s=${Math.round(grain * 15)}:c0f=t+u`); // ±0.06 × grain of the range on luma, new each frame
  if (vignette > 0) fxg = `;${vignetteSource(w, h, vignette)}[vg];[v][vg]overlay=0:0:format=auto:shortest=1,format=yuv420p[v2]`;
  const fc = `[0:v]${v.join(',')}[v]${fxg};[1:v]${o.join(',')}[o];[${vignette > 0 ? 'v2' : 'v'}][o]overlay=0:0:format=auto:eof_action=repeat:shortest=1${cut},format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[out]${A.graph}`;
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-noautorotate', '-display_rotation', '0', '-i', src, // as the proxy: we rotate ourselves, no display matrix survives
    '-f', 'concat', '-safe', '0', '-i', concat,
    ...A.inputs,
    '-filter_complex', fc,
    '-map', '[out]', ...A.map, '-sn', '-dn',
    ...(limitSec ? ['-t', String(limitSec)] : []),
    '-r', String(fps), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...A.codec,
    '-movflags', '+faststart', '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats', out,
  ];
}
