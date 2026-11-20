import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

/** A scheduled / draft / published social post in the planner. */
@Schema({ collection: "social_posts", strict: false, minimize: false, timestamps: true, versionKey: false })
export class SocialPost {
  @Prop({ required: true, index: true }) brandId!: string;
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) order!: number;
  @Prop() hash?: string;
  /** Design id */
  @Prop() d?: string;
  /** YYYY-MM-DD */
  @Prop({ index: true }) date?: string;
  /** HH:mm */
  @Prop() time?: string;
  /** Platform keys: ig, li, x, fb, tt, tg, yt */
  @Prop({ type: [String], default: undefined }) pf?: string[];
  @Prop() status?: string;
}
export type SocialPostDocument = HydratedDocument<SocialPost>;
export const SocialPostSchema = SchemaFactory.createForClass(SocialPost);
SocialPostSchema.index({ brandId: 1, id: 1 }, { unique: true });
