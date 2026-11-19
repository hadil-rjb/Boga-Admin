import { Body, Controller, Delete, Get, Param, Post, Put, Query, Redirect, Req } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsBoolean, IsObject, IsOptional, IsString } from "class-validator";
import { Public } from "../../common/public.decorator";
import { Roles } from "../../common/roles.decorator";
import { FigmaService } from "./figma.service";

const EDIT = ["admin", "editor"];

export class FigmaTokenDto {
  @IsString() token!: string;
}

export class FigmaRefDto {
  /** A Figma link, a file key or a team link */
  @IsString() ref!: string;
}

export class FigmaImportDto {
  @IsString() fileKey!: string;
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) ids!: string[];
  /** Brand fonts used in place of families the studio doesn't load */
  @IsOptional() @IsObject() fonts?: { heading?: string; body?: string };
  /** Keep missing families as they are (Settings → Figma → Missing fonts) */
  @IsOptional() @IsBoolean() keepFonts?: boolean;
}

/** Settings → Figma (Connect Figma, default file, teams) and the studio's "Import from Figma" / "Re-sync". */
@Controller("social/figma")
export class FigmaController {
  constructor(private figma: FigmaService) {}

  @Get("status") status() { return this.figma.status(); }

  /* ---------- OAuth 2.0 ---------- */
  @Roles(...EDIT) @Get("oauth/url") authUrl(@Req() r: any) { return this.figma.authUrl(r.user.sub); }
  /** Figma's redirect after consent (browser, no Authorization header): protected by `state` + PKCE. */
  @Public() @Get("oauth/callback") @Redirect()
  async callback(@Query() q: Record<string, string>) { return { url: await this.figma.callback(q) }; }
  @Roles(...EDIT) @Delete("connection") disconnect() { return this.figma.disconnect(); }

  /** Personal access token: the alternative to Connect Figma (replaces the current connection). */
  @Roles(...EDIT) @Put("token") saveToken(@Body() d: FigmaTokenDto) { return this.figma.saveToken(d.token); }


  /* ---------- file picker ---------- */
  @Roles(...EDIT) @Put("default") setDefault(@Body() d: FigmaRefDto) { return this.figma.setDefault(d.ref); }
  @Roles(...EDIT) @Delete("default") clearDefault() { return this.figma.clearDefault(); }
  @Roles(...EDIT) @Delete("recent/:key") forgetRecent(@Param("key") key: string) { return this.figma.forgetRecent(key); }
  @Roles(...EDIT) @Post("teams") addTeam(@Body() d: FigmaRefDto) { return this.figma.addTeam(d.ref); }
  @Roles(...EDIT) @Delete("teams/:id") removeTeam(@Param("id") id: string) { return this.figma.removeTeam(id); }
  @Get("teams/:id/folders") teamFolders(@Param("id") id: string) { return this.figma.teamFolders(id); }
  @Get("folders/:id/files") folderFiles(@Param("id") id: string) { return this.figma.folderFiles(id); }

  /* ---------- frames, versions, import ---------- */
  @Get("frames") frames(@Query("url") url?: string, @Query("fileKey") fileKey?: string, @Query("nodeId") nodeId?: string) { return this.figma.frames({ url, fileKey, nodeId }); }
  /** A page (or file) read as a template library: categories → templates → versions */
  @Get("library") library(@Query("url") url?: string, @Query("fileKey") fileKey?: string) { return this.figma.library({ url, fileKey }); }
  @Get("version") version(@Query("fileKey") fileKey: string) { return this.figma.version(fileKey); }
  @Roles(...EDIT) @Post("import") import(@Body() d: FigmaImportDto) { return this.figma.import(d.fileKey, d.ids, { fonts: d.fonts, keepFonts: d.keepFonts }); }
}
