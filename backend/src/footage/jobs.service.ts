import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { spawn } from "child_process";
import { existsSync, promises as fs } from "fs";
import { join, resolve } from "path";
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

type RunOpts = { onLine?: (line: string) => void };
/** Runs a program without a shell; resolves with the tail of stderr, rejects with it on a non-zero exit */
function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", buf = "";
    p.stdout.on("data", (d) => {
      const s = String(d);
      if (opts.onLine) { buf += s; const lines = buf.split("\n"); buf = lines.pop() ?? ""; lines.forEach(opts.onLine); }
      else out += s;
    });
    p.stderr.on("data", (d) => { err = (err + d).slice(-600); });
    p.on("error", (e) => fail(new Error(`${cmd}: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? ok({ stdout: out, stderr: err }) : fail(new Error(err.trim() || `${cmd} exited with code ${code}`))));
  });
}

@Injectable()
export class JobsService implements OnModuleInit {
  private log = new Logger("FootageJobs");
  private running = new Map<string, Promise<void>>(); // one chain per footage
  private ffmpegLock: Promise<void> = Promise.resolve(); // one ffmpeg process at a time overall
  private root = [process.cwd(), resolve(__dirname, "..", ".."), resolve(__dirname, "..", "..", "..")].find((d) => existsSync(join(d, "tts", "footage", "grade.py"))) ?? process.cwd();
  private python = process.env.TTS_PYTHON || join(this.root, ".tts", "venv", "bin", "python");

  constructor(@InjectModel(Footage.name) private model: Model<FootageDocument>, private store: FootageStore) {}

  get cube(): string { return join(this.store.root, "hlg2709.cube"); }

  async onModuleInit() {
    await this.ensureCube().catch((e) => this.log.warn(`hlg2709.cube not generated: ${e?.message ?? e}`));
    await this.recover().catch((e) => this.log.warn(`recovery failed: ${e?.message ?? e}`));
  }

  /** HLG to Rec.709 3D LUT, generated once by grade.py */
  async ensureCube(): Promise<void> {
    if (existsSync(this.cube)) return;
    await fs.mkdir(this.store.root, { recursive: true });
    const tmp = `${this.cube}.${process.pid}.tmp`;
    await run(this.python, [join(this.root, "tts", "footage", "grade.py"), "hlg2709", tmp]);
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
    if (this.running.has(footageId)) return; // the running chain will pick the step up from the record
    const p = this.chain(footageId, step).catch((e) => this.log.error(`chain ${footageId}: ${e?.message ?? e}`)).finally(() => this.running.delete(footageId));
    this.running.set(footageId, p);
  }

  /** Test hook: resolves when the footage's chain has finished */
  idle(footageId: string): Promise<void> { return this.running.get(footageId) ?? Promise.resolve(); }

  private async set(id: string, fields: Record<string, any>) { await this.model.updateOne({ _id: id }, { $set: fields }); }

  private async chain(id: string, from: Step) {
    for (const step of CHAIN.slice(CHAIN.indexOf(from))) {
      await this.set(id, { [`jobs.${step}`]: { state: "running", progress: 0 }, ...(step === "probe" ? { status: "processing" } : {}) });
      try {
        await this.runStep(id, step);
        await this.set(id, { [`jobs.${step}`]: { state: "done", progress: 1 } });
      } catch (e: any) {
        const error = String(e?.message ?? e).slice(-600);
        this.log.warn(`${step} failed for ${id}: ${error}`);
        await this.set(id, { [`jobs.${step}`]: { state: "failed", progress: 0, error }, ...(FATAL.includes(step) ? { status: "failed", error } : {}) });
        if (FATAL.includes(step)) return;
      }
    }
    await this.set(id, { status: "ready" }); // Task 7 extends the chain and this rule
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
      const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", await this.sourcePath(id)]);
      const meta = parseProbe(JSON.parse(stdout));
      if (meta.hdr === "pq") throw new Error(PQ_UNSUPPORTED);
      if (!(meta.dur > 0)) throw new Error("Could not read the video duration");
      await this.set(id, { meta });
    } else if (step === "proxy") {
      const meta = await this.metaOf(id);
      if (meta.hdr === "hlg") await this.ensureCube();
      const out = this.store.file(id, "proxy.mp4"), tmp = join(dir, "proxy.tmp.mp4");
      let last = 0, lastAt = 0;
      const onLine = (line: string) => {
        const pr = parseProgress(line, meta.dur * 1000);
        if (pr === null || Date.now() - lastAt < 1000 || pr - last < 0.02) return;
        last = pr; lastAt = Date.now();
        this.set(id, { "jobs.proxy.progress": pr }).catch(() => undefined);
      };
      try {
        await this.withFfmpeg(async () => run("ffmpeg", buildProxyArgs(await this.sourcePath(id), tmp, meta, this.cube), { onLine }));
        await fs.rename(tmp, out);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
    } else if (step === "frames") {
      const meta = await this.metaOf(id), frames = join(dir, "frames");
      await fs.rm(frames, { recursive: true, force: true });
      await fs.mkdir(frames, { recursive: true });
      await this.withFfmpeg(() => run("ffmpeg", buildFramesArgs(this.store.file(id, "proxy.mp4"), join(frames, "%03d.png"), meta.dur)));
    }
  }
}
