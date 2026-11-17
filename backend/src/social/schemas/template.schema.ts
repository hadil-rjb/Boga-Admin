import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema } from "mongoose";

/**
 * A brand template: one slide saved from the editor ("Save slide as brand template").
 * Stored one per document (not inside the brand), so slides with embedded images
 * never push the brand document past MongoDB's size limit.
 */
@Schema({ collection: "social_templates", strict: false, minimize: false, timestamps: true, versionKey: false })
export class SocialTemplate {
  @Prop({ required: true, index: true }) brandId!: string;
  /** Client id (e.g. "t1") */
  @Prop({ required: true }) id!: string;
  /** Position in the brand's template list (0 = newest) */
  @Prop({ required: true }) order!: number;
  @Prop() hash?: string;

  @Prop({ required: true }) name!: string;
  @Prop() ratio?: string;
  @Prop() bg?: string;
  /** Canvas layers of the saved slide */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) layers!: Record<string, unknown>[];
  /** Live data settings when the slide was a dynamic (live calendar) slide */
  @Prop({ type: MongooseSchema.Types.Mixed }) live?: Record<string, unknown>;
  /**
   * Other versions of the same layout (e.g. a blue, an orange and a dark one), saved from the editor with
   * "Save as a version of…". Each is { id, name, bg, layers, live?, at }; the template's own fields are the original.
   */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) versions!: Record<string, unknown>[];
}
export type SocialTemplateDocument = HydratedDocument<SocialTemplate>;
export const SocialTemplateSchema = SchemaFactory.createForClass(SocialTemplate);
SocialTemplateSchema.index({ brandId: 1, id: 1 }, { unique: true });
