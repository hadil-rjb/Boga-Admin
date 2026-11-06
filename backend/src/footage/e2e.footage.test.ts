/**
 * End-to-end preview/export parity on the real sample footage (skipped unless FOOTAGE_SAMPLES names a folder holding
 * 20261103_134552.mp4 (HLG original) and "dom 1 ex-captioned_1.mp4" (SDR reference with burned-in subtitles)).
 *
 *   FOOTAGE_SAMPLES=~/Downloads npm --prefix backend test -- e2e.footage
 *
 * Runs the real pipeline through the services (no HTTP): store → JobsService (probe, proxy, frames, transcribe with the real
 * whisper worker on the whole original, grade, caption-style) → captions grouped from words.json → ExportService.start with
 * a 10 s trim (limitMs, test only), three times: (a) identity look, no captions; (b) the look, no captions; (c) look and
 * captions. Each decomposes the parity floor; every variant must pass. Then, at t = 1, 3, 5, 7, 9 s:
 *   - preview: headless Chromium (SwiftShader WebGL2) loads footage-player.js / look.js / captions.js from a temp http server
 *     that also serves the proxy and look.cube, seeks, and returns the WebGL canvas + caption overlay composited at the
 *     export size (1080 × 1920: captions drawn at the same pixel size as the export's overlay);
 *   - export: ffmpeg extracts the same frame from the MP4 at full size (accurate seek, -ss after -i), decoded with
 *     accurate_rnd+full_chroma_int: swscale's default YUV→RGB rounding reads 2–3 levels darker than Chromium's decoder
 *     (measured on the proxy: ΔE 1.35 with the defaults, 0.53 with these flags), which would count against parity;
 *   - both full-size PNGs are shrunk to 360 px wide by the same ffmpeg call (RGB, area filter); mean CIEDE2000 between
 *     them (tts/footage/delta_e.py) must be < 2.
 * Decoder check: one frame of export (c) decoded by Chromium is within ΔE 0.5 of the accurate ffmpeg decode.
 * Also: stats.json result means (skin and global L and b) are closer to the reference than the source, and in at least one
 * exported frame ≥ 0.3 % of the caption band's pixels are within ΔE 10 of the style's highlight colour.
 *
 * Caption style: the test has no Anthropic key, and a missing key yields DEFAULT_STYLE without the measured colours. The
 * fake CaptionAi here fails with an ordinary error instead, so the caption-style step stores mergeStyle(null, sampled,
 * DEFAULT_STYLE): the default style with the colours textframes sampled from the reference (its highlight box ≈ #D8AC6C).
 * The highlight check therefore uses the sampled highlight colour.
 *
 * Subtitle overlay for the export: the production renderer opens the Next render page (?mode=captions), which needs the
 * frontend running. Here the export's CaptionRenderer is a page on the same temp server whose window.bogaCaptions is the
 * render page's captionsMode code (captions.js draw on a 2D canvas after the subtitle fonts load).
 *
 * Keep the work folder (frames, export, stats) with FOOTAGE_E2E_KEEP=1; its path is logged.
 */
import { copyFileSync, createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';
import { launchChromium } from '../social/publishing/headless';
import { CaptionRenderer, ExportService, validateExport } from './export.service';
import { FootageStore } from './footage.store';
import { JobsService } from './jobs.service';
import { NOTE_AI_FAILED } from './caption-style';
import { loadShared } from './shared';

const run = promisify(execFile);
const SAMPLES = process.env.FOOTAGE_SAMPLES ? resolve(process.env.FOOTAGE_SAMPLES.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')) : '';
const ORIG_FILE = '20261103_134552.mp4', REF_FILE = 'dom 1 ex-captioned_1.mp4';
const HAVE = !!SAMPLES && existsSync(join(SAMPLES, ORIG_FILE)) && existsSync(join(SAMPLES, REF_FILE));

const ORIG = 'e2e0'.repeat(6), REF = 'e2e1'.repeat(6);
const TIMES = [1, 3, 5, 7, 9]; // s
const FPS = 30, W = 1080, H = 1920, PREVIEW_W = 360, LIMIT_MS = 10_000;
// non-zero tweaks and strength < 1: the mix and lookTweak paths of the shader are compared with the baked LUT too
const LOOK = { lut: `footage/${ORIG}/look.cube`, strength: 0.85, exposure: 0.1, temp: 0.15, sat: 0.1 };
const BACKEND = resolve(__dirname, '..', '..');
const STUDIO = resolve(BACKEND, '..', 'frontend', 'studio');
const PY = process.env.TTS_PYTHON || join(BACKEND, '.tts', 'venv', 'bin', 'python');
const DELTA_E = join(BACKEND, 'tts', 'footage', 'delta_e.py');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-memory stand-in for the mongoose model (the same shape the unit tests use): dotted $set / $unset, find by status or a dotted path */
function fakeModel(initial: Record<string, any>) {
  const docs: Record<string, any> = JSON.parse(JSON.stringify(initial));
  const path = (o: any, p: string, v: any, del = false) => { const k = p.split('.'); let c = o; for (const x of k.slice(0, -1)) c = c[x] ??= {}; if (del) delete c[k.at(-1)!]; else c[k.at(-1)!] = v; };
  const get = (o: any, p: string) => p.split('.').reduce((c, x) => c?.[x], o);
  const q = (v: any) => ({ select: () => ({ lean: async () => (v ? JSON.parse(JSON.stringify(v)) : null) }) });
  const match = (d: any, f: Record<string, any>) => Object.entries(f).every(([k, v]) => (v && typeof v === 'object' && '$in' in v ? v.$in.includes(get(d, k)) : v && typeof v === 'object' && '$exists' in v ? (get(d, k) !== undefined) === v.$exists : get(d, k) === v));
  return {
    docs,
    findById: (id: string) => q(docs[id]),
    findOne: (f: any) => q(Object.values(docs).find((d) => match(d, f))),
    find: (f: any) => ({ select: () => ({ lean: async () => Object.values(docs).filter((d) => match(d, f)).map((d) => JSON.parse(JSON.stringify(d))) }) }),
    updateOne: async (f: any, u: any) => {
      const d = docs[String(f._id)]; if (!d) return;
      for (const [k, v] of Object.entries(u.$set ?? {})) path(d, k, v);
      for (const k of Object.keys(u.$unset ?? {})) path(d, k, null, true);
    },
    updateMany: async () => undefined,
  };
}

/** The test page: the studio modules, the subtitle fonts, the render page's bogaCaptions and a preview() that captures composited frames */
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000}#host{position:relative;overflow:hidden}.ftp-v{display:none}.ftp-c,.ftp-o{position:absolute;inset:0;width:100%;height:100%}</style>
</head><body><div id="host"></div>
<script type="module">
import { createPlayer } from '/studio/footage-player.js';
import { parseCube } from '/studio/look.js';
import * as C from '/studio/captions.js';
const css = new Promise((ok) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = C.FONTS_CSS; l.onload = () => ok(); l.onerror = () => ok(); document.head.append(l); });
const fonts = async (lines, style, H) => {
  await css;
  const text = lines.flatMap((l) => (l.words || []).map((x) => x.t)).join(' ');
  const chars = [...new Set(text + text.toUpperCase() + text.toLowerCase())].join('') || 'a';
  await document.fonts.load(C.fontOf(style, style.size * H), chars).catch(() => []);
  await document.fonts.ready;
};
// frontend/app/(social)/social-media/render/page.tsx captionsMode, verbatim in behaviour
window.bogaCaptions = async (lines, style, W, H, times) => {
  const st = style || C.DEFAULT_STYLE;
  await fonts(lines, st, H);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  return times.map((t) => { ctx.clearRect(0, 0, W, H); C.draw(ctx, lines, st, t, W, H); return cv.toDataURL('image/png'); });
};
window.preview = async ({ out, look, captions, cssW, times }) => {
  const cube = parseCube(await (await fetch('/look.cube')).text());
  const host = document.getElementById('host');
  host.style.width = cssW + 'px'; host.style.height = Math.round(cssW * out.h / out.w) + 'px';
  await fonts(captions.lines, captions.style || C.DEFAULT_STYLE, Math.round(cssW * out.h / out.w));
  const P = createPlayer(host, { proxyUrl: '/proxy.mp4', out, look, captions, cube: (k) => (k === look.lut ? cube : null) });
  if (!P.hasGL()) throw new Error('WebGL2 is not available in this headless Chromium: the preview would use the 2D fallback without the grade');
  P.setSplit(null);
  P.video.muted = true;
  await new Promise((ok, no) => {
    if (P.video.readyState >= 2) return ok();
    P.video.addEventListener('loadeddata', ok, { once: true });
    P.video.addEventListener('error', () => no(new Error('proxy did not load: ' + (P.video.error && P.video.error.message))), { once: true });
  });
  const [cv, ov] = host.querySelectorAll('canvas');
  const shots = [];
  const grab = () => { const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const x = c.getContext('2d'); x.drawImage(cv, 0, 0); x.drawImage(ov, 0, 0); return c.toDataURL('image/png'); };
  for (const t of times) {
    // wait for both the seek and the new frame's presentation: the player re-uploads the video texture on each (its
    // 'seeked' and requestVideoFrameCallback handlers, registered before ours, run first). Capturing in the first
    // requestVideoFrameCallback alone once returned the previous frame on the first seek after load.
    const seeked = new Promise((ok) => P.video.addEventListener('seeked', ok, { once: true }));
    const vfc = new Promise((ok) => P.video.requestVideoFrameCallback((_n, meta) => ok(meta)));
    const late = new Promise((_, no) => setTimeout(() => no(new Error('no video frame after seeking to ' + t)), 15000));
    P.seek(t);
    const [, meta] = await Promise.race([Promise.all([seeked, vfc]), late]);
    await new Promise((r) => requestAnimationFrame(r));
    // the WebGL canvas has no preserved drawing buffer: draw it again (same texture) and copy it in the same task
    P.redraw();
    shots.push({ png: grab(), mediaTime: meta.mediaTime, w: cv.width, h: cv.height });
  }
  const gl = cv.getContext('webgl2'), dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  P.destroy();
  return { shots, renderer };
};
// One frame of an MP4 decoded by Chromium (the preview's decoder), drawn 1:1 on a 2D canvas
window.decodeFrame = async (src, ms) => {
  const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = src;
  await new Promise((ok, no) => { v.addEventListener('loadeddata', ok, { once: true }); v.addEventListener('error', () => no(new Error('export did not load')), { once: true }); });
  const seeked = new Promise((ok) => v.addEventListener('seeked', ok, { once: true }));
  const vfc = new Promise((ok) => v.requestVideoFrameCallback((_n, meta) => ok(meta)));
  v.currentTime = ms / 1000;
  const [, meta] = await Promise.all([seeked, vfc]);
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const png = c.toDataURL('image/png');
  v.removeAttribute('src'); v.load();
  return { png, mediaTime: meta.mediaTime };
};
window.ready = true;
</script></body></html>`;

/** Static server: the page, three studio modules, the proxy (with Range, so the video can seek), look.cube, plus `files` */
function serve(store: FootageStore, files: Record<string, [string, string]> = {}): Promise<Server> {
  Object.assign(files, {
    '/proxy.mp4': [store.file(ORIG, 'proxy.mp4'), 'video/mp4'],
    '/look.cube': [store.file(ORIG, 'look.cube'), 'text/plain'],
    ...Object.fromEntries(['footage-player.js', 'look.js', 'captions.js'].map((n) => [`/studio/${n}`, [join(STUDIO, n), 'text/javascript']])),
  }); // the caller may add more later (the export, for the Chromium decode check)
  const srv = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end(PAGE); }
    const f = files[url];
    if (!f || !existsSync(f[0])) { res.writeHead(404); return void res.end(); }
    const size = statSync(f[0]).size, m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m) {
      const a = m[1] ? +m[1] : size - +m[2], b = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      res.writeHead(206, { 'content-type': f[1], 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 });
      return void createReadStream(f[0], { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { 'content-type': f[1], 'accept-ranges': 'bytes', 'content-length': size });
    createReadStream(f[0]).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

async function openPage(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String((e as Error)?.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log(`[page ${m.type()}] ${m.text()}`); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.ready === true', { timeout: 30_000 }).catch((e) => { throw new Error(`test page did not start: ${e.message} ${errors.join('; ')}`); });
  return page;
}

/** Export subtitles through the test page's bogaCaptions (the render page's code), on the shared browser */
const pageCaptions = (browser: Browser, url: string): CaptionRenderer => ({
  open: async () => {
    const page = await openPage(browser, url);
    return {
      draw: (lines, style, w, h, times) => page.evaluate((a: any, b: any, c: number, d: number, e: number[]) => (window as any).bogaCaptions(a, b, c, d, e), lines as any, style as any, w, h, times) as Promise<string[]>,
      close: async () => { await page.close().catch(() => undefined); },
    };
  },
});

const deltaE = async (args: string[]) => JSON.parse((await run(PY, ['-I', DELTA_E, ...args])).stdout.trim());

let work = '', browser: Browser | null = null, server: Server | null = null, jobs: JobsService | null = null;
afterAll(async () => {
  jobs?.onModuleDestroy();
  await browser?.close().catch(() => undefined);
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  if (work && !process.env.FOOTAGE_E2E_KEEP) rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!HAVE)('footage end to end: preview matches export (sample footage)', () => {
  it('pipeline, grade stats, caption highlight and 5-frame ΔE2000 parity', async () => {
    work = mkdtempSync(join(tmpdir(), 'footage-e2e-'));
    console.log(`[e2e] work folder ${work}`);
    process.env.FOOTAGE_DIR = join(work, 'footage');
    const store = new FootageStore();
    for (const [id, f] of [[ORIG, ORIG_FILE], [REF, REF_FILE]]) {
      await fs.mkdir(store.dir(id), { recursive: true });
      copyFileSync(join(SAMPLES, f), join(store.dir(id), 'source.mp4')); // copies: the samples are never touched
    }
    const model = fakeModel({
      [ORIG]: { _id: ORIG, role: 'original', status: 'processing', jobs: {}, pair: { ref: REF } },
      [REF]: { _id: REF, role: 'reference', status: 'processing', jobs: {} },
    });
    let sampled: any = null;
    const ai = { captionStyle: async (_i: any, s: any) => { sampled = s; throw new Error('no Claude in the parity test'); } };
    jobs = new JobsService(model as any, store, ai);

    // ---- 1. the pipeline, as upload + pair would start it
    const t0 = Date.now();
    await jobs.enqueue(REF, 'probe');
    await jobs.enqueue(ORIG, 'probe');
    await jobs.enqueue(ORIG, 'transcribe');
    await jobs.enqueue(ORIG, 'grade');
    const busy = (d: any) => !['ready', 'failed'].includes(d.status) || Object.values(d.jobs ?? {}).some((j: any) => ['queued', 'running'].includes(j?.state));
    while (busy(model.docs[ORIG]) || busy(model.docs[REF])) {
      if (Date.now() - t0 > 12 * 60_000) throw new Error(`pipeline timed out: ${JSON.stringify({ o: model.docs[ORIG].jobs, r: model.docs[REF].jobs })}`);
      await sleep(500);
    }
    console.log(`[e2e] pipeline ${Math.round((Date.now() - t0) / 1000)} s`);
    const o = model.docs[ORIG], r = model.docs[REF];
    expect({ status: o.status, error: o.error }).toEqual({ status: 'ready', error: undefined });
    for (const s of ['probe', 'proxy', 'frames', 'transcribe', 'grade']) expect([s, o.jobs[s]?.state, o.jobs[s]?.error]).toEqual([s, 'done', undefined]);
    for (const s of ['probe', 'proxy', 'frames', 'caption-style']) expect([s, r.jobs[s]?.state]).toEqual([s, 'done']);
    expect(o.meta.hdr).toBe('hlg');

    // ---- 2. grade statistics
    const stats = JSON.parse(readFileSync(store.file(ORIG, 'stats.json'), 'utf8'));
    console.log(`[e2e] stats ${JSON.stringify(stats)}`);
    expect(stats.mode).toBe('regions');
    for (const region of ['skin', 'global']) for (const k of ['L', 'b']) {
      const { src, ref, result } = stats[region];
      expect(Math.abs(result[k] - ref[k]), `${region}.${k}: result ${result[k]} vs src ${src[k]}, ref ${ref[k]}`).toBeLessThan(Math.abs(src[k] - ref[k]));
    }

    // ---- 3. caption style: the default style with the colours sampled from the reference
    const { captions: CAP } = await loadShared();
    console.log(`[e2e] sampled ${JSON.stringify(sampled)} note ${r.captionNote}`);
    expect(sampled?.highlight).toMatch(/^#[0-9A-F]{6}$/i);
    expect(r.captionNote).toBe(NOTE_AI_FAILED);
    const style = r.captionStyle;
    expect(style.highlight.color).toBe(sampled.highlight.toUpperCase());
    const words = JSON.parse(readFileSync(store.file(ORIG, 'words.json'), 'utf8'));
    expect(words.length).toBeGreaterThan(5);
    const lines = CAP.group(words, style);
    console.log(`[e2e] ${words.length} words, ${lines.length} lines; first: ${lines.slice(0, 3).map((l: any) => `${l.start}-${l.end} ${l.words.map((w: any) => w.t).join(' ')}`).join(' | ')}`);

    // ---- 4. browser + exports. Three variants decompose the parity floor; the spec's bar applies to each:
    //   a) identity look (HLG→709 only), no captions: the proxy path (720p, crf 23) vs the 10-bit source, plus decode
    //   b) the look (grade, strength, tweaks), no captions: adds shader vs baked LUT
    //   c) full: look and captions (the spec's comparison)
    const extra: Record<string, [string, string]> = {};
    server = await serve(store, extra);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await launchChromium(['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']);
    const exporter = new ExportService(model as any, store, jobs);
    exporter.renderer = pageCaptions(browser, url);
    const IDENTITY = { lut: null, strength: 1, exposure: 0, temp: 0, sat: 0 };
    const variants = [
      { name: 'a-identity-nocaptions', look: IDENTITY, lines: [] as any[] },
      { name: 'b-look-nocaptions', look: LOOK, lines: [] as any[] },
      { name: 'c-full', look: LOOK, lines },
    ];
    const page = await openPage(browser, url);
    const frames = join(work, 'frames');
    await fs.mkdir(frames, { recursive: true });
    /** Both sides go through this one call: full-size RGB PNG → 360 px wide, area filter (no YUV step) */
    const shrink = (src: string, dst: string) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `scale=${PREVIEW_W}:-2:flags=area`, '-pix_fmt', 'rgb24', dst]);
    /** One export frame at full size, accurate seek, decoded with accurate rounding (see the header) */
    const extract = (mp4: string, t: number, dst: string) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', mp4, '-ss', String(t), '-frames:v', '1', '-vf', 'scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int', '-pix_fmt', 'rgb24', dst]);
    const table: Record<string, number[]> = {};
    let fullMp4 = '';
    for (const v of variants) {
      const req = validateExport({ designId: 'e2e', footage: { src: ORIG, look: v.look, captions: { style, lines: v.lines } }, w: W, h: H, fps: FPS, limitMs: LIMIT_MS }, { allowLimit: true });
      const t1 = Date.now();
      const { jobId } = await exporter.start(req);
      await exporter.idle();
      const st = await exporter.status(jobId);
      expect(st?.error).toBeUndefined();
      expect(st?.state).toBe('done');
      const mp4 = store.file(ORIG, `exports/${jobId}.mp4`);
      console.log(`[e2e] export ${v.name} ${Math.round((Date.now() - t1) / 1000)} s → ${mp4}`);
      const dur = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4])).stdout);
      expect(dur).toBeGreaterThan(9.9); expect(dur).toBeLessThan(10.2);
      if (v.name === 'c-full') fullMp4 = mp4;

      // ---- 5. preview frames at the export size (canvas 1080 × 1920, captions drawn at 1080 like the export's overlay).
      // Frame k = t·fps of the export starts at t; the preview seeks half a frame later so the browser shows the proxy
      // frame at t, not the one before it on a boundary tie.
      const pv: any = await page.evaluate((x: any) => (window as any).preview(x), { out: { w: W, h: H, fps: FPS }, look: v.look, captions: { style, lines: v.lines }, cssW: W, times: TIMES.map((t) => t * 1000 + 500 / FPS) } as any);
      if (v.name === 'a-identity-nocaptions') console.log(`[e2e] WebGL renderer: ${pv.renderer}`);
      table[v.name] = [];
      for (let k = 0; k < TIMES.length; k++) {
        const t = TIMES[k], shot = pv.shots[k];
        expect([shot.w, shot.h]).toEqual([W, H]);
        expect(shot.mediaTime).toBeCloseTo(t, 1);
        const pFull = join(frames, `${v.name}-preview-${t}s-full.png`), eFull = join(frames, `${v.name}-export-${t}s-full.png`);
        const p = join(frames, `${v.name}-preview-${t}s.png`), e = join(frames, `${v.name}-export-${t}s.png`);
        writeFileSync(pFull, Buffer.from(shot.png.split(',')[1], 'base64'));
        await extract(mp4, t, eFull);
        await shrink(pFull, p); await shrink(eFull, e);
        table[v.name].push((await deltaE([p, e])).mean);
      }
      console.log(`[e2e] ΔE2000 ${v.name} at ${TIMES.join(', ')} s: ${JSON.stringify(table[v.name])}`);
    }
    for (const v of variants) table[v.name].forEach((dE, k) => expect(dE, `${v.name} frame at ${TIMES[k]} s`).toBeLessThan(2));

    // ---- 6. decoder check: the full export decoded by Chromium (the preview's decoder) vs the accurate ffmpeg decode
    extra['/export.mp4'] = [fullMp4, 'video/mp4'];
    const DEC_T = 5;
    const dec: any = await page.evaluate((src: string, ms: number) => (window as any).decodeFrame(src, ms), '/export.mp4', DEC_T * 1000 + 500 / FPS);
    expect(dec.mediaTime).toBeCloseTo(DEC_T, 1);
    const cFull = join(frames, `chromium-decode-${DEC_T}s-full.png`), c360 = join(frames, `chromium-decode-${DEC_T}s.png`);
    writeFileSync(cFull, Buffer.from(dec.png.split(',')[1], 'base64'));
    await shrink(cFull, c360);
    const decDE = (await deltaE([c360, join(frames, `c-full-export-${DEC_T}s.png`)])).mean;
    console.log(`[e2e] export decoded by Chromium vs accurate ffmpeg at ${DEC_T} s: ΔE ${decDE}`);
    expect(decDE).toBeLessThan(0.5);

    // ---- 7. the highlight box is in the export's caption band
    const y0 = Math.max(0, style.y - 1.5 * style.size), y1 = Math.min(1, style.y + 1.5 * style.size);
    const near: number[] = [];
    for (const t of TIMES) near.push((await deltaE(['--near', join(frames, `c-full-export-${t}s.png`), style.highlight.color, String(y0), String(y1)])).near);
    console.log(`[e2e] highlight ${style.highlight.color}, band ${y0.toFixed(3)}..${y1.toFixed(3)}, fraction within ΔE 10 per frame ${JSON.stringify(near)}`);
    expect(Math.max(...near)).toBeGreaterThanOrEqual(0.003);
  }, 15 * 60_000);
});
