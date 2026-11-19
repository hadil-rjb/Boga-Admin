import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Article, ArticleSchema } from "../articles/article.schema";
import { GscController } from "./gsc.controller";
import { GscConnection, GscConnectionSchema, GscSnapshot, GscSnapshotSchema } from "./gsc.schema";
import { GscService } from "./gsc.service";
import { SeoMonitor } from "./monitor.service";
@Module({
  imports: [MongooseModule.forFeature([{ name: GscConnection.name, schema: GscConnectionSchema }, { name: GscSnapshot.name, schema: GscSnapshotSchema }, { name: Article.name, schema: ArticleSchema }])],
  controllers: [GscController], providers: [GscService, SeoMonitor], exports: [GscService],
})
export class GscModule {}
