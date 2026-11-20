import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema } from "mongoose";

/**
 * A recurring post: one design (usually a live template: economic calendar, price alert, news) published
 * on a rhythm. The server creates each run as a scheduled post a week ahead (planner), renders it with
 * fresh data just before its time and publishes it, with or without a studio tab open.
 */
@Schema({ collection: "social_automations", strict: false, minimize: false, timestamps: true, versionKey: false })
export class SocialAutomation {
  @Prop({ required: true, index: true }) brandId!: string;
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) name!: string;
  /** Design id */
  @Prop({ required: true }) d!: string;
  @Prop({ default: true }) active!: boolean;
  /** { kind: daily | weekdays | weekly, days: [1..7], time: "HH:mm" } */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) cadence!: { kind: "daily" | "weekdays" | "weekly"; days: number[]; time: string };
  @Prop({ required: true }) tz!: string;
  /** Networks: ig, li, x, fb, tt, tg, yt */
  @Prop({ type: [String], default: [] }) pf!: string[];
  /** { mode: fixed | ai, text, fc } — text may hold {date} {weekday} {week} {headline} {price} {brand} {website} {hashtags} */
  @Prop({ type: MongooseSchema.Types.Mixed, default: { mode: "fixed", text: "" } }) caption!: { mode: "fixed" | "ai"; text: string; fc?: string };
  @Prop() startDate?: string;
  @Prop() endDate?: string;
  /** Dates (YYYY-MM-DD) skipped by hand in the planner */
  @Prop({ type: [String], default: [] }) skip!: string[];
  /** Also shown in Notion Calendar (when Notion is connected) */
  @Prop({ default: true }) notion!: boolean;
  /** Each run waits "In Review" in Notion and is published only once it's set to Approved there */
  @Prop({ default: false }) approval!: boolean;
  /** A picture of the design (media ids), rendered for Notion Calendar until each post has its own slides */
  @Prop({ type: MongooseSchema.Types.Mixed }) preview?: { ids: string[]; at: Date; d: string; hash?: string };
  /** Why it stopped by itself (e.g. its design was deleted) */
  @Prop() note?: string;
  @Prop() createdBy?: string;
}
export type SocialAutomationDocument = HydratedDocument<SocialAutomation>;
export const SocialAutomationSchema = SchemaFactory.createForClass(SocialAutomation);
SocialAutomationSchema.index({ brandId: 1, id: 1 }, { unique: true });
