import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { createHash, randomBytes } from "crypto";
import { Model } from "mongoose";
import { decrypt, encrypt } from "../../common/crypto";
import { ApiError } from "./http";
import { SocialConnection, SocialOAuthState } from "./connection.schema";
import { Linked, Net, NETS, providers, Provider } from "./providers";
import { publicApiBase } from "../../common/public-url";

const b64url = (b: Buffer) => b.toString("base64url");

/** Connected social accounts, per brand: OAuth handshakes, token storage/refresh, disconnect. */
@Injectable()
export class ConnectionsService {
  private log = new Logger("SocialConnections");
  constructor(
    @InjectModel(SocialConnection.name) private conns: Model<SocialConnection>,
    @InjectModel(SocialOAuthState.name) private states: Model<SocialOAuthState>,
    private cfg: ConfigService,
  ) {}

  private env = (k: string) => this.cfg.get<string>(k) || undefined;
  private get secret() { return this.cfg.getOrThrow<string>("JWT_SECRET"); }
  /** Public API base, always ending with /api (PUBLIC_API_URL may be set with or without it) */
  get apiUrl() { return publicApiBase(this.cfg.get<string>("PUBLIC_API_URL")); }
  get frontUrl() { return (this.cfg.get<string>("FRONTEND_URL") || "http://localhost:3000").replace(/\/+$/, ""); }
  redirectUri(net: Net) { return `${this.apiUrl}/social/connections/callback/${net}`; }

  provider(net: string): Provider {
    if (!NETS.includes(net as Net)) throw new NotFoundException(`Unknown network "${net}"`);
    return providers(this.env)[net as Net];
  }
  private missing(p: Provider) { return p.env.filter((k) => !this.env(k)); }

  /** Every network with its setup state and this brand's connection (no secrets). */
  async list(brandId: string) {
    const rows = await this.conns.find({ brandId }).lean();
    return NETS.map((net) => {
      const p = this.provider(net), c = rows.find((r) => r.net === net), missing = this.missing(p);
      return {
        net, name: p.name, kind: p.kind, configured: !missing.length, missing, setup: p.setup,
        callbackUrl: p.kind === "oauth" ? this.redirectUri(net) : undefined,
        // what the network's app settings must list: domains (Meta's App Domains), the site URL, and, for Meta (one app
        // for Facebook and Instagram), both callback URLs
        domains: p.kind === "oauth" ? [...new Set([this.apiUrl, this.frontUrl].map((u) => { try { return new URL(u).hostname; } catch { return ""; } }).filter(Boolean))] : undefined,
        siteUrl: p.kind === "oauth" ? this.frontUrl : undefined,
        callbackUrls: net === "fb" || net === "ig" ? [this.redirectUri("fb"), this.redirectUri("ig")] : p.kind === "oauth" ? [this.redirectUri(net)] : undefined,
        connected: !!c, account: c?.account ?? null, status: c?.status ?? null, error: c?.lastError ?? null, connectedAt: c?.connectedAt ?? null,
      };
    });
  }

  /** Starts an OAuth connection: returns the network's consent URL. */
  async authUrl(brandId: string, net: string, userId: string) {
    const p = this.provider(net);
    if (p.kind !== "oauth") throw new BadRequestException(`${p.name} doesn't use a sign-in page`);
    const missing = this.missing(p);
    if (missing.length) throw new BadRequestException(`${p.name} isn't set up yet: add ${missing.join(", ")} to the API's .env`);
    const state = b64url(randomBytes(24)), verifier = p.pkce ? b64url(randomBytes(48)) : undefined;
    await this.states.create({ _id: state, brandId, net, userId, verifier });
    const challenge = verifier ? b64url(createHash("sha256").update(verifier).digest()) : undefined;
    return { url: p.authorizeUrl({ state, redirectUri: this.redirectUri(net as Net), challenge }) };
  }

  /** The network redirected back: exchange the code and store the account. Returns where to send the browser. */
  async callback(net: string, q: { code?: string; state?: string; error?: string; error_description?: string }) {
    const done = (params: Record<string, string>) => `${this.frontUrl}/social-media/connected?${new URLSearchParams({ net, ...params })}`;
    try {
      if (q.error) throw new ApiError(q.error_description || (q.error === "access_denied" ? "Access was not granted" : q.error));
      const st = q.state && (await this.states.findOneAndDelete({ _id: q.state, net }));
      if (!st) throw new ApiError("This sign-in link expired. Start again from Settings.");
      if (!q.code) throw new ApiError("The network did not return an authorization code");
      const p = this.provider(net);
      if (p.kind !== "oauth") throw new ApiError("Unexpected network");
      const linked = await p.exchange({ code: q.code, redirectUri: this.redirectUri(net as Net), verifier: st.verifier });
      await this.save(st.brandId, net, linked, st.userId);
      return done({ ok: "1", name: linked.account.handle || linked.account.name });
    } catch (e: any) {
      this.log.warn(`${net} connection failed: ${e.message}`);
      return done({ ok: "0", error: e.message || "Connection failed" });
    }
  }

  /** Networks without OAuth (Telegram: bot token + chat). */
  async connectWithToken(brandId: string, net: string, input: Record<string, string>, userId: string) {
    const p = this.provider(net);
    if (p.kind !== "token") throw new BadRequestException(`${p.name} connects with its sign-in page`);
    try {
      const linked = await p.connect(input);
      await this.save(brandId, net, linked, userId);
      return { ok: true, account: linked.account };
    } catch (e: any) {
      throw new BadRequestException(e.message || "Connection failed");
    }
  }

  /** Checks a token connection's details without saving them (each step of the Connect wizard). */
  async checkToken(net: string, input: Record<string, string>) {
    const p = this.provider(net);
    if (p.kind !== "token" || !p.check) throw new BadRequestException(`${p.name} has nothing to check`);
    try {
      return await p.check(input);
    } catch (e: any) {
      throw new BadRequestException(e.message || "Check failed");
    }
  }

  async disconnect(brandId: string, net: string) {
    await this.conns.deleteOne({ brandId, net });
    return { ok: true };
  }

  private async save(brandId: string, net: string, l: Linked, userId?: string) {
    await this.conns.findOneAndUpdate(
      { brandId, net },
      { $set: { account: l.account, extra: l.extra, secret: encrypt(JSON.stringify(l.tokens), this.secret), status: "ok", connectedBy: userId, connectedAt: new Date() }, $unset: { lastError: 1 } },
      { upsert: true },
    );
  }

  /** Decrypted connection, with tokens refreshed when the network supports it. Throws if not connected. */
  async linked(brandId: string, net: Net): Promise<Linked> {
    const c = await this.conns.findOne({ brandId, net }).lean();
    if (!c) throw new ApiError(`${this.provider(net).name} isn't connected for this brand`);
    const l: Linked = { tokens: JSON.parse(decrypt(c.secret, this.secret)), account: c.account as any, extra: c.extra || {} };
    const p = this.provider(net);
    if (p.refresh) {
      const t = await p.refresh(l).catch((e) => { throw new ApiError(`${p.name} session expired, reconnect it in Settings (${e.message})`); });
      if (t) {
        l.tokens = { ...l.tokens, ...t };
        await this.conns.updateOne({ _id: c._id }, { $set: { secret: encrypt(JSON.stringify(l.tokens), this.secret) } });
      }
    }
    return l;
  }

  async markError(brandId: string, net: string, message?: string) {
    await this.conns.updateOne({ brandId, net }, message ? { $set: { status: "error", lastError: message } } : { $set: { status: "ok" }, $unset: { lastError: 1 } });
  }

  async removeBrand(brandIds: string[]) {
    await this.conns.deleteMany({ brandId: { $in: brandIds } });
  }
}
