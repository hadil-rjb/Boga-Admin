import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ChildProcess, spawn } from "child_process";
import { existsSync, promises as fs } from "fs";
import { join, resolve } from "path";
import { randomBytes } from "crypto";
import { Model } from "mongoose";
import { PyWorker } from "../ai/local-tts.service";
import { CaptionAi, FOOTAGE_AI, mergeStyle, NoAnthropicKey, NOTE_AI_FAILED, NOTE_NO_KEY, NOTE_NO_TEXT, NOTE_UNREADABLE } from "./caption-style";
import { loadShared } from "./shared";
import { buildCaptionCropArgs, buildFramesArgs, buildProxyArgs, parseProbe, parseProgress, Probe } from "./ffmpeg";
import { planRecovery, Step } from "./footage.recovery";
import { Footage, FootageDocument } from "./footage.schema";
import { FootageStore } from "./footage.store";

export type { Step } from "./footage.recovery";

export const PQ_UNSUPPORTED = "HDR10 footage is not supported yet. Record in HLG or SDR, or convert it first.";
/** Pipeline order */
const CHAIN: Step[] = ["probe", "proxy", "frames", "transcribe", "grade", "caption-style"];
/** Steps that follow each other automatically after probe. transcribe and grade are requested by the pair endpoint (originals only); caption-style follows frames of a reference only. */
const AUTO: Step[] = ["probe", "proxy", "frames", "caption-style"];
/** The step that follows automatically; none after frames, and none for steps outside the auto chain */
const autoNext = (s: Step): Step | undefined => (AUTO.includes(s) ? AUTO[AUTO.indexOf(s) + 1] : undefined);
const FATAL: Step[] = ["probe", "proxy"];
const NOT_DONE = ["queued", "running"];
/** Thrown by a step that has to wait for another footage; the step stays queued and is requested again when that footage is ready */
class Wait extends Error {}
export const REF_UNREADABLE = "The reference video could not be read";
export const LOOK_MISSING = "This brand look no longer exists";
export type Word = { t: string; s: number; e: number; p: number };

/** Whisper words: stripped text, integer ms, never empty, starts and ends increasing */
export function normalizeWords(raw: any[]): Word[] {
  const out: Word[] = []; let prev = 0;
  for (const w of Array.isArray(raw) ? raw : []) {
    const t = String(w?.t ?? "").trim();
    if (!t) continue;
    const s = Math.max(Math.round(Number(w.s) || 0), prev), e = Math.max(Math.round(Number(w.e) || 0), s);
    out.push({ t, s, e, p: Math.round((Number(w.p) || 0) * 1000) / 1000 });
    prev = s;
  }
  return out;
}

/** grade.py reports failures as a JSON line on stdout: {"ok": false, "error": "..."} */
const jsonError = (out: string): string => { try { return String(JSON.parse(out.trim().split("\n").pop() ?? "").error ?? ""); } catch { return ""; } };

export type RunOpts = { onLine?: (line: string) => void; timeoutMs?: number };
export type Runner = (cmd: string, args: string[], opts?: RunOpts) => Promise<{ stdout: string; stderr: string }>;

/**
 * Runs a program without a shell. Resolves with stdout/stderr tail; rejects with the stderr tail on a non-zero exit.
 * After timeoutMs the child gets SIGTERM, then SIGKILL 5 s later, and the promise rejects with a timeout message.
 * Live children are added to `live` so the module can kill them on shutdown.
 */
export function runProcess(cmd: string, args: string[], opts: RunOpts = {}, live: Set<ChildProcess> = new Set()): Promise<{ stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    live.add(p);
    let out = "", err = "", buf = "", timedOut = false, kill: NodeJS.Timeout | undefined;
    const timer = opts.timeoutMs ? setTimeout(() => {
      timedOut = true;
      p.kill("SIGTERM");
      kill = setTimeout(() => p.kill("SIGKILL"), 5000);
    }, opts.timeoutMs) : undefined;
    const done = () => { live.delete(p); if (timer) clearTimeout(timer); if (kill) clearTimeout(kill); };
    p.stdout.on("data", (d) => {
      const s = String(d);
      if (opts.onLine) { buf += s; const lines = buf.split("\n"); buf = lines.pop() ?? ""; lines.forEach(opts.onLine); }
      else out += s;
    });
    p.stderr.on("data", (d) => { err = (err + d).slice(-600); });
    p.on("error", (e) => { done(); fail(new Error(`${cmd}: ${e.message}`)); });
    p.on("close", (code) => {
      done();
      if (timedOut) fail(new Error(`${cmd} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)} s and was stopped`));
      else if (code === 0) ok({ stdout: out, stderr: err });
      else fail(new Error(err.trim() || jsonError(out) || `${cmd} exited with code ${code}`));
    });
  });
}

/** Per-step time limits: probe 60 s, python 120 s, proxy and frames 4 x duration + 5 min */
export const STEP_TIMEOUT = { probe: 60_000, python: 120_000, media: (durSec: number) => 4 * durSec * 1000 + 5 * 60_000 };

/**
 * The HLG LUT file name carries the SDR peak it was built for (color.SDR_PEAK_NITS), so a cube generated with an older
 * mapping is never picked up: change both together.
 */
export const HLG_SDR_PEAK_NITS = 300;
export const HLG_CUBE_NAME = `hlg2709-${HLG_SDR_PEAK_NITS}.cube`;

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger("FootageJobs");
  private running = new Map<string, Promise<void>>(); // one runner per footage
  private pending = new Map<string, Set<Step>>(); // steps requested for a footage, drained in pipeline order
  private children = new Set<ChildProcess>();
  /** Replaceable in tests */
  runner: Runner = (cmd, args, o) => runProcess(cmd, args, o, this.children);
  private ffmpegLock: Promise<void> = Promise.resolve(); // one ffmpeg process at a time overall
  private root = [process.cwd(), resolve(__dirname, "..", ".."), resolve(__dirname, "..", "..", "..")].find((d) => existsSync(join(d, "tts", "footage", "grade.py"))) ?? process.cwd();
  private python = process.env.TTS_PYTHON || join(this.root, ".tts", "venv", "bin", "python");
  private whisperWorker?: PyWorker;
  /** Shared, lazily started, stopped after 10 minutes without a request. Replaceable in tests. */
  whisper: { ask(req: Record<string, unknown>, timeoutMs?: number): Promise<any>; stop?(): void } = {
    ask: (req, timeoutMs) => (this.whisperWorker ??= new PyWorker(this.log, "Transcription", this.python, join(this.root, "tts", "footage", "whisper_worker.py"),
      { HF_HOME: join(this.root, ".tts", "hf") }, 180_000, 600_000, 10 * 60_000)).ask(req, timeoutMs),
  };

  constructor(@InjectModel(Footage.name) private model: Model<FootageDocument>, private store: FootageStore, @Inject(FOOTAGE_AI) private ai: CaptionAi) {}

  get cube(): string { return join(this.store.root, HLG_CUBE_NAME); }

  onModuleDestroy() { for (const c of this.children) c.kill("SIGKILL"); this.whisperWorker?.stop(); }

  async onModuleInit() {
    await this.ensureCube().catch((e) => this.log.warn(`hlg2709.cube not generated: ${e?.message ?? e}`));
    await this.recover().catch((e) => this.log.warn(`recovery failed: ${e?.message ?? e}`));
  }

  /** HLG to Rec.709 3D LUT, generated once by grade.py */
  async ensureCube(): Promise<void> {
    if (existsSync(this.cube)) return;
    await fs.mkdir(this.store.root, { recursive: true });
    const tmp = `${this.cube}.${process.pid}.tmp`;
    await this.runner(this.python, [join(this.root, "tts", "footage", "grade.py"), "hlg2709", tmp], { timeoutMs: STEP_TIMEOUT.python });
    await fs.rename(tmp, this.cube);
  }

  /** After a crash: stale `assembling` goes back to uploading, interrupted steps are re-enqueued */
  async recover(now = Date.now()): Promise<void> {
    const recs = await this.model.find({ status: { $in: ["assembling", "processing"] } }).select("_id status jobs updatedAt").lean();
    const plan = planRecovery(recs as any, now);
    if (plan.reset.length) await this.model.updateMany({ _id: { $in: plan.reset }, status: "assembling" }, { $set: { status: "uploading" } });
    for (const r of plan.requeue) {
      await this.enqueue(r.id, r.step);
      // later requested steps (transcribe, grade) that were interrupted or still waiting
      const jobs = (recs as any[]).find((x) => String(x._id) === r.id)?.jobs ?? {};
      for (const s of CHAIN) if (s !== r.step && NOT_DONE.includes(jobs[s]?.state) && CHAIN.indexOf(s) > CHAIN.indexOf(r.step)) await this.enqueue(r.id, s);
    }
    if (plan.reset.length || plan.requeue.length) this.log.log(`recovered ${plan.reset.length} upload(s), re-queued ${plan.requeue.length} job(s)`);
  }

  /** Persists `queued` for the step, then runs it and the steps after it in the background */
  async enqueue(footageId: string, step: Step): Promise<void> {
    await this.model.updateOne({ _id: footageId }, { $set: { [`jobs.${step}`]: { state: "queued", progress: 0 } } });
    this.request(footageId, step);
  }

  /** Adds the step to the footage's pending set and starts its runner when there is none (synchronous: no race with the runner's exit) */
  private request(id: string, step: Step) {
    let set = this.pending.get(id);
    if (!set) this.pending.set(id, (set = new Set()));
    set.add(step);
    if (this.running.has(id)) return;
    const p = Promise.resolve().then(() => this.drain(id)).catch((e) => { this.log.error(`jobs ${id}: ${e?.message ?? e}`); this.running.delete(id); this.pending.delete(id); });
    this.running.set(id, p);
  }

  /** Test hook: resolves when the footage's runner has finished */
  async idle(footageId: string): Promise<void> { while (this.running.has(footageId)) await this.running.get(footageId); }

  private async set(id: string, fields: Record<string, any>) { await this.model.updateOne({ _id: id }, { $set: fields }); }

  /** True while some step is persisted queued/running although nothing is pending: a grade waiting for its reference */
  private async hasWaiting(id: string): Promise<boolean> {
    const doc = await this.model.findById(id).select("jobs").lean();
    return Object.values((doc?.jobs ?? {}) as Record<string, any>).some((j) => NOT_DONE.includes(j?.state));
  }

  /** True when the original's reference has stopped being a reason to wait (frames done or failed, footage failed, or record gone) */
  private async refSettled(id: string): Promise<boolean> {
    const doc: any = await this.model.findById(id).select("pair").lean();
    const ref = doc?.pair?.ref;
    if (!ref || !/^[0-9a-f]{24}$/.test(String(ref))) return true;
    const r: any = await this.model.findById(String(ref)).select("status jobs").lean();
    return !r || r.status === "failed" || ["done", "failed"].includes(r.jobs?.frames?.state);
  }

  /** The footage's own frames step ended (or the footage failed): originals paired with it that wait in `grade` look again */
  async wake(refId: string) {
    try {
      const rows = await this.model.find({ "pair.ref": refId }).select("_id jobs").lean();
      // running too: a grade between reading the reference and persisting `queued` must not be skipped (request into a live runner is harmless)
      for (const r of rows as any[]) if (NOT_DONE.includes(r.jobs?.grade?.state)) this.request(String(r._id), "grade");
    } catch (e: any) { this.log.warn(`wake ${refId}: ${e?.message ?? e}`); }
  }

  /** Runs pending steps lowest pipeline position first; a finished step requests the next one. Exits only when nothing is pending, checked synchronously. */
  private async drain(id: string) {
    const pending = this.pending.get(id)!;
    let failed = false;
    for (;;) {
      const step = CHAIN.find((s) => pending.has(s));
      if (!step) {
        if (!failed && !(await this.hasWaiting(id))) await this.set(id, { status: "ready" }); // every requested step is done, skipped or failed non-fatally
        if (CHAIN.some((s) => pending.has(s))) continue; // requested while we were saving
        this.running.delete(id); this.pending.delete(id); // same tick as the check above: a concurrent request() either saw us running (and is in `pending`, handled above) or starts a new runner
        return;
      }
      pending.delete(step);
      await this.set(id, { [`jobs.${step}`]: { state: "running", progress: 0 }, ...(step === "probe" ? { status: "processing" } : {}) });
      if (FATAL.includes(step)) failed = false;
      try {
        const outcome = await this.runStep(id, step);
        await this.set(id, { [`jobs.${step}`]: { state: outcome === "skipped" ? "skipped" : "done", progress: 1 } });
        const next = autoNext(step);
        if (next && !pending.has(next) && (next !== "caption-style" || await this.isReference(id))) { pending.add(next); await this.set(id, { [`jobs.${next}`]: { state: "queued", progress: 0 } }); }
      } catch (e: any) {
        if (e instanceof Wait) {
          await this.set(id, { [`jobs.${step}`]: { state: "queued", progress: 0 } });
          if (await this.refSettled(id)) pending.add(step); // the reference finished while we were persisting: no wake-up is coming
          continue;
        }
        const error = String(e?.message ?? e).slice(-600);
        this.log.warn(`${step} failed for ${id}: ${error}`);
        await this.set(id, { [`jobs.${step}`]: { state: "failed", progress: 0, error }, ...(FATAL.includes(step) ? { status: "failed", error } : {}) });
        if (FATAL.includes(step)) { failed = true; pending.clear(); await this.wake(id); continue; }
        // frames failed: there is nothing for caption-style to look at
      }
      if (step === "frames") await this.wake(id);
    }
  }

  private async isReference(id: string): Promise<boolean> {
    const doc: any = await this.model.findById(id).select("role").lean();
    return doc?.role === "reference";
  }

  private async sourcePath(id: string): Promise<string> {
    const name = (await fs.readdir(this.store.dir(id))).find((n) => /^source\.[a-z0-9]+$/i.test(n));
    if (!name) throw new Error("The uploaded video file is missing");
    return join(this.store.dir(id), name);
  }

  /** One ffmpeg at a time across all footage */
  private withFfmpeg<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.ffmpegLock.then(fn);
    this.ffmpegLock = result.then(() => undefined, () => undefined);
    return result;
  }

  private async metaOf(id: string): Promise<Probe> {
    const doc = await this.model.findById(id).select("meta").lean();
    if (!doc?.meta?.dur) throw new Error("Probe result is missing");
    return doc.meta as Probe;
  }

  private async runStep(id: string, step: Step): Promise<"skipped" | void> {
    const dir = this.store.dir(id);
    if (step === "probe") {
      const { stdout } = await this.runner("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", await this.sourcePath(id)], { timeoutMs: STEP_TIMEOUT.probe });
      const meta = parseProbe(JSON.parse(stdout));
      if (meta.hdr === "pq") throw new Error(PQ_UNSUPPORTED);
      if (!(meta.dur > 0)) throw new Error("Could not read the video duration");
      await this.set(id, { meta });
    } else if (step === "proxy") {
      const meta = await this.metaOf(id);
      if (meta.hdr === "hlg") await this.ensureCube();
      const out = this.store.file(id, "proxy.mp4"), tmp = join(dir, `proxy.${randomBytes(6).toString("hex")}.tmp.mp4`); // unique per run
      let last = 0, lastAt = 0;
      const onLine = (line: string) => {
        const pr = parseProgress(line, meta.dur * 1000);
        if (pr === null || Date.now() - lastAt < 1000 || pr - last < 0.02) return;
        last = pr; lastAt = Date.now();
        this.set(id, { "jobs.proxy.progress": pr }).catch(() => undefined);
      };
      try {
        await this.withFfmpeg(async () => this.runner("ffmpeg", buildProxyArgs(await this.sourcePath(id), tmp, meta, this.cube), { onLine, timeoutMs: STEP_TIMEOUT.media(meta.dur) }));
        await fs.rename(tmp, out);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
    } else if (step === "frames") {
      const meta = await this.metaOf(id), frames = join(dir, "frames");
      await fs.rm(frames, { recursive: true, force: true });
      await fs.mkdir(frames, { recursive: true });
      await this.withFfmpeg(() => this.runner("ffmpeg", buildFramesArgs(this.store.file(id, "proxy.mp4"), join(frames, "%03d.png"), meta.dur), { timeoutMs: STEP_TIMEOUT.media(meta.dur) }));
    } else if (step === "transcribe") {
      const doc = await this.model.findById(id).select("meta pair").lean();
      const meta = await this.metaOf(id);
      if (!meta.audio) return "skipped";
      const wav = join(dir, `audio.${randomBytes(6).toString("hex")}.tmp.wav`);
      try {
        await this.withFfmpeg(async () => this.runner("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", await this.sourcePath(id), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", wav], { timeoutMs: STEP_TIMEOUT.media(meta.dur) }));
        const lang = (doc as any)?.pair?.lang;
        const res = await this.whisper.ask({ audio: wav, ...(lang ? { lang } : {}) }, 2 * meta.dur * 1000 + 60_000);
        const words = normalizeWords(res?.words);
        const out = this.store.file(id, "words.json"), tmp = `${out}.${randomBytes(6).toString("hex")}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(words));
        await fs.rename(tmp, out);
      } finally {
        await fs.rm(wav, { force: true });
      }
    } else if (step === "grade") {
      const doc: any = await this.model.findById(id).select("pair jobs").lean();
      const pair = doc?.pair ?? {}, look = this.store.file(id, "look.cube"), stats = this.store.file(id, "stats.json");
      if (pair.ref) {
        if (doc?.jobs?.frames?.state !== "done") throw new Error("The video frames could not be read");
        const ref: any = /^[0-9a-f]{24}$/.test(String(pair.ref)) ? await this.model.findById(String(pair.ref)).select("status jobs").lean() : null;
        if (!ref || ref.status === "failed" || ref.jobs?.frames?.state === "failed") throw new Error(REF_UNREADABLE);
        if (ref.jobs?.frames?.state !== "done") throw new Wait(); // the reference's frames step wakes this one up
        try {
          await this.runner(this.python, [join(this.root, "tts", "footage", "grade.py"), "transfer", "--src", join(dir, "frames"), "--ref", join(this.store.dir(String(pair.ref)), "frames"), "--out", look, "--stats", stats], { timeoutMs: 600_000 });
        } catch (e) {
          await Promise.all([fs.rm(look, { force: true }), fs.rm(stats, { force: true })]);
          throw e;
        }
      } else if (pair.lookId && /^[\w-]{1,64}$/.test(String(pair.lookId))) {
        const src = join(this.store.root, "looks", `${pair.lookId}.cube`), tmp = `${look}.${randomBytes(6).toString("hex")}.tmp`;
        if (!existsSync(src)) throw new Error(LOOK_MISSING);
        try { await fs.copyFile(src, tmp); await fs.rename(tmp, look); } catch (e) { await fs.rm(tmp, { force: true }); throw e; }
      } else throw new Error("No reference video or brand look is set for this video");
    } else if (step === "caption-style") {
      await this.captionStyle(id);
    }
  }

  /** Finds the burned-in subtitles in the reference's frames, has Claude describe them and stores the merged style. Never fails the pipeline for a missing key or an unreadable answer. */
  private async captionStyle(id: string) {
    const dir = this.store.dir(id), meta = await this.metaOf(id);
    const { captions } = await loadShared();
    const defaults = captions.DEFAULT_STYLE;
    const store = (r: { style: any; note?: string }) => this.set(id, { captionStyle: r.style, captionNote: r.note ?? null });
    const unreadable = (why: string) => { this.log.warn(`caption style for ${id}: ${why}`); return store({ ...mergeStyle(null, {}, defaults), note: NOTE_UNREADABLE }); };
    let found: any;
    try {
      const { stdout } = await this.runner(this.python, [join(this.root, "tts", "footage", "grade.py"), "textframes", "--frames", join(dir, "frames"), "--keep", "6"], { timeoutMs: STEP_TIMEOUT.python });
      found = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    } catch (e: any) { return void (await unreadable(`textframes: ${e?.message ?? e}`)); }
    if (found?.ok !== true) return void (await unreadable(`textframes: ${found?.error ?? "not ok"}`));
    const names: string[] = Array.isArray(found.frames) ? found.frames.map(String) : [];
    if (!names.length) return void (await store({ ...mergeStyle(null, {}, defaults), note: NOTE_NO_TEXT }));
    const band = Array.isArray(found.band) ? found.band.map(Number) : [];
    if (band.length !== 2 || !band.every((v: number) => Number.isFinite(v) && v >= 0 && v <= 1) || !(band[0] < band[1])) return void (await unreadable(`textframes band: ${JSON.stringify(found.band)}`));
    const sampled = { text: found.colors?.text ?? null, highlight: found.colors?.highlight ?? null };
    // 256 px frames are too small for Claude to read the styling: full-resolution crops of the band come from the proxy
    const times = names.map((n) => (Math.max(0, (parseInt(n, 10) || 1) - 1) + 0.5) * meta.dur / 60);
    const tmp = join(dir, `caption.${randomBytes(6).toString("hex")}.tmp`);
    let result: { style: any; note?: string };
    try {
      await fs.mkdir(tmp, { recursive: true });
      await this.withFfmpeg(() => this.runner("ffmpeg", buildCaptionCropArgs(this.store.file(id, "proxy.mp4"), times, [band[0], band[1]], tmp), { timeoutMs: STEP_TIMEOUT.media(10) }));
      const images = await Promise.all(["full.jpg", ...times.map((_, k) => `c${k}.jpg`)].map(async (f) => ({ media: "image/jpeg", data: (await fs.readFile(join(tmp, f))).toString("base64") })));
      const doc: any = await this.model.findById(id).select("createdBy").lean();
      try {
        const r = await this.ai.captionStyle(images, sampled, { id: doc?.createdBy ?? null, name: "Footage" }, [band[0], band[1]]);
        result = mergeStyle(r.style, sampled, defaults);
      } catch (e: any) {
        this.log.warn(`caption style for ${id}: ${e?.message ?? e}`);
        result = e instanceof NoAnthropicKey ? { ...mergeStyle(null, {}, defaults), note: NOTE_NO_KEY } : { ...mergeStyle(null, sampled, defaults), note: NOTE_AI_FAILED };
      }
    } catch (e: any) {
      return void (await unreadable(`crops: ${e?.message ?? e}`));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    await store(result);
  }
}
