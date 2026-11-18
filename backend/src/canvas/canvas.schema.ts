import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema } from "mongoose";

/**
 * A Creative Canvas board: an infinite whiteboard of a brand's ideas (text, sticky notes, images, shapes,
 * pen strokes, connectors). Elements are stored as sent after cleaning (see canvas.elements.ts); `rev` grows
 * on every save so two tabs can't silently overwrite each other.
 */
@Schema({ collection: "social_canvas_boards", minimize: false, timestamps: true, versionKey: false })
export class CanvasBoard {
  @Prop({ required: true, index: true }) brandId!: string;
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) name!: string;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) elements!: Record<string, unknown>[];
  /** Where the board was last looked at: pan (x, y) and zoom (z) */
  @Prop({ type: MongooseSchema.Types.Mixed, default: { x: 0, y: 0, z: 1 } }) viewport!: { x: number; y: number; z: number };
  @Prop({ default: 1 }) rev!: number;
  @Prop() createdBy?: string;
  @Prop() updatedBy?: string;
}
export type CanvasBoardDocument = HydratedDocument<CanvasBoard>;
export const CanvasBoardSchema = SchemaFactory.createForClass(CanvasBoard);
CanvasBoardSchema.index({ brandId: 1, id: 1 }, { unique: true });
