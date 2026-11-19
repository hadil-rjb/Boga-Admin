import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { decrypt, encrypt } from "../common/crypto";
import { Article, ArticleDocument } from "../articles/article.schema";
import { Actor, ActivityService } from "../share/activity.service";
import { FramerSettings, FramerSettingsDocument } from "./framer-settings.schema";
import { UpdateFramerSettingsDto } from "./dto/framer.dto";
import { parseFramerProject, withFramer } from "./framer.client";
import { validTz, zonedToUtc } from "./time";
import { publicOrigin } from "../common/public-url";
import { diff, itemToArticle, type DiffField, type Fld, type Item, type Pulled, type Resolved } from "./pull";

/** Champs de l'article → noms de champs Framer reconnus automatiquement (insensible à la casse). */
export const MAP_KEYS = ["title", "meta", "sub", "cat", "tags", "html", "img", "alt", "date"] as const;
export type MapKey = (typeof MAP_KEYS)[number];
const GUESS: Record<MapKey, string[]> = {
  title: ["title", "name", "headline"],
  meta: ["meta description", "description", "meta", "seo description", "excerpt", "summary"],
  sub: ["subtitle", "sub title", "subheading", "sub"],
  cat: ["category", "categories"],
  tags: ["tags", "tag"],
  html: ["content", "body", "article", "post", "text"],
  img: ["cover image", "cover", "featured image", "thumbnail", "image", "hero image"],
  alt: ["alt text", "image alt", "cover alt", "alt"],
  date: ["publish date", "published at", "published", "publication date", "date"],
};
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const abs = (u: string, base: string) => (u.startsWith("/") ? base.replace(/\/$/, "") + u : u);

@Injectable()
export class FramerService {
  private log = new Logger("Framer");
  private secret: string;
  private publicApi: string;
  private running = false; // une seule synchronisation à la fois (une connexion WebSocket = un projet)

  constructor(
    @InjectModel(FramerSettings.name) private settings: Model<FramerSettingsDocument>,
    @InjectModel(Article.name) private articles: Model<ArticleDocument>,
    private act: ActivityService,
    cfg: ConfigService,
  ) {
    this.secret = cfg.getOrThrow<string>("JWT_SECRET");
    this.publicApi = publicOrigin(cfg.get<string>("PUBLIC_API_URL"));
  }

  /* ───────────── Réglages ───────────── */
  async load() { return (await this.settings.findOne().select("+apiKey")) ?? (await this.settings.create({ timezone: process.env.PUBLISH_TIMEZONE || "Africa/Tunis" })); }
  private creds(s: FramerSettingsDocument) {
    let key = process.env.FRAMER_API_KEY || "";
    if (s.apiKey) { try { key = decrypt(s.apiKey, this.secret); } catch { /* clé illisible (JWT_SECRET changé) */ } }
    return { url: s.projectUrl || process.env.FRAMER_PROJECT_URL || "", key };
  }
  async view() {
    const s = await this.load(), { url, key } = this.creds(s);
    const counts = await this.articles.aggregate([{ $match: { status: "Scheduled" } }, { $group: { _id: "$framerState", n: { $sum: 1 } } }]);
    return {
      enabled: s.enabled, projectUrl: url, hasKey: !!key, last4: key ? key.slice(-4) : "", collectionId: s.collectionId, collectionName: s.collectionName,
      fieldMap: s.fieldMap ?? {}, publish: s.publish, deploy: s.deploy, timezone: s.timezone,
      ready: !!(url && key && s.collectionId), pendingErrors: counts.find(c => c._id === "error")?.n ?? 0,
    };
  }
  /** Version minimale pour les éditeurs (aucun secret) */
  async status() { const v = await this.view(); return { enabled: v.enabled, ready: v.ready, timezone: v.timezone, publish: v.publish, deploy: v.deploy }; }
  async update(dto: UpdateFramerSettingsDto, actor: Actor) {
    const s = await this.load();
    if (dto.projectUrl !== undefined) {
      s.projectUrl = parseFramerProject(dto.projectUrl); // lève une erreur claire si l'URL n'est pas celle d'un projet Framer
    }
    if (dto.apiKey?.trim()) s.apiKey = encrypt(dto.apiKey.trim(), this.secret);
    if (dto.clearKey) s.apiKey = undefined;
    if (dto.timezone) { if (!validTz(dto.timezone)) throw new BadRequestException("Unknown time zone (use e.g. Africa/Tunis, Europe/Paris)"); s.timezone = dto.timezone; }
    if (dto.publish !== undefined) s.publish = dto.publish;
    if (dto.deploy !== undefined) s.deploy = dto.deploy;
    if (dto.fieldMap) { s.fieldMap = Object.fromEntries(MAP_KEYS.map(k => [k, String(dto.fieldMap![k] ?? "")])); s.markModified("fieldMap"); }
    if (dto.collectionId !== undefined && dto.collectionId !== s.collectionId) { s.collectionId = dto.collectionId; s.collectionName = ""; s.fieldMap = {}; s.markModified("fieldMap"); }
    await s.save(); // on enregistre d'abord : une connexion refusée ne fait pas perdre l'URL / la clé saisies
    // Vérifie la connexion avant d'activer (clé valide + collection existante)
    const { url, key } = this.creds(s);
    if (dto.enabled === true || dto.apiKey?.trim() || dto.collectionId) {
      const cols = await withFramer(url, key, async f => (await f.getCollections()).map((c: any) => ({ id: c.id, name: c.name })));
      if (s.collectionId) {
        const c = cols.find((x: any) => x.id === s.collectionId);
        if (!c) throw new BadRequestException("That CMS collection no longer exists in the Framer project");
        s.collectionName = c.name;
      }
    }
    if (dto.enabled !== undefined) {
      if (dto.enabled && !(url && key && s.collectionId)) throw new BadRequestException("Add the project URL, API key and pick the blog collection before enabling auto-publish");
      s.enabled = dto.enabled;
    }
    await s.save();
    await this.act.record({ kind: "share", action: "framer", actorId: actor.id ?? undefined, actorName: actor.name, target: `Framer · ${s.enabled ? "auto-publish on" : "off"}${s.collectionName ? " · " + s.collectionName : ""}` });
    return this.view();
  }

  /** Collections du projet (pour choisir la collection « blog ») */
  async collections() {
    const s = await this.load(), { url, key } = this.creds(s);
    return withFramer(url, key, async f => (await f.getCollections()).map((c: any) => ({ id: c.id, name: c.name, managedBy: c.managedBy })));
  }
  /** Champs de la collection choisie + correspondance automatique proposée */
  async fields() {
    const s = await this.load(), { url, key } = this.creds(s);
    if (!s.collectionId) throw new BadRequestException("Pick the blog collection first");
    return withFramer(url, key, async f => {
      const col = await f.getCollection(s.collectionId);
      if (!col) throw new NotFoundException("Collection not found");
      const fields = (await col.getFields()).map((x: any) => ({ id: x.id, name: x.name, type: x.type }));
      const tf = this.tagFields(fields), img = this.autoField("img", fields);
      const names: Record<string, string> = Object.fromEntries(MAP_KEYS.map(k => [k, this.autoField(k, fields)?.name ?? ""]));
      if (tf.length) names.tags = tf.map(f => f.name).join(" + ");
      if (!names.alt && img) names.alt = `${img.name} (alt text)`; // l'alt vit dans le champ image lui-même
      return { fields, auto: Object.fromEntries(MAP_KEYS.map(k => [k, this.autoField(k, fields)?.id ?? ""])), autoNames: names };
    });
  }
  /** Champs « Tag 1 / Tag 2 / Tag 3 … » (triés par numéro) */
  private tagFields<T extends { name: string }>(fields: T[]): T[] {
    const n = (f: T) => { const m = /^tags?\s*(\d+)$/.exec(norm(f.name)); return m ? +m[1] : 0; };
    return fields.filter(f => n(f) > 0).sort((a, b) => n(a) - n(b));
  }
  private autoField(k: MapKey, fields: { id: string; name: string; type: string }[]) {
    for (const g of GUESS[k]) { const f = fields.find(x => norm(x.name) === g); if (f) return f; }
    return undefined;
  }

  /* ───────────── Synchronisation d'un article ───────────── */
  /** Ajoute (ou met à jour) l'article dans la collection CMS, puis publie le site. Idempotent : le slug identifie l'élément. */
  async syncArticle(slug: string): Promise<{ itemId: string; note: string; preview: string[] }> {
    if (this.running) throw new BadRequestException("Another Framer publish is in progress — try again in a moment");
    this.running = true;
    try {
      const s = await this.load(), { url, key } = this.creds(s);
      if (!url || !key || !s.collectionId) throw new BadRequestException("Framer is not configured (Settings → Framer)");
      const a = await this.articles.findOne({ slug }).lean();
      if (!a) throw new NotFoundException("Article introuvable");
      return await withFramer(url, key, async f => {
        const col = await f.getCollection(s.collectionId);
        if (!col) throw new BadRequestException("The CMS collection no longer exists in Framer");
        const fields: { id: string; name: string; type: string; cases?: any[] }[] = await col.getFields();
        const notes: string[] = [];
        const data: Record<string, any> = {};
        for (const k of MAP_KEYS) {
          const pick = s.fieldMap?.[k];
          if (pick === "-") continue;
          if (k === "tags" && !pick) {
            const tf = this.tagFields(fields);
            if (tf.length) { // un tag par champ : Tag 1, Tag 2, Tag 3…
              const tags = (a.t ?? []).map((x: string) => String(x).trim()).filter(Boolean);
              tf.forEach((fld, i) => { const v = this.text(tags[i] ?? "", fld.type); if (v) data[fld.id] = v; });
              if (tags.length > tf.length) notes.push(`${tags.length - tf.length} tag(s) not sent: the collection only has ${tf.length} tag field(s)`);
              continue;
            }
          }
          const fld = pick ? fields.find(x => x.id === pick) : this.autoField(k, fields);
          if (!fld) { if (["title", "html"].includes(k)) notes.push(`No Framer field matched “${k}”`); continue; }
          const v = await this.value(k, a, fld, f, notes, s.timezone);
          if (v) data[fld.id] = v;
        }
        const items: any[] = await col.getItems();
        const existing = items.find(i => i.slug === a.slug);
        if (existing) await existing.setAttributes({ slug: a.slug, draft: false, fieldData: data }); // fieldData obligatoire, sinon ignoré en silence
        else await col.addItems([{ slug: a.slug, draft: false, fieldData: data }]);
        const id = existing?.id ?? (await col.getItems()).find((i: any) => i.slug === a.slug)?.id ?? "";

        let preview: string[] = [];
        if (s.publish) {
          const r = await f.publish();           // déploiement « preview »
          preview = r?.hostnames?.map((h: any) => h.hostname ?? h) ?? [];
          if (s.deploy) await f.deploy(r.deployment.id); // promotion en production
        }
        return { itemId: String(id), note: notes.join(" · "), preview };
      });
    } finally { this.running = false; }
  }

  private async value(k: MapKey, a: any, fld: { type: string; cases?: any[] }, f: any, notes: string[], tz: string) {
    const t = fld.type;
    const text = (s: string) => this.text(s, t);
    switch (k) {
      case "title": return text(a.title);
      case "meta": return text(a.meta || "");
      case "sub": return text(a.sub || "");
      case "alt": return text(a.alt || "");
      case "cat": {
        if (t === "enum") { const c = (fld.cases ?? []).find((x: any) => norm(x.name) === norm(a.cat)); if (!c) { if (a.cat) notes.push(`Category “${a.cat}” is not an option of the Framer field`); return null; } return { type: t, value: c.id ?? c.name }; }
        return text(a.cat || "");
      }
      case "tags": return text((a.t ?? []).filter(Boolean).join(", "));
      case "html": return t === "formattedText" || t === "string" ? { type: t, value: a.html || "" } : null;
      case "date": return t === "date" && a.date ? { type: t, value: zonedToUtc(a.date, a.time || "09:00", tz).toISOString() } : null;
      case "img": {
        if (t !== "image" || !a.img) return null;
        try { const asset = await this.upload(f, a.img, a.alt); return { type: t, value: asset.url, ...(a.alt ? { alt: a.alt } : {}) }; } // alt text = propriété du champ image
        catch (e: any) { notes.push(`Cover image not transferred (${String(e?.message ?? e).slice(0, 80)})`); return null; }
      }
    }
  }
  private text(s: string, t: string) { return t === "formattedText" ? { type: t, value: s ? `<p>${esc(s)}</p>` : "" } : t === "string" ? { type: t, value: s } : null; }
  /** Télécharge l'image côté serveur (data-URL, /api/media/… ou http) puis l'envoie à Framer en octets : fonctionne même en local. */
  private async upload(f: any, src: string, alt: string) {
    let bytes: Uint8Array, mimeType: string;
    const m = /^data:([^;]+);base64,(.+)$/s.exec(src);
    if (m) { mimeType = m[1]; bytes = new Uint8Array(Buffer.from(m[2], "base64")); }
    else {
      const r = await fetch(abs(src, this.publicApi), { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`image HTTP ${r.status}`);
      mimeType = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
      bytes = new Uint8Array(await r.arrayBuffer());
    }
    return f.uploadImage({ image: { bytes, mimeType }, altText: alt || undefined });
  }

  /* ───────────── « Get from Framer » : lecture de la collection (rien n'est envoyé à Framer) ───────────── */
  /** The collection's published items mapped to article fields, with the same field matching as publishing */
  private async readCollection(): Promise<{ items: (Pulled & { itemId: string })[]; drafts: number }> {
    const s = await this.load(), { url, key } = this.creds(s);
    if (!url || !key || !s.collectionId) throw new BadRequestException("Framer is not configured (Settings → Framer)");
    if (this.running) throw new BadRequestException("A Framer sync is in progress — try again in a moment");
    this.running = true;
    try {
      return await withFramer(url, key, async f => {
        const col = await f.getCollection(s.collectionId);
        if (!col) throw new BadRequestException("The CMS collection no longer exists in Framer");
        const fields: Fld[] = await col.getFields();
        const pick = (k: (typeof MAP_KEYS)[number]) => { const p = s.fieldMap?.[k]; return p === "-" ? undefined : p ? fields.find(x => x.id === p) : this.autoField(k, fields); };
        const r: Resolved = { tagFields: s.fieldMap?.tags ? [] : this.tagFields(fields) };
        for (const k of MAP_KEYS) (r as any)[k] = pick(k);
        const all: Item[] = await col.getItems();
        const live = all.filter(i => !i.draft && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(i.slug ?? ""));
        return { items: live.map(i => ({ ...itemToArticle(i, r, s.timezone), itemId: String(i.id ?? "") })), drafts: all.length - live.length };
      });
    } finally { this.running = false; }
  }

  /** Preview: what is new on Framer, what differs from the admin, what is the same. Nothing is saved. */
  async pullPreview() {
    const { items, drafts } = await this.readCollection();
    const have = new Map((await this.articles.find({ slug: { $in: items.map(i => i.slug) } }).select("slug title meta sub cat t html img alt date status").lean()).map(a => [a.slug, a]));
    const rows = items.map(i => {
      const a = have.get(i.slug);
      const changes: DiffField[] = a ? diff(a as any, i) : [];
      return { slug: i.slug, title: i.title || i.slug, date: i.date ?? "", img: i.img ?? "", state: !a ? "new" : changes.length ? "changed" : "same", changes, status: a?.status ?? null };
    });
    const order = { new: 0, changed: 1, same: 2 } as const;
    rows.sort((x, y) => order[x.state as keyof typeof order] - order[y.state as keyof typeof order] || (y.date || "").localeCompare(x.date || ""));
    return { items: rows, drafts };
  }

  /** Imports the chosen articles: new ones are created as Live, existing ones take Framer's version of the fields that differ. The collection is read again here, never taken from the browser. */
  async pullApply(slugs: string[], actor: Actor) {
    const want = new Set(slugs);
    const { items } = await this.readCollection();
    let created = 0, updated = 0;
    for (const i of items.filter(x => want.has(x.slug))) {
      const { itemId, slug, ...fields } = i;
      const a = await this.articles.findOne({ slug }).lean();
      const sync = { status: "Live", framerState: "synced", framerItemId: itemId, framerSyncedAt: new Date(), framerNote: "", framerTries: 0 };
      if (!a) {
        await this.articles.create({ slug, ...fields, title: fields.title || slug, t: fields.t ?? [], ...sync });
        created++;
      } else {
        const ch = diff(a as any, fields);
        const set: Record<string, unknown> = { ...sync };
        for (const k of ch) set[k] = (fields as any)[k];
        if (ch.includes("date") && fields.time) set.time = fields.time;
        await this.articles.updateOne({ slug }, { $set: set });
        updated++;
      }
      await this.act.record({ kind: "article", action: a ? "framer-pull-update" : "framer-pull-create", actorId: actor.id ?? undefined, actorName: actor.name, target: fields.title || slug, slug });
    }
    return { created, updated };
  }

  /* ───────────── Résultat enregistré sur l'article ───────────── */
  async runFor(slug: string, actor?: Actor) {
    try {
      const r = await this.syncArticle(slug);
      await this.articles.updateOne({ slug }, { $set: { status: "Live", framerState: "synced", framerItemId: r.itemId, framerSyncedAt: new Date(), framerNote: r.note, framerTries: 0 }, $unset: { framerNextTry: 1, framerLock: 1 } });
      await this.act.record({ kind: "article", action: "framer-publish", actorId: actor?.id ?? undefined, actorName: actor?.name ?? "Scheduler", target: slug, slug });
      return { ok: true, ...r };
    } catch (e: any) {
      const msg = String(e?.response?.message ?? e?.message ?? e).slice(0, 300);
      this.log.warn(`${slug}: ${msg}`);
      await this.articles.updateOne({ slug }, { $set: { framerState: "error", framerNote: msg }, $inc: { framerTries: 1 }, $unset: { framerLock: 1 } });
      throw e;
    }
  }
}
