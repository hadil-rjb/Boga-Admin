import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

/** Connexion au serveur du chatbot RAG (document unique).
 *  L'adresse du serveur est trouvée sur le site (ou CHATBOT_API_URL) ; la clé admin vient de CHATBOT_ADMIN_KEY, jamais de la base. */
@Schema({ timestamps: true })
export class ChatbotSettings {
  @Prop({ default: "" }) website: string;   // https://uxboga.com
  @Prop({ default: "" }) apiUrl: string;    // serveur trouvé sur le site (vide = CHATBOT_API_URL)
  @Prop({ default: "" }) source: string;    // "site" | "env"
  @Prop({ default: false }) disconnected: boolean; // « Disconnect » : coupe aussi la connexion automatique par l'environnement
  @Prop() connectedAt?: Date;
  /** Apparence du widget du site (titre, couleurs, messages) — sert à l'aperçu et au code d'intégration */
  @Prop({ type: Object, default: {} }) widget: Record<string, unknown>;
}
export type ChatbotSettingsDocument = HydratedDocument<ChatbotSettings>;
export const ChatbotSettingsSchema = SchemaFactory.createForClass(ChatbotSettings);
