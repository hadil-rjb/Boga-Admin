import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import * as mongoose from "mongoose";

/** One uploaded video (raw phone footage or a reference). The bytes live on disk (FootageStore). */
@Schema({ timestamps: true, collection: "footage" })
export class Footage {
  @Prop({ type: String, required: true, index: true }) brand: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: Number, required: true }) size: number;
  @Prop({ type: String, required: true }) mime: string;
  /** "original" (the user's raw video) or "reference" (the style to match) */
  @Prop({ type: String, required: true, enum: ["original", "reference"] }) role: string;
  @Prop({ type: String, default: "uploading", enum: ["uploading", "assembling", "processing", "ready", "failed"] }) status: string;
  @Prop({ type: String }) ext?: string;
  @Prop({ type: String }) createdBy?: string;
  @Prop({ type: String }) error?: string;
  /** probe / proxy / words / look ... : { state, progress, error? } per step */
  @Prop({ type: mongoose.Schema.Types.Mixed, default: {} }) jobs: Record<string, any>;
  /** probe result, filled by the pipeline */
  @Prop({ type: mongoose.Schema.Types.Mixed }) meta?: Record<string, any>;
  /** Original only: the reference video to match (ref) or a saved brand look (lookId), and the spoken language (lang) */
  @Prop({ type: mongoose.Schema.Types.Mixed }) pair?: { ref?: string; lookId?: string; lang?: string };
  createdAt?: Date;
  updatedAt?: Date;
}
export type FootageDocument = HydratedDocument<Footage>;
export const FootageSchema = SchemaFactory.createForClass(Footage);
FootageSchema.set("minimize", false); // keep jobs: {}
