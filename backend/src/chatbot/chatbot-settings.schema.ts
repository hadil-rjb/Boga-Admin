import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

/** Connexion au serveur du chatbot RAG (document unique). La clé admin est chiffrée (AES-256-GCM) et jamais renvoyée au navigateur. */
@Schema({ timestamps: true })
export class ChatbotSettings {
  @Prop({ default: "" }) apiUrl: string;   // https://uxboga-chatbot.onrender.com
  @Prop({ select: false }) apiKey?: string; // ADMIN_API_KEY du serveur chatbot
  @Prop({ default: "" }) last4: string;
  @Prop() connectedAt?: Date;
  /** Apparence du widget du site (titre, couleurs, messages) — sert à l'aperçu et au code d'intégration */
  @Prop({ type: Object, default: {} }) widget: Record<string, unknown>;
}
export type ChatbotSettingsDocument = HydratedDocument<ChatbotSettings>;
export const ChatbotSettingsSchema = SchemaFactory.createForClass(ChatbotSettings);
