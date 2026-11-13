import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import type { Browser } from "puppeteer-core";
import { CalendarService } from "../calendar/calendar.service";
import { MarketsService } from "../markets/markets.service";
import { SocialBrand } from "../schemas/brand.schema";
import { SocialDesign } from "../schemas/design.schema";
import { SocialPost } from "../schemas/post.schema";
import { SocialWorkspace, WORKSPACE_ID } from "../schemas/workspace.schema";
import { strip } from "../social.util";
import { launchChromium } from "./headless";
import { isVideoDesign } from "./post-state";
import { PublisherService } from "./publisher.service";

const RENDER_TIMEOUT_MS = Number(process.env.SOCIAL_LIVE_RENDER_TIMEOUT_MS) || 120_000;
/** The browser is closed after this long without renders (it holds ~150–250 MB) */
const IDLE_MS = 60_000;

/** A page of a design is a live template (economic calendar, price alert, news) once the studio stored its mapping */
export const hasLive = (design: { pages?: any[] } | null | undefined) => !!design?.pages?.some((pg) => pg?.live?.map);

/** Settings → Export & publishing → "Refresh live posts on the server" (on unless switched off) */
export const liveServerOn = (set: Record<string, unknown> | undefined) => set?.liveServer !== 0 && set?.liveServer !== false;

export interface LiveRefresh { postId: string; brandId: string; ms: number; pages: any[] }

/**
 * Live posts (economic calendar, price alert, news), refreshed by the server just before they're published.
 *
 * The studio fills a live design with the events of the post's day and uploads the slides when it
 * schedules the post, and again whenever that day's data changes, but only while a studio tab is open.
 * So that a post scheduled days ahead still goes out with fresh data, the scheduler calls refresh()
 * right before publishing: the studio's own engine runs in headless Chromium (FRONTEND_URL +
 * /social-media/render), applies the data (that day's events from TradingView / Forex Factory, the latest
 * prices, the latest headlines, all fetched here) and renders the slides exactly like a studio export;
 * they replace the post's media.
 */
@Injectable()
export class LiveRenderService implements OnModuleDestroy {
  private log = new Logger("LiveRender");
  private browser: Promise<Browser> | null = null;
  private idle?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectModel(SocialPost.name) private posts: Model<SocialPost>,
    @InjectModel(SocialDesign.name) private designs: Model<SocialDesign>,
    @InjectModel(SocialBrand.name) private brands: Model<SocialBrand>,
    @InjectModel(SocialWorkspace.name) private workspaces: Model<SocialWorkspace>,
    private calendar: CalendarService,
    private markets: MarketsService,
    private publisher: PublisherService,
    private cfg: ConfigService,
  ) {}

  /** SOCIAL_LIVE_RENDER=off disables it for the whole server (e.g. an instance without enough memory) */
  get disabledByEnv() { return /^(off|false|0|no)$/i.test(this.cfg.get<string>("SOCIAL_LIVE_RENDER") || ""); }
  private get studioUrl() {
    return (this.cfg.get<string>("STUDIO_RENDER_URL") || this.cfg.get<string>("FRONTEND_URL") || "http://localhost:3000").replace(/\/+$/, "");
  }

  async onModuleDestroy() { await this.close(); }

  /**
   * Re-renders a scheduled post whose design has live pages. Returns what was refreshed, or null when
   * there was nothing to do (setting off, no live page). Throws when rendering failed: the caller then
   * publishes the slides it already has.
   */
  async refresh(brandId: string, postId: string): Promise<LiveRefresh | null> {
    if (this.disabledByEnv) return null;
    const post = await this.posts.findOne({ brandId, id: postId }).lean<Record<string, any>>();
    if (!post?.d) return null;
    // an automation's post was rendered with fresh data a few minutes ago, when it was armed
    if (post.auto && post.media?.live?.at && Date.now() - new Date(post.media.live.at).getTime() < 15 * 60_000) return null;
    const design = await this.designs.findOne({ brandId, id: post.d }).lean<Record<string, any>>();
    if (!hasLive(design)) return null;
    const ws = await this.workspaces.findById(WORKSPACE_ID).lean();
    if (!liveServerOn((ws?.set || {}) as Record<string, unknown>)) return null;
    const out = await this.renderPost(brandId, postId);
    if (!out) return null;
    await this.publisher.replaceRendered(brandId, postId, out.images, { by: "server", at: new Date(), pages: out.live });
    return { brandId, postId, ms: out.ms, pages: out.live };
  }

  /**
   * Renders any post's design with the studio engine (live data applied for its day), like a studio export.
   * Returns the slides, what the live pages showed and the slides' texts (for captions); null when the post,
   * design or brand is missing or rendering is switched off for this server.
   */
  async renderPost(brandId: string, postId: string): Promise<{ images: string[]; live: any[]; texts: string[]; ms: number } | null> {
    if (this.disabledByEnv) return null;
    const post = await this.posts.findOne({ brandId, id: postId }).lean<Record<string, any>>();
    if (!post?.d) return null;
    const design = await this.designs.findOne({ brandId, id: post.d }).lean<Record<string, any>>();
    if (!design) return null;
    if (isVideoDesign(design)) return null; // a video publishes its prepared MP4: nothing to re-render
    const ws = await this.workspaces.findById(WORKSPACE_ID).lean();
    const set = (ws?.set || {}) as Record<string, unknown>;
    const brand = await this.brands.findById(brandId).lean<Record<string, any>>();
    if (!brand) return null;

    // The studio's workspace snapshot, reduced to this brand, design and post
    const { platforms, ideas, articles, extraData, ...kit } = brand;
    const state = {
      brands: [{ id: brandId, ...strip(kit), templates: [] }],
      data: { [brandId]: { designs: [strip(design)], posts: [strip(post)], platforms: platforms || {}, ideas: [], articles: [] } },
      active: brandId,
      set: { ...set, sec: "accounts" },
    };
    const started = Date.now();
    const { images, live, texts } = await this.render(state, String(post.d), postId);
    for (const p of live) {
      if (p.error) this.log.warn(`Post ${postId} (${brandId}) slide ${p.page + 1}: live data unavailable (${p.error}), kept the last data`);
      else if (p.kind) this.log.log(`Post ${postId} (${brandId}) slide ${p.page + 1}: ${p.kind} · ${p.source} · ${(p.shown || []).join(" | ") || "none"}`);
      else this.log.log(`Post ${postId} (${brandId}) slide ${p.page + 1}: ${p.date} · ${p.source} · ${p.shown.length}/${p.events} events: ${p.shown.join(" | ") || "none"}`);
    }
    const ms = Date.now() - started;
    this.log.log(`Rendered post ${postId} (${brandId}): ${images.length} slide(s) in ${ms} ms`);
    return { images, live, texts: texts || [], ms };
  }

  /** One render at a time (memory), each in its own page */
  private render(state: unknown, designId: string, postId: string) {
    const job = this.queue.then(() => this.renderNow(state, designId, postId));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async renderNow(state: unknown, designId: string, postId: string): Promise<{ images: string[]; live: any[]; texts?: string[] }> {
    if (this.idle) clearTimeout(this.idle);
    const browser = await this.open();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String((e as Error)?.message || e)));
    try {
      page.setDefaultTimeout(RENDER_TIMEOUT_MS);
      // the engine's only requests: live data, answered by this server
      await page.exposeFunction("bogaApi", async (path: string) => {
        const u = new URL(path, "http://x"), q = u.searchParams, opt = (k: string) => q.get(k) || undefined;
        if (u.pathname === "/social/markets/quotes") return this.markets.quotes(opt("symbols"));
        if (u.pathname === "/social/markets/photo") return this.markets.photo(opt("url"));
        if (u.pathname === "/social/markets/news") return this.markets.news({ source: opt("source"), q: opt("q"), lang: opt("lang"), limit: opt("limit"), topics: opt("topics") });
        return this.calendar.events({ date: q.get("date") || "", tz: opt("tz"), countries: opt("countries"), source: opt("source") });
      });
      await page.goto(`${this.studioUrl}/social-media/render`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
      await page.waitForFunction("window.bogaReady === true", { timeout: RENDER_TIMEOUT_MS });
      await page.evaluate((s) => (window as any).bogaBoot(s), state as any);
      const out = await Promise.race([
        page.evaluate((d, p) => (window as any).bogaRender(d, p), designId, postId) as Promise<{ images: string[]; live: any[]; texts?: string[] }>,
        new Promise<never>((_, no) => setTimeout(() => no(new Error("Rendering timed out")), RENDER_TIMEOUT_MS)),
      ]);
      if (!out?.images?.length) throw new Error("The studio rendered no slide");
      return out;
    } catch (e: any) {
      throw new Error(`${e?.message || e}${errors.length ? ` (page: ${errors.slice(0, 2).join("; ")})` : ""}`);
    } finally {
      await page.close().catch(() => undefined);
      this.idle = setTimeout(() => void this.close(), IDLE_MS);
    }
  }

  private open() {
    if (!this.browser) {
      this.browser = launchChromium().then((b) => {
        b.on("disconnected", () => { this.browser = null; });
        return b;
      }).catch((e) => { this.browser = null; throw e; });
    }
    return this.browser;
  }

  private async close() {
    if (this.idle) clearTimeout(this.idle);
    const b = this.browser; this.browser = null;
    if (b) await (await b.catch(() => null))?.close().catch(() => undefined);
  }
}
