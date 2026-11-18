import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from "@nestjs/common";
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { Roles } from "../common/roles.decorator";
import { CanvasService } from "./canvas.service";

class CreateBoardDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsArray() elements?: unknown[];
  @IsOptional() @IsObject() viewport?: Record<string, unknown>;
}
class SaveBoardDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsArray() elements?: unknown[];
  @IsOptional() @IsObject() viewport?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) rev?: number;
  @IsOptional() @IsBoolean() force?: boolean;
}
class ViewDto {
  @IsObject() viewport!: Record<string, unknown>;
}

const EDIT = ["admin", "editor"];

/** Creative Canvas: a brand's whiteboards of ideas and drafts (collection social_canvas_boards) */
@Controller("social/brands/:brandId/canvas")
export class CanvasController {
  constructor(private svc: CanvasService) {}

  @Get() list(@Param("brandId") b: string) { return this.svc.list(b); }
  @Get(":id") get(@Param("brandId") b: string, @Param("id") id: string) { return this.svc.get(b, id); }
  @Roles(...EDIT) @Post() create(@Param("brandId") b: string, @Body() dto: CreateBoardDto, @Req() r: any) { return this.svc.create(b, dto, r.user?.name); }
  @Roles(...EDIT) @Put(":id") save(@Param("brandId") b: string, @Param("id") id: string, @Body() dto: SaveBoardDto, @Req() r: any) { return this.svc.save(b, id, dto, r.user?.name); }
  /** Pan and zoom only (any signed-in user, viewers too: it changes nothing on the board) */
  @Put(":id/view") @HttpCode(200) view(@Param("brandId") b: string, @Param("id") id: string, @Body() dto: ViewDto) { return this.svc.view(b, id, dto.viewport); }
  @Roles(...EDIT) @Post(":id/duplicate") duplicate(@Param("brandId") b: string, @Param("id") id: string, @Req() r: any) { return this.svc.duplicate(b, id, r.user?.name); }
  @Roles(...EDIT) @Delete(":id") remove(@Param("brandId") b: string, @Param("id") id: string) { return this.svc.remove(b, id); }
}
