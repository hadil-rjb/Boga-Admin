import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req, Res } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { createHash } from "crypto";
import { Connection, Model, Types } from "mongoose";
import sharp from "sharp";
import { reencode } from "../ai/hf";
import { AudioService } from "../ai/audio.service";
import { AUDIO_EXT } from "../ai/audio";
import { sniff } from "../ai/image";
import { Public } from "../common/public.decorator";
import { Roles } from "../common/roles.decorator";
import { Media, MediaDocument } from "./media.schema";
import { publicApiBase } from "../common/public-url";

export class CreateMediaDto {
  @IsString() @MaxLength(9_000_000) dataUrl: string;
  @IsOptional() @IsString() @MaxLength(120) model?: string;
}

export class CreateAudioDto {
  @IsString() @MaxLength(17_000_000) dataUrl: string;
}

export class CreateAssetDto {
  @IsString() @MaxLength(17_000_000) dataUrl: string;
}

/** Largest studio image kept (bytes): a Mongo document holds 16 MB */
const ASSET_MAX = 12 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

@Controller("media")
export class MediaController {
  constructor(@InjectModel(Media.name) private media: Model<MediaDocument>, private audio: AudioService, @InjectConnection() private db: Connection) {}

  /** Ids of every hosted file a design, a saved version, a template or a brand still points to (their URLs end in /media/<id>.<ext>) */
  private async inUse() {
    const ids = new Set<string>(), re = /\/media\/([0-9a-f]{24})\./g;
    for (const name of ["social_designs", "social_design_versions", "social_templates", "social_brands"]) {
      for await (const doc of this.db.collection(name).find({}, { projection: { _id: 0 } })) for (const m of JSON.stringify(doc).matchAll(re)) ids.add(m[1]);
    }
    return ids;
  }

  /** Enregistre une couverture choisie et renvoie son URL publique */
  @Roles("admin", "editor") @Post("cover")
  async create(@Req() r: any, @Body() d: CreateMediaDto) {
    const m = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(d.dataUrl);
    if (!m) throw new BadRequestException("Expected a PNG, JPEG or WebP data URL");
    const out = await reencode(Buffer.from(m[1], "base64"));
    const doc = await this.media.create({ data: out.buf, mime: "image/webp", size: out.buf.length, width: out.width, height: out.height, model: d.model ?? "", createdBy: r.user.sub });
    const base = publicApiBase(process.env.PUBLIC_API_URL, `${r.protocol}://${r.get("host")}`);
    return { id: String(doc._id), url: `${base}/media/${doc._id}.webp`, width: out.width, height: out.height, bytes: out.buf.length };
  }

  /**
   * Studio design image (upload, adjusted image, import): stored as sent, so the canvas and exports keep
   * full quality. Identical bytes are stored once; the design keeps only the returned URL.
   */
  @Roles("admin", "editor") @Post("assets")
  async asset(@Req() r: any, @Body() d: CreateAssetDto) {
    const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(d.dataUrl);
    if (!m) throw new BadRequestException("Expected an image data URL");
    const buf = Buffer.from(m[1], "base64"), mime = sniff(buf);
    if (!mime) throw new BadRequestException("This is not a PNG, JPEG, WebP or GIF image");
    if (buf.length > ASSET_MAX) throw new BadRequestException("This image is larger than 12 MB");
    const sha = createHash("sha256").update(buf).digest("hex");
    let doc = await this.media.findOne({ kind: "asset", sha });
    if (!doc) {
      const meta = await sharp(buf, { failOn: "none" }).metadata().catch(() => ({ width: 0, height: 0 }));
      doc = await this.media.create({ data: buf, mime, size: buf.length, width: meta.width ?? 0, height: meta.height ?? 0, kind: "asset", sha, createdBy: r.user.sub });
    }
    const base = publicApiBase(process.env.PUBLIC_API_URL, `${r.protocol}://${r.get("host")}`);
    return { id: String(doc._id), url: `${base}/media/${doc._id}.${EXT[doc.mime] || "bin"}`, width: doc.width, height: doc.height, bytes: doc.size };
  }

  /** An audio file from the video editor (music the user uploads): stored once, the design keeps the URL */
  @Roles("admin", "editor") @Post("audio")
  async audioFile(@Req() r: any, @Body() d: CreateAudioDto) {
    const m = /^data:audio\/[a-z0-9+.-]+(?:;[a-z0-9=.-]+)*;base64,([A-Za-z0-9+/=]+)$/i.exec(d.dataUrl);
    if (!m) throw new BadRequestException("Expected an audio data URL");
    const out = await this.audio.store(Buffer.from(m[1], "base64"), r.user.sub);
    const base = publicApiBase(process.env.PUBLIC_API_URL, `${r.protocol}://${r.get("host")}`);
    return { ...out, url: `${base}/media/${out.id}.${AUDIO_EXT[out.mime] || "bin"}` };
  }

  /** Deletes one audio file of the video editor, unless a design, a version or a template still uses it */
  @Roles("admin", "editor") @Delete("audio/:id") @HttpCode(200)
  async deleteAudio(@Param("id") raw: string) {
    const id = raw.replace(/\.[a-z0-9]+$/i, "");
    if (!Types.ObjectId.isValid(id) || id.length !== 24) throw new NotFoundException();
    const doc = await this.media.findOne({ _id: id, kind: "audio" }).select("size");
    if (!doc) throw new NotFoundException("This audio file no longer exists");
    if ((await this.inUse()).has(id)) throw new ConflictException("A design still uses this audio file");
    await doc.deleteOne();
    return { ok: true, bytes: doc.size ?? 0 };
  }

  /** Deletes every audio file no design, version or template uses ({ dry: true }: only counts them). Files from the last
      hour are kept: a clip can be uploaded a moment before the design that uses it is saved. */
  @Roles("admin") @Post("audio/cleanup") @HttpCode(200)
  async cleanupAudio(@Body() b: { dry?: boolean } = {}) {
    const used = await this.inUse(), old = new Date(Date.now() - 3_600_000);
    const files = await this.media.find({ kind: "audio", createdAt: { $lt: old } }).select("_id size").lean();
    const drop = files.filter((f: any) => !used.has(String(f._id)));
    const bytes = drop.reduce((n: number, f: any) => n + (f.size ?? 0), 0);
    if (b && b.dry === true) return { unused: drop.length, bytes, kept: files.length - drop.length }; // what a clean-up would delete
    if (drop.length) await this.media.deleteMany({ _id: { $in: drop.map((f: any) => f._id) }, kind: "audio" });
    return { deleted: drop.length, bytes, kept: files.length - drop.length };
  }

  /** Public (l'identifiant est aléatoire) : le site du blog doit pouvoir afficher la couverture */
  @Public() @Get(":id")
  async get(@Param("id") raw: string, @Req() req: any, @Res() res: any) {
    const id = raw.replace(/\.(webp|png|jpe?g|gif|bin|mp3|wav|ogg|flac|m4a|weba)$/i, "");
    if (!Types.ObjectId.isValid(id) || id.length !== 24) throw new NotFoundException();
    const doc = await this.media.findById(id).select("+data");
    if (!doc) throw new NotFoundException();
    // Any origin may read the pixels: the studio draws its images on a canvas (image adjustments, export)
    // Audio is read in ranges: the browser needs them to seek and to play before the whole file arrived
    if (/^audio\//.test(doc.mime)) {
      const size = doc.data.length, rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
      const head = { "Content-Type": doc.mime, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=31536000, immutable", "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff" };
      if (rg && (rg[1] || rg[2])) {
        const start = rg[1] ? Math.min(Number(rg[1]), size - 1) : Math.max(0, size - Number(rg[2])), end = rg[1] && rg[2] ? Math.min(Number(rg[2]), size - 1) : size - 1;
        res.status(206).set({ ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) }).send(doc.data.subarray(start, end + 1));
        return;
      }
      res.set({ ...head, "Content-Length": String(size) }).send(doc.data);
      return;
    }
    res.set({ "Content-Type": doc.mime || "image/webp", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=31536000, immutable", "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff" });
    res.send(doc.data);
  }
}
