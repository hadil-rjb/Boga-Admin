import { Body, Controller, Delete, Get, Param, Post, Put, Query, Redirect, Req, Res } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsInt, IsObject, IsOptional, IsString, Matches, Max, Min } from "class-validator";
import { Public } from "../../common/public.decorator";
import { Roles } from "../../common/roles.decorator";
import { ConnectionsService } from "./connections.service";
import { LiveRenderService } from "./live-render.service";
import { PublisherService } from "./publisher.service";

const EDIT = ["admin", "editor"];

export class PostMediaDto {
  /** Slides rendered by the studio, as PNG/JPEG data URLs */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) images?: string[];
  /** Content hash of the design pages the images were rendered from */
  @IsOptional() @IsString() hash?: string;
  /** The post itself, so it exists on the server before the debounced sync */
  @IsOptional() @IsObject() post?: Record<string, any>;
}

export class VideoBeginDto {
  /** The post itself, so it exists on the server before the debounced sync */
  @IsOptional() @IsObject() post?: Record<string, any>;
}
export class VideoCompleteDto {
  @IsInt() @Min(1) @Max(256) parts!: number;
  /** Content hash of the design the video was made from */
  @IsOptional() @IsString() hash?: string;
}
export class VideoFootageDto {
  /** A finished footage export of the post's design (POST /api/footage/export) */
  @IsString() @Matches(/^[a-f0-9]{24}$/) jobId!: string;
  @IsOptional() @IsString() hash?: string;
  @IsOptional() @IsObject() post?: Record<string, any>;
}

export class TokenConnectDto {
  @IsOptional() @IsString() botToken?: string;
  @IsOptional() @IsString() chat?: string;
}

/** Connected accounts (Settings → Connected accounts) and publishing. */
@Controller("social")
export class PublishingController {
  constructor(private conns: ConnectionsService, private publisher: PublisherService, private live: LiveRenderService) {}

  /* ---------- connected accounts ---------- */
  @Get("brands/:brandId/connections")
  list(@Param("brandId") brandId: string) { return this.conns.list(brandId); }

  @Roles(...EDIT) @Get("brands/:brandId/connections/:net/auth-url")
  authUrl(@Param("brandId") brandId: string, @Param("net") net: string, @Req() r: any) { return this.conns.authUrl(brandId, net, r.user.sub); }

  @Roles(...EDIT) @Post("brands/:brandId/connections/:net")
  connect(@Param("brandId") brandId: string, @Param("net") net: string, @Body() d: TokenConnectDto, @Req() r: any) {
    return this.conns.connectWithToken(brandId, net, { botToken: d.botToken ?? "", chat: d.chat ?? "" }, r.user.sub);
  }

  @Roles(...EDIT) @Delete("brands/:brandId/connections/:net")
  disconnect(@Param("brandId") brandId: string, @Param("net") net: string) { return this.conns.disconnect(brandId, net); }

  /** The network's redirect after sign-in (browser, no Authorization header): protected by `state`. */
  @Public() @Get("connections/callback/:net") @Redirect()
  async callback(@Param("net") net: string, @Query() q: Record<string, string>) {
    return { url: await this.conns.callback(net, q) };
  }

  /* ---------- publishing ---------- */
  @Roles(...EDIT) @Put("brands/:brandId/posts/:id/media")
  media(@Param("brandId") brandId: string, @Param("id") id: string, @Body() d: PostMediaDto) {
    return this.publisher.saveMedia(brandId, id, { images: d.images ?? [], hash: d.hash, post: d.post });
  }

  /* ---------- video posts: the studio prepares the MP4 when the post is scheduled (an animated design is recorded and
     uploaded in 8 MB chunks; an imported clip is exported on the server and attached by its export job) ---------- */
  @Roles(...EDIT) @Post("brands/:brandId/posts/:id/video/upload")
  videoBegin(@Param("brandId") brandId: string, @Param("id") id: string, @Body() d: VideoBeginDto) {
    return this.publisher.videoBegin(brandId, id, d.post);
  }

  /** One raw chunk (application/octet-stream, see main.ts) */
  @Roles(...EDIT) @Put("brands/:brandId/posts/:id/video/upload/:uploadId/:index")
  async videoChunk(@Param("brandId") brandId: string, @Param("id") id: string, @Param("uploadId") uploadId: string, @Param("index") index: string, @Req() r: any) {
    await this.publisher.videoChunk(brandId, id, uploadId, Number(index), r.body);
    return { ok: true };
  }

  @Roles(...EDIT) @Post("brands/:brandId/posts/:id/video/upload/:uploadId/complete")
  videoComplete(@Param("brandId") brandId: string, @Param("id") id: string, @Param("uploadId") uploadId: string, @Body() d: VideoCompleteDto) {
    return this.publisher.videoComplete(brandId, id, uploadId, d.parts, d.hash);
  }

  @Roles(...EDIT) @Post("brands/:brandId/posts/:id/video/footage")
  videoFootage(@Param("brandId") brandId: string, @Param("id") id: string, @Body() d: VideoFootageDto) {
    return this.publisher.videoFromFootage(brandId, id, { jobId: d.jobId, hash: d.hash, post: d.post });
  }

  /** Published videos. Public (random ids), with Range requests: Instagram, Facebook and TikTok download them from here. */
  @Public() @Get("video/:file")
  async video(@Param("file") file: string, @Res() res: any) {
    const path = await this.publisher.videoFile(file);
    res.sendFile(path, { headers: { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=31536000, immutable", "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff" }, acceptRanges: true });
  }

  /** Publish now (optionally sending the post and its rendered slides in the same request). */
  @Roles(...EDIT) @Post("brands/:brandId/posts/:id/publish")
  async publish(@Param("brandId") brandId: string, @Param("id") id: string, @Body() d: PostMediaDto) {
    if (d.images?.length) await this.publisher.saveMedia(brandId, id, { images: d.images, hash: d.hash, post: d.post });
    else if (d.post) await this.publisher.upsertPost(brandId, { ...d.post, id });
    return this.publisher.publish(brandId, id, { manual: true });
  }

  /**
   * Re-renders a live calendar post on the server now, with its day's events (what the scheduler does
   * just before publishing). `refreshed` is null when there's nothing to refresh (no live page, setting off).
   */
  @Roles(...EDIT) @Post("brands/:brandId/posts/:id/live-refresh")
  async liveRefresh(@Param("brandId") brandId: string, @Param("id") id: string) {
    const refreshed = await this.live.refresh(brandId, id);
    return { refreshed, ...(await this.publisher.state(brandId, id)) };
  }

  @Get("brands/:brandId/publish-state")
  states(@Param("brandId") brandId: string) { return this.publisher.states(brandId); }

  /** Published images. Public (random ids): Instagram and TikTok download them from here. */
  @Public() @Get("media/:file")
  async file(@Param("file") file: string, @Res() res: any) {
    const m = await this.publisher.file(file);
    res.set({ "Content-Type": m.mime, "Cache-Control": "public, max-age=31536000, immutable", "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff" });
    res.send(m.data);
  }
}
