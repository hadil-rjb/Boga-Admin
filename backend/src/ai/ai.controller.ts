import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { Roles } from "../common/roles.decorator";
import { AiService, Provider } from "./ai.service";
import { AudioService } from "./audio.service";
import { LocalTtsService } from "./local-tts.service";
import { MUSIC_MODEL } from "./audio";
import { publicApiBase } from "../common/public-url";
import { CoverImageService } from "./cover-image.service";
import { UsageService } from "./usage.service";
import { validTz } from "../framer/time";
import { AgentStepDto, CoverImageDto, CoverPromptDto, GenerateArticleDto, GenerateIdeasDto, MusicDto, SocialCaptionDto, UpdateAiSettingsDto, VoiceScriptDto, VoiceoverDto } from "./dto/ai.dto";

const actor = (r: any) => ({ id: r.user.sub as string, name: r.user.name as string });

@Controller("ai")
export class AiController {
  constructor(private s: AiService, private img: CoverImageService, private usage: UsageService, private audio: AudioService, private tts: LocalTtsService) {}
  @Get("settings") settings() { return this.s.view(); }
  @Roles("admin") @Put("settings") save(@Req() r: any, @Body() d: UpdateAiSettingsDto) { return this.s.update(d, actor(r)); }
  @Roles("admin") @Get("models") models(@Query("provider") p: string) { return this.s.models(p === "groq" ? "groq" : ("anthropic" as Provider)); }
  /** Claude tokens and cost, across all brands and per brand */
  @Roles("admin", "editor") @Get("usage") usageSummary(@Query("days") d: string, @Query("tz") tz: string) { return this.usage.summary(Math.max(1, Math.min(365, Math.round(Number(d)) || 30)), tz && validTz(tz) ? tz : "UTC"); }
  @Get("ideas") ideas() { return this.s.listIdeas(); }
  @Roles("admin", "editor") @Post("ideas/generate") generate(@Req() r: any, @Body() d: GenerateIdeasDto) { return this.s.generateIdeas(d, actor(r)); }
  @Roles("admin", "editor") @Post("ideas/:id/article") article(@Req() r: any, @Param("id") id: string, @Body() d: GenerateArticleDto) { return this.s.generateArticle(id, d.date || undefined, actor(r)); }
  @Roles("admin") @Get("image-models") imageModels() { return this.s.imageModels(); }
  @Roles("admin", "editor") @Post("cover-image") coverImage(@Req() r: any, @Body() d: CoverImageDto) { return this.img.generate(d, actor(r)); }
  @Roles("admin") @Post("cover-style/analyze") analyzeCover() { return this.s.analyzeCoverStyle(); }
  @Roles("admin", "editor") @Post("cover-prompt") cover(@Req() r: any, @Body() d: CoverPromptDto) { return this.s.coverPrompt(d, actor(r)); }
  @Roles("admin", "editor") @Post("social-caption") caption(@Req() r: any, @Body() d: SocialCaptionDto) { return this.s.socialCaption(d, actor(r)); }
  /** Video editor: the voices on offer, a script written from the scenes, a voice-over and music made with AI */
  @Roles("admin", "editor") @Get("audio/options") async audioOptions() {
    // the voice: Kokoro and Piper on this server, free and offline (backend/tts/setup.sh); music: Hugging Face, optional
    const voices = this.tts.installed() ? await this.tts.voices().catch(() => null) : null;
    return { engine: voices?.length ? "local" : null, voices: voices ?? [], ready: !!voices?.length, musicReady: !!(await this.s.hfKey()), music: MUSIC_MODEL };
  }
  @Roles("admin", "editor") @Post("voice-script") @HttpCode(200) voiceScript(@Req() r: any, @Body() d: VoiceScriptDto) { return this.s.voiceScript(d, actor(r)); }
  @Roles("admin", "editor") @Post("voiceover") @HttpCode(200) async voiceover(@Req() r: any, @Body() d: VoiceoverDto) { return this.withUrl(r, await this.audio.voiceover(d, actor(r))); }
  @Roles("admin", "editor") @Post("music") @HttpCode(200) async music(@Req() r: any, @Body() d: MusicDto) { return this.withUrl(r, await this.audio.music(d, actor(r))); }
  private withUrl(r: any, a: { id: string; mime: string; bytes: number; model: string }) {
    const base = publicApiBase(process.env.PUBLIC_API_URL, `${r.protocol}://${r.get("host")}`);
    return { ...a, url: `${base}/media/${a.id}.${a.mime === "audio/mpeg" ? "mp3" : a.mime === "audio/wav" ? "wav" : a.mime === "audio/ogg" ? "ogg" : a.mime === "audio/flac" ? "flac" : a.mime === "audio/mp4" ? "m4a" : "weba"}` };
  }
  /** Studio Agent: models to choose from, and one turn of the agent */
  @Roles("admin", "editor") @Get("agent/models") agentModels() { return this.s.agentModels(); }
  @Roles("admin", "editor") @Post("agent") @HttpCode(200) agent(@Req() r: any, @Body() d: AgentStepDto) { return this.s.agentStep(d, actor(r)); }
  @Roles("admin", "editor") @Delete("ideas/:id") dismiss(@Param("id") id: string) { return this.s.dismiss(id); }
}
