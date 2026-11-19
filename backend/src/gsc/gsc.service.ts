import { BadGatewayException, BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { decrypt, encrypt } from "../common/crypto";
import { GscConnection, GscConnectionDocument } from "./gsc.schema";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const day = (d: Date) => d.toISOString().slice(0, 10);
interface Row { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }

@Injectable()
export class GscService {
  private access?: { token: string; exp: number };
  private cache = new Map<string, { exp: number; data: unknown }>();
  constructor(
    @InjectModel(GscConnection.name) private conn: Model<GscConnectionDocument>,
    private cfg: ConfigService,
    private jwt: JwtService,
  ) {}

  private get secret() { return this.cfg.getOrThrow<string>("JWT_SECRET"); }
  private get site() { return this.cfg.get<string>("GSC_SITE") || "sc-domain:uxboga.com"; }
  private get configured() { return !!this.cfg.get("GOOGLE_CLIENT_ID") && !!this.cfg.get("GOOGLE_CLIENT_SECRET"); }
  get frontUrl() { return this.cfg.get<string>("FRONTEND_URL") || "http://localhost:3000"; }
  private get redirectUri() { return this.cfg.get<string>("GOOGLE_REDIRECT_URI") || "http://localhost:4000/api/gsc/callback"; }

  async status() {
    const c = await this.conn.findOne();
    const site = c?.site ?? this.site;
    const domain = site.startsWith("sc-domain:") ? site.slice(10) : new URL(site).host;
    return { configured: this.configured, connected: !!c, site, domain, connectedAt: c?.connectedAt ?? null };
  }

  /** URL de consentement Google. `state` = JWT court signé (anti-CSRF + identifie l'admin) */
  async authUrl(userId: string) {
    if (!this.configured) throw new BadRequestException("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET manquants dans le .env");
    const state = await this.jwt.signAsync({ sub: userId, purpose: "gsc" }, { expiresIn: "10m" });
    const q = new URLSearchParams({
      client_id: this.cfg.getOrThrow("GOOGLE_CLIENT_ID"), redirect_uri: this.redirectUri, response_type: "code",
      scope: SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  private async token(body: Record<string, string>) {
    const res = await fetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.getOrThrow("GOOGLE_CLIENT_ID"), client_secret: this.cfg.getOrThrow("GOOGLE_CLIENT_SECRET"), ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(j.error_description ?? j.error ?? "Google OAuth error"), { code: j.error });
    return j as { access_token: string; expires_in: number; refresh_token?: string };
  }

  async handleCallback(code: string, state: string) {
    try { const p = await this.jwt.verifyAsync(state); if (p.purpose !== "gsc") throw new Error(); }
    catch { throw new UnauthorizedException("État OAuth invalide ou expiré — relancez la connexion"); }
    const t = await this.token({ code, grant_type: "authorization_code", redirect_uri: this.redirectUri });
    if (!t.refresh_token) throw new BadRequestException("Google n'a pas renvoyé de refresh token — révoquez l'accès de l'app puis reconnectez");
    await this.conn.findOneAndUpdate({}, { refreshToken: encrypt(t.refresh_token, this.secret), site: this.site, connectedAt: new Date() }, { upsert: true });
    this.access = undefined; this.cache.clear();
  }

  /** Propriétés Search Console accessibles au compte connecté */
  async sites(): Promise<{ site: string; level: string }[]> {
    const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadGatewayException(j.error?.message ?? "Impossible de lister les propriétés");
    return (j.siteEntry ?? []).map((e: any) => ({ site: e.siteUrl as string, level: e.permissionLevel as string }));
  }

  async setSite(site: string) {
    const ok = (await this.sites()).some(s => s.site === site);
    if (!ok) throw new BadRequestException("Propriété inconnue pour ce compte Google");
    await this.conn.updateOne({}, { site }); this.cache.clear();
    return { ok: true, site };
  }

  /** Statut d'indexation réel d'une URL (URL Inspection API) */
  async inspect(url: string) {
    const c = await this.conn.findOne();
    if (!c) throw new UnauthorizedException("Search Console n'est pas connecté");
    const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST", headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: c.site }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadGatewayException(j.error?.message ?? "Inspection impossible");
    const r = j.inspectionResult?.indexStatusResult ?? {};
    return { state: r.coverageState ?? "Unknown", verdict: r.verdict ?? "", lastCrawl: r.lastCrawlTime ?? null };
  }

  async disconnect() { await this.conn.deleteMany(); this.access = undefined; this.cache.clear(); return { ok: true }; }

  private async accessToken() {
    if (this.access && this.access.exp > Date.now() + 30_000) return this.access.token;
    const c = await this.conn.findOne().select("+refreshToken");
    if (!c) throw new UnauthorizedException("Search Console n'est pas connecté");
    try {
      const t = await this.token({ grant_type: "refresh_token", refresh_token: decrypt(c.refreshToken, this.secret) });
      this.access = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
      return t.access_token;
    } catch (e: any) {
      if (e.code === "invalid_grant") { await this.disconnect(); throw new UnauthorizedException("Accès Google révoqué — reconnectez Search Console"); }
      throw new BadGatewayException(e.message);
    }
  }

  private async query(site: string, body: object): Promise<Row[]> {
    const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: "POST", headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadGatewayException(j.error?.message ?? "Erreur Search Console (ce compte a-t-il accès à la propriété ?)");
    return j.rows ?? [];
  }

  /** One week of data for the weekly monitor: totals, top pages and top queries (3 light requests, no cache) */
  async week(start: string, end: string) {
    const c = await this.conn.findOne();
    if (!c) throw new UnauthorizedException("Search Console n'est pas connecté");
    const filter = this.cfg.get<string>("GSC_PAGE_FILTER");
    const base = { startDate: start, endDate: end, ...(filter && { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: filter }] }] }) };
    const [tot, pages, queries] = await Promise.all([
      this.query(c.site, base),
      this.query(c.site, { ...base, dimensions: ["page"], rowLimit: 250 }),
      this.query(c.site, { ...base, dimensions: ["query"], rowLimit: 250 }),
    ]);
    const m = (r: Row) => ({ key: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 });
    return { start, end, totals: { clicks: tot[0]?.clicks ?? 0, impressions: tot[0]?.impressions ?? 0, position: tot[0]?.position ?? 0 }, pages: pages.map(m), queries: queries.map(m) };
  }

  /** SEO opportunities: page × query rows for the period, and page totals for this period and the one before it (3 light requests, cached 10 min) */
  async pageQueries(days: number) {
    if (![28, 90].includes(days)) throw new BadRequestException("days doit valoir 28 ou 90");
    const key = `pq:${days}`; const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.data;
    const c = await this.conn.findOne();
    if (!c) throw new UnauthorizedException("Search Console n'est pas connecté");
    const end = new Date(Date.now() - 2 * 864e5), start = new Date(end.getTime() - (days - 1) * 864e5);
    const pEnd = new Date(start.getTime() - 864e5), pStart = new Date(pEnd.getTime() - (days - 1) * 864e5);
    const filter = this.cfg.get<string>("GSC_PAGE_FILTER");
    const f = filter ? { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: filter }] }] } : {};
    const [pq, pages, prev] = await Promise.all([
      this.query(c.site, { startDate: day(start), endDate: day(end), ...f, dimensions: ["page", "query"], rowLimit: 1000 }),
      this.query(c.site, { startDate: day(start), endDate: day(end), ...f, dimensions: ["page"], rowLimit: 250 }),
      this.query(c.site, { startDate: day(pStart), endDate: day(pEnd), ...f, dimensions: ["page"], rowLimit: 250 }),
    ]);
    const m = (r: Row) => ({ clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
    const data = {
      range: { start: day(start), end: day(end), days }, previous: { start: day(pStart), end: day(pEnd) }, site: c.site,
      rows: pq.map(r => ({ page: r.keys?.[0] ?? "", query: r.keys?.[1] ?? "", ...m(r) })),
      pages: pages.map(r => ({ key: r.keys?.[0] ?? "", ...m(r) })),
      prevPages: prev.map(r => ({ key: r.keys?.[0] ?? "", ...m(r) })),
    };
    this.cache.set(key, { exp: Date.now() + 10 * 60_000, data });
    return data;
  }

  /** Performance sur N jours (les données GSC ont ~2 jours de retard). Cache 10 min. */
  async performance(days: number) {
    if (![7, 28, 90, 365].includes(days)) throw new BadRequestException("days doit valoir 7, 28, 90 ou 365");
    const key = `perf:${days}`; const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.data;
    const c = await this.conn.findOne();
    if (!c) throw new UnauthorizedException("Search Console n'est pas connecté");
    const end = new Date(Date.now() - 2 * 864e5), start = new Date(end.getTime() - (days - 1) * 864e5);
    const filter = this.cfg.get<string>("GSC_PAGE_FILTER"); // ex. "/blog" pour ne suivre que le blog
    const base = { startDate: day(start), endDate: day(end), ...(filter && { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: filter }] }] }) };
    const map = (r: Row) => ({ key: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
    const pEnd = new Date(start.getTime() - 864e5), pStart = new Date(pEnd.getTime() - (days - 1) * 864e5);
    const prevBase = { ...base, startDate: day(pStart), endDate: day(pEnd) };
    const [tot, series, queries, pages, devices, prev] = await Promise.all([
      this.query(c.site, base),
      this.query(c.site, { ...base, dimensions: ["date"], rowLimit: 400 }),
      this.query(c.site, { ...base, dimensions: ["query"], rowLimit: 250 }),
      this.query(c.site, { ...base, dimensions: ["page"], rowLimit: 250 }),
      this.query(c.site, { ...base, dimensions: ["device"], rowLimit: 5 }),
      this.query(c.site, prevBase),
    ]);
    const data = {
      range: { start: base.startDate, end: base.endDate, days }, site: c.site,
      totals: tot[0] ? { clicks: tot[0].clicks, impressions: tot[0].impressions, ctr: tot[0].ctr, position: tot[0].position } : { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      series: series.map(map), queries: queries.map(map), pages: pages.map(map), devices: devices.map(map),
      previous: { clicks: prev[0]?.clicks ?? 0, impressions: prev[0]?.impressions ?? 0 },
    };
    this.cache.set(key, { exp: Date.now() + 10 * 60_000, data });
    return data;
  }
}
