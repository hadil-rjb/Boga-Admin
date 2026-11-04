import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Article, ArticleSchema } from "../articles/article.schema";
import { GscModule } from "../gsc/gsc.module";
import { AiSettings, AiSettingsSchema } from "./ai-settings.schema";
import { Media, MediaSchema } from "../media/media.schema";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { AudioService } from "./audio.service";
import { LocalTtsService } from "./local-tts.service";
import { CoverImageService } from "./cover-image.service";
import { Idea, IdeaSchema } from "./idea.schema";
import { AiUsage, AiUsageSchema, UsageService } from "./usage.service";

@Module({
  imports: [GscModule, MongooseModule.forFeature([{ name: AiSettings.name, schema: AiSettingsSchema }, { name: Idea.name, schema: IdeaSchema }, { name: Article.name, schema: ArticleSchema }, { name: AiUsage.name, schema: AiUsageSchema }, { name: Media.name, schema: MediaSchema }])],
  controllers: [AiController],
  providers: [AiService, CoverImageService, UsageService, AudioService, LocalTtsService],
  exports: [AiService, AudioService],
})
export class AiModule {}
