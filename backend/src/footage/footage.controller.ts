import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Header, HttpCode, NotFoundException, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { createReadStream, promises as fs } from "fs";
import { Model } from "mongoose";
import { Public } from "../common/public.decorator";
import { Roles } from "../common/roles.decorator";
import { Footage, FootageDocument } from "./footage.schema";
import { FootageRefs } from "./footage.refs";
import { parseRange } from "./footage.range";
import { signFile, verifyFile } from "./footage.sign";
import { FootageStore } from "./footage.store";
import { STEP_ORDER, Step } from "./footage.recovery";
import { JobsService } from "./jobs.service";

export const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_SIZE = 2 * 1024 * 1024 * 1024;

export class CreateFootageDto {
  @IsString() @MaxLength(255) name: string;
  @IsInt() @Min(1) @Max(MAX_SIZE) size: number;
  @IsString() @MaxLength(100) mime: string;
  @IsIn(["original", "reference"]) role: string;
  @IsString() @MaxLength(64) brand: string;
}

export class PairFootageDto {
  @IsOptional() @IsString() @Matches(/^[0-9a-f]{24}$/) ref?: string;
  @IsOptional() @IsString() @Matches(/^[\w-]{1,64}$/) lookId?: string;
  @IsOptional() @IsString() @Matches(/^[a-z]{2}$/) lang?: string;
}

export class RetryFootageDto {
  @IsIn([...STEP_ORDER]) step: Step;
}

const MIME_EXT: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv", "video/x-m4v": "m4v" };
const extOf = (name: string, mime: string) => MIME_EXT[mime] ?? (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toLowerCase() || "mp4");
const isId = (id: string) => /^[0-9a-f]{24}$/.test(id);

@Controller("footage")
export class FootageController {
  constructor(
    @InjectModel(Footage.name) private model: Model<FootageDocument>,
    private store: FootageStore,
    private refs: FootageRefs,
    private jobs: JobsService,
  ) {}

  private async find(id: string) {
    if (!isId(id)) throw new NotFoundException();
    const doc = await this.model.findById(id);
    if (!doc) throw new NotFoundException();
    return doc;
  }

  @Roles("admin", "editor") @Post()
  async create(@Req() r: any, @Body() d: CreateFootageDto) {
    if (!/^video\//.test(d.mime)) throw new BadRequestException("Expected a video file");
    if (d.size > MAX_SIZE) throw new BadRequestException("Videos are limited to 2 GB");
    // same brand, name, size and user still uploading: resume it
    const prev = await this.model.findOne({ brand: d.brand, name: d.name, size: d.size, createdBy: r.user.sub, status: "uploading" });
    if (prev) return { id: String(prev._id), chunkSize: CHUNK_SIZE, received: await this.store.received(String(prev._id)) };
    const doc = await this.model.create({ ...d, ext: extOf(d.name, d.mime), createdBy: r.user.sub, status: "uploading", jobs: {} });
    return { id: String(doc._id), chunkSize: CHUNK_SIZE, received: [] };
  }

  @Roles("admin", "editor") @Put(":id/chunk") @HttpCode(200)
  async chunk(@Param("id") id: string, @Query("i") i: string, @Req() req: any) {
    const doc = await this.find(id), n = Number(i);
    if (doc.status !== "uploading") throw new ConflictException("This upload is already complete");
    if (!/^\d+$/.test(String(i)) || n >= Math.ceil(doc.size / CHUNK_SIZE)) throw new BadRequestException("Invalid chunk index");
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw new BadRequestException("Expected a raw application/octet-stream body");
    if (body.length > CHUNK_SIZE) throw new BadRequestException("Chunk is larger than 8 MB");
    await this.store.writeChunk(id, n, body);
    return { ok: true, i: n };
  }

  /**
   * Atomic claim (uploading -> assembling) so a double click or retry cannot assemble twice. Chunks are only deleted after the
   * record is saved as processing; any failure before that puts the record back to uploading (chunks intact), so it never sticks.
   */
  @Roles("admin", "editor") @Post(":id/complete") @HttpCode(200)
  async complete(@Param("id") id: string) {
    if (!isId(id)) throw new NotFoundException();
    const claimed = await this.model.findOneAndUpdate({ _id: id, status: "uploading" }, { $set: { status: "assembling" } }, { new: true });
    if (!claimed) {
      const cur = await this.find(id);
      if (cur.status === "assembling") throw new ConflictException("This upload is already being assembled");
      return this.view(cur); // already completed: idempotent
    }
    const back = () => this.model.updateOne({ _id: id }, { $set: { status: "uploading" }, }).catch(() => undefined);
    const got = await this.store.received(id), want = Math.ceil(claimed.size / CHUNK_SIZE);
    if (got.length !== want || got.some((v, k) => v !== k)) {
      await back();
      throw new BadRequestException(`Missing chunks: received ${got.length} of ${want}`);
    }
    let path: string;
    try {
      path = await this.store.assemble(id, claimed.ext || "mp4");
      if ((await fs.stat(path)).size !== claimed.size) {
        await fs.rm(path, { force: true });
        await back();
        throw new BadRequestException("The assembled file does not match the declared size; upload the chunks again");
      }
      await this.model.updateOne({ _id: id }, { $set: { status: "processing" } });
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      await fs.rm(this.store.dir(id) + `/source.${claimed.ext || "mp4"}`, { force: true }).catch(() => undefined);
      await back(); // chunks are still there: the client can call complete again
      throw e;
    }
    // chunks are no longer needed; a failure here only leaves disk garbage, the record is already processing
    await this.store.clearChunks(id).catch(() => undefined);
    await this.jobs.enqueue(id, "probe");
    return this.view(await this.find(id));
  }

  /**
   * Called by the client after both uploads are complete: stores the pairing on the original and starts the transcript and
   * the grade. The grade waits by itself until the reference's frames exist.
   */
  @Roles("admin", "editor") @Post(":id/pair") @HttpCode(200)
  async pair(@Param("id") id: string, @Body() d: PairFootageDto) {
    const doc = await this.find(id);
    if (doc.role !== "original") throw new BadRequestException("Only an original video can be paired");
    if (doc.status === "uploading" || doc.status === "assembling") throw new ConflictException("Finish uploading this video first");
    if (doc.status === "failed") throw new ConflictException("This video could not be processed");
    if (!d.ref && !d.lookId) throw new BadRequestException("Choose a reference video or a brand look");
    if (d.ref) {
      const ref = d.ref === id ? null : await this.model.findById(d.ref);
      if (!ref || ref.role !== "reference") throw new BadRequestException("The reference video was not found");
    }
    const pair: Record<string, string> = {};
    if (d.ref) pair.ref = d.ref; else pair.lookId = d.lookId!; // a reference wins over a saved look
    if (d.lang) pair.lang = d.lang;
    await this.model.updateOne({ _id: id }, { $set: { pair, ...(doc.status === "ready" ? { status: "processing" } : {}) } });
    await this.jobs.enqueue(id, "transcribe");
    await this.jobs.enqueue(id, "grade");
    return this.view(await this.find(id));
  }

  private async view(doc: FootageDocument) {
    const id = String(doc._id), o: any = doc.toObject();
    if (doc.status === "uploading") o.received = await this.store.received(id);
    const hasProxy = await fs.stat(this.store.file(id, "proxy.mp4")).then(() => true, () => false);
    if (hasProxy) o.proxyUrl = signFile(id, "proxy.mp4");
    return o;
  }

  @Get(":id")
  async get(@Param("id") id: string) { return this.view(await this.find(id)); }

  /** The transcript's words ([] until the transcribe step has written them, or when the video has no audio) */
  @Get(":id/words")
  async words(@Param("id") id: string) {
    await this.find(id);
    const text = await fs.readFile(this.store.file(id, "words.json"), "utf8").catch(() => null);
    if (text == null) return [];
    try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
  }

  /** The matched grade as a .cube file (404 until the grade step has written it) */
  @Get(":id/look") @Header("Content-Type", "text/plain; charset=utf-8") @Header("Cache-Control", "no-store")
  async look(@Param("id") id: string) {
    await this.find(id);
    const text = await fs.readFile(this.store.file(id, "look.cube"), "utf8").catch(() => null);
    if (text == null) throw new NotFoundException("No colour grade yet");
    return text;
  }

  /**
   * Runs a pipeline step again (the editor's Retry). A step already queued or running is left alone. Retrying probe or proxy of a
   * paired original also requests its unfinished transcribe and grade: a fatal failure dropped them from the queue.
   */
  @Roles("admin", "editor") @Post(":id/retry") @HttpCode(200)
  async retry(@Param("id") id: string, @Body() d: RetryFootageDto) {
    const doc = await this.find(id), step = d.step;
    if (!STEP_ORDER.includes(step)) throw new BadRequestException("Unknown step");
    if (doc.status === "uploading" || doc.status === "assembling") throw new ConflictException("Finish uploading this video first");
    const jobs: Record<string, any> = doc.jobs || {}, busy = (s: Step) => ["queued", "running"].includes(jobs[s]?.state);
    if ((step === "transcribe" || step === "grade") && (doc.role !== "original" || !doc.pair)) throw new BadRequestException("Pair this video with a reference or a brand look first");
    if (step === "caption-style" && doc.role !== "reference") throw new BadRequestException("Only a reference video has a subtitle style");
    if (busy(step)) return this.view(doc);
    const steps: Step[] = [step];
    if ((step === "probe" || step === "proxy") && doc.role === "original" && doc.pair) {
      // a fatal failure cleared the runner's queue, so a transcribe or grade still persisted as queued is orphaned: request it too (harmless if not)
      for (const s of ["transcribe", "grade"] as Step[]) if (!["done", "skipped", "running"].includes(jobs[s]?.state)) steps.push(s);
    }
    if (doc.status === "ready" || doc.status === "failed") await this.model.updateOne({ _id: id }, { $set: { status: "processing", error: null } });
    for (const s of steps) await this.jobs.enqueue(id, s);
    return this.view(await this.find(id));
  }

  @Roles("admin", "editor") @Delete(":id") @HttpCode(200)
  async remove(@Param("id") id: string) {
    const doc = await this.find(id);
    if ((await this.refs.used()).has(id)) throw new ConflictException("A design or a saved version still uses this video");
    await this.store.remove(id);
    await this.model.deleteOne({ _id: id });
    await this.jobs.wake(id).catch(() => undefined); // originals waiting on this reference fail their grade instead of waiting forever
    return { ok: true };
  }

  /** Signed-URL file (the browser cannot send a Bearer header from <video> or a download link) */
  async send(id: string, file: string, token: string, req: any, res: any) {
    if (!isId(id) || !/^(proxy\.mp4|exports\/[\w-]{1,64}\.mp4)$/.test(file)) throw new NotFoundException();
    if (!verifyFile(id, file, token)) throw new ForbiddenException("Invalid or expired link");
    const path = this.store.file(id, file as any);
    const stat = await fs.stat(path).catch(() => null);
    if (!stat || !stat.isFile()) throw new NotFoundException();
    const size = stat.size, rg = parseRange(req.headers.range, size);
    const head = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" };
    if (rg === "unsatisfiable") { res.status(416).set({ ...head, "Content-Range": `bytes */${size}` }).end(); return; }
    const [status, start, end] = rg ? [206, rg.start, rg.end] : [200, 0, Math.max(0, size - 1)];
    res.status(status).set({ ...head, "Content-Length": String(size ? end - start + 1 : 0), ...(rg ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
    if (!size) { res.end(); return; }
    const stream = createReadStream(path, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  @Public() @Get(":id/proxy.mp4")
  proxy(@Param("id") id: string, @Query("t") t: string, @Req() req: any, @Res() res: any) { return this.send(id, "proxy.mp4", t, req, res); }

  @Public() @Get(":id/exports/:job.mp4")
  exported(@Param("id") id: string, @Param("job") job: string, @Query("t") t: string, @Req() req: any, @Res() res: any) { return this.send(id, `exports/${job}.mp4`, t, req, res); }
}
