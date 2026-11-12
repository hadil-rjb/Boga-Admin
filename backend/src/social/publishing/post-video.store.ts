import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { JobsService, STEP_TIMEOUT } from "../../footage/jobs.service";
import { parseProbe } from "../../footage/ffmpeg";
import { VIDEO_ID, VideoMeta } from "./post-video";

/** backend folder: the cwd when started from it, else found by walking up from this file (as footage.store.ts) */
function backendRoot(): string {
  if (existsSync(join(process.cwd(), "nest-cli.json"))) return process.cwd();
  for (let d = __dirname; dirname(d) !== d; d = dirname(d)) if (existsSync(join(d, "nest-cli.json"))) return d;
  return process.cwd();
}

const UPLOAD_ID = /^[a-f0-9]{24}$/;
export const VIDEO_CHUNK = 8 * 1024 * 1024;
const MAX_PARTS = 256; // 2 GB in 8 MB chunks

export interface StoredVideo extends VideoMeta { id: string; mime: "video/mp4" }

/**
 * Post videos on disk: <root>/<id>.mp4, one per post, pinned for as long as the post points at it (footage exports are
 * pruned and swept, so a scheduled post keeps its own copy). Browser recordings arrive in 8 MB chunks and are re-encoded
 * to H.264 + AAC with faststart (MediaRecorder output can be WebM, fragmented or variable frame rate, which networks refuse).
 */
@Injectable()
export class PostVideoStore {
  readonly root = resolve(process.env.SOCIAL_VIDEO_DIR || join(backendRoot(), "storage", "social-videos"));
  constructor(private jobs: JobsService) {}

  path(id: string): string {
    if (!VIDEO_ID.test(id)) throw new NotFoundException();
    return join(this.root, `${id}.mp4`);
  }
  private upDir(uploadId: string) {
    if (!UPLOAD_ID.test(uploadId)) throw new BadRequestException("Unknown upload");
    return join(this.root, "uploads", uploadId);
  }

  /** Starts a chunked upload for a post's recording */
  async begin(brandId: string, postId: string): Promise<{ uploadId: string; chunk: number }> {
    const uploadId = randomBytes(12).toString("hex"), dir = this.upDir(uploadId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), JSON.stringify({ brandId, postId, at: Date.now() }));
    return { uploadId, chunk: VIDEO_CHUNK };
  }

  async chunk(brandId: string, postId: string, uploadId: string, index: number, body: Buffer) {
    await this.owned(brandId, postId, uploadId);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PARTS) throw new BadRequestException("Bad chunk index");
    if (!Buffer.isBuffer(body) || !body.length) throw new BadRequestException("Empty chunk");
    if (body.length > VIDEO_CHUNK + 1024) throw new BadRequestException("Chunk too large");
    await writeFile(join(this.upDir(uploadId), `${String(index).padStart(4, "0")}.part`), body);
  }

  /** Joins the chunks and re-encodes them into the post's MP4 */
  async complete(brandId: string, postId: string, uploadId: string, parts: number): Promise<StoredVideo> {
    await this.owned(brandId, postId, uploadId);
    const dir = this.upDir(uploadId);
    const names = (await readdir(dir)).filter((n) => n.endsWith(".part")).sort();
    if (!names.length || names.length !== parts || names.some((n, i) => n !== `${String(i).padStart(4, "0")}.part`)) throw new BadRequestException("Some parts of the video are missing. Upload it again.");
    const src = join(dir, "source");
    const fh = await open(src, "w");
    try { for (const n of names) await fh.write(await readFile(join(dir, n))); } finally { await fh.close(); }
    try {
      const probe = await this.probe(src);
      const id = randomBytes(12).toString("hex"), out = this.path(id);
      await mkdir(this.root, { recursive: true });
      await this.jobs.withFfmpeg(() => this.jobs.runner("ffmpeg", [
        "-y", "-v", "error", "-i", src,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-r", String(Math.min(60, Math.max(24, Math.round(probe.fps) || 30))), "-fps_mode", "cfr",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart", out,
      ], { timeoutMs: STEP_TIMEOUT.media(probe.dur || 60) }));
      return await this.describe(id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** A finished footage export (already H.264 + AAC, faststart): copied so the post keeps it after the export is pruned */
  async adopt(file: string): Promise<StoredVideo> {
    if (!existsSync(file)) throw new BadRequestException("The video export isn't ready. Export it again.");
    const id = randomBytes(12).toString("hex");
    await mkdir(this.root, { recursive: true });
    await copyFile(file, this.path(id));
    return this.describe(id);
  }

  async remove(id?: string | null) {
    if (id && VIDEO_ID.test(id)) await rm(this.path(id), { force: true });
  }

  /** Files on disk, for the sweep: post videos ({ id, at }) and unfinished uploads ({ uploadId, at }) */
  async inventory(): Promise<{ videos: { id: string; at: number }[]; uploads: { uploadId: string; at: number }[] }> {
    const videos: { id: string; at: number }[] = [], uploads: { uploadId: string; at: number }[] = [];
    const names = await readdir(this.root).catch(() => [] as string[]);
    for (const n of names) {
      const id = n.replace(/\.mp4$/, "");
      if (n.endsWith(".mp4") && VIDEO_ID.test(id)) videos.push({ id, at: (await stat(join(this.root, n))).mtimeMs });
    }
    for (const u of await readdir(join(this.root, "uploads")).catch(() => [] as string[])) {
      if (UPLOAD_ID.test(u)) uploads.push({ uploadId: u, at: (await stat(join(this.root, "uploads", u))).mtimeMs });
    }
    return { videos, uploads };
  }
  async dropUpload(uploadId: string) { await rm(this.upDir(uploadId), { recursive: true, force: true }); }

  async exists(id: string) { try { return (await stat(this.path(id))).isFile(); } catch { return false; } }

  private async describe(id: string): Promise<StoredVideo> {
    const file = this.path(id), p = await this.probe(file), { size } = await stat(file);
    return { id, mime: "video/mp4", size, durationMs: Math.round((p.dur || 0) * 1000), width: p.w, height: p.h };
  }

  private async probe(file: string) {
    let out: string;
    try {
      ({ stdout: out } = await this.jobs.runner("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeoutMs: STEP_TIMEOUT.probe }));
    } catch { throw new BadRequestException("This file couldn't be read as a video."); }
    try { return parseProbe(JSON.parse(out)); } catch (e: any) { throw new BadRequestException(e?.message || "This file couldn't be read as a video."); }
  }

  private async owned(brandId: string, postId: string, uploadId: string) {
    let meta: any;
    try { meta = JSON.parse(await readFile(join(this.upDir(uploadId), "meta.json"), "utf8")); } catch { throw new BadRequestException("Unknown upload"); }
    if (meta.brandId !== brandId || meta.postId !== postId) throw new BadRequestException("Unknown upload");
  }
}
