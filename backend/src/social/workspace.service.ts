import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { AnyBulkWriteOperation, Model } from "mongoose";
import { BrandUpsert, WorkspaceDeltaDto, WorkspaceDto } from "./dto/workspace.dto";
import { SocialBrand } from "./schemas/brand.schema";
import { SocialDesign } from "./schemas/design.schema";
import { SocialPost } from "./schemas/post.schema";
import { SocialTemplate } from "./schemas/template.schema";
import { SocialWorkspace, WORKSPACE_ID } from "./schemas/workspace.schema";
import { dropAt, hashOf, strip, withAt } from "./social.util";
import { mergePost } from "./publishing/post-state";
import { ConnectionsService } from "./publishing/connections.service";
import { NotionService } from "./notion/notion.service";
import { PublisherService } from "./publishing/publisher.service";
import { VersionsService } from "./versions.service";
import { CommentsService } from "./comments.service";

type Item = Record<string, any> & { id: string };

/**
 * Maps the studio's in-memory snapshot ({ brands, data, active, set }) onto
 * normalized collections: brands, designs, posts and workspaces.
 */
@Injectable()
export class WorkspaceService {
  constructor(
    @InjectModel(SocialBrand.name) private readonly brands: Model<SocialBrand>,
    @InjectModel(SocialDesign.name) private readonly designs: Model<SocialDesign>,
    @InjectModel(SocialPost.name) private readonly posts: Model<SocialPost>,
    @InjectModel(SocialTemplate.name) private readonly templates: Model<SocialTemplate>,
    @InjectModel(SocialWorkspace.name) private readonly workspaces: Model<SocialWorkspace>,
    private readonly conns: ConnectionsService,
    private readonly publisher: PublisherService,
    private readonly notion: NotionService,
    private readonly versions: VersionsService,
    private readonly comments: CommentsService,
  ) {}

  /** Rebuilds the snapshot the client expects, or null when nothing was saved yet. */
  async get(): Promise<WorkspaceDto | null> {
    const ws = await this.workspaces.findById(WORKSPACE_ID).lean();
    const [brands, designs, posts, templates] = await Promise.all([
      this.brands.find().sort({ order: 1 }).lean(),
      this.designs.find().sort({ order: 1 }).lean(),
      this.posts.find().sort({ order: 1 }).lean(),
      this.templates.find().sort({ order: 1 }).lean(),
    ]);
    if (!brands.length) return null;

    const data: WorkspaceDto["data"] = {};
    const kits = brands.map((b) => {
      const { platforms, ideas, articles, extraData, ...kit } = b as Record<string, any>;
      data[b._id] = { designs: [], posts: [], platforms: platforms || {}, ideas: ideas || [], articles: articles || [], ...(extraData || {}) };
      // Brand templates have their own collection (see BrandsService)
      return { id: b._id, ...strip(kit), templates: templates.filter((t) => t.brandId === b._id).map(strip) };
    });
    designs.forEach((d) => data[d.brandId]?.designs.push(withAt(d)));
    posts.forEach((p) => data[p.brandId]?.posts.push(strip(p)));

    const active = ws && kits.some((b) => b.id === ws.active) ? ws.active : kits[0].id;
    return { brands: kits, data, active, ...(ws?.set ? { set: ws.set } : {}) };
  }

  private brandDoc({ id, kit, content }: BrandUpsert, order: number) {
    // templates are written through /social/brands/:id/templates only, never by the kit sync
    const { id: _id, templates: _templates, ...fields } = kit;
    const { designs, posts, platforms = {}, ideas = [], articles = [], ...extraData } = content || {};
    return { ...fields, _id: String(id), order, platforms, ideas, articles, extraData } as any;
  }

  /**
   * Replaces the whole workspace with a snapshot (e.g. restoring an "Export JSON" backup).
   * Unchanged designs/posts are skipped using a content hash.
   */
  async replace(dto: WorkspaceDto) {
    const brandIds = dto.brands.map((b) => String(b.id));

    await this.brands.bulkWrite(
      dto.brands.map(
        (b, order): AnyBulkWriteOperation => ({
          replaceOne: { filter: { _id: String(b.id) }, replacement: this.brandDoc({ id: b.id, kit: b, content: dto.data[b.id] }, order), upsert: true },
        }),
      ),
      { ordered: false },
    );
    const gone = (await this.brands.find({ _id: { $nin: brandIds } }, { _id: 1 }).lean()).map((b) => String(b._id));
    await Promise.all([
      this.brands.deleteMany({ _id: { $nin: brandIds } }),
      this.designs.deleteMany({ brandId: { $nin: brandIds } }),
      this.posts.deleteMany({ brandId: { $nin: brandIds } }),
      this.templates.deleteMany({ brandId: { $nin: brandIds } }),
      this.conns.removeBrand(gone),
      this.publisher.removeBrand(gone),
    ]);

    for (const b of dto.brands) {
      const id = String(b.id), d = dto.data[id] || {};
      await Promise.all([
        this.syncItems(this.designs, id, d.designs || []),
        this.syncItems(this.posts, id, d.posts || []),
        this.syncItems(this.templates, id, Array.isArray(b.templates) ? b.templates : []),
      ]);
    }

    const ws = await this.workspaces.findByIdAndUpdate(
      WORKSPACE_ID,
      { $set: { active: dto.active || brandIds[0], set: dto.set ?? {} } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { ok: true, updatedAt: (ws as any)?.updatedAt };
  }

  /**
   * Applies the studio's incremental sync. Only items listed are written; only items the
   * client explicitly deleted are removed, so concurrent tabs / API clients don't clobber
   * each other (last write wins per brand, design or post).
   */
  async applyDelta(dto: WorkspaceDeltaDto) {
    const del = dto.deleted || {};
    if (del.brands?.length) {
      const ids = del.brands;
      await Promise.all([
        this.brands.deleteMany({ _id: { $in: ids } }),
        this.designs.deleteMany({ brandId: { $in: ids } }),
        this.posts.deleteMany({ brandId: { $in: ids } }),
        this.templates.deleteMany({ brandId: { $in: ids } }),
        this.conns.removeBrand(ids),
        this.publisher.removeBrand(ids),
        this.versions.removeBrands(ids),
        this.comments.removeBrands(ids),
      ]);
    }

    if (dto.brands?.length) {
      const existing = new Map((await this.brands.find({}, { order: 1 }).lean()).map((b) => [b._id, b.order]));
      let next = existing.size;
      const orderOf = (id: string) => {
        const i = dto.brandOrder?.indexOf(id) ?? -1;
        return i >= 0 ? i : existing.get(id) ?? next++;
      };
      await this.brands.bulkWrite(
        dto.brands.map((b): AnyBulkWriteOperation => ({
          replaceOne: { filter: { _id: b.id }, replacement: this.brandDoc(b, orderOf(b.id)), upsert: true },
        })),
        { ordered: false },
      );
    }
    if (dto.brandOrder?.length) {
      await this.brands.bulkWrite(dto.brandOrder.map((id, order) => ({ updateOne: { filter: { _id: id }, update: { $set: { order } } } })));
    }

    const designs = await this.applyDesigns(dto.designs);
    await this.applyItems(this.designs, [], dto.designOrder, del.designs);
    await this.versions.removeFor(del.designs || []); // a deleted design's history and comments go with it
    await this.comments.removeFor(del.designs || []);
    await this.applyItems(this.posts, dto.posts, dto.postOrder, del.posts);
    if (dto.posts?.length || del.posts?.length) this.notion.reconcileSoon(); // Notion Calendar, when it shows every post

    const $set: Record<string, unknown> = {};
    if (dto.active !== undefined) $set.active = dto.active;
    if (dto.set !== undefined) $set.set = dto.set;
    if (Object.keys($set).length) await this.workspaces.updateOne({ _id: WORKSPACE_ID }, { $set }, { upsert: true });
    return { ok: true, ...designs };
  }

  /**
   * Design upserts with optimistic concurrency. Each one carries `rev`, the revision the client's copy is based on:
   * - same content as stored (hash): nothing is written;
   * - `rev` is the stored revision: the design is replaced and its revision goes up by one;
   * - `rev` is older (another tab or user saved meanwhile): refused, the stored design comes back in `conflicts`.
   * Upserts without `rev` (older clients) are written as before. Returns the revision of every design listed.
   */
  private async applyDesigns(upserts: { brandId: string; item: Item; rev?: number }[] = []) {
    const revs: Record<string, number> = {};
    const conflicts: { brandId: string; item: Item; rev: number }[] = [];
    const list = upserts.filter((u) => u.item && u.item.id).map((u) => ({ ...u, item: dropAt(u.item) as Item }));
    if (!list.length) return { revs, conflicts };
    type Row = { brandId: string; id: string; order: number; hash?: string; rev?: number };
    const stored = new Map(
      (await this.designs.find({ $or: list.map(({ brandId, item }) => ({ brandId, id: item.id })) }, { brandId: 1, id: 1, order: 1, hash: 1, rev: 1 }).lean<Row[]>())
        .map((r) => [`${r.brandId}|${r.id}`, r]),
    );
    /** Refused save; when the stored design already has this content (the same save delivered twice), it's not a conflict */
    const conflict = async (brandId: string, id: string, hash?: string) => {
      const d = await this.designs.findOne({ brandId, id }).lean<Record<string, any>>();
      if (!d) return;
      if (hash && d.hash === hash) return void (revs[`${brandId}|${id}`] = d.rev ?? 0);
      const { rev = 0, ...item } = withAt(d);
      conflicts.push({ brandId, item: item as Item, rev });
    };

    await Promise.all(list.map(async ({ brandId, item: raw, rev }) => {
      const { rev: _ignored, ...item } = raw as Item & { rev?: number };
      const key = `${brandId}|${item.id}`, prev = stored.get(key), cur = prev?.rev ?? 0, hash = hashOf(item);
      if (prev && prev.hash === hash) return void (revs[key] = cur);
      if (prev && rev !== undefined && rev !== cur) return conflict(brandId, item.id, hash);
      const replacement = { ...item, brandId, order: prev?.order ?? Number.MAX_SAFE_INTEGER, hash, rev: cur + 1 };
      // The filter repeats the revision just read, so a save that lands in between matches nothing: a conflict, not an overwrite
      const filter = prev ? { brandId, id: item.id, rev: prev.rev ?? { $exists: false } } : { brandId, id: item.id };
      try {
        const r = await this.designs.replaceOne(filter, replacement, { upsert: !prev });
        if (prev && !r.matchedCount) return conflict(brandId, item.id, hash);
      } catch (e: any) {
        if (e?.code === 11000) return conflict(brandId, item.id, hash); // created by another client at the same moment
        throw e;
      }
      revs[key] = cur + 1;
    }));
    return { revs, conflicts };
  }

  private async applyItems(
    model: Model<any>,
    upserts: { brandId: string; item: Item }[] = [],
    order: Record<string, string[]> = {},
    deleted: { brandId: string; id: string }[] = [],
  ) {
    const pos = (brandId: string, id: string) => order[brandId]?.indexOf(id) ?? -1;
    const list = upserts.filter((u) => u.item && u.item.id).map((u) => ({ ...u, item: dropAt(u.item) as Item }));
    const owned = await this.serverOwned(model, list);
    // An edit without a new order (rename, status…) keeps the item where it was
    const unplaced = list.filter(({ brandId, item }) => pos(brandId, item.id) < 0);
    const prev = unplaced.length
      ? new Map((await model.find({ $or: unplaced.map(({ brandId, item }) => ({ brandId, id: item.id })) }, { brandId: 1, id: 1, order: 1 }).lean<{ brandId: string; id: string; order: number }[]>()).map((r) => [`${r.brandId}|${r.id}`, r.order]))
      : new Map<string, number>();
    const ops: AnyBulkWriteOperation[] = list.map(({ brandId, item }) => {
      const i = pos(brandId, item.id), doc = owned ? mergePost(owned.get(`${brandId}|${item.id}`), item) : item;
      return {
        replaceOne: {
          filter: { brandId, id: item.id },
          replacement: { ...doc, brandId, order: i >= 0 ? i : prev.get(`${brandId}|${item.id}`) ?? Number.MAX_SAFE_INTEGER, hash: hashOf(item) },
          upsert: true,
        },
      };
    });
    Object.entries(order).forEach(([brandId, ids]) =>
      ids.forEach((id, i) => ops.push({ updateOne: { filter: { brandId, id }, update: { $set: { order: i } } } })),
    );
    if (ops.length) await model.bulkWrite(ops, { ordered: true });
    if (deleted.length) await model.deleteMany({ $or: deleted.map(({ brandId, id }) => ({ brandId, id })) });
  }

  /** Posts carry fields only the publisher writes (publish, media): load them so upserts keep them. */
  private async serverOwned(model: Model<any>, list: { brandId: string; item: Item }[]) {
    if (model !== (this.posts as Model<any>) || !list.length) return null;
    const rows = await model.find({ $or: list.map(({ brandId, item }) => ({ brandId, id: item.id })) }).select("brandId id status date time publish media review").lean<Record<string, any>[]>();
    return new Map(rows.map((r) => [`${r.brandId}|${r.id}`, r]));
  }

  private async syncItems(model: Model<any>, brandId: string, items: Item[]) {
    const list = items.filter((i) => i && i.id).map((i) => dropAt(i) as Item);
    const existing = new Map(
      (await model.find({ brandId }, { id: 1, hash: 1, order: 1, rev: 1 }).lean<{ id: string; hash?: string; order: number; rev?: number }[]>()).map((e) => [e.id, e]),
    );
    const ops: AnyBulkWriteOperation[] = [];
    const owned = await this.serverOwned(model, list.map((item) => ({ brandId, item })));
    list.forEach((item, order) => {
      const hash = hashOf(item);
      const prev = existing.get(item.id);
      if (prev && prev.hash === hash && prev.order === order) return;
      const doc = owned ? mergePost(owned.get(`${brandId}|${item.id}`), item) : item;
      const rev = model === (this.designs as Model<any>) ? { rev: (prev?.rev ?? 0) + 1 } : {};
      ops.push({ replaceOne: { filter: { brandId, id: item.id }, replacement: { ...doc, brandId, order, hash, ...rev }, upsert: true } });
    });
    if (ops.length) await model.bulkWrite(ops, { ordered: false });
    await model.deleteMany({ brandId, id: { $nin: list.map((i) => i.id) } });
  }

  /** Wipes everything; the client seeds the demo workspace again on next load. */
  async reset() {
    await Promise.all([this.brands.deleteMany({}), this.designs.deleteMany({}), this.posts.deleteMany({}), this.templates.deleteMany({}), this.workspaces.deleteMany({})]);
    return { ok: true };
  }

  async getSettings() {
    const ws = await this.workspaces.findById(WORKSPACE_ID).lean();
    return { active: ws?.active ?? null, set: ws?.set ?? {} };
  }

  async patchSettings(body: { active?: string; set?: Record<string, unknown> }) {
    const $set: Record<string, unknown> = {};
    if (typeof body.active === "string") $set.active = body.active;
    Object.entries(body.set || {}).forEach(([k, v]) => ($set["set." + k] = v));
    await this.workspaces.updateOne({ _id: WORKSPACE_ID }, { $set }, { upsert: true });
    return this.getSettings();
  }
}
