import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema } from "mongoose";

/** A brand's connected social account. Tokens are AES-256-GCM encrypted (see common/crypto). */
@Schema({ collection: "social_connections", timestamps: true, versionKey: false })
export class SocialConnection {
  @Prop({ required: true, index: true }) brandId!: string;
  /** ig · li · x · fb · tt · tg · yt */
  @Prop({ required: true }) net!: string;
  /** { id, name, handle?, avatar?, url? } */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) account!: Record<string, any>;
  /** Encrypted JSON: { accessToken, refreshToken?, expiresAt?, … } */
  @Prop({ required: true }) secret!: string;
  /** Non-secret provider data (page id, chat id, …) */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) extra!: Record<string, any>;
  @Prop({ default: "ok" }) status!: "ok" | "error";
  @Prop() lastError?: string;
  @Prop() connectedBy?: string;
  @Prop() connectedAt?: Date;
}
export type SocialConnectionDocument = HydratedDocument<SocialConnection>;
export const SocialConnectionSchema = SchemaFactory.createForClass(SocialConnection);
SocialConnectionSchema.index({ brandId: 1, net: 1 }, { unique: true });

/** Pending OAuth handshakes (state → PKCE verifier), removed after 15 minutes. */
@Schema({ collection: "social_oauth_states", versionKey: false })
export class SocialOAuthState {
  @Prop({ type: String, required: true }) _id!: string;
  @Prop({ required: true }) brandId!: string;
  @Prop({ required: true }) net!: string;
  @Prop({ required: true }) userId!: string;
  @Prop() verifier?: string;
  @Prop({ type: Date, default: () => new Date(), expires: 900 }) createdAt!: Date;
}
export const SocialOAuthStateSchema = SchemaFactory.createForClass(SocialOAuthState);

/** Images rendered by the studio for a post (what gets published). Public URL: /api/social/media/:id.jpg */
@Schema({ collection: "social_media", timestamps: { createdAt: true, updatedAt: false }, versionKey: false })
export class SocialMedia {
  @Prop({ required: true, index: true }) brandId!: string;
  @Prop({ required: true, index: true }) postId!: string;
  @Prop({ required: true }) index!: number;
  @Prop({ required: true, select: false }) data!: Buffer;
  @Prop({ default: "image/jpeg" }) mime!: string;
  @Prop() width?: number;
  @Prop() height?: number;
}
export type SocialMediaDocument = HydratedDocument<SocialMedia>;
export const SocialMediaSchema = SchemaFactory.createForClass(SocialMedia);

/** Workspace-level integrations (Figma token, …). */
@Schema({ collection: "social_integrations", timestamps: true, versionKey: false })
export class SocialIntegration {
  @Prop({ type: String, required: true }) _id!: string;
  @Prop() secret?: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) info!: Record<string, any>;
}
export const SocialIntegrationSchema = SchemaFactory.createForClass(SocialIntegration);
