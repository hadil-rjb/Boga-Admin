import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
@Schema({ timestamps: true })
export class GscConnection {
  @Prop({ required: true, select: false }) refreshToken: string; // chiffré
  @Prop({ required: true }) site: string;
  @Prop({ default: () => new Date() }) connectedAt: Date;
}
export type GscConnectionDocument = HydratedDocument<GscConnection>;
export const GscConnectionSchema = SchemaFactory.createForClass(GscConnection);

/** One week of Search Console data (Monday–Sunday), kept for the weekly comparison and alerts */
@Schema({ timestamps: true, collection: "gsc_snapshots" })
export class GscSnapshot {
  @Prop({ required: true }) site: string;
  @Prop({ required: true }) start: string;
  @Prop({ required: true }) end: string;
  @Prop({ type: Object, required: true }) totals: { clicks: number; impressions: number; position: number };
  @Prop({ type: [Object], default: [] }) pages: { key: string; clicks: number; impressions: number; position: number }[];
  @Prop({ type: [Object], default: [] }) queries: { key: string; clicks: number; impressions: number; position: number }[];
}
export type GscSnapshotDocument = HydratedDocument<GscSnapshot>;
export const GscSnapshotSchema = SchemaFactory.createForClass(GscSnapshot);
GscSnapshotSchema.index({ site: 1, start: 1 }, { unique: true });
