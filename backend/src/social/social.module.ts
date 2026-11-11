import { FootageModule } from "../footage/footage.module";
import { PostVideoStore } from "./publishing/post-video.store";
import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { BrandsService } from "./brands.service";
import { SocialBrand, SocialBrandSchema } from "./schemas/brand.schema";
import { SocialDesign, SocialDesignSchema } from "./schemas/design.schema";
import { SocialPost, SocialPostSchema } from "./schemas/post.schema";
import { SocialTemplate, SocialTemplateSchema } from "./schemas/template.schema";
import { SocialWorkspace, SocialWorkspaceSchema } from "./schemas/workspace.schema";
import { SocialBrandsController, SocialWorkspaceController } from "./social.controller";
import { WorkspaceService } from "./workspace.service";
import {
  SocialConnection, SocialConnectionSchema, SocialIntegration, SocialIntegrationSchema,
  SocialMedia, SocialMediaSchema, SocialOAuthState, SocialOAuthStateSchema,
} from "./publishing/connection.schema";
import { ConnectionsService } from "./publishing/connections.service";
import { PublisherService } from "./publishing/publisher.service";
import { PublishScheduler } from "./publishing/publish.scheduler";
import { LiveRenderService } from "./publishing/live-render.service";
import { PublishingController } from "./publishing/publishing.controller";
import { FigmaController } from "./figma/figma.controller";
import { FigmaService } from "./figma/figma.service";
import { AiModule } from "../ai/ai.module";
import { CalendarController } from "./calendar/calendar.controller";
import { CalendarService } from "./calendar/calendar.service";
import { BrandGuideController } from "./brand-guide/guide.controller";
import { DesignSystemController } from "./design-system/system.controller";
import { MarketsController } from "./markets/markets.controller";
import { AutomationsController } from "./automations/automations.controller";
import { AutomationsService } from "./automations/automations.service";
import { NotionController } from "./notion/notion.controller";
import { NotionService, SocialNotionPage, SocialNotionPageSchema } from "./notion/notion.service";
import { SocialAutomation, SocialAutomationSchema } from "./schemas/automation.schema";
import { MarketsService } from "./markets/markets.service";
import { SocialDesignVersion, SocialDesignVersionSchema } from "./schemas/version.schema";
import { VersionsController } from "./versions.controller";
import { VersionsService } from "./versions.service";
import { SocialDesignComment, SocialDesignCommentSchema } from "./schemas/comment.schema";
import { CommentsController } from "./comments.controller";
import { CommentsService } from "./comments.service";

/** Social Media workspace: brands, designs, posts, settings, connected accounts, publishing and Figma import (collections prefixed social_). */
@Module({
  imports: [
    AiModule,
    FootageModule, // a video post's MP4: the footage export it was made from, and ffmpeg for recordings
    MongooseModule.forFeature([
      { name: SocialBrand.name, schema: SocialBrandSchema },
      { name: SocialDesign.name, schema: SocialDesignSchema },
      { name: SocialPost.name, schema: SocialPostSchema },
      { name: SocialTemplate.name, schema: SocialTemplateSchema },
      { name: SocialWorkspace.name, schema: SocialWorkspaceSchema },
      { name: SocialConnection.name, schema: SocialConnectionSchema },
      { name: SocialOAuthState.name, schema: SocialOAuthStateSchema },
      { name: SocialMedia.name, schema: SocialMediaSchema },
      { name: SocialIntegration.name, schema: SocialIntegrationSchema },
      { name: SocialAutomation.name, schema: SocialAutomationSchema },
      { name: SocialNotionPage.name, schema: SocialNotionPageSchema },
      { name: SocialDesignVersion.name, schema: SocialDesignVersionSchema },
      { name: SocialDesignComment.name, schema: SocialDesignCommentSchema },
    ]),
  ],
  controllers: [SocialWorkspaceController, SocialBrandsController, VersionsController, CommentsController, PublishingController, FigmaController, CalendarController, MarketsController, AutomationsController, NotionController, BrandGuideController, DesignSystemController],
  providers: [WorkspaceService, BrandsService, VersionsService, CommentsService, ConnectionsService, PublisherService, PostVideoStore, PublishScheduler, LiveRenderService, FigmaService, CalendarService, MarketsService, AutomationsService, NotionService],
})
export class SocialModule {}
