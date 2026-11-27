import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { ChatbotSettings, ChatbotSettingsDocument } from "./chatbot-settings.schema";
import { UpdateWidgetDto } from "./chatbot.dto";
import { findServers, importUrls, normalizeWebsite, scriptUrls } from "./discover";

const clean = (u: string) => u.trim().replace(/\/+$/, "").replace(/\/api(\/admin)?$/, "");
const KEY_HELP = "Add CHATBOT_ADMIN_KEY to the admin API's environment (same value as ADMIN_API_KEY on the chatbot server), then restart it.";

/** Relais vers l'API admin du serveur chatbot (Express, routes /api/admin/*).
 *  Connexion sans saisie : on donne le site, l'adresse du serveur est lue dans le code du widget installé dessus. */
@Injectable()
export class ChatbotService {
  private envUrl: string;
  private key: string;
  constructor(@InjectModel(ChatbotSettings.name) private m: Model<ChatbotSettingsDocument>, cfg: ConfigService) {
    this.envUrl = clean(cfg.get<string>("CHATBOT_API_URL") || "");
    this.key = (cfg.get<string>("CHATBOT_ADMIN_KEY") || "").trim();
  }

  private async conn() {
    const s = await this.m.findOne().lean();
    const url = s?.apiUrl || this.envUrl;
    return { s, url, source: s?.apiUrl ? s.source || "site" : this.envUrl ? "env" : "", live: !!(url && this.key && !s?.disconnected) };
  }

  async view() {
    const { s, url, source, live } = await this.conn();
    return {
      connected: live, website: s?.website || "", apiUrl: live ? url : "", source: live ? source : "",
      keyConfigured: !!this.key, envUrl: !!this.envUrl, connectedAt: s?.connectedAt || null, widget: s?.widget || {},
    };
  }

  /** URL du serveur chatbot (publique de toute façon : elle figure dans le code du widget sur le site) */
  async publicUrl() { const c = await this.conn(); return c.live ? c.url : ""; }

  /** Appel brut vers le serveur chatbot */
  private async call(url: string, path: string, init: RequestInit = {}) {
    let r: Response;
    try {
      r = await fetch(`${url}/api/admin${path}`, { ...init, headers: { "x-admin-key": this.key, "Content-Type": "application/json", ...(init.headers || {}) }, signal: AbortSignal.timeout(path.endsWith(".pdf") ? 60000 : 20000) });
    } catch {
      throw new ServiceUnavailableException("The chatbot server didn't answer. It may be asleep (free hosting): try again in a minute.");
    }
    if (r.status === 401) throw new BadRequestException("The chatbot server refused the admin key. CHATBOT_ADMIN_KEY must match ADMIN_API_KEY on the chatbot server.");
    if (r.status === 404) throw new BadGatewayException("This server doesn't look like the UX Boğa chatbot (no /api/admin route).");
    if (!r.ok) {
      const j: any = await r.json().catch(() => ({}));
      throw new BadGatewayException(j.error || `Chatbot server error (${r.status})`);
    }
    return r;
  }

  private async req(path: string, init?: RequestInit) {
    const c = await this.conn();
    if (!this.key) throw new BadRequestException(KEY_HELP);
    if (!c.live) throw new BadRequestException("The chatbot isn't connected yet. Enter your website in Chatbot Settings.");
    return this.call(c.url, path, init);
  }
  async json(path: string, init?: RequestInit) { return (await this.req(path, init)).json(); }
  async file(path: string) {
    const r = await this.req(path);
    return { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "application/octet-stream" };
  }

  /** Lit une page/un script du site (10 s, 3 Mo max) — "" si indisponible */
  private async get(url: string) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "UXBogaAdmin/1.0 (+chatbot setup)", Accept: "text/html,application/javascript,*/*" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
      if (!r.ok) return "";
      const t = await r.text();
      return t.length > 3_000_000 ? t.slice(0, 3_000_000) : t;
    } catch { return ""; }
  }

  /** Cherche le widget sur le site : HTML, puis scripts de la page, puis leurs modules (Framer charge le composant à part) */
  private async discover(origin: string) {
    // https, puis www., puis http (site sans certificat ou en local)
    let html = "";
    for (const o of [origin, origin.replace("://", "://www."), origin.replace(/^https:/, "http:")]) { if ((html = await this.get(o + "/"))) { origin = o; break; } }
    if (!html) return { reached: false, found: [] as string[], origin };
    let found = findServers(html);
    if (found.length) return { reached: true, found, origin };
    const seen = new Set<string>();
    let queue = scriptUrls(html, origin);
    for (let depth = 0; depth < 2 && queue.length && !found.length; depth++) {
      const batch = queue.filter((u) => !seen.has(u)).slice(0, 60);
      batch.forEach((u) => seen.add(u));
      const texts = await Promise.all(batch.map((u) => this.get(u)));
      found = [...new Set(texts.flatMap(findServers))];
      queue = texts.flatMap((t, i) => importUrls(t, batch[i]));
    }
    return { reached: true, found, origin };
  }

  /** « Connect » : site → serveur chatbot (trouvé sur le site, sinon CHATBOT_API_URL), testé avec la clé de l'environnement */
  async connect(website: string) {
    let site: { origin: string; host: string };
    try { site = normalizeWebsite(website); } catch (e: any) { throw new BadRequestException(e.message); }
    if (!this.key) throw new BadRequestException(KEY_HELP);
    const { reached, found, origin } = await this.discover(site.origin);
    const tries: [string, "site" | "env"][] = [...found.map((u) => [u, "site"] as [string, "site"]), ...(this.envUrl && !found.includes(this.envUrl) ? [[this.envUrl, "env"] as [string, "env"]] : [])];
    if (!tries.length) {
      throw new BadRequestException(reached
        ? `The chatbot widget isn't on ${site.host} yet. Publish it first (Chatbot Settings → Install on website), or set CHATBOT_API_URL on the admin API.`
        : `We couldn't open ${site.host}. Check the address, or set CHATBOT_API_URL on the admin API.`);
    }
    let last: any;
    for (const [url, source] of tries) {
      try {
        await this.call(url, "/knowledge-status");
        await this.m.updateOne({}, { $set: { website: reached ? origin : site.origin, apiUrl: source === "site" ? url : "", source, disconnected: false, connectedAt: new Date() } }, { upsert: true });
        return this.view();
      } catch (e) { last = e; }
    }
    throw last;
  }

  async saveWidget(d: UpdateWidgetDto) {
    await this.m.updateOne({}, { $set: { widget: { ...d } } }, { upsert: true });
    return this.view();
  }

  /** Déconnexion : coupe aussi la connexion automatique ; le site et l'apparence du widget sont gardés */
  async disconnect() {
    await this.m.updateOne({}, { $set: { disconnected: true }, $unset: { connectedAt: 1 } }, { upsert: true });
    return this.view();
  }
}
