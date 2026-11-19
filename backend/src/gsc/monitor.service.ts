import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Article, ArticleDocument } from "../articles/article.schema";
import { GscConnection, GscConnectionDocument, GscSnapshot, GscSnapshotDocument } from "./gsc.schema";
import { GscService } from "./gsc.service";
import { compareWeeks, weekBefore, weekFor } from "./monitor";

const TICK_MS = 6 * 3600_000; // a new week appears once a week: checking 4 times a day is plenty
const KEEP = 12;              // weeks of history

/** Weekly Search Console snapshot (last full week), compared with the week before to raise alerts in the notification bell */
@Injectable()
export class SeoMonitor implements OnModuleInit, OnModuleDestroy {
  private log = new Logger("SeoMonitor");
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private gsc: GscService,
    @InjectModel(GscSnapshot.name) private snaps: Model<GscSnapshotDocument>,
    @InjectModel(GscConnection.name) private conn: Model<GscConnectionDocument>,
    @InjectModel(Article.name) private articles: Model<ArticleDocument>,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 60_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** Takes the missing snapshots (last week, and the week before when there is none to compare with). */
  async tick() {
    if (this.busy) return { taken: [] as string[] };
    this.busy = true;
    const taken: string[] = [];
    try {
      const c = await this.conn.findOne().lean();
      if (!c) return { taken };
      const site = c.site, w = weekFor(new Date());
      for (const x of [weekBefore(w), w]) {
        if (await this.snaps.exists({ site, start: x.start })) continue;
        const data = await this.gsc.week(x.start, x.end);
        await this.snaps.updateOne({ site, start: x.start }, { $setOnInsert: { ...data, site } }, { upsert: true });
        taken.push(x.start);
      }
      const old = await this.snaps.find({ site }).sort({ start: -1 }).skip(KEEP).select("_id").lean();
      if (old.length) await this.snaps.deleteMany({ _id: { $in: old.map((o) => o._id) } });
    } catch (e: any) { this.log.warn(`Weekly snapshot: ${e?.message || e}`); }
    finally { this.busy = false; }
    return { taken };
  }

  /** The last week, the one before, and the alerts between them */
  async summary() {
    const c = await this.conn.findOne().lean();
    if (!c) return { week: null, previous: null, alerts: [] };
    const [cur, prev] = await this.snaps.find({ site: c.site }).sort({ start: -1 }).limit(2).lean();
    if (!cur) return { week: null, previous: null, alerts: [] };
    const brief = (s: any) => ({ start: s.start, end: s.end, totals: s.totals });
    if (!prev || prev.start !== weekBefore(cur).start) return { week: brief(cur), previous: null, alerts: [] };
    const titles = Object.fromEntries((await this.articles.find().select("slug title").lean()).map((a) => [a.slug.toLowerCase(), a.title]));
    return { week: brief(cur), previous: brief(prev), alerts: compareWeeks(cur as any, prev as any, titles) };
  }
}
