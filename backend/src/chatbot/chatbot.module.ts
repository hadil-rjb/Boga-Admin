import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ChatbotSettings, ChatbotSettingsSchema } from "./chatbot-settings.schema";
import { ChatbotController } from "./chatbot.controller";
import { ChatbotService } from "./chatbot.service";

@Module({
  imports: [MongooseModule.forFeature([{ name: ChatbotSettings.name, schema: ChatbotSettingsSchema }])],
  controllers: [ChatbotController],
  providers: [ChatbotService],
})
export class ChatbotModule {}
