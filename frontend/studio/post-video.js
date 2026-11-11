/* ============================================================
   Video posts: an imported clip (d.footage) or an animated design (d.motion) is scheduled like an image post, but what
   goes out is its MP4. The studio prepares that MP4 when the post is scheduled:
   - a clip: the server exports it (POST /footage/export, the same MP4 as Export video), then the post adopts that file;
   - an animated design: this browser records it (real time, like Export video) and uploads it in 8 MB chunks; the server
     re-encodes it to H.264 + AAC.
   The per-network limits mirror backend/src/social/publishing/post-video.ts (keep both in sync: same numbers, same text).
   Pure helpers on top; prepareVideo talks to the API through the functions it is given.
   ============================================================ */

const MB = 1024 ** 2, GB = 1024 ** 3;
export const VIDEO_LIMITS = {
  ig: { minMs: 3_000, maxMs: 15 * 60_000, maxBytes: 300 * MB, name: 'Instagram' },
  fb: { minMs: 1_000, maxMs: 240 * 60_000, maxBytes: 4 * GB, name: 'Facebook' },
  tt: { minMs: 3_000, maxMs: 10 * 60_000, maxBytes: 4 * GB, name: 'TikTok' },
  li: { minMs: 3_000, maxMs: 30 * 60_000, maxBytes: 5 * GB, name: 'LinkedIn' },
  x: { minMs: 500, maxMs: 140_000, maxBytes: 512 * MB, name: 'X' },
  tg: { minMs: 0, maxMs: Infinity, maxBytes: 50 * MB, name: 'Telegram' },
};
const secs = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
const mb = (b) => (b >= GB ? `${Math.round(b / GB)} GB` : `${Math.round(b / MB)} MB`);

/** Why `net` can't take a video of this length / size (a sentence), or null. Size unknown before it's prepared: only the length is checked. */
export function videoProblem(net, v) {
  const L = VIDEO_LIMITS[net]; if (!L || !v) return null;
  if (v.durationMs && v.durationMs < L.minMs) return `${L.name} needs a video of at least ${secs(L.minMs)}.`;
  if (v.durationMs && v.durationMs > L.maxMs) return `${L.name} takes videos up to ${secs(L.maxMs)}: this one is ${secs(v.durationMs)}.`;
  if (v.size && v.size > L.maxBytes) return `${L.name} takes videos up to ${mb(L.maxBytes)}: this one is ${mb(v.size)}.`;
  return null;
}

export const isVideoPost = (d) => !!(d && (d.footage || d.motion));
/** A clip with no file yet can't be scheduled: there is nothing to publish */
export const NO_CLIP = 'Add your video first, then schedule it.';
export const videoBlocked = (d) => (d && d.footage && !d.footage.src ? NO_CLIP : null);

/** What the published video depends on (a change means the prepared MP4 is out of date) */
export function videoKey(d) {
  if (!d) return '';
  if (d.footage) { const f = d.footage; return JSON.stringify(['ft', f.src, f.look, f.out, f.audio, d.captions && d.captions.on, d.captions && d.captions.lines, d.captions && d.captions.style]); }
  return JSON.stringify(['mo', d.ratio, d.motion, d.captions, d.pages.map((p) => [p.bg, p.layers, p.scene, p.vo])]);
}

/** The length of a video design, in ms (a clip's file, or the sum of a design's scenes), 0 when unknown */
export function videoLength(d, timeline) {
  if (!d) return 0;
  if (d.footage) return +d.footage.dur || 0;
  try { return timeline ? timeline(d.pages).total || 0 : 0; } catch (e) { return 0; }
}

/** The steps of preparing a video, for the progress bar: [weight, label] (a clip has no recording; a design no export) */
export const STEPS = {
  export: [0.9, 'Exporting your video…'], attach: [0.1, 'Saving it for publishing…'],
  prep: [0.05, 'Loading fonts and images…'], record: [0.6, 'Recording your video…'], upload: [0.25, 'Uploading…'], process: [0.1, 'Converting it for every network…'],
};
const ORDER = { footage: ['export', 'attach'], motion: ['prep', 'record', 'upload', 'process'] };
/** Overall progress 0–1 from the current step and its own progress */
export function overall(kind, step, p) {
  const steps = ORDER[kind] || []; let done = 0;
  for (const s of steps) { if (s === step) return Math.min(1, done + STEPS[s][0] * Math.max(0, Math.min(1, p || 0))); done += STEPS[s][0]; }
  return Math.min(1, done);
}

export const UPLOAD_CHUNK = 8 * 1024 * 1024;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Prepares a post's video and attaches it on the server. Resolves with the post's publish state ({ id, status, publish, media }).
 * ctx: { api(path, opts), postPath (".../posts/<id>"), post (plain, without publish/media), hash, exportPayload(d, size),
 *        exportSizes(out), record(d, opts) -> Blob, mimes() -> [[mime, ext]], fps, onProgress(step, p), signal { stop } }
 */
export async function prepareVideo(d, ctx) {
  const { api, postPath, post, hash, onProgress = () => {}, signal = {} } = ctx;
  const stopped = () => { if (signal.stop) throw Object.assign(new Error('Stopped'), { stopped: true }); };
  if (d.footage) {
    const no = videoBlocked(d); if (no) throw new Error(no);
    const size = ctx.exportSizes(d.footage.out)[0]; // the reference size: what the clip was made at
    onProgress('export', 0);
    const job = await api('/footage/export', { method: 'POST', body: ctx.exportPayload(d, size) });
    for (;;) {
      stopped();
      const r = await api(`/footage/export/${job.jobId}`);
      if (r.state === 'done') break;
      if (r.state === 'failed') throw new Error(r.error || 'The video export failed. Try again.');
      onProgress('export', r.progress || 0);
      await wait(ctx.pollMs || 1500);
    }
    onProgress('attach', 0);
    return api(`${postPath}/video/footage`, { method: 'POST', body: { jobId: job.jobId, hash, post } });
  }
  // an animated design: recorded here, as MP4 when the browser can (the server converts WebM)
  const m = (ctx.mimes() || [])[0];
  if (!m) throw new Error('This browser can’t record video. Schedule it from Chrome, Edge or Safari.');
  const blob = await ctx.record(d, { s: 1, fps: ctx.fps || 30, mime: m[0], signal, onStep: (k, p) => onProgress(k === 'prep' ? 'prep' : 'record', p) });
  stopped(); if (!blob || !blob.size) throw new Error('The recording is empty. Try again.');
  const up = await api(`${postPath}/video/upload`, { method: 'POST', body: { post } });
  const size = up.chunk || UPLOAD_CHUNK, parts = Math.ceil(blob.size / size);
  for (let i = 0; i < parts; i++) {
    stopped();
    await api(`${postPath}/video/upload/${up.uploadId}/${i}`, { method: 'PUT', raw: true, body: blob.slice(i * size, Math.min(blob.size, (i + 1) * size)) });
    onProgress('upload', (i + 1) / parts);
  }
  onProgress('process', 0);
  return api(`${postPath}/video/upload/${up.uploadId}/complete`, { method: 'POST', body: { parts, hash } });
}
