import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";

export const RATIOS = ["1:1", "4:5", "9:16"];
/** Standard ratios, or a custom canvas named "<w>x<h>" (designs imported from Figma keep their own size) */
export const RATIO_RE = /^(1:1|4:5|9:16|\d{1,4}x\d{1,4})$/;
export const PLATFORM_KEYS = ["ig", "li", "x", "fb", "tt", "tg"];
export const POST_STATUSES = ["Draft", "Scheduled", "Published"];
export const DESIGN_STATUSES = ["Draft", "Approved", "Scheduled", "Published"];
export const TEMPLATES = ["blank", "calendar", "article", "quote", "stat", "launch", "event", "testimonial", "features"];

// The global ValidationPipe uses `whitelist`, so every accepted field is declared here.

export class CreateBrandDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @IsNotEmpty() name!: string;
  /** Primary brand color, used to build the default palette */
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) color?: string;
  @IsOptional() @IsString() handle?: string;
  @IsOptional() @IsString() website?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() tagline?: string;
  @IsOptional() @IsString() about?: string;
  @IsOptional() @IsString() audience?: string;
  @IsOptional() @IsString() voice?: string;
  @IsOptional() @IsString() dos?: string;
  @IsOptional() @IsString() donts?: string;
  @IsOptional() @IsString() hashtags?: string;
  @IsOptional() @IsString() cta?: string;
  @IsOptional() @IsString() lang?: string;
  @IsOptional() @Matches(RATIO_RE) defaultRatio?: string;
  @IsOptional() @IsBoolean() linkBlog?: boolean;
}

export class CreateDesignDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @Matches(RATIO_RE) ratio?: string;
  @IsOptional() @IsIn(TEMPLATES) tpl?: string;
  @IsOptional() @IsIn(DESIGN_STATUSES) status?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) slides?: number;
  @IsOptional() @IsObject() figma?: Record<string, unknown>;
  @IsOptional() @IsArray() pages?: Record<string, unknown>[];
}

/** One version of a brand template: the same layout with other colors, pictures or words */
export class TemplateVersionDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name!: string;
  /** Its own size (a Story version of a Portrait template); the template's when missing */
  @IsOptional() @Matches(RATIO_RE) ratio?: string;
  @IsOptional() @IsString() bg?: string;
  @IsArray() layers!: Record<string, unknown>[];
  @IsOptional() @IsObject() live?: Record<string, unknown>;
}

export class CreateTemplateDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name!: string;
  @Matches(RATIO_RE) ratio!: string;
  @IsOptional() @IsString() bg?: string;
  @IsArray() layers!: Record<string, unknown>[];
  /** Live data settings of a dynamic slide (mapping, filters, language): the template stays live when reused */
  @IsOptional() @IsObject() live?: Record<string, unknown>;
  /** Other versions of the template (copied with a brand) */
  @IsOptional() @IsArray() versions?: Record<string, unknown>[];
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsString() bg?: string;
  @IsOptional() @IsArray() layers?: Record<string, unknown>[];
  @IsOptional() @IsObject() live?: Record<string, unknown>;
  @IsOptional() @IsArray() versions?: Record<string, unknown>[];
}

export class CreatePostDto {
  @IsOptional() @IsString() id?: string;
  /** Design id */
  @IsString() @IsNotEmpty() d!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @Matches(/^\d{2}:\d{2}$/) time!: string;
  @IsArray() @IsIn(PLATFORM_KEYS, { each: true }) pf!: string[];
  @IsOptional() @IsIn(POST_STATUSES) status?: string;
}
