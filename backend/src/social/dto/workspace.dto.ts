import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, MaxLength, IsObject, IsOptional, IsString, Min, ValidateNested } from "class-validator";

/** Full workspace snapshot, the shape the studio keeps in memory (and exports as JSON). */
export class WorkspaceDto {
  /** Brand kits, in sidebar order */
  @IsArray() @ArrayMinSize(1) brands!: Record<string, any>[];
  /** Per-brand content keyed by brand id: { designs, posts, platforms, ideas, articles } */
  @IsObject() data!: Record<string, Record<string, any>>;
  /** Active brand id (defaults to the first brand) */
  @IsOptional() @IsString() active?: string;
  @IsOptional() @IsObject() set?: Record<string, any>;
}

export class BrandUpsert {
  @IsString() id!: string;
  /** Brand kit (name, colors, fonts, logos, templates, …) */
  @IsObject() kit!: Record<string, any>;
  /** Per-brand content except designs/posts: { platforms, ideas, articles, … } */
  @IsOptional() @IsObject() content?: Record<string, any>;
}

export class ItemUpsert {
  @IsString() brandId!: string;
  @IsObject() item!: Record<string, any> & { id: string };
  /** Designs: the revision this copy is based on (see WorkspaceService.applyDesigns) */
  @IsOptional() @IsInt() @Min(0) rev?: number;
  /** Designs: id of this write, stored with the design */
  @IsOptional() @IsString() @MaxLength(64) wid?: string;
  /** Designs: the client's writes it hasn't had an answer for; a newer revision written by one of them isn't a conflict */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(64, { each: true }) mine?: string[];
}

export class ItemRef {
  @IsString() brandId!: string;
  @IsString() id!: string;
}

export class Deleted {
  @IsOptional() @IsArray() @IsString({ each: true }) brands?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemRef) designs?: ItemRef[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemRef) posts?: ItemRef[];
}

/** Incremental sync sent by the studio: only what changed since its last sync. */
export class WorkspaceDeltaDto {
  @IsOptional() @IsString() active?: string;
  @IsOptional() @IsObject() set?: Record<string, any>;
  @IsOptional() @IsArray() @IsString({ each: true }) brandOrder?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BrandUpsert) brands?: BrandUpsert[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemUpsert) designs?: ItemUpsert[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemUpsert) posts?: ItemUpsert[];
  /** brandId -> design ids in library order */
  @IsOptional() @IsObject() designOrder?: Record<string, string[]>;
  /** brandId -> post ids in planner order */
  @IsOptional() @IsObject() postOrder?: Record<string, string[]>;
  @IsOptional() @ValidateNested() @Type(() => Deleted) deleted?: Deleted;
}
