import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import sharp from "sharp";
import { SocialDesign } from "../schemas/design.schema";
import { SocialPost } from "../schemas/post.schema";
import { SocialWorkspace, WORKSPACE_ID } from "../schemas/workspace.schema";
import { validTz, zonedToUtc } from "../../framer/time";
import { SocialMedia } from "./connection.schema";
import { ConnectionsService } from "./connections.service";
import { isVideoDesign, mergePost, PublishState, textFor, VIDEO_NOT_READY } from "./post-state";
import { Net, NETS, PublishImage, PublishVideo } from "./providers";
import { PostVideoStore, StoredVideo } from "./post-video.store";
import { FootageStore } from "../../footage/footage.store";
import { VIDEO_ID, videoProblem } from "./post-video";

export const MAX_ATTEMPTS = 3;
const LOCK_MS = 30 * 60_000; // a video can take minutes per network (upload, then the network's processing)
const DATA_URL = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i;

/** Stored bytes come back from MongoDB as BSON Binary, not Buffer */
const toBuffer = (d: any): Buffer => (Buffer.isBuffer(d) ? d : d?.buffer instanceof Uint8Array ? Buffer.from(d.buffer) : Buffer.from(d?.buffer ?? d));

export interface NetResult { ok: boolean; id?: string; url?: string; warning?: string; error?: string; at: Date }

/** Stores the slides the studio rendered for a post, and publishes posts to their networks. */
@Injectable()
export class PublisherService {
  private log = new Logger("SocialPublisher");
  constructor(
    @InjectModel(SocialPost.name) private posts: Model<SocialPost>,
    @InjectModel(SocialDesign.name) private designs: Model<SocialDesign>,
    @InjectModel(SocialMedia.name) private media: Model<SocialMedia>,
    @InjectModel(SocialWorkspace.name) private workspaces: Model<SocialWorkspace>,
    private conns: ConnectionsService,
    private videos: PostVideoStore,
    private footage: FootageStore,
  ) {}

  /** Upserts a post sent by the studio, keeping the server-owned fields (publish, media). */
  async upsertPost(brandId: string, item: Record<string, any>) {
    if (!item?.id) throw new BadRequestException("Post id missing");
    const existing = await this.posts.findOne({ brandId, id: item.id }).lean<Record<string, any>>();
    const merged = mergePost(existing, item);
    await this.posts.replaceOne(
      { brandId, id: item.id },
      { ...merged, brandId, id: item.id, order: existing?.order ?? Number.MAX_SAFE_INTEGER, hash: "" },
      { upsert: true },
    );
  }

  /** Rendered slides for a post (sent as PNG, stored as JPEG). Scheduling a post with images arms it for the scheduler. */
  async saveMedia(brandId: string, postId: string, body: { images: string[]; hash?: string; post?: Record<string, any> }) {
    if (body.post) await this.upsertPost(brandId, { ...body.post, id: postId });
    const post = await this.posts.findOne({ brandId, id: postId }).lean<Record<string, any>>();
    if (!post) throw new NotFoundException("Post not found");
    if (!body.images?.length) throw new BadRequestException("No images");
    const saved = await this.store(brandId, postId, body.images);
    if (post.media?.video?.id) await this.videos.remove(post.media.video.id); // it was a video post: its file goes
    const media = { ids: saved.map((d) => String(d._id)), hash: body.hash || "", count: saved.length, at: new Date() };
    const pub = post.publish || { state: "idle", results: {}, attempts: 0 };
    const armed = post.status === "Scheduled" && !["published", "partial", "publishing"].includes(pub.state);
    await this.posts.updateOne({ brandId, id: postId }, { $set: { media, publish: armed ? { ...pub, state: "pending", attempts: 0, nextTry: null } : pub } });
    return this.state(brandId, postId);
  }

  /* ---------- video posts ---------- */
  /** A chunked upload of the studio's recording (an animated design) for this post */
  async videoBegin(brandId: string, postId: string, post?: Record<string, any>) {
    if (post) await this.upsertPost(brandId, { ...post, id: postId });
    if (!(await this.posts.exists({ brandId, id: postId }))) throw new NotFoundException("Post not found");
    return this.videos.begin(brandId, postId);
  }
  videoChunk(brandId: string, postId: string, uploadId: string, index: number, body: Buffer) { return this.videos.chunk(brandId, postId, uploadId, index, body); }
  async videoComplete(brandId: string, postId: string, uploadId: string, parts: number, hash?: string) {
    const v = await this.videos.complete(brandId, postId, uploadId, parts);
    return this.attachVideo(brandId, postId, v, hash);
  }
  /** An imported clip: the footage export the studio finished (exports/<jobId>.mp4 of the design's footage) becomes the post's video */
  async videoFromFootage(brandId: string, postId: string, body: { jobId: string; hash?: string; post?: Record<string, any> }) {
    if (body.post) await this.upsertPost(brandId, { ...body.post, id: postId });
    const post = await this.posts.findOne({ brandId, id: postId }).select("d").lean<Record<string, any>>();
    if (!post) throw new NotFoundException("Post not found");
    const design = await this.designs.findOne({ brandId, id: post.d }).select("footage").lean<Record<string, any>>();
    const src = String(design?.footage?.src || "");
    if (!VIDEO_ID.test(src) || !VIDEO_ID.test(String(body.jobId || ""))) throw new BadRequestException("This post's design has no exported video");
    const v = await this.videos.adopt(this.footage.file(src, `exports/${body.jobId}.mp4`));
    return this.attachVideo(brandId, postId, v, body.hash);
  }
  /** The post's media becomes this video (the previous slides or video go); a scheduled post is armed */
  private async attachVideo(brandId: string, postId: string, v: StoredVideo, hash?: string) {
    const post = await this.posts.findOne({ brandId, id: postId }).lean<Record<string, any>>();
    if (!post) { await this.videos.remove(v.id); throw new NotFoundException("Post not found"); }
    if (post.media?.video?.id && post.media.video.id !== v.id) await this.videos.remove(post.media.video.id);
    await this.media.deleteMany({ brandId, postId });
    const media = { ids: [], video: { id: v.id, mime: v.mime, size: v.size, durationMs: v.durationMs, width: v.width, height: v.height }, hash: hash || "", count: 1, at: new Date() };
    const pub = post.publish || { state: "idle", results: {}, attempts: 0 };
    const armed = post.status === "Scheduled" && !["published", "partial", "publishing"].includes(pub.state);
    await this.posts.updateOne({ brandId, id: postId }, { $set: { media, publish: armed ? { ...pub, state: "pending", attempts: 0, nextTry: null } : pub } });
    return this.state(brandId, postId);
  }
  videoUrl(id: string) { return `${this.conns.apiUrl}/social/video/${id}.mp4`; }
  /** A post video's file (public route: networks download it), or 404 */
  async videoFile(raw: string) {
    const id = raw.replace(/\.mp4$/i, "");
    if (!VIDEO_ID.test(id) || !(await this.videos.exists(id))) throw new NotFoundException();
    return this.videos.path(id);
  }

  /** Encodes the slides (PNG/JPEG data URLs) and replaces the stored files of a post. */
  private async store(brandId: string, postId: string, images: string[]) {
    const docs = [];
    for (const [index, url] of images.slice(0, 20).entries()) {
      const m = DATA_URL.exec(url);
      if (!m) throw new BadRequestException("Expected PNG or JPEG data URLs");
      const img = sharp(Buffer.from(m[2], "base64")).flatten({ background: "#ffffff" });
      // The studio sends lossless PNGs: encode once, with full-resolution colour (4:4:4) so thin coloured
      // text and brand colours stay crisp instead of bleeding as with the default 4:2:0 subsampling.
      const { data, info } = await img.jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
      docs.push({ brandId, postId, index, data, mime: "image/jpeg", width: info.width, height: info.height });
    }
    await this.media.deleteMany({ brandId, postId });
    return this.media.insertMany(docs);
  }

  /**
   * Slides re-rendered by the server (live calendar data, see LiveRenderService). The publish state is
   * left as it is, and the design hash too: the design didn't change, so an open studio doesn't re-send them.
   */
  async replaceRendered(brandId: string, postId: string, images: string[], live: Record<string, unknown>) {
    if (!images.length) throw new BadRequestException("No images");
    const post = await this.posts.findOne({ brandId, id: postId }).select("media").lean<Record<string, any>>();
    if (!post) throw new NotFoundException("Post not found");
    const saved = await this.store(brandId, postId, images);
    const media = { ids: saved.map((d) => String(d._id)), hash: post.media?.hash || "", count: saved.length, at: new Date(), live };
    await this.posts.updateOne({ brandId, id: postId }, { $set: { media } });
  }

  /** An automation's post rendered by the server: its slides and caption, ready for the scheduler */
  async arm(brandId: string, postId: string, images: string[], live: Record<string, unknown>, caption: string) {
    if (!images.length) throw new BadRequestException("No images");
    const post = await this.posts.findOne({ brandId, id: postId }).select("publish status").lean<Record<string, any>>();
    if (!post) throw new NotFoundException("Post not found");
    const saved = await this.store(brandId, postId, images);
    const media = { ids: saved.map((d) => String(d._id)), hash: "auto", count: saved.length, at: new Date(), live };
    const pub = post.publish || { state: "idle", results: {}, attempts: 0 };
    await this.posts.updateOne({ brandId, id: postId }, { $set: { media, cap: caption, hash: "", publish: { ...pub, state: "pending", attempts: 0, nextTry: null } } });
  }

  async state(brandId: string, postId: string) {
    const p = await this.posts.findOne({ brandId, id: postId }).select("id status publish media").lean<Record<string, any>>();
    if (!p) throw new NotFoundException("Post not found");
    return { id: p.id, status: p.status, publish: p.publish ?? null, media: p.media ?? null };
  }

  /** Publish state of every post of a brand that went through the publisher (the studio polls this). */
  async states(brandId: string) {
    const rows = await this.posts.find({ brandId, $or: [{ publish: { $exists: true } }, { review: { $exists: true } }] }).select("id status publish media review").lean<Record<string, any>[]>();
    return rows.map((p) => ({ id: p.id, status: p.status, publish: p.publish ?? null, media: p.media ?? null, review: p.review ?? null }));
  }

  /** Images that aren't a post's slides (an automation's design preview), stored like slides and served at the public media URL */
  async storeImages(brandId: string, key: string, images: string[]) {
    return (await this.store(brandId, key, images)).map((d) => String(d._id));
  }

  publicUrl(id: string) { return `${this.conns.apiUrl}/social/media/${id}.jpg`; }

  async file(raw: string) {
    const id = raw.replace(/\.jpe?g$/i, "");
    if (!Types.ObjectId.isValid(id) || id.length !== 24) throw new NotFoundException();
    const m = await this.media.findById(id).select("+data").lean();
    if (!m) throw new NotFoundException();
    return { mime: m.mime, data: toBuffer(m.data) };
  }

  /**
   * Publishes a post to every selected network that hasn't received it yet. `manual`: Publish now
   * (no retries); otherwise the scheduler retries failures up to MAX_ATTEMPTS times.
   */
  async publish(brandId: string, postId: string, { manual = false } = {}) {
    const now = new Date();
    const cur = await this.posts.findOne({ brandId, id: postId }).select("review").lean<Record<string, any>>();
    if (cur?.review && cur.review.state !== "approved") throw new BadRequestException(cur.review.state === "rejected" ? "This post was rejected in Notion" : "This post is waiting for approval in Notion");
    const claimed = await this.posts.findOneAndUpdate(
      { brandId, id: postId, $or: [{ "publish.state": { $ne: "publishing" } }, { "publish.lockedAt": { $lt: new Date(now.getTime() - LOCK_MS) } }] },
      { $set: { "publish.state": "publishing", "publish.lockedAt": now } },
      { new: true },
    ).lean<Record<string, any>>();
    if (!claimed) {
      if (!(await this.posts.exists({ brandId, id: postId }))) throw new NotFoundException("Post not found");
      throw new ConflictException("This post is already being published");
    }
    const prev = claimed.publish || {};
    const results: Record<string, NetResult> = { ...(prev.results || {}) };
    let state: PublishState = "failed", status = claimed.status, attempts = (prev.attempts || 0) + 1, nextTry: Date | null = null, fatal = "", permanent = false;
    try {
      const design = await this.designs.findOne({ brandId, id: claimed.d }).select("name ratio footage motion").lean();
      const nets = ((claimed.pf || []) as string[]).filter((n): n is Net => NETS.includes(n as Net));
      if (!nets.length) throw new Error("No network selected");
      let images: PublishImage[] = [], video: PublishVideo | undefined, unfit = 0;
      if (isVideoDesign(design)) {
        // a video design publishes its MP4, never its pages (a clip's only page is a black background)
        const v = claimed.media?.video;
        if (!v?.id || !(await this.videos.exists(v.id))) { permanent = true; throw new Error(VIDEO_NOT_READY); }
        video = { url: this.videoUrl(v.id), path: this.videos.path(v.id), mime: v.mime || "video/mp4", size: v.size || 0, width: v.width || 0, height: v.height || 0, durationMs: v.durationMs || 0 };
      } else {
        const files = await this.media.find({ brandId, postId }).sort({ index: 1 }).select("+data").lean();
        if (!files.length) throw new Error("The slides haven't been rendered yet: open the post in the studio and schedule it again");
        images = files.map((f) => ({ buffer: toBuffer(f.data), mime: f.mime, url: this.publicUrl(String(f._id)), width: f.width, height: f.height }));
      }
      // a 9:16 still goes to Instagram as a Story; a 9:16 video as a Reel (the Story option is the post's `igStory`)
      const story = design?.ratio === "9:16" && (!video || !!claimed.igStory);

      for (const net of nets) {
        if (results[net]?.ok) continue; // already out: never post twice
        const problem = video ? videoProblem(net, video) : null;
        if (problem) { results[net] = { ok: false, error: problem, at: new Date() }; unfit++; continue; } // this network can't take it: no call, no retry helps
        try {
          const link = await this.conns.linked(brandId, net);
          const r = await this.conns.provider(net).publish(link, {
            text: textFor(claimed, net, design?.name),
            firstComment: net === "ig" || net === "li" ? claimed.fc : undefined,
            images,
            video,
            story: story && net === "ig",
          });
          results[net] = { ok: true, id: r.id, url: r.url, warning: r.warning, at: new Date() };
          this.log.log(`Published post ${postId} (${brandId}) to ${net}`);
        } catch (e: any) {
          results[net] = { ok: false, error: e?.message || "Failed", at: new Date() };
          if (e?.status === 401 || e?.status === 403 || /expired|reconnect|isn't connected/i.test(e?.message || "")) await this.conns.markError(brandId, net, e.message);
          this.log.warn(`Post ${postId} → ${net}: ${e?.message}`);
        }
      }
      const ok = nets.filter((n) => results[n]?.ok).length;
      state = ok === nets.length ? "published" : ok ? "partial" : "failed";
      if (!ok && unfit === nets.filter((n) => !results[n]?.ok).length) permanent = true; // only limits failed: retrying won't change the video
    } catch (e: any) {
      fatal = e?.message || "Failed";
      state = "failed";
    }
    const retry = state === "failed" && !manual && !permanent && attempts < MAX_ATTEMPTS;
    if (state === "published" || state === "partial") status = "Published";
    else if (retry) { state = "pending"; nextTry = new Date(Date.now() + 2 ** attempts * 60_000); }
    else status = "Failed";
    const lastError = fatal || Object.values(results).find((r) => !r.ok)?.error;
    await this.posts.updateOne(
      { brandId, id: postId },
      { $set: { status, publish: { state, results, attempts, nextTry, lockedAt: null, at: new Date(), lastError: lastError || null } } },
    );
    return this.state(brandId, postId);
  }

  /**
   * Post videos no post points to any more (the post, its design or its brand was deleted, or a newer video replaced it),
   * older than an hour so a video being attached is never taken; and uploads left unfinished for a day.
   */
  async sweepVideos(now = Date.now()) {
    const { videos, uploads } = await this.videos.inventory();
    let removed = 0;
    if (videos.length) {
      const used = new Set((await this.posts.distinct("media.video.id")).map(String));
      for (const v of videos) if (!used.has(v.id) && now - v.at > 3600_000) { await this.videos.remove(v.id); removed++; }
    }
    for (const u of uploads) if (now - u.at > 24 * 3600_000) { await this.videos.dropUpload(u.uploadId); removed++; }
    if (removed) this.log.log(`Removed ${removed} unused post video file(s)`);
    return removed;
  }

  /** Scheduled posts whose time has come (in their time zone). */
  async due(now = Date.now()) {
    const ws = await this.workspaces.findById(WORKSPACE_ID).lean();
    const wsTz = String((ws?.set as any)?.tz || "");
    const horizon = new Date(now + 36 * 3600_000).toISOString().slice(0, 10);
    const rows = await this.posts.find({
      status: "Scheduled", "publish.state": "pending", date: { $lte: horizon },
      $or: [{ "publish.nextTry": null }, { "publish.nextTry": { $exists: false } }, { "publish.nextTry": { $lte: new Date(now) } }],
    }).select("brandId id date time tz").lean<Record<string, any>[]>();
    return rows.filter((p) => {
      const tz = validTz(p.tz || "") ? p.tz : validTz(wsTz) ? wsTz : "UTC";
      return zonedToUtc(p.date, p.time || "09:00", tz).getTime() <= now;
    });
  }

  async removeBrand(brandIds: string[]) {
    await this.media.deleteMany({ brandId: { $in: brandIds } });
    const withVideo = await this.posts.find({ brandId: { $in: brandIds }, "media.video.id": { $exists: true } }).select("media.video.id").lean<Record<string, any>[]>();
    for (const p of withVideo) await this.videos.remove(p.media?.video?.id);
  }
}
