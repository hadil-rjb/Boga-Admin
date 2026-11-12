import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";

const MODEL = /^[\w.\-:\/]+$/;
export class UpdateAiSettingsDto {
  @IsOptional() @IsIn(["anthropic", "groq"]) provider?: "anthropic" | "groq";
  @IsOptional() @IsString() @MaxLength(120) @Matches(MODEL) anthropicModel?: string;
  @IsOptional() @IsString() @MaxLength(120) @Matches(MODEL) groqModel?: string;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(400) anthropicKey?: string;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(400) groqKey?: string;
  @IsOptional() @IsArray() @IsIn(["anthropic", "groq", "hf"], { each: true }) clearKeys?: ("anthropic" | "groq" | "hf")[];
  @IsOptional() @IsString() @MinLength(10) @MaxLength(400) hfKey?: string;
  @IsOptional() @IsString() @MaxLength(120) @Matches(/^[\w.-]+\/[\w.-]+$/) hfModel?: string;
  @IsOptional() @IsString() @MaxLength(600) imageKeywords?: string;
  @IsOptional() @IsString() @MaxLength(400) imageNegative?: string;
  @IsOptional() @IsString() @MaxLength(2000) brief?: string;
  @IsOptional() @IsString() @MaxLength(40) language?: string;
  @IsOptional() @IsString() @MaxLength(2500) coverStyle?: string;
}
export class CoverPromptDto {
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(80) cat?: string;
  @IsOptional() @IsString() @MaxLength(400) meta?: string;
  @IsOptional() @IsString() @MaxLength(400) sub?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) t?: string[];
  @IsOptional() @IsString() @MaxLength(2000) text?: string;
}
export class GenerateIdeasDto {
  @IsOptional() @IsInt() @Min(1) @Max(10) count?: number;
  @IsOptional() @IsString() @MaxLength(200) focus?: string;
}
export class GenerateArticleDto {
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/, { message: "date au format YYYY-MM-DD" }) date?: string;
}
export class SocialCaptionDto {
  @IsString() @MinLength(1) @MaxLength(120) brand: string;
  @IsOptional() @IsString() @MaxLength(2000) voice?: string;
  @IsOptional() @IsString() @MaxLength(1000) dos?: string;
  @IsOptional() @IsString() @MaxLength(1000) donts?: string;
  @IsOptional() @IsString() @MaxLength(400) hashtags?: string;
  @IsOptional() @IsString() @MaxLength(200) cta?: string;
  @IsOptional() @IsString() @MaxLength(40) language?: string;
  @IsOptional() @IsString() @MaxLength(40) tone?: string;
  @IsString() @MaxLength(120) design: string;
  /** Texts on the slides, top to bottom */
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) @MaxLength(400, { each: true }) texts?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsIn(["ig", "li", "x", "fb", "tt", "tg"], { each: true }) networks?: string[];
  /** First slide as a JPEG/PNG data URL, so the model sees the visual */
  @IsOptional() @IsString() @Matches(/^data:image\/(png|jpeg|webp);base64,/) @MaxLength(4_000_000) image?: string;
}
export class CoverImageDto {
  @IsString() @MinLength(20) @MaxLength(3000) prompt: string;
  @IsOptional() @Matches(/^\d{1,2}:\d{1,2}$/) ratio?: string;
  @IsOptional() @IsInt() @Min(0) @Max(2147483647) seed?: number;
}

/** One turn of the Studio Agent (see agent.ts): the conversation so far and the editor's state */
export class AgentStepDto {
  @IsOptional() @IsIn(["anthropic", "groq"]) provider?: "anthropic" | "groq";
  @IsOptional() @IsString() @Matches(/^[\w.:\/-]{1,120}$/, { message: "invalid model id" }) model?: string;
  /** The agent's mode (see agent.ts): which tools and prompt this turn gets. Missing: design */
  @IsOptional() @IsIn(["design", "animate", "video"]) mode?: "design" | "animate" | "video";
  /** The design, the selection and the brand kit as JSON, built by the studio */
  @IsString() @MaxLength(120_000) context: string;
  /** Provider-neutral messages: user / assistant (text, tool calls) / tool (results); checked in agent.ts */
  @IsArray() @ArrayMaxSize(80) messages: unknown[];
}

export class SceneBriefDto {
  @IsIn(["intro", "body", "outro"]) kind: string;
  /** Length of the scene, in seconds */
  @IsNumber() @Min(0.5) @Max(120) seconds: number;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(400, { each: true }) texts?: string[];
}
/** Voice-over script: one spoken line per scene, sized to the scene's length */
export class VoiceScriptDto {
  @IsString() @MinLength(1) @MaxLength(120) brand: string;
  @IsOptional() @IsString() @MaxLength(2000) voice?: string;
  @IsOptional() @IsString() @MaxLength(40) language?: string;
  @IsOptional() @IsString() @MaxLength(40) tone?: string;
  @IsOptional() @IsString() @MaxLength(200) topic?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => SceneBriefDto) scenes: SceneBriefDto[];
}
export class VoiceoverDto {
  @IsString() @MinLength(1) @MaxLength(1500) text: string;
  /** A local voice: a Kokoro id (af_heart, ff_siwis…), "piper:<file>", or an Arabic F5 voice "f5:<model>:<sample>"
      (f5:habibi-EGY:silma; "custom" with refMedia and refText for a brand's own recording) */
  @IsOptional() @IsString() @MaxLength(80) @Matches(/^((piper|f5):)?[\w.:-]+$/) voice?: string;
  /** A brand's own voice sample (an audio file hosted by the API) and what is said in it, for "f5:<model>:custom" */
  @IsOptional() @IsString() @Matches(/^[0-9a-f]{24}$/) refMedia?: string;
  @IsOptional() @IsString() @MaxLength(400) refText?: string;
  /** Speaking speed (1 = normal) and, for Kokoro, the language code (en-us, fr-fr…; defaults to the voice's) */
  @IsOptional() @IsNumber() @Min(0.6) @Max(1.5) speed?: number;
  @IsOptional() @IsString() @MaxLength(10) lang?: string;
}
export class MusicDto {
  @IsString() @MinLength(3) @MaxLength(300) prompt: string;
  @IsOptional() @IsNumber() @Min(3) @Max(30) seconds?: number;
}
