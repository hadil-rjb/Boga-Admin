import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Roles } from "../common/roles.decorator";
import { Article, ArticleDocument } from "../articles/article.schema";
import { PullFramerDto, UpdateFramerSettingsDto } from "./dto/framer.dto";
import { FramerService } from "./framer.service";

const actor = (r: any) => ({ id: r.user.sub as string, name: r.user.name as string });

@Controller("framer")
export class FramerController {
  constructor(private s: FramerService, @InjectModel(Article.name) private articles: Model<ArticleDocument>) {}
  @Get("status") status() { return this.s.status(); }
  @Roles("admin") @Get("settings") settings() { return this.s.view(); }
  @Roles("admin") @Put("settings") save(@Req() r: any, @Body() d: UpdateFramerSettingsDto) { return this.s.update(d, actor(r)); }
  @Roles("admin") @Get("collections") collections() { return this.s.collections(); }
  @Roles("admin") @Get("fields") fields() { return this.s.fields(); }
  /** « Publish to Framer now » : envoie l'article tout de suite (passe en Live) */
  /** « Get from Framer » : aperçu puis import des articles publiés dans la collection CMS */
  @Roles("admin", "editor") @Get("pull") pullPreview() { return this.s.pullPreview(); }
  @Roles("admin", "editor") @Post("pull") @HttpCode(200) pull(@Body() d: PullFramerDto, @Req() r: any) { return this.s.pullApply(d.slugs, actor(r)); }
  @Roles("admin", "editor") @Post("publish/:slug") publish(@Param("slug") slug: string, @Req() r: any) { return this.s.runFor(slug, actor(r)); }
  /** « Retry » : remet le compteur d'essais à zéro, le scheduler reprend l'article */
  @Roles("admin", "editor") @Post("retry/:slug") async retry(@Param("slug") slug: string) {
    await this.articles.updateOne({ slug }, { $set: { framerTries: 0, framerState: "", framerNote: "" }, $unset: { framerNextTry: 1, framerLock: 1 } });
    return { ok: true };
  }
}
