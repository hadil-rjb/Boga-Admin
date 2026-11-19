import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsObject, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class UpdateFramerSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(300) projectUrl?: string;
  @IsOptional() @IsString() @MaxLength(300) apiKey?: string;
  @IsOptional() @IsBoolean() clearKey?: boolean;
  @IsOptional() @IsString() @MaxLength(100) collectionId?: string;
  @IsOptional() @IsObject() fieldMap?: Record<string, string>;
  @IsOptional() @IsBoolean() publish?: boolean;
  @IsOptional() @IsBoolean() deploy?: boolean;
  @IsOptional() @IsString() @MaxLength(80) timezone?: string;
}

/** « Get from Framer » : slugs des articles à importer (relus dans Framer côté serveur) */
export class PullFramerDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsString({ each: true }) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { each: true }) slugs: string[];
}
