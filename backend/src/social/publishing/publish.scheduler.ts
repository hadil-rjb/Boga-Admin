import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AutomationsService } from "../automations/automations.service";
import { NotionService } from "../notion/notion.service";
import { LiveRenderService } from "./live-render.service";
import { PublisherService } from "./publisher.service";

const TICK_MS = Number(process.env.SOCIAL_PUBLISH_TICK_MS) || 30_000;

/**
 * Every 30 s: scheduled social posts whose time has come are published to their networks.
 * Automations create and arm their runs first (AutomationsService). Live calendar posts are re-rendered with their day's events first (LiveRenderService); if that
 * fails, the slides the studio uploaded go out.
 */
@Injectable()
export class PublishScheduler implements OnModuleInit, OnModuleDestroy {
  private log = new Logger("SocialScheduler");
  private timer?: NodeJS.Timeout;
  private busy = false;
  private ticks = 0;

  constructor(private publisher: PublisherService, private live: LiveRenderService, private automations: AutomationsService, private notion: NotionService) {}

  onModuleInit() { this.timer = setInterval(() => void this.tick(), TICK_MS); setTimeout(() => void this.tick(), 5_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // about once an hour: video files no post uses any more
      if (this.ticks++ % Math.max(1, Math.round(3600_000 / TICK_MS)) === 0) await this.publisher.sweepVideos().catch((e) => this.log.warn(`Video sweep: ${e?.message || e}`));
      // recurring posts: the coming week's runs, and the ones due soon rendered and armed
      await this.automations.tick().catch((e) => this.log.warn(`Automations: ${e?.message || e}`));
      for (const p of await this.publisher.due()) {
        await this.live.refresh(p.brandId, p.id).catch((e) => this.log.warn(`Live data refresh of ${p.brandId}/${p.id} failed, publishing the last rendered slides: ${e?.message || e}`));
        await this.publisher.publish(p.brandId, p.id).catch((e) => this.log.warn(`${p.brandId}/${p.id}: ${e.message}`));
        this.notion.reconcileSoon(); // the published status and link show in Notion Calendar
      }
    } catch (e: any) {
      this.log.error(e?.message ?? e);
    } finally {
      this.busy = false;
    }
  }
}
