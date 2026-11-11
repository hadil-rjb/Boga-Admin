import { Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { CreateBrandDto, CreateDesignDto, CreatePostDto, CreateTemplateDto, UpdateTemplateDto } from "./dto/resource.dto";
import { SocialBrand } from "./schemas/brand.schema";
import { SocialDesign } from "./schemas/design.schema";
import { SocialPost } from "./schemas/post.schema";
import { SocialTemplate } from "./schemas/template.schema";
import { SocialWorkspace, WORKSPACE_ID } from "./schemas/workspace.schema";
import { dropAt, hashOf, newId, strip, withAt } from "./social.util";
import { ConnectionsService } from "./publishing/connections.service";
import { PublisherService } from "./publishing/publisher.service";
import { VersionsService } from "./versions.service";
import { CommentsService } from "./comments.service";

/** Fields a client may not overwrite through PATCH */
const LOCKED = ["_id", "id", "brandId", "order", "hash", "rev", "wid", "createdAt", "updatedAt", "publish", "media"];
/** Darken/lighten a hex color, same as the studio's shade() */
const shade = (h: string, k: number) => {
  const n = parseInt(h.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 + k))));
  return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(f).map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
};
const editable = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([k]) => !LOCKED.includes(k)));

/** REST access to brands, designs and posts (for integrations, scripts and future clients). */
@Injectable()
export class BrandsService implements OnModuleInit {
  private readonly log = new Logger("BrandsService");

  constructor(
    @InjectModel(SocialBrand.name) private readonly brands: Model<SocialBrand>,
    @InjectModel(SocialDesign.name) private readonly designs: Model<SocialDesign>,
    @InjectModel(SocialPost.name) private readonly posts: Model<SocialPost>,
    @InjectModel(SocialTemplate.name) private readonly templates: Model<SocialTemplate>,
    @InjectModel(SocialWorkspace.name) private readonly workspaces: Model<SocialWorkspace>,
    private readonly conns: ConnectionsService,
    private readonly publisher: PublisherService,
    private readonly versions: VersionsService,
    private readonly comments: CommentsService,
  ) {}

  /**
   * Templates used to be stored inside the brand document (brand.templates). Move them to
   * their own collection once, so a brand with many image-heavy templates can still be saved.
   */
  async onModuleInit() {
    const legacy = await this.brands.find({ "templates.0": { $exists: true } }, { templates: 1 }).lean<{ _id: string; templates: Record<string, any>[] }[]>();
    for (const b of legacy) {
      const list = b.templates.filter((t) => t && t.id);
      const ops = list.map((t, order) => ({
        updateOne: { filter: { brandId: b._id, id: String(t.id) }, update: { $setOnInsert: { ...t, name: t.name || "Untitled template", brandId: b._id, order, hash: hashOf(t) } }, upsert: true },
      }));
      if (ops.length) await this.templates.bulkWrite(ops, { ordered: false });
      await this.brands.updateOne({ _id: b._id }, { $unset: { templates: 1 } });
      this.log.log(`Moved ${list.length} template(s) of brand "${b._id}" to social_templates`);
    }
  }

  private brandOut(b: Record<string, any>) {
    return { id: b._id, ...strip(b) };
  }

  private async mustBrand(id: string) {
    const b = await this.brands.findById(id).lean();
    if (!b) throw new NotFoundException(`Brand "${id}" not found`);
    return b;
  }

  /* ---------- brands ---------- */
  async listBrands() {
    const [list, designs, posts] = await Promise.all([
      this.brands.find().sort({ order: 1 }).lean(),
      this.designs.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$brandId", n: { $sum: 1 } } }]),
      this.posts.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$brandId", n: { $sum: 1 } } }]),
    ]);
    const count = (a: { _id: string; n: number }[], id: string) => a.find((x) => x._id === id)?.n ?? 0;
    return list.map((b) => ({ ...this.brandOut(b), counts: { designs: count(designs, b._id), posts: count(posts, b._id) } }));
  }

  async getBrand(id: string) {
    return this.brandOut(await this.mustBrand(id));
  }

  async createBrand(dto: CreateBrandDto) {
    const { id, color, ...rest } = dto;
    const _id = id || "b" + newId();
    const col = color || "#6366f1";
    const order = await this.brands.countDocuments();
    const name = String(rest.name);
    const words = name.trim().split(/\s+/).filter(Boolean);
    const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
    // Same defaults as "Add brand" in the studio
    const doc = await this.brands.create({
      initials,
      handle: "", website: "", industry: "", tagline: "", about: "", audience: "", voice: "", dos: "", donts: "", hashtags: "", cta: "",
      lang: "English",
      defaultRatio: "4:5",
      colors: [["Primary", col], ["Dark", "#0B1220"], ["Light", "#F8FAFC"], ["Neutral", "#94A3B8"], ["Accent", shade(col, -0.28)]].map(([n, hex]) => ({ id: "c" + newId(), name: n, hex })),
      fonts: { heading: "Plus Jakarta Sans", body: "Inter", arabic: "Cairo" },
      ideas: [
        { t: "Announce " + name + " with a launch post", cat: "Announcement", p: 80, tpl: "launch" },
        { t: "Share a customer quote as a social proof post", cat: "Proof", p: 60, tpl: "testimonial" },
      ],
      ...editable(rest),
      _id,
      order,
    });
    return this.brandOut(doc.toObject());
  }

  async updateBrand(id: string, body: Record<string, unknown>) {
    const b = await this.brands.findByIdAndUpdate(id, { $set: editable(body) }, { new: true }).lean();
    if (!b) throw new NotFoundException(`Brand "${id}" not found`);
    return this.brandOut(b);
  }

  async deleteBrand(id: string) {
    await this.mustBrand(id);
    await Promise.all([
      this.brands.deleteOne({ _id: id }), this.designs.deleteMany({ brandId: id }), this.posts.deleteMany({ brandId: id }), this.templates.deleteMany({ brandId: id }),
      this.conns.removeBrand([id]), this.publisher.removeBrand([id]),
    ]);
    const ws = await this.workspaces.findById(WORKSPACE_ID).lean();
    if (ws?.active === id) {
      const first = await this.brands.findOne().sort({ order: 1 }).lean();
      await this.workspaces.updateOne({ _id: WORKSPACE_ID }, { $set: { active: first?._id ?? "" } });
    }
    return { ok: true };
  }

  /* ---------- designs ---------- */
  async listDesigns(brandId: string, q?: string) {
    await this.mustBrand(brandId);
    const filter: Record<string, unknown> = { brandId };
    if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    return (await this.designs.find(filter).sort({ order: 1 }).lean()).map(withAt);
  }

  async getDesign(brandId: string, id: string) {
    const d = await this.designs.findOne({ brandId, id }).lean();
    if (!d) throw new NotFoundException(`Design "${id}" not found`);
    return withAt(d);
  }

  async createDesign(brandId: string, dto: CreateDesignDto) {
    await this.mustBrand(brandId);
    const item = { status: "Draft", source: "Template", upd: "Just now", ratio: "4:5", tpl: "blank", ...dto, id: dto.id || "d" + newId() };
    // New designs go first in the library, like in the studio
    await this.designs.updateMany({ brandId }, { $inc: { order: 1 } });
    const doc = await this.designs.create({ ...item, brandId, order: 0, hash: hashOf(item), rev: 1 });
    return withAt(doc.toObject());
  }

  async updateDesign(brandId: string, id: string, body: Record<string, unknown>) {
    const d = await this.designs.findOneAndUpdate({ brandId, id }, { $set: { ...dropAt(editable(body)), hash: "" }, $inc: { rev: 1 }, $unset: { wid: 1 } }, { new: true }).lean();
    if (!d) throw new NotFoundException(`Design "${id}" not found`);
    return withAt(d);
  }

  async deleteDesign(brandId: string, id: string) {
    const r = await this.designs.deleteOne({ brandId, id });
    if (!r.deletedCount) throw new NotFoundException(`Design "${id}" not found`);
    await this.posts.deleteMany({ brandId, d: id });
    await this.versions.removeFor([{ brandId, id }]);
    await this.comments.removeFor([{ brandId, id }]);
    return { ok: true };
  }

  /* ---------- brand templates ---------- */
  async listTemplates(brandId: string) {
    await this.mustBrand(brandId);
    return (await this.templates.find({ brandId }).sort({ order: 1 }).lean()).map(strip);
  }

  async createTemplate(brandId: string, dto: CreateTemplateDto) {
    await this.mustBrand(brandId);
    const item = { ...dto, name: dto.name.trim(), id: dto.id || "t" + newId() };
    // Newest first, like the studio's list
    await this.templates.updateMany({ brandId }, { $inc: { order: 1 } });
    const doc = await this.templates.findOneAndUpdate(
      { brandId, id: item.id },
      { $set: { ...item, brandId, order: 0, hash: hashOf(item) } },
      { upsert: true, new: true },
    ).lean();
    return strip(doc);
  }

  async updateTemplate(brandId: string, id: string, dto: UpdateTemplateDto) {
    const $set: Record<string, unknown> = { ...editable(dto as Record<string, unknown>), hash: "" };
    if (typeof dto.name === "string") $set.name = dto.name.trim();
    const t = await this.templates.findOneAndUpdate({ brandId, id }, { $set }, { new: true }).lean();
    if (!t) throw new NotFoundException(`Template "${id}" not found`);
    return strip(t);
  }

  async deleteTemplate(brandId: string, id: string) {
    const r = await this.templates.deleteOne({ brandId, id });
    if (!r.deletedCount) throw new NotFoundException(`Template "${id}" not found`);
    return { ok: true };
  }

  /* ---------- posts ---------- */
  async listPosts(brandId: string, from?: string, to?: string, status?: string) {
    await this.mustBrand(brandId);
    const filter: Record<string, any> = { brandId };
    if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    if (status) filter.status = status;
    return (await this.posts.find(filter).sort({ date: 1, time: 1 }).lean()).map(strip);
  }

  async createPost(brandId: string, dto: CreatePostDto) {
    await this.mustBrand(brandId);
    if (!(await this.designs.exists({ brandId, id: dto.d }))) throw new NotFoundException(`Design "${dto.d}" not found`);
    const item = { status: "Scheduled", ...dto, id: dto.id || "p" + newId() };
    const order = await this.posts.countDocuments({ brandId });
    const doc = await this.posts.create({ ...item, brandId, order, hash: hashOf(item) });
    return strip(doc.toObject());
  }

  async updatePost(brandId: string, id: string, body: Record<string, unknown>) {
    const p = await this.posts.findOneAndUpdate({ brandId, id }, { $set: { ...editable(body), hash: "" } }, { new: true }).lean();
    if (!p) throw new NotFoundException(`Post "${id}" not found`);
    return strip(p);
  }

  async deletePost(brandId: string, id: string) {
    const r = await this.posts.deleteOne({ brandId, id });
    if (!r.deletedCount) throw new NotFoundException(`Post "${id}" not found`);
    return { ok: true };
  }
}
