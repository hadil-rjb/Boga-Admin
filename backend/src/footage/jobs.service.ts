import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ChildProcess, spawn } from "child_process";
import { existsSync, promises as fs } from "fs";
import { join, resolve } from "path";
import { randomBytes } from "crypto";
import { Model } from "mongoose";
import { buildFramesArgs, buildProxyArgs, parseProbe, parseProgress, Probe } from "./ffmpeg";
import { planRecovery, Step } from "./footage.recovery";
import { Footage, FootageDocument } from "./footage.schema";
import { FootageStore } from "./footage.store";

export type { Step } from "./footage.recovery";

export const PQ_UNSUPPORTED = "HDR10 footage is not supported yet. Record in HLG or SDR, or convert it first.";
/** Steps implemented so far, in order. Later tasks append transcribe / grade / caption-style. */
const CHAIN: Step[] = ["probe", "proxy", "frames"];
const FATAL: Step[] = ["probe", "proxy"];

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
      else fail(new Error(err.trim() || `${cmd} exited with code ${code}`));
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

  constructor(@InjectModel(Footage.name) private model: Model<FootageDocument>, private store: FootageStore) {}

  get cube(): string { return join(this.store.root, HLG_CUBE_NAME); }

  onModuleDestroy() { for (const c of this.children) c.kill("SIGKILL"); }

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
    for (const r of plan.requeue) await this.enqueue(r.id, r.step);
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

  /** Runs pending steps lowest pipeline position first; a finished step requests the next one. Exits only when nothing is pending, checked synchronously. */
  private async drain(id: string) {
    const pending = this.pending.get(id)!;
    let failed = false;
    for (;;) {
      const step = CHAIN.find((s) => pending.has(s));
      if (!step) {
        if (!failed) await this.set(id, { status: "ready" }); // Task 7 extends the chain and this rule
        if (CHAIN.some((s) => pending.has(s))) continue; // requested while we were saving
        this.running.delete(id); this.pending.delete(id); // same tick as the check above: a concurrent request() either saw us running (and is in `pending`, handled above) or starts a new runner
        return;
      }
      pending.delete(step);
      await this.set(id, { [`jobs.${step}`]: { state: "running", progress: 0 }, ...(step === "probe" ? { status: "processing" } : {}) });
      if (FATAL.includes(step)) failed = false;
      try {
        await this.runStep(id, step);
        await this.set(id, { [`jobs.${step}`]: { state: "done", progress: 1 } });
        const next = CHAIN[CHAIN.indexOf(step) + 1];
        if (next && !pending.has(next)) { pending.add(next); await this.set(id, { [`jobs.${next}`]: { state: "queued", progress: 0 } }); }
      } catch (e: any) {
        const error = String(e?.message ?? e).slice(-600);
        this.log.warn(`${step} failed for ${id}: ${error}`);
        await this.set(id, { [`jobs.${step}`]: { state: "failed", progress: 0, error }, ...(FATAL.includes(step) ? { status: "failed", error } : {}) });
        if (FATAL.includes(step)) { failed = true; pending.clear(); continue; }
        const next = CHAIN[CHAIN.indexOf(step) + 1];
        if (next) pending.add(next);
      }
    }
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

  private async runStep(id: string, step: Step) {
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
    }
  }
}
