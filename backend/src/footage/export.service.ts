import { Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ChildProcess } from "child_process";
import { createHash, randomBytes } from "crypto";
import { existsSync, promises as fs } from "fs";
import { join } from "path";
import { Model } from "mongoose";
import type { Browser, Page } from "puppeteer-core";
import type { MediaDocument } from "../media/media.schema";
import { launchChromium } from "../social/publishing/headless";
import { buildExportArgs, ExportMusic, parseProgress, Probe } from "./ffmpeg";
import { Footage, FootageDocument } from "./footage.schema";
import { signFile } from "./footage.sign";
import { FootageStore } from "./footage.store";
import { JobsService, runProcess, Runner, STEP_TIMEOUT } from "./jobs.service";
import { loadShared } from "./shared";

/* ============================================================
   Export: the footage design as an H.264 MP4 that matches the editor's preview.
   - one 3D LUT, export.cube = bakeExport(HLG→709 when the source is HLG ∘ matched grade at strength ∘ tweaks), 33³;
   - the subtitles drawn by the studio's own captions.js in headless Chromium (render page, ?mode=captions), one PNG per
     change of the overlay (captions.changeTimes), joined by a concat list; caption-free stretches share one transparent PNG;
   - ffmpeg (buildExportArgs) crops like the preview, applies the LUT and overlays the PNGs.

   Concurrency: at most 2 exports run at once (MAX_ACTIVE: each holds a Chromium page, an overlay folder on disk and, later,
   an encode). A third waits in `queued` until one of them ends. The encode itself also takes the pipeline's global ffmpeg
   lock (JobsService.withFfmpeg), so only one ffmpeg process runs on the machine at any time: while export A encodes, export B
   can render its overlay and then waits for the lock; pipeline steps (proxy, frames, …) queue on the same lock.

   Jobs: kept in memory while the server runs, and mirrored on the footage record (`exports.<jobId>` = { hash, state, at,
   error? }) so a poll after completion, or after a restart, still finds the file, and an identical request (same hash)
   returns the finished export at once. A job persisted as queued or running that is not in memory was cut by a restart:
   it reads as failed.
   ============================================================ */

export const MAX_ACTIVE = 2;
/** Overlay times per round trip to the page */
export const BATCH = 50;
/** Finished exports kept per footage (older files are deleted) */
export const KEEP = 5;
const RENDER_TIMEOUT_MS = 120_000;
export const INTERRUPTED = "This export was interrupted. Export again.";

export type Word = { t: string; s: number; e: number };
export type Line = { id?: string; start: number; end: number; words: Word[] };
export type ExportLook = { lut: string | null; strength: number; exposure: number; temp: number; sat: number };
/** The sound: the original's volume (0 mutes it) and an optional music bed (a hosted audio file, /api/media/<id>) */
export type ExportAudio = { vol: number; music: { mediaId: string; vol: number; duck: boolean } | null };
/** Loads a hosted audio file's bytes (null when it does not exist or is not audio) */
export type MusicSource = (mediaId: string) => Promise<{ data: Buffer; mime: string } | null>;
export const MUSIC_GONE = "The music file was not found. Choose the music again.";
export type ExportRequest = {
  designId: string;
  src: string;
  look: ExportLook;
  captions: { style: Record<string, any> | null; lines: Line[] };
  audio: ExportAudio;
  w: number; h: number; fps: 24 | 25 | 30 | 60;
  /** test only (never accepted in production): export the first limitMs of the clip */
  limitMs?: number;
};
export type JobState = "queued" | "running" | "done" | "failed";
export type ExportStatus = { state: JobState; progress: number; url?: string; error?: string };

/** A request the client should fix (the controller turns it into a 400) */
export class ExportInvalid extends Error {}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, what: string) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new ExportInvalid(`${what} must be a number from ${lo} to ${hi}`);
  return v;
};
const ms = (v: unknown, what: string) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 24 * 3600_000) throw new ExportInvalid(`${what} must be a time in milliseconds`);
  return Math.round(v);
};
const evenSize = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) < 240 || (v as number) > 3840 || (v as number) % 2) throw new ExportInvalid(`${what} must be an even number of pixels from 240 to 3840`);
  return v as number;
};

/**
 * The export request, shape-checked and copied (nothing unknown passes through): src a 24-hex id, look.lut null or
 * footage/<24hex>/look.cube or looks/<id>.cube, strength 0..1, tweaks −1..1, at most 5000 lines of at most 60 words of at
 * most 200 characters, numeric ms, a style object of at most 8 KB, w/h even 240..3840, fps 24|25|30|60, audio.vol 0..1
 * (default 1), audio.music null or { mediaId 24-hex, vol 0..1 (0.6), duck boolean (true) }.
 */
export function validateExport(body: any, { allowLimit = false } = {}): ExportRequest {
  if (!isObj(body)) throw new ExportInvalid("Expected a JSON body");
  const designId = String(body.designId ?? "");
  if (!/^[\w-]{1,64}$/.test(designId)) throw new ExportInvalid("Invalid design id");
  const ft = body.footage;
  if (!isObj(ft)) throw new ExportInvalid("Missing footage");
  const src = String(ft.src ?? "");
  if (!/^[0-9a-f]{24}$/.test(src)) throw new ExportInvalid("Invalid footage id");
  const L = isObj(ft.look) ? ft.look : {};
  const lut = L.lut == null ? null : String(L.lut);
  if (lut !== null && !/^footage\/[0-9a-f]{24}\/look\.cube$/.test(lut) && !/^looks\/[\w-]{1,64}\.cube$/.test(lut)) throw new ExportInvalid("Invalid colour grade");
  const look: ExportLook = {
    lut,
    strength: L.strength == null ? 1 : num(L.strength, 0, 1, "Strength"),
    exposure: L.exposure == null ? 0 : num(L.exposure, -1, 1, "Exposure"),
    temp: L.temp == null ? 0 : num(L.temp, -1, 1, "Temperature"),
    sat: L.sat == null ? 0 : num(L.sat, -1, 1, "Saturation"),
  };
  const C = isObj(ft.captions) ? ft.captions : {};
  const rawLines = C.lines == null ? [] : C.lines;
  if (!Array.isArray(rawLines)) throw new ExportInvalid("Subtitles must be a list");
  if (rawLines.length > 5000) throw new ExportInvalid("Too many subtitle lines (5000 at most)");
  const lines: Line[] = rawLines.map((l: any, i: number) => {
    if (!isObj(l) || !Array.isArray(l.words)) throw new ExportInvalid(`Subtitle ${i + 1} is malformed`);
    if (l.words.length > 60) throw new ExportInvalid(`Subtitle ${i + 1} has more than 60 words`);
    const words = l.words.map((w: any) => {
      if (!isObj(w) || typeof w.t !== "string" || w.t.length > 200) throw new ExportInvalid(`Subtitle ${i + 1} has a malformed word`);
      return { t: w.t, s: ms(w.s, "A word start"), e: ms(w.e, "A word end") };
    });
    return { ...(typeof l.id === "string" ? { id: l.id.slice(0, 64) } : {}), start: ms(l.start, "A subtitle start"), end: ms(l.end, "A subtitle end"), words };
  });
  let style: Record<string, any> | null = null;
  if (C.style != null) {
    if (!isObj(C.style) || JSON.stringify(C.style).length > 8192) throw new ExportInvalid("Invalid subtitle style");
    style = JSON.parse(JSON.stringify(C.style));
  }
  const audio = validateAudio(ft.audio);
  const w = evenSize(body.w, "Width"), h = evenSize(body.h, "Height");
  if (![24, 25, 30, 60].includes(body.fps)) throw new ExportInvalid("Frame rate must be 24, 25, 30 or 60");
  const out: ExportRequest = { designId, src, look, captions: { style, lines }, audio, w, h, fps: body.fps };
  if (body.limitMs != null) {
    if (!allowLimit) throw new ExportInvalid("limitMs is not accepted");
    out.limitMs = Math.max(1000, ms(body.limitMs, "limitMs"));
  }
  return out;
}

function validateAudio(a: unknown): ExportAudio {
  if (a == null) return { vol: 1, music: null };
  if (!isObj(a)) throw new ExportInvalid("Invalid audio");
  const vol = a.vol == null ? 1 : num(a.vol, 0, 1, "The original sound volume");
  if (a.music == null) return { vol, music: null };
  const m = a.music;
  if (!isObj(m) || typeof m.mediaId !== "string" || !/^[0-9a-f]{24}$/.test(m.mediaId)) throw new ExportInvalid("Invalid music");
  if (m.duck != null && typeof m.duck !== "boolean") throw new ExportInvalid("Invalid music");
  return { vol, music: { mediaId: m.mediaId, vol: m.vol == null ? 0.6 : num(m.vol, 0, 1, "The music volume"), duck: m.duck !== false } };
}
const defaultAudio = (a: ExportAudio | undefined) => !a || (a.vol === 1 && !a.music);

/** Bump whenever the encode changes its output for the same request (filters, timing, codec settings): old exports are not reused */
export const EXPORT_PIPELINE_VERSION = 2;

/**
 * SHA-1 of what the MP4 depends on: src, look, captions, out size, the grade cube's digest (a re-matched grade is not
 * served stale), the audio (only when it is not the default, so earlier exports keep their hash) and the pipeline version.
 * Line ids are left out: they do not change a pixel.
 */
export function exportHash(r: ExportRequest, cubeDigest: string | null, version: number = EXPORT_PIPELINE_VERSION): string {
  const out = { w: r.w, h: r.h, fps: r.fps, ...(r.limitMs ? { limitMs: r.limitMs } : {}) };
  const captions = { style: r.captions.style, lines: r.captions.lines.map(({ start, end, words }) => ({ start, end, words })) };
  const audio = defaultAudio(r.audio) ? {} : { audio: r.audio };
  return createHash("sha1").update(JSON.stringify({ v: version, src: r.src, look: r.look, captions, out, cube: cubeDigest, ...audio })).digest("hex");
}

/**
 * The overlay as segments: one per change time, merged while there is no subtitle (one shared blank PNG). `shows(t)` says
 * whether a subtitle is drawn at t. Durations (ms) sum to durMs.
 */
export function overlayPlan(times: number[], shows: (t: number) => boolean, durMs: number): { t: number; dur: number; blank: boolean }[] {
  const ts = [...new Set(times.filter((t) => t >= 0 && t < durMs).map(Math.round))].sort((a, b) => a - b);
  if (ts[0] !== 0) ts.unshift(0);
  const out: { t: number; dur: number; blank: boolean }[] = [];
  ts.forEach((t, k) => {
    const dur = (k + 1 < ts.length ? ts[k + 1] : durMs) - t, blank = !shows(t);
    const prev = out[out.length - 1];
    if (blank && prev?.blank) prev.dur += dur; else out.push({ t, dur, blank });
  });
  return out;
}

/**
 * ffconcat text: file/duration pairs (seconds), the last file repeated so its duration is honoured (concat demuxer rule).
 * `option framerate 1000` on every file: the concat demuxer takes the PNG stream's time base from image2, whose default
 * framerate (25) would snap every change to a 40 ms grid and drop segments shorter than that (the 33 ms animation steps).
 * At 1000 the time base is 1/1000 and each change keeps its exact ms.
 */
export function concatText(entries: { file: string; dur: number }[]): string {
  const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
  const file = (f: string) => `file ${q(f)}\noption framerate 1000\n`;
  const body = entries.map((e) => `${file(e.file)}duration ${(e.dur / 1000).toFixed(6)}\n`).join("");
  return `ffconcat version 1.0\n${body}${entries.length ? file(entries[entries.length - 1].file) : ""}`;
}

/** Draws subtitle frames: one session per export (a page), draw() returns a PNG data URL per time */
export interface CaptionSession { draw(lines: Line[], style: Record<string, any> | null, w: number, h: number, times: number[]): Promise<string[]>; close(): Promise<void> }
export interface CaptionRenderer { open(): Promise<CaptionSession>; stop?(): Promise<void> }

/** The studio's render page in headless Chromium (?mode=captions): window.bogaCaptions(lines, style, w, h, times) */
export class ChromiumCaptions implements CaptionRenderer {
  private browser: Promise<Browser> | null = null;
  private open_ = 0;
  private idle?: NodeJS.Timeout;
  private get url() {
    return (process.env.STUDIO_RENDER_URL || process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "") + "/social-media/render?mode=captions";
  }
  private launch() {
    if (!this.browser) {
      this.browser = launchChromium().then((b) => { b.on("disconnected", () => { this.browser = null; }); return b; }).catch((e) => { this.browser = null; throw e; });
    }
    return this.browser;
  }
  async open(): Promise<CaptionSession> {
    if (this.idle) clearTimeout(this.idle);
    this.open_++;
    let page: Page | null = null;
    const errors: string[] = [];
    const release = async () => {
      await page?.close().catch(() => undefined); page = null;
      if (--this.open_ === 0) { this.idle = setTimeout(() => void this.stop(), 60_000); this.idle.unref?.(); }
    };
    try {
      page = await (await this.launch()).newPage();
      page.on("pageerror", (e) => errors.push(String((e as Error)?.message || e)));
      page.setDefaultTimeout(RENDER_TIMEOUT_MS);
      await page.goto(this.url, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
      await page.waitForFunction("typeof window.bogaCaptions === 'function'", { timeout: RENDER_TIMEOUT_MS });
    } catch (e: any) {
      await release();
      throw new Error(`The subtitle renderer did not start: ${e?.message || e}${errors.length ? ` (page: ${errors.slice(0, 2).join("; ")})` : ""}`);
    }
    const p = page!;
    let closed = false;
    return {
      draw: async (lines, style, w, h, times) => {
        const out = await Promise.race([
          p.evaluate((a: any, b: any, c: number, d: number, e: number[]) => (window as any).bogaCaptions(a, b, c, d, e), lines as any, style as any, w, h, times) as Promise<string[]>,
          new Promise<never>((_, no) => setTimeout(() => no(new Error("Drawing the subtitles timed out")), RENDER_TIMEOUT_MS)),
        ]);
        if (!Array.isArray(out) || out.length !== times.length) throw new Error(`The subtitle renderer returned ${Array.isArray(out) ? out.length : "no"} frames for ${times.length}${errors.length ? ` (page: ${errors[0]})` : ""}`);
        return out;
      },
      close: async () => { if (closed) return; closed = true; await release(); },
    };
  }
  async stop() {
    if (this.idle) clearTimeout(this.idle);
    const b = this.browser; this.browser = null;
    if (b) await (await b.catch(() => null))?.close().catch(() => undefined);
  }
}

const AUDIO_EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "audio/x-flac": "flac", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/webm": "webm" };
type Job = { id: string; footageId: string; hash: string; state: JobState; progress: number; error?: string };
const PNG_PREFIX = "data:image/png;base64,";
const pngOf = (dataUrl: string) => {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_PREFIX)) throw new Error("The subtitle renderer returned something other than a PNG");
  return Buffer.from(dataUrl.slice(PNG_PREFIX.length), "base64");
};

@Injectable()
export class ExportService implements OnModuleDestroy {
  private log = new Logger("FootageExport");
  readonly jobs = new Map<string, Job>();
  private children = new Set<ChildProcess>();
  private active = 0;
  private waiting: (() => void)[] = [];
  /** Replaceable in tests */
  runner: Runner = (cmd, args, o) => runProcess(cmd, args, o, this.children);
  renderer: CaptionRenderer = new ChromiumCaptions();
  /** The music bed's bytes (replaceable in tests): the hosted audio file, never anything else */
  music: MusicSource = async (id) => {
    if (!this.media) return null;
    const doc: any = await this.media.findById(id).select("+data").lean();
    if (!doc || !/^audio\//.test(String(doc.mime)) || !doc.data) return null;
    const data = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer ?? doc.data);
    return { data, mime: String(doc.mime) };
  };
  /** Test hook: every job's background run */
  readonly runs = new Map<string, Promise<void>>();

  constructor(
    @InjectModel(Footage.name) private model: Model<FootageDocument>,
    private store: FootageStore,
    private pipeline: JobsService,
    // "Media" (= Media.name): the schema class is not imported here, its decorators need metadata the test runner does not emit
    @Optional() @InjectModel("Media") private media?: Model<MediaDocument>,
  ) {}

  async onModuleDestroy() { for (const c of this.children) c.kill("SIGKILL"); await this.renderer.stop?.().catch(() => undefined); }

  /** The cube file a look path names (validated by validateExport), or null for none */
  lutFile(lut: string | null): string | null {
    if (!lut) return null;
    const m = /^footage\/([0-9a-f]{24})\/look\.cube$/.exec(lut);
    if (m) return this.store.file(m[1], "look.cube");
    const k = /^looks\/([\w-]{1,64})\.cube$/.exec(lut);
    if (k) return this.store.lookFile(k[1]);
    throw new ExportInvalid("Invalid colour grade");
  }

  /** Starts (or finds) the export; resolves as soon as the job exists. Throws ExportInvalid for a request that cannot run. */
  async start(r: ExportRequest): Promise<{ jobId: string; state: JobState }> {
    const rec: any = await this.model.findById(r.src).select("role status meta exports").lean();
    if (!rec || rec.role !== "original") throw new ExportInvalid("The video was not found");
    if (rec.status !== "ready" || !rec.meta?.dur) throw new ExportInvalid("The video is still being prepared");
    const lutPath = this.lutFile(r.look.lut);
    const cubeText = lutPath ? await fs.readFile(lutPath, "utf8").catch(() => null) : null;
    if (lutPath && cubeText == null) throw new ExportInvalid(r.look.lut!.startsWith("looks/") ? "This brand look no longer exists" : "No colour grade yet");
    const hash = exportHash(r, cubeText == null ? null : createHash("sha1").update(cubeText).digest("hex"));
    // same request: the job in progress, or the finished file
    for (const j of this.jobs.values()) if (j.hash === hash && j.footageId === r.src && j.state !== "failed" && (j.state !== "done" || existsSync(this.out(j)))) return { jobId: j.id, state: j.state };
    for (const [id, e] of Object.entries((rec.exports ?? {}) as Record<string, any>)) {
      if (e?.hash === hash && e.state === "done" && /^[0-9a-f]{24}$/.test(id) && existsSync(this.store.file(r.src, `exports/${id}.mp4`))) return { jobId: id, state: "done" };
    }
    const job: Job = { id: randomBytes(12).toString("hex"), footageId: r.src, hash, state: "queued", progress: 0 };
    this.jobs.set(job.id, job);
    await this.persist(job, { at: new Date().toISOString() });
    const run = this.slot(() => this.run(job, r, rec.meta as Probe, cubeText)).catch((e) => this.log.error(`export ${job.id}: ${e?.message ?? e}`));
    this.runs.set(job.id, run);
    run.finally(() => this.runs.delete(job.id));
    return { jobId: job.id, state: job.state };
  }

  /** The job's state, from memory, else from the footage record (null when unknown) */
  async status(jobId: string): Promise<ExportStatus | null> {
    if (!/^[0-9a-f]{24}$/.test(jobId)) return null;
    const j = this.jobs.get(jobId);
    if (j) return this.view(j.footageId, jobId, j.state, j.progress, j.error);
    const rec: any = await this.model.findOne({ [`exports.${jobId}`]: { $exists: true } }).select("_id exports").lean();
    const e = rec?.exports?.[jobId];
    if (!e) return null;
    const id = String(rec._id);
    if (e.state === "done" && existsSync(this.store.file(id, `exports/${jobId}.mp4`))) return this.view(id, jobId, "done", 1);
    return { state: "failed", progress: 0, error: e.state === "failed" ? e.error || "The export failed" : INTERRUPTED };
  }

  private view(footageId: string, jobId: string, state: JobState, progress: number, error?: string): ExportStatus {
    return { state, progress: Math.round(progress * 1000) / 1000, ...(state === "done" ? { url: signFile(footageId, `exports/${jobId}.mp4`) } : {}), ...(error ? { error } : {}) };
  }

  /** Test hook: resolves when every started job has ended */
  async idle() { while (this.runs.size) await Promise.all([...this.runs.values()]); }

  private out(j: { id: string; footageId: string }) { return this.store.file(j.footageId, `exports/${j.id}.mp4`); }

  private async persist(j: Job, extra: Record<string, any> = {}) {
    const cur = { hash: j.hash, state: j.state, ...(j.error ? { error: j.error } : {}) };
    const set: Record<string, any> = {};
    for (const [k, v] of Object.entries({ ...cur, ...extra })) set[`exports.${j.id}.${k}`] = v;
    await this.model.updateOne({ _id: j.footageId }, { $set: set }).catch((e) => this.log.warn(`export ${j.id}: could not save the state: ${e?.message ?? e}`));
  }

  /** At most MAX_ACTIVE exports run at once; the others wait in order */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_ACTIVE) await new Promise<void>((ok) => this.waiting.push(ok));
    else this.active++;
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--; // the slot passes straight to the next job
    }
  }

  private async run(job: Job, r: ExportRequest, meta: Probe, cubeText: string | null) {
    const dir = this.store.dir(job.footageId), work = join(dir, "exports", `${job.id}.work`), ov = join(work, "overlay");
    const final = this.out(job), tmp = join(dir, "exports", `${job.id}.${randomBytes(6).toString("hex")}.tmp.mp4`);
    let lastSave = 0;
    const progress = (p: number) => {
      job.progress = Math.max(job.progress, Math.min(1, p));
      if (Date.now() - lastSave > 2000) { lastSave = Date.now(); this.persist(job).catch(() => undefined); }
    };
    job.state = "running"; await this.persist(job);
    let session: CaptionSession | null = null;
    try {
      await fs.mkdir(ov, { recursive: true });
      const { look: LOOK, captions: CAP } = await loadShared();
      // 1. the LUT
      let base = cubeText ? LOOK.parseCube(cubeText) : LOOK.identityCube(33);
      if (base.size !== 33) base = resample(LOOK, base, 33);
      let hlg = null;
      if (meta.hdr === "hlg") { await this.pipeline.ensureCube(); hlg = LOOK.parseCube(await fs.readFile(this.pipeline.cube, "utf8")); }
      const baked = LOOK.bakeExport({ look: base, hlg, strength: r.look.lut ? r.look.strength : 0, tweaks: { exposure: r.look.exposure, temp: r.look.temp, sat: r.look.sat } });
      const cube = join(work, "export.cube");
      await fs.writeFile(cube, LOOK.writeCube(baked, "export"));
      // 2. the overlay: one PNG per change, a shared blank one where no subtitle shows
      const durMs = Math.round(Math.min(meta.dur * 1000, r.limitMs ?? Infinity));
      const lines = r.captions.lines, style = r.captions.style;
      const plan = overlayPlan(CAP.changeTimes(lines, style, durMs), (t) => !!CAP.lineAt(lines, t), durMs);
      const drawn = plan.filter((s) => !s.blank);
      session = await this.renderer.open();
      const blank = join(ov, "blank.png");
      await fs.writeFile(blank, pngOf((await session.draw([], style, r.w, r.h, [0]))[0]));
      const files = new Map<number, string>();
      for (let i = 0; i < drawn.length; i += BATCH) {
        const batch = drawn.slice(i, i + BATCH), t0 = batch[0].t, t1 = batch[batch.length - 1].t;
        const near = lines.filter((l) => l.end > t0 && l.start <= t1); // only the lines this batch can show
        const urls = await session.draw(near, style, r.w, r.h, batch.map((s) => s.t));
        for (let k = 0; k < batch.length; k++) {
          const f = join(ov, `${String(i + k).padStart(5, "0")}.png`);
          await fs.writeFile(f, pngOf(urls[k]));
          files.set(batch[k].t, f);
        }
        progress(0.3 * Math.min(1, (i + batch.length) / Math.max(1, drawn.length)));
      }
      await session.close(); session = null;
      progress(0.3);
      const concat = join(work, "concat.txt");
      await fs.writeFile(concat, concatText(plan.map((s) => ({ file: s.blank ? blank : files.get(s.t)!, dur: s.dur }))));
      // 3. the music bed: its bytes in the work folder for the encode (removed with it)
      const audio = r.audio ?? { vol: 1, music: null };
      let music: ExportMusic | null = null;
      if (audio.music) {
        const m = await this.music(audio.music.mediaId);
        if (!m) throw new Error(MUSIC_GONE);
        const path = join(work, `music.${AUDIO_EXT[m.mime.split(";")[0]] ?? "bin"}`);
        await fs.writeFile(path, m.data);
        music = { path, vol: audio.music.vol, duck: audio.music.duck };
      }
      // 4. the encode, under the global ffmpeg lock
      const args = buildExportArgs({ src: await this.sourcePath(job.footageId), probe: meta, cube, concat, out: tmp, w: r.w, h: r.h, fps: r.fps, ...(r.limitMs ? { limitSec: durMs / 1000 } : {}), vol: audio.vol, music });
      const onLine = (line: string) => { const p = parseProgress(line, durMs); if (p !== null) progress(0.3 + 0.7 * p); };
      await this.pipeline.withFfmpeg(() => this.runner("ffmpeg", args, { onLine, timeoutMs: STEP_TIMEOUT.media(durMs / 1000) }));
      await fs.rename(tmp, final);
      job.state = "done"; job.progress = 1;
      await this.persist(job, { at: new Date().toISOString() });
      await this.prune(job.footageId).catch((e) => this.log.warn(`prune ${job.footageId}: ${e?.message ?? e}`));
    } catch (e: any) {
      job.state = "failed"; job.error = String(e?.message ?? e).slice(-600);
      this.log.warn(`export ${job.id} failed: ${job.error}`);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      await this.persist(job);
    } finally {
      if (session) await session.close().catch(() => undefined);
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async sourcePath(id: string): Promise<string> {
    const name = (await fs.readdir(this.store.dir(id))).find((n) => /^source\.[a-z0-9]+$/i.test(n));
    if (!name) throw new Error("The uploaded video file is missing");
    return join(this.store.dir(id), name);
  }

  /** Keeps the KEEP most recent finished exports of a footage; older files and entries go */
  private async prune(footageId: string) {
    const rec: any = await this.model.findById(footageId).select("exports").lean();
    const done = Object.entries((rec?.exports ?? {}) as Record<string, any>).filter(([id, e]) => e?.state === "done" && /^[0-9a-f]{24}$/.test(id)).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
    const old = done.slice(KEEP).map(([id]) => id).filter((id) => !this.jobs.has(id) || this.jobs.get(id)!.state === "done");
    if (!old.length) return;
    for (const id of old) { await fs.rm(this.store.file(footageId, `exports/${id}.mp4`), { force: true }); this.jobs.delete(id); }
    await this.model.updateOne({ _id: footageId }, { $unset: Object.fromEntries(old.map((id) => [`exports.${id}`, ""])) });
  }
}

/** A cube resampled to n³ (trilinear), so export.cube is always 33³ */
function resample(LOOK: any, lut: { size: number; data: Float32Array }, n: number) {
  const id = LOOK.identityCube(n), data = new Float32Array(id.data.length);
  for (let i = 0; i < id.data.length; i += 3) data.set(LOOK.sampleCube(lut, [id.data[i], id.data[i + 1], id.data[i + 2]]), i);
  return { size: n, data };
}
