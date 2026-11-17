import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { createHash, randomBytes } from "crypto";
import { Model } from "mongoose";
import sharp from "sharp";
import { decrypt, encrypt } from "../../common/crypto";
import { SocialIntegration, SocialOAuthState } from "../publishing/connection.schema";
import { ApiError, download, request } from "../publishing/http";
import { newId } from "../social.util";
import { canvasOf, convertFrame, defaultFont, parseFigmaUrl, STUDIO_FONTS } from "./convert";
import { publicApiBase } from "../../common/public-url";

/** Workspace connection (encrypted credentials) and picker preferences (default file, recent files, teams) */
const ID = "figma", PREFS = "figma:prefs";
const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);
/** A group with frames inside is browsed; any other group is imported like a frame */
const holdsFrames = (n: any): boolean => (n.children || []).some((c: any) => FRAME_TYPES.has(c.type) || (c.type === "GROUP" && holdsFrames(c)));
const MAX_FRAMES = 60, MAX_RECENT = 12;
/** Longest side of an embedded picture (px) */
const MAX_EMBED = 3200;
/** Scopes asked by default (enough to import, re-sync and pick files). Add folders:read in FIGMA_SCOPES to browse teams. */
const DEFAULT_SCOPES = "current_user:read file_content:read file_metadata:read";
const b64url = (b: Buffer) => b.toString("base64url");

/** OAuth credentials, or a personal access token saved before OAuth (still accepted, read-only) */
type Cred =
  | { kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: number; scopes?: string[]; userId?: string }
  | { kind: "pat"; token: string };
export type FigmaFile = { key: string; name: string; thumb?: string | null; lastModified?: string | null; at?: number };

/**
 * Figma for the studio: OAuth 2.0 connection (Connect Figma → figma.com consent → callback), token refresh,
 * file picker (default file, recent files, team folders), frame listing and conversion.
 * Docs: https://developers.figma.com/docs/rest-api/oauth-apps/
 */
@Injectable()
export class FigmaService {
  private log = new Logger("Figma");
  private refreshing?: Promise<Cred>;
  constructor(
    @InjectModel(SocialIntegration.name) private integ: Model<SocialIntegration>,
    @InjectModel(SocialOAuthState.name) private states: Model<SocialOAuthState>,
    private cfg: ConfigService,
  ) {}

  private env = (k: string) => (this.cfg.get<string>(k) || "").trim() || undefined;
  private get secret() { return this.cfg.getOrThrow<string>("JWT_SECRET"); }
  private get api() { return (this.env("FIGMA_API_URL") || "https://api.figma.com").replace(/\/$/, ""); }
  private get authorizeBase() { return this.env("FIGMA_OAUTH_URL") || "https://www.figma.com/oauth"; }
  private get apiUrl() { return publicApiBase(this.env("PUBLIC_API_URL")); }
  private get frontUrl() { return (this.env("FRONTEND_URL") || "http://localhost:3000").replace(/\/+$/, ""); }
  /**
   * Redirect URL sent to Figma: it must be one of the app's redirect URLs, character for character.
   * Default: the API callback. FIGMA_REDIRECT_URI can name another registered URL, e.g. the frontend page
   * <FRONTEND_URL>/social-media/figma/callback, which hands the code over to the API callback.
   */
  get redirectUri() { return this.env("FIGMA_REDIRECT_URI") || `${this.apiUrl}/social/figma/oauth/callback`; }
  private get scopes() { return (this.env("FIGMA_SCOPES") || DEFAULT_SCOPES).split(/[\s,]+/).filter(Boolean); }
  private get oauthReady() { return !!(this.env("FIGMA_CLIENT_ID") && this.env("FIGMA_CLIENT_SECRET")); }
  private basic() { return "Basic " + Buffer.from(`${this.env("FIGMA_CLIENT_ID")}:${this.env("FIGMA_CLIENT_SECRET")}`).toString("base64"); }

  /* ---------- credentials ---------- */
  private async cred(): Promise<Cred> {
    const doc = await this.integ.findById(ID).lean();
    if (!doc?.secret) throw new BadRequestException("Connect Figma first: Settings → Figma → Connect Figma");
    const raw = decrypt(doc.secret, this.secret);
    if (raw.startsWith("{")) { try { const c = JSON.parse(raw); if (c.kind === "oauth" && c.accessToken) return c; } catch {} }
    return { kind: "pat", token: raw };
  }
  private headers(c: Cred): Record<string, string> { return c.kind === "oauth" ? { Authorization: `Bearer ${c.accessToken}` } : { "X-Figma-Token": c.token }; }
  private async storeCred(c: Cred) { await this.integ.updateOne({ _id: ID }, { $set: { secret: encrypt(JSON.stringify(c), this.secret) } }); }

  /** Credentials ready for a call: OAuth tokens are refreshed a few minutes before they expire (or when forced after a 401). */
  private async fresh(force = false): Promise<Cred> {
    const c = await this.cred();
    if (c.kind !== "oauth" || !c.refreshToken || !this.oauthReady) return c;
    if (!force && (!c.expiresAt || c.expiresAt - Date.now() > 5 * 60_000)) return c;
    // one refresh at a time: refreshing invalidates the previous access token
    return (this.refreshing ??= this.refresh(c).finally(() => { this.refreshing = undefined; }));
  }
  private async refresh(c: Extract<Cred, { kind: "oauth" }>): Promise<Cred> {
    try {
      const r: any = await request(`${this.api}/v1/oauth/refresh`, { method: "POST", headers: { Authorization: this.basic() }, form: { refresh_token: c.refreshToken! } });
      const next: Cred = { ...c, accessToken: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) || 90 * 86400) * 1000 };
      await this.storeCred(next);
      return next;
    } catch (e: any) {
      this.log.warn(`Figma token refresh failed: ${e.message}`);
      await this.integ.updateOne({ _id: ID }, { $set: { "info.error": "Figma sign-in expired. Connect Figma again." } });
      throw new BadRequestException("Your Figma sign-in expired. Connect Figma again in Settings → Figma.");
    }
  }

  private async get(path: string, cred?: Cred): Promise<any> {
    let c = cred ?? (await this.fresh());
    const call = (x: Cred) => request(`${this.api}${path}`, { headers: this.headers(x), timeoutMs: 60_000 });
    try {
      return await call(c);
    } catch (e: any) {
      let err = e;
      // an OAuth token rejected before its expiry date: refresh once and retry
      if (!cred && c.kind === "oauth" && c.refreshToken && e.status === 401) {
        try { c = await this.fresh(true); return await call(c); } catch (e2: any) { err = e2; }
      }
      if (err instanceof BadRequestException) throw err;
      const msg = String(err.message || "");
      if (err.status) this.log.warn(`Figma ${err.status} on ${path.split("?")[0]} (${c.kind}): ${msg} ${err.body ? JSON.stringify(err.body).slice(0, 300) : ""}`);
      if (err.status === 403 && /scope/i.test(msg)) throw new BadRequestException(`Figma didn't grant this access (${msg}). Connect Figma again, or ask an admin to add the scope to the Figma app.`);
      if (err.status === 401) throw new BadRequestException(c.kind === "oauth" ? "Your Figma sign-in expired. Connect Figma again in Settings → Figma." : "Figma refused the token. Connect Figma again in Settings → Figma.");
      // OAuth: the account works (/v1/me) but Figma refuses the file for this app: an app setting on figma.com
      if (err.status === 403 && c.kind === "oauth" && /request denied|forbidden/i.test(`${msg} ${JSON.stringify(err.body || "")}`)) {
        throw new BadRequestException("Figma denied this app access to the file. In figma.com/developers/apps → your app: turn on the scopes file_content:read and file_metadata:read, publish the app (Private is enough) for the team that owns the file, or move the file from Drafts into that team. Then click Reconnect in Settings → Figma.");
      }
      if (err.status === 403) throw new BadRequestException(`Your Figma account can't open this file (Figma: ${msg || "forbidden"}).`);
      if (err.status === 404) throw new BadRequestException("Figma file or frame not found. Check that your account can open it.");
      if (err.status === 429) throw new BadRequestException("Figma rate limit reached. Try again in a minute.");
      throw new BadRequestException(msg || "Figma error");
    }
  }

  /* ---------- connection ---------- */
  async status() {
    const [doc, prefs] = await Promise.all([this.integ.findById(ID).lean(), this.prefs()]);
    const method = doc?.secret ? (doc.info?.method === "oauth" ? "oauth" : "token") : null;
    const granted: string[] = doc?.info?.scopes || [];
    return {
      connected: !!doc?.secret, method, user: doc?.info?.user ?? null, connectedAt: doc?.info?.connectedAt ?? null, error: doc?.info?.error ?? null,
      oauth: { configured: this.oauthReady, callbackUrl: this.redirectUri, appsUrl: "https://www.figma.com/developers/apps", scopes: this.scopes },
      // team folders need folders:read (private OAuth apps only); a personal token can always try
      canBrowseTeams: method === "token" || granted.some((s) => s === "folders:read" || s === "projects:read" || s === "files:read"),
      defaultFile: prefs.defaultFile ?? null, recent: prefs.recent ?? [], teams: prefs.teams ?? [],
    };
  }

  /** Connect Figma: the consent URL on figma.com (state + PKCE, checked in the callback). */
  async authUrl(userId: string) {
    if (!this.oauthReady) throw new BadRequestException("Figma sign-in isn't set up yet: add FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET to the API's .env");
    const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
    await this.states.create({ _id: state, brandId: "*", net: "figma", userId, verifier });
    const q = new URLSearchParams({
      client_id: this.env("FIGMA_CLIENT_ID")!, redirect_uri: this.redirectUri, scope: this.scopes.join(" "), state, response_type: "code",
      code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    });
    return { url: `${this.authorizeBase}?${q}` };
  }

  /** Figma redirected back: exchange the code, read the account, store the tokens (encrypted). Returns where the browser goes. */
  async callback(q: { code?: string; state?: string; error?: string; error_description?: string }) {
    const done = (p: Record<string, string>) => `${this.frontUrl}/social-media/connected?${new URLSearchParams({ net: "figma", ...p })}`;
    try {
      if (q.error) throw new ApiError(q.error_description || (q.error === "access_denied" ? "Access was not granted" : q.error));
      const st = q.state && (await this.states.findOneAndDelete({ _id: q.state, net: "figma" }));
      if (!st) throw new ApiError("This sign-in link expired. Click Connect Figma again.");
      if (!q.code) throw new ApiError("Figma did not return an authorization code");
      const form: Record<string, string> = { redirect_uri: this.redirectUri, code: q.code, grant_type: "authorization_code" };
      if (st.verifier) form.code_verifier = st.verifier;
      const r: any = await request(`${this.api}/v1/oauth/token`, { method: "POST", headers: { Authorization: this.basic() }, form });
      if (!r.access_token) throw new ApiError("Figma did not return an access token");
      const cred: Cred = {
        kind: "oauth", accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: Date.now() + (Number(r.expires_in) || 90 * 86400) * 1000,
        scopes: this.scopes, userId: r.user_id_string || (r.user_id != null ? String(r.user_id) : undefined),
      };
      const me = await this.get("/v1/me", cred).catch(() => null);
      const user = me ? { id: me.id, handle: me.handle, email: me.email, img: me.img_url } : { id: cred.userId, handle: "Figma account" };
      await this.integ.findByIdAndUpdate(ID, {
        secret: encrypt(JSON.stringify(cred), this.secret),
        info: { method: "oauth", user, scopes: cred.scopes, connectedAt: new Date(), connectedBy: st.userId },
      }, { upsert: true });
      return done({ ok: "1", name: user.handle || "" });
    } catch (e: any) {
      this.log.warn(`Figma connection failed: ${e.message}`);
      return done({ ok: "0", error: e.message || "Connection failed" });
    }
  }

  /** Personal access token (alternative to Connect Figma): checked with Figma before it's stored, replaces the current connection. */
  async saveToken(raw: string) {
    const token = String(raw || "").trim();
    if (!token) throw new BadRequestException("Paste a Figma personal access token");
    const me = await this.get("/v1/me", { kind: "pat", token });
    const user = { id: me.id, handle: me.handle, email: me.email, img: me.img_url };
    await this.integ.findByIdAndUpdate(ID, { secret: encrypt(token, this.secret), info: { method: "token", user, connectedAt: new Date() } }, { upsert: true });
    return this.status();
  }

  /** Forget the account (tokens deleted). The default file and recent files stay for the next connection. */
  async disconnect() {
    await this.integ.deleteOne({ _id: ID });
    return this.status();
  }

  /* ---------- picker preferences ---------- */
  private async prefs(): Promise<{ defaultFile?: FigmaFile | null; recent?: FigmaFile[]; teams?: { id: string; name: string }[] }> {
    return ((await this.integ.findById(PREFS).lean())?.info as any) || {};
  }
  private async setPrefs(patch: Record<string, unknown>) {
    await this.integ.updateOne({ _id: PREFS }, { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => ["info." + k, v])) }, { upsert: true });
  }
  private async remember(f: FigmaFile) {
    const p = await this.prefs();
    const recent = [{ ...f, at: Date.now() }, ...(p.recent || []).filter((x) => x.key !== f.key)].slice(0, MAX_RECENT);
    const patch: Record<string, unknown> = { recent };
    if (p.defaultFile?.key === f.key) patch.defaultFile = { ...p.defaultFile, name: f.name, thumb: f.thumb ?? p.defaultFile.thumb };
    await this.setPrefs(patch);
  }

  /** Name and thumbnail of a file (metadata scope, or the file itself as a fallback). */
  private async fileInfo(fileKey: string): Promise<FigmaFile> {
    const key = encodeURIComponent(fileKey);
    const m = await this.get(`/v1/files/${key}/meta`).catch(() => null);
    if (m?.file) return { key: fileKey, name: m.file.name, thumb: m.file.thumbnail_url ?? null, lastModified: m.file.last_touched_at ?? null };
    const f = await this.get(`/v1/files/${key}?depth=1`);
    return { key: fileKey, name: f.name, thumb: f.thumbnailUrl ?? null, lastModified: f.lastModified ?? null };
  }

  async setDefault(input: string) {
    const ref = parseFigmaUrl(String(input || "")) || (/^[A-Za-z0-9]{10,}$/.test(String(input).trim()) ? { fileKey: String(input).trim() } : null);
    if (!ref) throw new BadRequestException("That isn't a Figma file link");
    const f = await this.fileInfo(ref.fileKey);
    await this.setPrefs({ defaultFile: f });
    await this.remember(f);
    return this.status();
  }
  async clearDefault() { await this.setPrefs({ defaultFile: null }); return this.status(); }
  async forgetRecent(fileKey: string) {
    const p = await this.prefs();
    await this.setPrefs({ recent: (p.recent || []).filter((x) => x.key !== fileKey) });
    return this.status();
  }

  /* ---------- teams (Figma lists files by team: the team id comes from its URL) ---------- */
  async addTeam(input: string) {
    const s = String(input || "").trim(), m = s.match(/team\/(\d+)/) || s.match(/^(\d{6,})$/);
    if (!m) throw new BadRequestException("Paste the link of a team page in Figma (figma.com/files/team/…)");
    const id = m[1], slug = s.match(/team\/\d+\/([^/?#]+)/)?.[1];
    const r = await this.teamFolders(id);
    const name = r.name || (slug ? decodeURIComponent(slug).replace(/-/g, " ") : `Team ${id}`);
    const p = await this.prefs();
    await this.setPrefs({ teams: [{ id, name }, ...(p.teams || []).filter((t) => t.id !== id)].slice(0, 10) });
    return this.status();
  }
  async removeTeam(id: string) {
    const p = await this.prefs();
    await this.setPrefs({ teams: (p.teams || []).filter((t) => t.id !== id) });
    return this.status();
  }
  /** Folders (projects) of a team: /v2 folders, or the older /v1 projects endpoint */
  async teamFolders(teamId: string) {
    const id = encodeURIComponent(teamId);
    const r = await this.get(`/v2/teams/${id}/folders`).catch(async (e) => {
      if (/not found/i.test(e.message)) return this.get(`/v1/teams/${id}/projects`);
      throw e;
    });
    const list = r.folders || r.projects || [];
    return { name: r.name || null, folders: list.map((f: any) => ({ id: String(f.id), name: f.name })) };
  }
  /** Files (and subfolders) of a folder */
  async folderFiles(folderId: string) {
    const id = encodeURIComponent(folderId);
    const r = await this.get(`/v2/folders/${id}/files`).catch(async (e) => {
      if (/not found/i.test(e.message)) return this.get(`/v1/projects/${id}/files`);
      throw e;
    });
    const sub = await this.get(`/v2/folders/${id}/folders`).catch(() => ({ folders: [] }));
    return {
      name: r.name || null,
      folders: (sub.folders || []).map((f: any) => ({ id: String(f.id), name: f.name })),
      files: (r.files || []).map((f: any): FigmaFile => ({ key: f.key, name: f.name, thumb: f.thumbnail_url ?? null, lastModified: f.last_modified ?? null })),
    };
  }

  /* ---------- frames ---------- */
  /** Frames of a file (the whole file, a page, a section or one frame): from a link, or a file key (+ node id). */
  async frames(input: { url?: string; fileKey?: string; nodeId?: string }) {
    const ref = input.fileKey ? { fileKey: input.fileKey, nodeId: input.nodeId || undefined } : parseFigmaUrl(input.url || "");
    if (!ref) throw new BadRequestException("That isn't a Figma file link (figma.com/design/…)");
    let file: any, list: any[] = [];
    const collect = (n: any, page: string) => {
      if (!n || n.visible === false || list.length >= MAX_FRAMES) return;
      if (FRAME_TYPES.has(n.type) || (n.type === "GROUP" && !holdsFrames(n))) list.push({ ...n, page });
      else if (["CANVAS", "SECTION", "COMPONENT_SET", "GROUP"].includes(n.type)) (n.children || []).forEach((c: any) => collect(c, n.type === "CANVAS" ? n.name : page));
    };
    if (ref.nodeId) {
      file = await this.get(`/v1/files/${ref.fileKey}/nodes?ids=${encodeURIComponent(ref.nodeId)}&depth=2`);
      const node = file.nodes?.[ref.nodeId]?.document;
      if (!node) throw new BadRequestException("That frame wasn't found in the file");
      if (node.type === "DOCUMENT") (node.children || []).forEach((p: any) => collect(p, p.name));
      else collect(node, "");
    } else {
      file = await this.get(`/v1/files/${ref.fileKey}?depth=3`);
      (file.document?.children || []).forEach((p: any) => collect(p, p.name));
    }
    await this.remember({ key: ref.fileKey, name: file.name, thumb: file.thumbnailUrl ?? null, lastModified: file.lastModified ?? null }).catch(() => undefined);
    if (!list.length) throw new BadRequestException("No frames or groups found there. Pick another file, or link to a frame or a page.");
    const thumbs = await this.get(`/v1/images/${ref.fileKey}?ids=${encodeURIComponent(list.map((f) => f.id).join(","))}&format=png&scale=${this.thumbScale(list)}`).catch(() => ({ images: {} }));
    return {
      fileKey: ref.fileKey,
      file: file.name,
      thumb: file.thumbnailUrl ?? null,
      version: file.version,
      lastModified: file.lastModified,
      more: list.length >= MAX_FRAMES,
      frames: list.map((f) => {
        const w = f.absoluteBoundingBox?.width || 1080, h = f.absoluteBoundingBox?.height || 1080;
        const c = canvasOf(w, h);
        return { id: f.id, name: f.name, page: f.page, kind: f.type === "GROUP" ? "group" : "frame", width: c.W, height: c.H, ratio: c.key, thumb: thumbs.images?.[f.id] || null };
      }),
    };
  }

  private thumbScale(list: any[]) {
    const w = Math.max(...list.map((f) => f.absoluteBoundingBox?.width || 1080));
    return Math.min(1, Math.max(0.05, Math.round((300 / w) * 100) / 100));
  }

  /** Last change of a file (to flag linked slides as "Changed in Figma"). */
  async version(fileKey: string) {
    const f = await this.get(`/v1/files/${encodeURIComponent(fileKey)}?depth=1`);
    return { fileKey, file: f.name, version: f.version, lastModified: f.lastModified };
  }

  /** Families Google Fonts serves (true) or doesn't (false), checked once per family */
  private googleFonts = new Map<string, boolean>();
  /** Checks the font families used in these nodes against Google Fonts (a few seconds at most; unknown counts as missing). */
  private async checkFonts(nodes: any[]) {
    const fams = new Set<string>();
    const scan = (n: any) => {
      if (!n || n.visible === false) return;
      if (n.type === "TEXT") {
        if (n.style?.fontFamily) fams.add(String(n.style.fontFamily));
        Object.values(n.styleOverrideTable || {}).forEach((s: any) => s?.fontFamily && fams.add(String(s.fontFamily)));
      }
      (n.children || []).forEach(scan);
    };
    nodes.forEach(scan);
    const todo = [...fams].filter((f) => !STUDIO_FONTS.includes(f) && !this.googleFonts.has(f) && /^[\w .'-]{1,80}$/.test(f)).slice(0, 20);
    await Promise.all(todo.map(async (f) => {
      try {
        const r = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, "+")}`, { signal: AbortSignal.timeout(4000) });
        this.googleFonts.set(f, r.ok);
      } catch {} // offline: not cached, the font is swapped this time
    }));
  }

  /** Converts frames into studio pages. Images are downloaded, resized and embedded (designs export as PNG). */
  async import(fileKey: string, ids: string[], opts: { fonts?: { heading?: string; body?: string }; keepFonts?: boolean } = {}) {
    if (!ids?.length) throw new BadRequestException("Choose at least one frame");
    const res = await this.get(`/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ids.join(","))}&geometry=paths`);
    const uid = () => newId();
    // Missing families: keep the name, or use the brand's fonts (heading for large text, body for the rest)
    const fontFor = (family: string, size: number) => {
      if (opts.keepFonts || STUDIO_FONTS.includes(family) || this.googleFonts.get(family)) return family;
      const pick = size >= 28 ? opts.fonts?.heading : opts.fonts?.body;
      return pick && STUDIO_FONTS.includes(pick) ? pick : defaultFont(family, size);
    };
    const out = [];
    const allRasters = new Map<string, number>(), allImages = new Map<string, number>();
    type Conv = { id: string; error: string } | { id: string; node: any; c: ReturnType<typeof convertFrame> };
    // fonts Google Fonts serves are kept even when missing fonts are swapped: the studio loads them from there
    await this.checkFonts(ids.map((id) => res.nodes?.[id]?.document).filter(Boolean));
    const converted: Conv[] = ids.map((id): Conv => {
      const node = res.nodes?.[id]?.document;
      if (!node) return { id, error: "Frame not found (deleted or moved in Figma)" };
      const c = convertFrame(node, uid, fontFor);
      c.rasters.forEach((r) => allRasters.set(r.id, Math.max(allRasters.get(r.id) || 0, r.w, r.h)));
      c.images.forEach((r) => allImages.set(r.ref, Math.max(allImages.get(r.ref) || 0, r.w, r.h)));
      return { id, node, c };
    });

    // rendered nodes: one Figma render per scale (2× the size they take on the studio canvas), lower for the big ones
    // (a background larger than the frame): Figma renders 32 megapixels at most, and they are embedded at MAX_EMBED
    const rasterUrls: Record<string, string> = {};
    const byScale = new Map<number, string[]>();
    for (const conv of converted) {
      if ("error" in conv) continue;
      for (const r of conv.c.rasters) {
        const side = Math.max(r.w, r.h, 1) / (conv.c.scale || 1); // in Figma pixels
        const s = Math.min(4, conv.c.scale * 2, (MAX_EMBED * 1.25) / side);
        const sr = Math.max(0.01, Math.round(s * 100) / 100);
        byScale.set(sr, [...(byScale.get(sr) || []), r.id]);
      }
    }
    // Figma sometimes returns no render for a heavy node (null URL or a timeout): ask again for the missing ones
    const render = async (scale: number, list: string[]) => {
      for (let i = 0; i < list.length; i += 50) {
        const chunk = list.slice(i, i + 50);
        const r = await this.get(`/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(chunk.join(","))}&format=png&scale=${scale}`).catch(() => ({ images: {} }));
        Object.entries(r.images || {}).forEach(([id, url]) => { if (url) rasterUrls[id] = url as string; });
      }
    };
    for (const [scale, list] of byScale) {
      await render(scale, list);
      for (let attempt = 0; attempt < 2; attempt++) {
        const missing = list.filter((id) => !rasterUrls[id]); if (!missing.length) break;
        await new Promise((r) => setTimeout(r, 1500));
        await render(scale, missing);
      }
    }
    const imageUrls: Record<string, string> = allImages.size ? (await this.get(`/v1/files/${encodeURIComponent(fileKey)}/images`)).meta?.images || {} : {};

    const data = new Map<string, string>();
    const embed = async (key: string, url: string | undefined, maxPx: number) => {
      if (!url) return;
      try {
        const { buf } = await download(url, { timeoutMs: 60_000 }).catch(() => download(url, { timeoutMs: 90_000 })); // one retry
        const img = sharp(buf, { limitInputPixels: 1e8 }).rotate();
        const meta = await img.metadata();
        // 2× the size the picture takes on the canvas, up to MAX_EMBED (a background larger than the frame keeps its detail)
        const target = Math.max(64, Math.min(MAX_EMBED, Math.round(maxPx * 2)));
        const resized = img.resize({ width: target, height: target, fit: "inside", withoutEnlargement: true });
        // transparent pictures: small ones (icons, logos) as palette PNG; large ones (photos, glows, gradients) as WebP,
        // which keeps every color (a 256-color palette bands their gradients)
        const outW = Math.min(target, meta.width || target), outH = Math.min(target, meta.height || target);
        const kind = !meta.hasAlpha ? "jpeg" : Math.max(outW, outH) > 512 ? "webp" : "png";
        const b = kind === "png" ? await resized.png({ compressionLevel: 9, palette: true }).toBuffer()
          : kind === "webp" ? await resized.webp({ quality: 90, alphaQuality: 100 }).toBuffer()
          : await resized.jpeg({ quality: 86, mozjpeg: true }).toBuffer();
        data.set(key, `data:image/${kind};base64,${b.toString("base64")}`);
      } catch {}
    };
    await Promise.all([
      ...[...allRasters].map(([id, w]) => embed(`raster:${id}`, rasterUrls[id], w)),
      ...[...allImages].map(([ref, w]) => embed(`image:${ref}`, imageUrls[ref], w)),
    ]);

    for (const conv of converted) {
      if ("error" in conv) { out.push({ id: conv.id, error: conv.error }); continue; }
      const { node, c } = conv;
      const warnings = [...c.warnings];
      let missing = 0;
      const layers = c.layers.filter((l) => {
        if (typeof l.fill !== "string" || !l.fill.includes("{{")) return true;
        l.fill = l.fill.replace(/\{\{((?:raster|image):[^}]+)\}\}/g, (_: string, key: string) => data.get(key) || "");
        if (!l.fill.includes("url()")) return true;
        missing++;
        if (l.type === "image" && !l.locked) return false; // nothing else to show
        l.fill = l.fill.split(/,(?![^(]*\))/).filter((part: string) => !part.includes("url()")).join(",").trim() || "transparent";
        return true;
      });
      if (missing) warnings.push(`${missing} image${missing > 1 ? "s" : ""} couldn't be downloaded from Figma`);
      out.push({
        id: conv.id, name: node.name, ratio: c.ratio, width: c.width, height: c.height, warnings,
        page: { bg: c.bg, layers },
      });
    }
    return { fileKey, file: res.name, version: res.version, lastModified: res.lastModified, frames: out };
  }
}
