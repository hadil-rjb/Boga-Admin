import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { FootageController } from "./footage.controller";
import { Footage, FootageSchema } from "./footage.schema";
import { FootageRefs } from "./footage.refs";
import { FootageStore } from "./footage.store";
import { FootageSweep } from "./footage.sweep";
import { JobsService } from "./jobs.service";

@Module({
  imports: [MongooseModule.forFeature([{ name: Footage.name, schema: FootageSchema }])],
  controllers: [FootageController],
  providers: [FootageStore, FootageRefs, FootageSweep, JobsService],
  exports: [FootageStore, JobsService],
})
export class FootageModule {}
