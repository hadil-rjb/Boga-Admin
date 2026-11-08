import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Footage, FootageDocument } from "./footage.schema";
import { FootageRefs } from "./footage.refs";
import { FootageStore } from "./footage.store";

const DAY = 86_400_000;

/** Daily: removes footage older than 7 days that no design or version references, folder included */
@Injectable()
export class FootageSweep implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private log = new Logger("FootageSweep");
  constructor(@InjectModel(Footage.name) private model: Model<FootageDocument>, private store: FootageStore, private refs: FootageRefs) {}

  onModuleInit() {
    this.timer = setInterval(() => this.run().catch((e) => this.log.warn(`sweep failed: ${e?.message ?? e}`)), DAY);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** One pass (testable without timers). Returns the ids removed. */
  async run(now = Date.now()): Promise<string[]> {
    const old = await this.model.find({ createdAt: { $lt: new Date(now - 7 * DAY) } }).select("_id").lean();
    if (!old.length) return [];
    const used = await this.refs.used(), removed: string[] = [];
    for (const f of old as any[]) {
      const id = String(f._id);
      if (used.has(id)) continue;
      await this.store.remove(id);
      await this.model.deleteOne({ _id: f._id });
      removed.push(id);
    }
    return removed;
  }
}
