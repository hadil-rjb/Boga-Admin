import { BadGatewayException, BadRequestException, Body, Controller, HttpCode, Logger, Param, Post } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { Roles } from "../../common/roles.decorator";
import { AiService } from "../../ai/ai.service";
import { analyzeWithClaude } from "./system";

const ID = /^[A-Za-z0-9_-]+$/;

class KitColor {
  @IsString() @MaxLength(60) name!: string;
  @IsString() @MaxLength(20) hex!: string;
}

class KitFonts {
  @IsOptional() @IsString() @MaxLength(80) heading?: string;
  @IsOptional() @IsString() @MaxLength(80) body?: string;
  @IsOptional() @IsString() @MaxLength(80) arabic?: string;
}

class KitDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(200) industry?: string;
  @IsOptional() @IsString() @MaxLength(2000) voice?: string;
  @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => KitColor) colors!: KitColor[];
  @ValidateNested() @Type(() => KitFonts) fonts!: KitFonts;
  /** Names of the brand's logos, so the analysis can tell them apart in the layer lists */
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(60, { each: true }) logos?: string[];
}

class ReferenceDto {
  @IsString() @Matches(/^(template|design)$/) kind!: "template" | "design";
  @IsString() @MaxLength(80) @Matches(ID) id!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsString() @MaxLength(20) ratio!: string;
  @IsInt() @Min(100) @Max(8000) w!: number;
  @IsInt() @Min(100) @Max(8000) h!: number;
  @IsOptional() @IsBoolean() live?: boolean;
  @IsString() @Matches(/^data:image\/(png|jpeg|webp);base64,/) @MaxLength(2_500_000) image!: string;
  @IsString() @MaxLength(40_000) layers!: string;
}

/** An uploaded picture of another brand's work: composition and mood only */
class InspirationDto {
  @IsString() @MaxLength(80) @Matches(ID) id!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsInt() @Min(100) @Max(8000) w!: number;
  @IsInt() @Min(100) @Max(8000) h!: number;
  @IsString() @Matches(/^data:image\/(png|jpeg|webp);base64,/) @MaxLength(2_500_000) image!: string;
}

class GuideRuleDto {
  @IsString() @MaxLength(160) text!: string;
  @IsIn(["do", "dont"]) kind!: "do" | "dont";
}

/** What the brand's guide says about design, as read when the guide was imported */
class GuideDto {
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(400) layout?: string;
  @IsOptional() @IsString() @MaxLength(400) imagery?: string;
  @IsOptional() @IsString() @MaxLength(400) logoUse?: string;
  @IsOptional() @IsString() @MaxLength(400) typography?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => GuideRuleDto) rules?: GuideRuleDto[];
}

export class AnalyzeSystemDto {
  @ValidateNested() @Type(() => KitDto) kit!: KitDto;
  @IsOptional() @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => ReferenceDto) references?: ReferenceDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => InspirationDto) inspiration?: InspirationDto[];
  @IsOptional() @ValidateNested() @Type(() => GuideDto) guide?: GuideDto;
}

/** True when the request has a reference, an inspiration picture, or a guide with at least one non-empty text or rule */
export function hasAnySource(dto: AnalyzeSystemDto): boolean {
  const g = dto.guide;
  const guideHas = !!g && ([g.layout, g.imagery, g.logoUse, g.typography].some((t) => typeof t === "string" && t.trim() !== "")
    || (g.rules ?? []).some((r) => typeof r?.text === "string" && r.text.trim() !== ""));
  return !!dto.references?.length || !!dto.inspiration?.length || guideHas;
}

/** Brand → Design system → "Analyze": pictures and layer lists of the brand's templates and designs → a design system. Stores nothing. */
@Controller("social/brands/:brandId/design-system")
export class DesignSystemController {
  private log = new Logger("DesignSystem");
  constructor(private ai: AiService) {}

  @Roles("admin", "editor") @Post("analyze") @HttpCode(200)
  async analyze(@Param("brandId") brandId: string, @Body() dto: AnalyzeSystemDto) {
    if (!ID.test(brandId)) throw new BadRequestException("This brand id is not valid");
    if (!hasAnySource(dto)) throw new BadRequestException("Add a template, an approved design, an inspiration picture or a brand guide first");
    const key = await this.ai.anthropicKey();
    if (!key) throw new BadRequestException("Add a Claude key in Settings → AI to analyze a brand's designs");
    try {
      return await analyzeWithClaude(key, dto);
    } catch (e: any) {
      this.log.warn(`Design system analysis failed: ${e?.message || e}`);
      const reason = String(e?.message || "").split("\n")[0].trim().slice(0, 160) || "error";
      throw new BadGatewayException(`Claude couldn't analyze these designs: ${reason}`);
    }
  }
}
