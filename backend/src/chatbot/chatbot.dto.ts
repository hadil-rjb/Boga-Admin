import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUrl, Matches, MaxLength, ValidateNested } from "class-validator";

export class UpdateChatbotSettingsDto {
  @IsString() @MaxLength(300) @IsUrl({ require_tld: false, require_protocol: true, protocols: ["http", "https"] }, { message: "Server URL must start with http:// or https://" }) apiUrl: string;
  /** Vide = garder la clé déjà enregistrée */
  @IsOptional() @IsString() @MaxLength(300) apiKey?: string;
}

export class IngestDto {
  @IsOptional() @IsString() @MaxLength(300) @IsUrl({ require_tld: false, require_protocol: true, protocols: ["http", "https"] }, { message: "Start URL must start with http:// or https://" }) startUrl?: string;
}

export class QuickActionDto {
  @IsString() @MaxLength(40) label: string;
  @IsString() @MaxLength(200) prompt: string;
  @IsOptional() @IsString() @MaxLength(20) icon?: string;
}

export class UpdateWidgetDto {
  @IsString() @MaxLength(40) title: string;
  @IsString() @MaxLength(60) subtitle: string;
  @IsString() @MaxLength(600) welcomeMessage: string;
  @IsArray() @ArrayMaxSize(4) @IsString({ each: true }) @MaxLength(120, { each: true }) suggestedQuestions: string[];
  @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => QuickActionDto) quickActions: QuickActionDto[];
  @IsIn(["auto", "light", "dark"]) theme: string;
  @IsIn(["right", "left"]) position: string;
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: "Accent color must be a hex color like #fd0e35" }) accentColor: string;
}
