import { BadGatewayException, BadRequestException, Body, Controller, HttpCode, Logger, Param, Post } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
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

export class AnalyzeSystemDto {
  @ValidateNested() @Type(() => KitDto) kit!: KitDto;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => ReferenceDto) references!: ReferenceDto[];
}

/** Brand → Design system → "Analyze": pictures and layer lists of the brand's templates and designs → a design system. Stores nothing. */
@Controller("social/brands/:brandId/design-system")
export class DesignSystemController {
  private log = new Logger("DesignSystem");
  constructor(private ai: AiService) {}

  @Roles("admin", "editor") @Post("analyze") @HttpCode(200)
  async analyze(@Param("brandId") brandId: string, @Body() dto: AnalyzeSystemDto) {
    if (!ID.test(brandId)) throw new BadRequestException("This brand id is not valid");
    const key = await this.ai.anthropicKey();
    if (!key) throw new BadRequestException("Add a Claude key in Settings → AI to analyze a brand's designs");
    try {
      return await analyzeWithClaude(key, dto);
    } catch (e: any) {
      this.log.warn(`Design system analysis failed: ${e?.message || e}`);
      throw new BadGatewayException(`Claude couldn't analyze these designs: ${e?.message || "error"}`);
    }
  }
}
