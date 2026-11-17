import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { Roles } from "../common/roles.decorator";
import { BrandsService } from "./brands.service";
import { CreateBrandDto, CreateDesignDto, CreatePostDto, CreateTemplateDto, TemplateVersionDto, UpdateTemplateDto } from "./dto/resource.dto";
import { WorkspaceDeltaDto, WorkspaceDto } from "./dto/workspace.dto";
import { WorkspaceService } from "./workspace.service";

// Every signed-in member can read the social workspace; admins and editors can change it.
const EDIT = ["admin", "editor"];

/** Used by the Social Media workspace UI: load / save / reset the whole workspace. */
@Controller("social")
export class SocialWorkspaceController {
  constructor(private readonly ws: WorkspaceService) {}

  @Get("workspace")
  async get() {
    return { workspace: await this.ws.get() };
  }

  /** Incremental sync (what the studio sends while you work) */
  @Roles(...EDIT) @Patch("workspace")
  sync(@Body() dto: WorkspaceDeltaDto) {
    return this.ws.applyDelta(dto);
  }

  /** Replace everything with a snapshot, e.g. a JSON backup from Social Media Settings → Data */
  @Roles(...EDIT) @Put("workspace")
  replace(@Body() dto: WorkspaceDto) {
    return this.ws.replace(dto);
  }

  /** Wipe the social workspace (the studio seeds the demo again) */
  @Roles("admin") @Delete("workspace")
  reset() {
    return this.ws.reset();
  }

  @Get("settings")
  settings() {
    return this.ws.getSettings();
  }

  @Roles(...EDIT) @Patch("settings")
  patchSettings(@Body() body: { active?: string; set?: Record<string, unknown> }) {
    return this.ws.patchSettings(body);
  }
}

/** Granular REST resources: /social/brands, /social/brands/:brandId/designs, …/templates, …/posts */
@Controller("social/brands")
export class SocialBrandsController {
  constructor(private readonly svc: BrandsService) {}

  @Get() list() { return this.svc.listBrands(); }
  @Roles(...EDIT) @Post() create(@Body() dto: CreateBrandDto) { return this.svc.createBrand(dto); }
  @Get(":brandId") get(@Param("brandId") id: string) { return this.svc.getBrand(id); }
  @Roles(...EDIT) @Patch(":brandId") update(@Param("brandId") id: string, @Body() body: Record<string, unknown>) { return this.svc.updateBrand(id, body); }
  @Roles(...EDIT) @Delete(":brandId") remove(@Param("brandId") id: string) { return this.svc.deleteBrand(id); }

  @Get(":brandId/designs") designs(@Param("brandId") brandId: string, @Query("q") q?: string) { return this.svc.listDesigns(brandId, q); }
  @Roles(...EDIT) @Post(":brandId/designs") createDesign(@Param("brandId") brandId: string, @Body() dto: CreateDesignDto) { return this.svc.createDesign(brandId, dto); }
  @Get(":brandId/designs/:id") design(@Param("brandId") brandId: string, @Param("id") id: string) { return this.svc.getDesign(brandId, id); }
  @Roles(...EDIT) @Patch(":brandId/designs/:id") updateDesign(@Param("brandId") brandId: string, @Param("id") id: string, @Body() body: Record<string, unknown>) { return this.svc.updateDesign(brandId, id, body); }
  @Roles(...EDIT) @Delete(":brandId/designs/:id") @HttpCode(200) deleteDesign(@Param("brandId") brandId: string, @Param("id") id: string) { return this.svc.deleteDesign(brandId, id); }

  @Get(":brandId/templates") templates(@Param("brandId") brandId: string) { return this.svc.listTemplates(brandId); }
  @Roles(...EDIT) @Post(":brandId/templates") createTemplate(@Param("brandId") brandId: string, @Body() dto: CreateTemplateDto) { return this.svc.createTemplate(brandId, dto); }
  @Roles(...EDIT) @Patch(":brandId/templates/:id") updateTemplate(@Param("brandId") brandId: string, @Param("id") id: string, @Body() dto: UpdateTemplateDto) { return this.svc.updateTemplate(brandId, id, dto); }
  @Roles(...EDIT) @Delete(":brandId/templates/:id") @HttpCode(200) deleteTemplate(@Param("brandId") brandId: string, @Param("id") id: string) { return this.svc.deleteTemplate(brandId, id); }
  @Roles(...EDIT) @Post(":brandId/templates/:id/versions") addTemplateVersion(@Param("brandId") brandId: string, @Param("id") id: string, @Body() dto: TemplateVersionDto) { return this.svc.addTemplateVersion(brandId, id, dto); }
  @Roles(...EDIT) @Delete(":brandId/templates/:id/versions/:vid") @HttpCode(200) deleteTemplateVersion(@Param("brandId") brandId: string, @Param("id") id: string, @Param("vid") vid: string) { return this.svc.deleteTemplateVersion(brandId, id, vid); }

  @Get(":brandId/posts")
  posts(@Param("brandId") brandId: string, @Query("from") from?: string, @Query("to") to?: string, @Query("status") status?: string) {
    return this.svc.listPosts(brandId, from, to, status);
  }
  @Roles(...EDIT) @Post(":brandId/posts") createPost(@Param("brandId") brandId: string, @Body() dto: CreatePostDto) { return this.svc.createPost(brandId, dto); }
  @Roles(...EDIT) @Patch(":brandId/posts/:id") updatePost(@Param("brandId") brandId: string, @Param("id") id: string, @Body() body: Record<string, unknown>) { return this.svc.updatePost(brandId, id, body); }
  @Roles(...EDIT) @Delete(":brandId/posts/:id") @HttpCode(200) deletePost(@Param("brandId") brandId: string, @Param("id") id: string) { return this.svc.deletePost(brandId, id); }
}
