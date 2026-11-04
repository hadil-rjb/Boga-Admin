import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AiModule } from "../ai/ai.module";
import { AiService } from "../ai/ai.service";
import { FOOTAGE_AI } from "./caption-style";
import { FootageController } from "./footage.controller";
import { Footage, FootageSchema } from "./footage.schema";
import { FootageRefs } from "./footage.refs";
import { FootageStore } from "./footage.store";
import { FootageSweep } from "./footage.sweep";
import { ExportService } from "./export.service";
import { JobsService } from "./jobs.service";

@Module({
  imports: [AiModule, MongooseModule.forFeature([{ name: Footage.name, schema: FootageSchema }])],
  controllers: [FootageController],
  providers: [{ provide: FOOTAGE_AI, useExisting: AiService }, FootageStore, FootageRefs, FootageSweep, JobsService, ExportService],
  exports: [FootageStore, JobsService],
})
export class FootageModule {}
