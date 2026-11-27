import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { decrypt, encrypt } from "../common/crypto";
import { ChatbotSettings, ChatbotSettingsDocument } from "./chatbot-settings.schema";
import { UpdateChatbotSettingsDto, UpdateWidgetDto } from "./chatbot.dto";

const clean = (u: string) => u.trim().replace(/\/+$/, "").replace(/\/api(\/admin)?$/, "");

/** Relais vers l'API admin du serveur chatbot (Express, routes /api/admin/*). La clé reste côté serveur. */
@Injectable()
export class ChatbotService {
  private secret: string;
  constructor(@InjectModel(ChatbotSettings.name) private m: Model<ChatbotSettingsDocument>, cfg: ConfigService) {
    this.secret = cfg.getOrThrow<string>("JWT_SECRET");
  }

  private async conn() {
    const s = await this.m.findOne().select("+apiKey").lean();
    let key = "";
    if (s?.apiKey) { try { key = decrypt(s.apiKey, this.secret); } catch { /* JWT_SECRET changé */ } }
    return { url: s?.apiUrl || "", key, last4: s?.last4 || "", connectedAt: s?.connectedAt, widget: s?.widget || {} };
  }

  async view() {
    const c = await this.conn();
    return { connected: !!(c.url && c.key), apiUrl: c.url, hasKey: !!c.key, last4: c.last4, connectedAt: c.connectedAt || null, widget: c.widget };
  }

  /** URL du serveur chatbot (publique de toute façon : elle figure dans le code du widget sur le site) */
  async publicUrl() { return (await this.m.findOne().lean())?.apiUrl || ""; }

  /** Appel brut vers le serveur chatbot (url/clé explicites pour tester avant d'enregistrer) */
  private async call(url: string, key: string, path: string, init: RequestInit = {}) {
    let r: Response;
    try {
      r = await fetch(`${url}/api/admin${path}`, { ...init, headers: { "x-admin-key": key, "Content-Type": "application/json", ...(init.headers || {}) }, signal: AbortSignal.timeout(path.endsWith(".pdf") ? 60000 : 20000) });
    } catch {
      throw new ServiceUnavailableException("The chatbot server didn't answer. It may be asleep (free hosting): try again in a minute.");
    }
    if (r.status === 401) throw new BadRequestException("The chatbot server refused the admin key. Check ADMIN_API_KEY.");
    if (r.status === 404) throw new BadGatewayException("This server doesn't look like the UX Boğa chatbot (no /api/admin route).");
    if (!r.ok) {
      const j: any = await r.json().catch(() => ({}));
      throw new BadGatewayException(j.error || `Chatbot server error (${r.status})`);
    }
    return r;
  }

  private async req(path: string, init?: RequestInit) {
    const c = await this.conn();
    if (!c.url || !c.key) throw new BadRequestException("The chatbot isn't connected yet. Add its server URL and admin key in Chatbot Settings.");
    return this.call(c.url, c.key, path, init);
  }
  async json(path: string, init?: RequestInit) { return (await this.req(path, init)).json(); }
  async file(path: string) {
    const r = await this.req(path);
    return { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "application/octet-stream" };
  }

  async update(d: UpdateChatbotSettingsDto) {
    const cur = await this.conn();
    const url = clean(d.apiUrl), key = d.apiKey?.trim() || cur.key;
    if (!key) throw new BadRequestException("Paste the chatbot admin key (ADMIN_API_KEY).");
    await this.call(url, key, "/knowledge-status"); // vérifie l'URL et la clé avant d'enregistrer
    const set: Partial<ChatbotSettings> = { apiUrl: url, connectedAt: new Date() };
    if (d.apiKey?.trim()) Object.assign(set, { apiKey: encrypt(key, this.secret), last4: key.slice(-4) });
    await this.m.updateOne({}, { $set: set }, { upsert: true });
    return this.view();
  }

  async saveWidget(d: UpdateWidgetDto) {
    await this.m.updateOne({}, { $set: { widget: { ...d } } }, { upsert: true });
    return this.view();
  }

  /** Déconnexion : on oublie l'URL et la clé, l'apparence du widget est gardée */
  async disconnect() {
    await this.m.updateOne({}, { $set: { apiUrl: "", last4: "" }, $unset: { apiKey: 1, connectedAt: 1 } });
    return this.view();
  }
}
