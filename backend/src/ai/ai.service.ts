import { BadGatewayException, BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { decrypt, encrypt } from "../common/crypto";
import { Article, ArticleDocument } from "../articles/article.schema";
import { slugify } from "../articles/articles.service";
import { GscService } from "../gsc/gsc.service";
import { Actor, ActivityService } from "../share/activity.service";
import { AiSettings, AiSettingsDocument } from "./ai-settings.schema";
import { Idea, IdeaDocument } from "./idea.schema";
import { AgentStepDto, GenerateIdeasDto, SocialCaptionDto, UpdateAiSettingsDto, VoiceScriptDto } from "./dto/ai.dto";
import { AgentCall, agentSystemPrompt, cleanMessages, toAnthropic, toOpenAi, toolsFor } from "./agent";
import { cleanHtml, words } from "./html";
import { fetchImage, Img } from "./image";
import { coverProfile } from "./cover-profile";
import { hfImageModels, hfWhoami } from "./hf";
import { trackClaude } from "./usage";
import { NoAnthropicKey, parseJsonLoose } from "../footage/caption-style";

export type Provider = "anthropic" | "groq";
const LABEL: Record<Provider, string> = { anthropic: "Claude", groq: "Groq" };
const PREFIX: Record<Provider, string> = { anthropic: "sk-ant-", groq: "gsk_" };
const BRAND = "UX Boğa";
const FORMATS = ["guide", "how-to", "listicle", "comparison", "case-study", "checklist", "opinion", "news-analysis"];
const INTENTS = ["informational", "commercial", "transactional", "navigational"];
const HOURLY_LIMIT = 30;
/** Agent turns per user and hour (one request can run several tools) */
const AGENT_HOURLY_LIMIT = 400;

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n + 1).replace(/\s+\S*$/, "").trim());
const today = () => new Date().toISOString().slice(0, 10);

export function parseJson(t: string) {
  const s = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new BadGatewayException("The AI returned an unexpected answer. Please try again.");
  try { return JSON.parse(s.slice(a, b + 1)); } catch { throw new BadGatewayException("The AI returned malformed JSON. Please try again."); }
}
/** Format balisé [TAG]…[/TAG] : bien plus fiable que du JSON pour un long contenu HTML */
export function parseBlocks(t: string) {
  const o: Record<string, string> = {};
  for (const m of t.matchAll(/\[([A-Z]+)\]([\s\S]*?)\[\/\1\]/g)) o[m[1]] = m[2].trim();
  return o;
}

@Injectable()
export class AiService {
  private busy = new Set<string>();
  private hits = new Map<string, number[]>();
  private secret: string;

  constructor(
    @InjectModel(AiSettings.name) private settings: Model<AiSettingsDocument>,
    @InjectModel(Idea.name) private ideas: Model<IdeaDocument>,
    @InjectModel(Article.name) private articles: Model<ArticleDocument>,
    private gsc: GscService,
    private act: ActivityService,
    cfg: ConfigService,
  ) { this.secret = cfg.getOrThrow<string>("JWT_SECRET"); }

  /* ───────────── Studio Agent ───────────── */
  private agentHits = new Map<string, number[]>();
  private modelCache = new Map<Provider, { at: number; models: { id: string; name: string }[] }>();

  /** Models the agent can use: the providers with a key, and the workspace default */
  async agentModels() {
    const s = await this.load(), providers: { id: Provider; label: string; models: { id: string; name: string }[] }[] = [];
    for (const p of ["anthropic", "groq"] as Provider[]) {
      if (!this.key(s, p)) continue;
      let hit = this.modelCache.get(p);
      if (!hit || Date.now() - hit.at > 10 * 60_000) {
        const models = await this.listModels(p).catch(() => hit?.models ?? []);
        hit = { at: Date.now(), models }; this.modelCache.set(p, hit);
      }
      providers.push({ id: p, label: LABEL[p], models: hit.models });
    }
    return { default: { provider: s.provider, model: s.provider === "anthropic" ? s.anthropicModel : s.groqModel }, providers };
  }

  /** One turn of the agent: the model answers with text and/or tool calls the studio then runs */
  async agentStep(d: AgentStepDto, actor: Actor) {
    const now = Date.now(), uid = actor.id ?? "anon", h = (this.agentHits.get(uid) ?? []).filter((t) => now - t < 3_600_000);
    if (h.length >= AGENT_HOURLY_LIMIT) throw new HttpException("Hourly agent limit reached — try again later", 429);
    h.push(now); this.agentHits.set(uid, h);

    const s = await this.load(), p: Provider = d.provider ?? s.provider, key = this.key(s, p);
    if (!key) throw new BadRequestException(`Add a ${LABEL[p]} API key in Settings → AI first`);
    const model = d.model || (p === "anthropic" ? s.anthropicModel : s.groqModel);
    const msgs = cleanMessages(d.messages), mode = d.mode ?? "design", tools = toolsFor(mode);
    const system = `${agentSystemPrompt(d.context, mode)}\n\nWorkspace brief (audience, tone, goals): ${clip(s.brief, 1500) || "none"}\nDefault language for copy: ${s.language || "English"}\n\nThe editor right now (JSON):\n${d.context}`;

    if (p === "anthropic") {
      const res = await this.http("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 4096, system, tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })), messages: toAnthropic(msgs) }),
      });
      if (!res.ok) await this.fail(res, p);
      const j: any = await res.json();
      trackClaude("Studio agent", j.model || model, j.usage);
      const blocks: any[] = j.content ?? [];
      const calls: AgentCall[] = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
      return { text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), calls, provider: p, model, stop: j.stop_reason };
    }
    const vision = /llama-4|vision|scout|maverick/i.test(model);
    const res = await this.http("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 4096, temperature: 0.4, messages: toOpenAi(system, msgs, vision), tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: "auto" }),
    });
    if (!res.ok) await this.fail(res, p);
    const j: any = await res.json(), m = j.choices?.[0]?.message ?? {};
    const calls: AgentCall[] = (m.tool_calls ?? []).map((c: any) => {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(c.function?.arguments || "{}"); } catch { input = { _error: "The arguments were not valid JSON" }; }
      return { id: String(c.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.function?.name, input };
    });
    return { text: String(m.content ?? "").trim(), calls, provider: p, model, stop: j.choices?.[0]?.finish_reason };
  }

  /* ───────────── Réglages ───────────── */
  private async load() {
    return (await this.settings.findOne().select("+anthropicKey +groqKey +hfKey")) ?? (await this.settings.create({}));
  }
  private key(s: AiSettingsDocument, p: Provider) {
    const e = s[`${p}Key` as "anthropicKey" | "groqKey"];
    if (!e) return null;
    try { return decrypt(e, this.secret); } catch { return null; }
  }
  /** Claude key from Settings → AI (decrypted), for other features that call Claude, or null */
  async anthropicKey() { return this.key(await this.load(), "anthropic"); }
  private hfToken(s: AiSettingsDocument) { if (!s.hfKey) return null; try { return decrypt(s.hfKey, this.secret); } catch { return null; } }
  async imageModels() { return hfImageModels(this.hfToken(await this.load()) ?? undefined); }

  async view() {
    const s = await this.load();
    const k = (p: Provider) => { const v = this.key(s, p); return { hasKey: !!v, last4: v ? v.slice(-4) : "", model: p === "anthropic" ? s.anthropicModel : s.groqModel }; };
    const a = k("anthropic"), g = k("groq"), hk = this.hfToken(s);
    return { provider: s.provider, anthropic: a, groq: g, brief: s.brief, language: s.language, coverStyle: s.coverStyle, coverStyleSource: s.coverStyleSource, coverStyleAt: s.coverStyleAt ?? null, hf: { hasKey: !!hk, last4: hk ? hk.slice(-4) : "", model: s.hfModel }, imageKeywords: s.imageKeywords, imageNegative: s.imageNegative, imageKeywordsSource: s.imageKeywordsSource, coverProfile: s.coverProfile ?? null, ready: (s.provider === "anthropic" ? a : g).hasKey };
  }

  async update(dto: UpdateAiSettingsDto, actor: Actor) {
    const s = await this.load();
    for (const p of ["anthropic", "groq"] as Provider[]) {
      const raw = dto[`${p}Key` as "anthropicKey" | "groqKey"]?.trim();
      if (!raw) continue;
      if (!raw.startsWith(PREFIX[p])) throw new BadRequestException(`That doesn't look like a ${LABEL[p]} API key (it should start with ${PREFIX[p]}…)`);
      const list = await this.listModels(p, raw); // valide la clé auprès du fournisseur avant de l'enregistrer
      s[`${p}Key` as "anthropicKey" | "groqKey"] = encrypt(raw, this.secret);
      const cur = p === "anthropic" ? s.anthropicModel : s.groqModel;
      if (!list.some(m => m.id === cur)) {
        const pick = (p === "anthropic" ? list.find(m => /sonnet/i.test(m.id)) : list.find(m => m.id === "llama-3.3-70b-versatile")) ?? list[0];
        if (pick) { if (p === "anthropic") s.anthropicModel = pick.id; else s.groqModel = pick.id; }
      }
    }
    const hfRaw = dto.hfKey?.trim();
    if (hfRaw) {
      if (!hfRaw.startsWith("hf_")) throw new BadRequestException("That doesn't look like a Hugging Face token (it should start with hf_…)");
      await hfWhoami(hfRaw); // jeton valide ? sinon rien n'est enregistré
      s.hfKey = encrypt(hfRaw, this.secret);
    }
    for (const p of dto.clearKeys ?? []) s[`${p}Key` as "anthropicKey" | "groqKey" | "hfKey"] = undefined;
    if (dto.hfModel) s.hfModel = dto.hfModel;
    if (dto.imageKeywords !== undefined && dto.imageKeywords.trim() !== s.imageKeywords) { s.imageKeywords = dto.imageKeywords.trim(); s.imageKeywordsSource = "manual"; }
    if (dto.imageNegative !== undefined && dto.imageNegative.trim() !== s.imageNegative) { s.imageNegative = dto.imageNegative.trim(); s.imageKeywordsSource = "manual"; }
    if (dto.provider) s.provider = dto.provider;
    if (dto.anthropicModel) s.anthropicModel = dto.anthropicModel;
    if (dto.groqModel) s.groqModel = dto.groqModel;
    if (dto.brief !== undefined) s.brief = dto.brief.trim();
    if (dto.language) s.language = dto.language.trim();
    if (dto.coverStyle !== undefined && dto.coverStyle.trim() !== s.coverStyle) { s.coverStyle = dto.coverStyle.trim(); s.coverStyleSource = s.coverStyle ? "manual" : ""; s.coverStyleAt = new Date(); }
    await s.save();
    await this.act.record({ kind: "share", action: "ai", actorId: actor.id ?? undefined, actorName: actor.name, target: `${LABEL[s.provider]} · ${s.provider === "anthropic" ? s.anthropicModel : s.groqModel}` });
    return this.view();
  }

  /* ───────────── Appels fournisseurs ───────────── */
  private async http(url: string, init: RequestInit, ms = 150_000) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...init, signal: ctl.signal }); }
    catch (e: any) { throw new BadGatewayException(e?.name === "AbortError" ? "The AI provider took too long to respond" : "Could not reach the AI provider"); }
    finally { clearTimeout(t); }
  }
  /** Ne jamais renvoyer le 401 du fournisseur tel quel : le front déconnecterait l'utilisateur */
  private async fail(res: Response, p: Provider): Promise<never> {
    const j: any = await res.json().catch(() => ({}));
    const m = clip(j?.error?.message ?? j?.message ?? res.statusText, 200);
    if (res.status === 401 || res.status === 403) throw new BadRequestException(`${LABEL[p]} rejected the API key`);
    if (res.status === 404) throw new BadRequestException(`Model not found — choose another model in Settings → AI`);
    if (res.status === 413) throw new BadGatewayException(`The request is too large for this model — choose a model with a larger limit`);
    if (res.status === 429) throw new BadGatewayException(`${LABEL[p]} rate limit or quota reached — try again shortly`);
    throw new BadGatewayException(`${LABEL[p]} error: ${m}`);
  }

  async listModels(p: Provider, key?: string) {
    const k = key ?? this.key(await this.load(), p);
    if (!k) throw new BadRequestException(`Add a ${LABEL[p]} API key first`);
    const res = p === "anthropic"
      ? await this.http("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": k, "anthropic-version": "2023-06-01" } }, 20_000)
      : await this.http("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${k}` } }, 20_000);
    if (!res.ok) await this.fail(res, p);
    const j: any = await res.json();
    const out: { id: string; name: string }[] = (j.data ?? [])
      .filter((m: any) => p === "anthropic" || !/whisper|tts|guard|embed|playai|orpheus/i.test(m.id))
      .map((m: any) => ({ id: String(m.id), name: String(m.display_name ?? m.id) }));
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  async models(p: Provider) { return { models: await this.listModels(p) }; }

  private async complete(system: string, user: string, o: { maxTokens: number; json?: boolean; images?: Img[]; model?: string; feature?: string; provider?: Provider }) {
    const s = await this.load(), p = o.provider ?? s.provider, key = this.key(s, p);
    if (!key) throw new BadRequestException(`Add a ${LABEL[p]} API key in Settings → AI first`);
    const model = o.model ?? (p === "anthropic" ? s.anthropicModel : s.groqModel);
    const imgs = o.images ?? [];
    if (p === "anthropic") {
      const res = await this.http("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: o.maxTokens, system, messages: [{ role: "user", content: imgs.length ? [...imgs.map(i => ({ type: "image", source: { type: "base64", media_type: i.media, data: i.data } })), { type: "text", text: user }] : user }] }),
      });
      if (!res.ok) await this.fail(res, p);
      const j: any = await res.json();
      trackClaude(o.feature ?? "Blog AI", j.model || model, j.usage);
      if (j.stop_reason === "max_tokens") throw new BadGatewayException("The answer was cut off — try again or pick a model with a larger output limit");
      return { text: (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""), model };
    }
    const body: any = { model, max_tokens: o.maxTokens, temperature: 0.7, messages: [{ role: "system", content: system }, { role: "user", content: imgs.length ? [{ type: "text", text: user }, ...imgs.map(i => ({ type: "image_url", image_url: { url: `data:${i.media};base64,${i.data}` } }))] : user }] };
    if (o.json) body.response_format = { type: "json_object" };
    const call = () => this.http("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    let res = await call();
    if (res.status === 400 && o.json) { delete body.response_format; res = await call(); } // modèle sans mode JSON
    if (!res.ok) await this.fail(res, p);
    const j: any = await res.json();
    if (j.choices?.[0]?.finish_reason === "length") throw new BadGatewayException("The answer was cut off — try again or pick a model with a larger output limit");
    return { text: String(j.choices?.[0]?.message?.content ?? ""), model };
  }

  /** Caption for a social post, in the brand's voice, with the provider chosen in Settings → AI */
  async socialCaption(d: SocialCaptionDto, actor: Actor) {
    this.throttle(actor.id ?? "anon");
    const NET: Record<string, string> = { ig: "Instagram", li: "LinkedIn", x: "X (280 characters max)", fb: "Facebook", tt: "TikTok", tg: "Telegram" };
    const lang = d.language || "English";
    const system = `You write social media captions for the brand "${clip(d.brand, 120)}". Write in ${lang}. ${d.tone && d.tone !== "Auto" ? `Tone: ${d.tone}.` : ""}
Brand voice: ${clip(d.voice, 2000) || "clear, friendly and expert"}.
${d.dos ? `Always: ${clip(d.dos, 1000)}.` : ""} ${d.donts ? `Never: ${clip(d.donts, 1000)}.` : ""}
Write one caption that works on ${(d.networks ?? []).map((n) => NET[n] || n).join(", ") || "Instagram and LinkedIn"}: a strong first line, one or two short paragraphs about what the post shows, ${d.cta ? `this call to action: "${clip(d.cta, 200)}", ` : ""}then 3 to 5 relevant hashtags${d.hashtags ? ` (prefer: ${clip(d.hashtags, 400)})` : ""}.
Only state facts that appear on the slides; never invent figures, dates or promises. Answer with the caption only: no title, no quotes, no explanation.`;
    const user = `Post: ${clip(d.design, 120)}\nText on the slides:\n${(d.texts ?? []).map((t) => "- " + clip(t, 400)).join("\n") || "(no text)"}`;
    const m = d.image && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(d.image);
    const { text, model } = await this.complete(system, user, { maxTokens: 1500, images: m ? [{ media: m[1], data: m[2] }] : [], feature: "Post captions" });
    return { caption: text.trim().replace(/^["“]|["”]$/g, ""), model };
  }

  /**
   * Describes the burned-in subtitle style of a reference video from crops of its caption band (`images[0]` is a whole frame,
   * the others are crops of the band `band`, fractions of the frame height). Always Claude: the settings model when it can read
   * images, else claude-sonnet-5-5. Throws NoAnthropicKey without a Claude key. Colors are not asked: the caller samples them from the pixels.
   */
  async captionStyle(images: Img[], sampled: { text: string | null; highlight: string | null }, actor: Actor, band?: [number, number]): Promise<{ style: Record<string, any>; model: string }> {
    const s = await this.load();
    if (!this.key(s, "anthropic")) throw new NoAnthropicKey();
    const model = /^claude-(?!2|instant)/i.test(s.anthropicModel ?? "") ? s.anthropicModel : "claude-sonnet-5-5";
    const [b0, b1] = band ? [Math.max(0, band[0] - 0.05), Math.min(1, band[1] + 0.05)] : [0, 1];
    const system = `You are a motion designer who copies the burned-in subtitle style of a video. Reply with one JSON object only: no prose, no code fence.`;
    const user = `Image 1 is a whole frame of the reference video. The other ${Math.max(0, images.length - 1)} images are crops of the caption band, taken at full resolution from different moments; in the whole frame the band runs from ${b0.toFixed(3)} to ${b1.toFixed(3)} of the frame height (0 = top, 1 = bottom).${sampled.text ? ` The measured text color is ${sampled.text}.` : ""}${sampled.highlight ? ` The measured color of the emphasized word is ${sampled.highlight}.` : ""}
Reply with one JSON object that has exactly these keys, in this order (the values below only show the types):
{"font":"sans-bold","size":0.045,"weight":800,"case":"none","stroke":null,"shadow":null,"box":null,"highlight":{"mode":"box","textLight":false,"radius":0.2},"y":0.65,"maxWords":3,"maxChars":22,"lines":1,"anim":"none"}
Every key must be present; "highlight" is always an object and "y" is always a top-level number. Meaning of each key:
- font: the closest class: "sans-bold" (heavy rounded or grotesque), "sans" (regular grotesque), "serif" (letters with serifs), "display" (decorative or condensed poster lettering).
- size: font size as a fraction of the FULL frame height. The cap height of the letters is about 0.7 x the font size: measure a capital letter, divide by 0.7, convert to a fraction of the full frame height. Typical 0.03 to 0.07.
- weight: 300 to 900. case: "none" or "upper".
- stroke: null, or {"width": n} for an outline around the letters (fraction of the frame height, typical 0.003 to 0.008).
- shadow: null, or {"blur": n, "y": n} for a soft drop shadow (fractions of the frame height). Its "y" is the shadow offset and has nothing to do with the top-level "y".
- box: null, or {"radius": n, "pad": n} for a background box behind the WHOLE caption line, not behind one word (radius 0 to 0.5 relative to the box height, pad a fraction of the frame height).
- highlight: one word emphasized differently from the others. mode "box" = a colored box behind that word, "color" = only that word's color changes, "scale" = that word is larger, "none" = no emphasis. textLight = true when the emphasized word's letters are light (for example white on a colored box), false when they are dark. radius = corner radius of the word box relative to its height, 0 to 0.5.
- y: the vertical CENTER of the caption line as a fraction of the FULL frame height, 0 = top edge, 1 = bottom edge. Measure it on image 1: find the line of text, take the middle of its letters, divide by the image height. Cross-check with the crops: they start at ${b0.toFixed(3)} and end at ${b1.toFixed(3)} of the frame height, so y = ${b0.toFixed(3)} + (position of the line center inside the crop, 0 to 1) x ${(b1 - b0).toFixed(3)}. The band is wider than the text and may show body, clothes or background above and below the line: the caption is the text, not the middle of the band.
- maxWords: how many words are visible at once on the line, counted across the images. maxChars: the most characters visible on one line. lines: 1 or 2.
- anim: "pop" only when the emphasized word looks larger in some images than in others, "fade" only if you can see it fading, otherwise "none".
Describe only what is visible. When unsure, use the most common value.`;
    const { text } = await this.complete(system, user, { maxTokens: 700, json: true, images, model, provider: "anthropic", feature: "Footage captions" });
    return { style: (parseJsonLoose(text) as Record<string, any>) ?? {}, model };
  }

  /** One spoken line per scene, as many words as fit the scene at a natural pace (about 2.5 words a second) */
  async voiceScript(d: VoiceScriptDto, actor: Actor) {
    this.throttle(actor.id ?? "anon");
    const lang = d.language || "English";
    const system = `You write the voice-over of a short social video for the brand "${clip(d.brand, 120)}". Write in ${lang}. ${d.tone && d.tone !== "Auto" ? `Tone: ${d.tone}.` : ""}
Brand voice: ${clip(d.voice, 2000) || "clear, friendly and expert"}.
The video has ${d.scenes.length} scenes. Write exactly one spoken line per scene, in order. A line must be natural to say aloud, with no hashtags, emojis, stage directions or scene numbers.
Each scene has a length: write about 2.3 words per second of that scene, never more than 2.6, so the voice finishes before the scene ends. The intro hooks, the middle scenes explain, the outro ends with a short call to action.
Only use facts that appear in the scene texts; never invent figures, dates or promises.
Reply with JSON only: {"lines": ["…", "…"]} with exactly ${d.scenes.length} strings.`;
    const user = `${d.topic ? `Topic: ${clip(d.topic, 200)}\n` : ""}Scenes:\n${d.scenes.map((x, i) => `${i + 1}. ${x.kind}, ${Math.round(x.seconds * 10) / 10} s. On screen: ${(x.texts ?? []).map((t) => clip(t, 200)).join(" | ") || "(no text)"}`).join("\n")}`;
    const { text, model } = await this.complete(system, user, { maxTokens: 2000, json: true, feature: "Video voice-over" });
    let lines: string[] = [];
    try { const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); lines = Array.isArray(j.lines) ? j.lines.map((x: unknown) => String(x ?? "").trim()) : []; } catch { /* repli ci-dessous */ }
    if (!lines.length) lines = text.split(/\n+/).map((x: string) => x.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
    while (lines.length < d.scenes.length) lines.push("");
    return { lines: lines.slice(0, d.scenes.length).map((x) => clip(x, 600)), model };
  }
  /** Hugging Face token from Settings → Cover images (decrypted), or null */
  async hfKey() { return this.hfToken(await this.load()); }

  private throttle(user: string) {
    const now = Date.now(), h = (this.hits.get(user) ?? []).filter(t => now - t < 3_600_000);
    if (h.length >= HOURLY_LIMIT) throw new HttpException("Hourly AI generation limit reached — try again later", 429);
    h.push(now); this.hits.set(user, h);
  }

  /* ───────────── Stratégie de contenu : données disponibles ───────────── */
  private async context(focus?: string) {
    const arts = await this.articles.find().select("title cat t status date meta alt").lean();
    const count = (f: (a: any) => string[]) => { const m = new Map<string, number>(); arts.forEach(a => f(a).filter(Boolean).forEach(x => m.set(x, (m.get(x) ?? 0) + 1))); return [...m].sort((a, b) => b[1] - a[1]); };
    const cats = count(a => [a.cat]), tags = count(a => a.t ?? []).slice(0, 20);
    const st = (s: string) => arts.filter(a => a.status === s).length;
    const months = new Map<string, number>();
    arts.filter(a => a.status === "Live" && a.date).forEach(a => months.set(a.date.slice(0, 7), (months.get(a.date.slice(0, 7)) ?? 0) + 1));
    const cadence = [...months].sort().slice(-8).map(([m, n]) => `${m}:${n}`).join(", ") || "none";
    const upcoming = arts.filter(a => a.status === "Scheduled" && a.date >= today()).map(a => a.date).sort().slice(0, 10).join(", ") || "nothing scheduled";
    const titles = arts.map(a => `- ${clip(a.title, 90)} [${a.cat || "uncategorised"}]`).slice(0, 90).join("\n");
    const seo = { noAlt: arts.filter(a => !(a.alt ?? "").trim()).length, metaOff: arts.filter(a => (a.meta ?? "").length < 120 || (a.meta ?? "").length > 160).length, longTitle: arts.filter(a => a.title.length > 60).length };

    let g = "Search Console is NOT connected: there is no traffic or ranking data. Base ideas on the catalog and general SEO best practice, and do not claim any search volume or ranking.";
    let site = "unknown";
    try {
      const p: any = await this.gsc.performance(90);
      site = p.site ?? site;
      const q = (p.queries as any[]).map(r => `${clip(r.key, 70)} | ${r.clicks} | ${r.impressions} | ${(r.ctr * 100).toFixed(1)}% | ${r.position.toFixed(1)}`);
      const near = (p.queries as any[]).filter(r => r.position >= 6 && r.position <= 20 && r.impressions >= 20).sort((a, b) => b.impressions - a.impressions).slice(0, 20)
        .map(r => `${clip(r.key, 70)} | ${r.clicks} | ${r.impressions} | ${(r.ctr * 100).toFixed(1)}% | ${r.position.toFixed(1)}`);
      const pages = (p.pages as any[]).slice(0, 8).map(r => `${clip(String(r.key).replace(/^https?:\/\/[^/]+/, ""), 90)} | ${r.clicks} | ${r.impressions} | ${r.position.toFixed(1)}`);
      g = `SEARCH CONSOLE (last 90 days) — totals: ${p.totals.clicks} clicks, ${p.totals.impressions} impressions, avg position ${p.totals.position.toFixed(1)}.
Top queries (query | clicks | impressions | CTR | position):\n${q.slice(0, 20).join("\n") || "none"}
Striking-distance queries, positions 6–20 (query | clicks | impressions | CTR | position):\n${near.join("\n") || "none"}
Top pages (path | clicks | impressions | position):\n${pages.join("\n") || "none"}`;
    } catch { /* non connecté ou indisponible */ }

    return `SITE: ${site}
CATALOG: ${arts.length} articles — ${st("Live")} live, ${st("Scheduled")} scheduled, ${st("Draft")} drafts.
Categories (articles): ${cats.map(([c, n]) => `${c} (${n})`).join(", ") || "none"}
Top tags: ${tags.map(([t, n]) => `${t} (${n})`).join(", ") || "none"}
Live articles published per month: ${cadence}
Upcoming scheduled dates: ${upcoming}
SEO hygiene: ${seo.noAlt} without cover alt text, ${seo.metaOff} with meta description outside 120–160 chars, ${seo.longTitle} titles over 60 chars.
EXISTING TITLES (never duplicate or lightly rephrase):\n${titles || "none"}

${g}${focus ? `\n\nFOCUS REQUESTED BY THE EDITOR: ${clip(focus, 200)}` : ""}`;
  }

  /* ───────────── Idées d'articles ───────────── */
  async listIdeas() {
    const rows = await this.ideas.find({ status: "new" }).sort({ priority: -1, createdAt: -1 }).limit(24).lean();
    return rows.map(r => ({ ...r, _id: String(r._id) }));
  }

  async generateIdeas(dto: GenerateIdeasDto, actor: Actor) {
    this.throttle(actor.id ?? "x");
    const s = await this.load();
    const count = dto.count ?? 6;
    const system = `You are a senior SEO content strategist for "${BRAND}".
${s.brief ? `Brand & strategy notes from the owner:\n${s.brief}\n` : ""}Write in ${s.language}.
Task: propose NEW blog article ideas that the content calendar should include next, each justified by the data provided.
Rules:
- Ground every idea in a data signal: queries with impressions but weak position or CTR, thin categories or tags, gaps in the publishing cadence, topics adjacent to top performers. State the signal in "rationale" (1–2 sentences). Quote only numbers that appear in the data; never invent search volumes, rankings or traffic.
- Never repeat or lightly rephrase an existing title.
- "outline": 4–6 short H2 headings forming a logical structure. "title": at most 60 characters, written for humans. "primaryKeyword": a realistic search query of 2–6 words.
- "category": reuse an existing category when it fits, otherwise propose a short new one. "tags": exactly 3 short tags.
- "format": one of ${FORMATS.join(", ")}. "intent": one of ${INTENTS.join(", ")}. "priority": integer 1–100 (expected SEO impact versus effort).
- Mix quick wins (striking-distance queries) with strategic pieces; avoid near-duplicate ideas among themselves.
Return ONLY a JSON object: {"ideas":[{"title":"","angle":"","category":"","primaryKeyword":"","intent":"","rationale":"","tags":["","",""],"format":"","priority":0,"outline":["","","",""]}]}`;
    const { text, model } = await this.complete(system, `${await this.context(dto.focus)}\n\nGenerate ${count} ideas.`, { maxTokens: 3500, json: true, feature: "Blog ideas" });
    const raw: any[] = Array.isArray(parseJson(text).ideas) ? parseJson(text).ideas : [];

    const seen = new Set((await this.articles.find().select("title").lean()).map(a => a.title.toLowerCase()));
    (await this.ideas.find({ status: { $in: ["new", "used"] } }).select("title").lean()).forEach(i => seen.add(i.title.toLowerCase()));
    const docs: Partial<Idea>[] = [];
    for (const r of raw) {
      const title = clip(r?.title, 90);
      if (title.length < 8 || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      docs.push({
        title, angle: clip(r.angle, 300), cat: clip(r.category, 40), keyword: clip(r.primaryKeyword, 80),
        intent: INTENTS.includes(r.intent) ? r.intent : "informational", rationale: clip(r.rationale, 360),
        tags: (Array.isArray(r.tags) ? r.tags : []).map((t: unknown) => clip(t, 30)).filter(Boolean).slice(0, 3),
        outline: (Array.isArray(r.outline) ? r.outline : []).map((t: unknown) => clip(t, 90)).filter(Boolean).slice(0, 7),
        format: FORMATS.includes(r.format) ? r.format : "guide", priority: Math.min(100, Math.max(1, Math.round(Number(r.priority)) || 50)), model, status: "new",
      });
      if (docs.length >= count) break;
    }
    if (!docs.length) throw new BadGatewayException("The AI did not return usable new ideas. Try again, or add a focus.");
    await this.ideas.insertMany(docs);
    const keep = await this.ideas.find({ status: "new" }).sort({ priority: -1, createdAt: -1 }).skip(24).select("_id").lean(); // plafond : 24 idées en attente
    if (keep.length) await this.ideas.deleteMany({ _id: { $in: keep.map(k => k._id) } });
    return { ideas: await this.listIdeas() };
  }

  async dismiss(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("Idea not found");
    const r = await this.ideas.updateOne({ _id: id, status: "new" }, { status: "dismissed" });
    if (!r.matchedCount) throw new NotFoundException("Idea not found");
    return { ok: true };
  }

  /* ───────────── Article complet à partir d'une idée ───────────── */
  async generateArticle(id: string, date: string | undefined, actor: Actor) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("Idea not found");
    const idea = await this.ideas.findById(id);
    if (!idea || idea.status !== "new") throw new NotFoundException("Idea not found or already used");
    if (this.busy.has(id)) throw new ConflictException("This article is already being written");
    this.throttle(actor.id ?? "x");
    this.busy.add(id);
    try {
      const s = await this.load();
      const all = await this.articles.find().select("title slug cat").lean();
      const related = [...all.filter(a => a.cat === idea.cat), ...all.filter(a => a.cat !== idea.cat)].slice(0, 25);
      const slugs = new Set(all.map(a => a.slug));
      const system = `You are an expert SEO copywriter and editor for "${BRAND}". Write in ${s.language}.
${s.brief ? `Brand & strategy notes from the owner:\n${s.brief}\n` : ""}Write a complete, original, publication-ready blog article for the idea provided. Be accurate: never invent statistics, studies, quotes, company facts or URLs. When you lack a verified number, speak qualitatively.
Output format — use EXACTLY these tagged blocks and nothing before or after them:
[TITLE]SEO title, max 60 characters, containing the primary keyword naturally[/TITLE]
[SLUG]lowercase-hyphenated-slug, max 70 characters[/SLUG]
[META]meta description of 140–158 characters, containing the keyword and ending on a clear benefit[/META]
[SUBTITLE]one-sentence subtitle[/SUBTITLE]
[CATEGORY]the category[/CATEGORY]
[TAGS]tag one, tag two, tag three[/TAGS]
[ALT]alt text for a fitting cover image, max 120 characters[/ALT]
[CONTENT]
the article body as HTML
[/CONTENT]
Body rules: 1,100–1,500 words. Short hook intro that says what the reader will learn; then 5–7 sections with <h2> (use <h3> sparingly); short paragraphs; at least one <ul> or <ol>; an FAQ section (<h2>FAQ</h2>, then 3 questions as <h3> each followed by a <p>); a conclusion with a soft call to action for ${BRAND}. Allowed tags: h2, h3, p, ul, ol, li, strong, em, a, blockquote, table, thead, tbody, tr, th, td. No <h1>, no images, no inline styles, no scripts. Internal links: include 2–3 links to relevant existing articles written exactly as <a href="/blog/SLUG">anchor text</a>, using only slugs from the list provided.`;
      const user = `IDEA
Working title: ${idea.title}
Primary keyword: ${idea.keyword || idea.title}
Search intent: ${idea.intent} · Format: ${idea.format}
Angle: ${idea.angle}
Why this idea (data signal): ${idea.rationale}
Suggested category: ${idea.cat} · Suggested tags: ${idea.tags.join(", ")}
${idea.outline?.length ? `Suggested structure (follow it unless the data argues otherwise):\n${idea.outline.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : ""}

EXISTING ARTICLES YOU MAY LINK TO (title — slug):
${related.map(a => `${clip(a.title, 80)} — ${a.slug}`).join("\n") || "none"}`;

      const { text } = await this.complete(system, user, { maxTokens: 5500, feature: "Blog articles" });
      const b = parseBlocks(text);
      if (!b.TITLE || !b.CONTENT || b.CONTENT.length < 400) throw new BadGatewayException("The AI returned an incomplete article. Please try again.");

      let title = clip(b.TITLE.replace(/^["“]|["”]$/g, ""), 120), meta = clip(b.META, 400);
      if (title.length > 60 || meta.length < 120 || meta.length > 160) { // un seul appel de correction, puis repli mécanique
        try {
          const f = parseBlocks((await this.complete("You fix SEO snippets. Reply ONLY with [TITLE]…[/TITLE] and [META]…[/META].", `Keyword: ${idea.keyword}\nTitle (max 60 chars): ${title}\nMeta description (140–158 chars): ${meta}\nRewrite both so they respect the limits, keep the meaning and the keyword.`, { maxTokens: 300, feature: "Blog articles" })).text);
          if (f.TITLE) title = clip(f.TITLE, 120);
          if (f.META) meta = clip(f.META, 400);
        } catch { /* repli ci-dessous */ }
        if (title.length > 60) title = cut(title, 60);
        if (meta.length > 160) meta = cut(meta, 157);
      }

      const html = cleanHtml(b.CONTENT, slugs);
      let slug = slugify(b.SLUG || title) || slugify(title), n = 2;
      const base = slug;
      while (await this.articles.exists({ slug })) slug = `${base}-${n++}`;
      const d = date ?? "";
      const tags = (b.TAGS ? b.TAGS.split(",") : idea.tags).map(t => clip(t, 30)).filter(Boolean).slice(0, 3);
      let cover: { coverPrompt: string; alt: string } | null = null;
      try { cover = await this.coverPrompt({ title, cat: clip(b.CATEGORY || idea.cat, 40), meta, sub: clip(b.SUBTITLE, 200), t: tags, text: html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 1500) }, actor, true); } catch { /* le brouillon reste valable sans prompt de cover */ }
      const art = await this.articles.create({
        slug, title, meta, sub: clip(b.SUBTITLE, 200), cat: clip(b.CATEGORY || idea.cat, 40), t: tags, alt: cover?.alt || clip(b.ALT, 140), coverPrompt: cover?.coverPrompt ?? "", img: "", html,
        date: d, status: d && d > today() ? "Scheduled" : "Draft",
      });
      idea.status = "used"; idea.articleSlug = slug; await idea.save();
      await this.act.record({ kind: "article", action: "ai-create", actorId: actor.id ?? undefined, actorName: actor.name, target: title, slug });
      return { ...art.toObject(), words: words(html) };
    } finally { this.busy.delete(id); }
  }
  /* ───────────── Style des couvertures + prompt de cover ───────────── */
  /** Analyse les dernières couvertures (vision) et en tire un guide de style réutilisable */
  async analyzeCoverStyle() {
    const s = await this.load();
    const rows = await this.articles.find({ img: { $nin: ["", null] } }).sort({ date: -1 }).select("img alt title").limit(40).lean();
    const seen = new Set<string>(), pick: typeof rows = [];
    for (const r of rows) { if (!seen.has(r.img)) { seen.add(r.img); pick.push(r); } if (pick.length >= 6) break; }
    if (!pick.length) throw new BadRequestException("No article has a cover image yet. Add covers first, or write the style by hand.");

    const loaded = (await Promise.all(pick.map(async r => ({ r, img: await fetchImage(r.img) })))).filter(x => x.img).slice(0, 4);
    const alts = pick.map(r => clip(r.alt, 120)).filter(Boolean);
    const sys = "You are an art director. You analyse a brand's blog cover images and write a reusable visual style guide for AI image generation. Describe only what is actually visible and recurring; if covers differ, describe the dominant pattern. Never invent details.";
    const fmt = `Write the style guide in English, at most 1,100 characters, as short labelled lines with no preamble: MEDIUM (photo, 3D render, flat vector, gradient abstract…), COMPOSITION, PALETTE (dominant colours with approximate hex codes), LIGHTING & MOOD, RECURRING ELEMENTS, TEXT IN IMAGE (is a title or lettering part of the cover? yes/no), ASPECT RATIO (estimate), AVOID (comma-separated), KEYWORDS (14–20 comma-separated visual style keywords to append to any image-generation prompt, without any subject words).`;
    let style = "", source = "", used = 0;
    let canUseVision = loaded.length > 0;
    if (canUseVision) {
      const p = s.provider;
      let model: string | undefined;
      if (p === "groq" && !/llama-4|vision|scout|maverick/i.test(s.groqModel)) { // seuls certains modèles Groq lisent les images
        model = (await this.listModels("groq")).find(m => /llama-4|scout|maverick|vision/i.test(m.id))?.id;
        canUseVision = !!model;
      }
      if (canUseVision) {
        const r = await this.complete(sys, `These are the ${loaded.length} most recent cover images of the blog "${BRAND}".${alts.length ? ` Their alt texts: ${alts.join(" | ")}.` : ""}\n${fmt}`, { maxTokens: 700, images: loaded.map(x => x.img as Img), model, feature: "Cover style" });
        style = r.text.replace(/```/g, "").trim().slice(0, 1500); source = "vision"; used = loaded.length;
      }
    }
    if (!canUseVision && alts.length >= 3) {
      const r = await this.complete(sys, `A vision-capable model is not available, so use these cover alt texts as a cautious fallback: ${alts.join(" | ")}.\nInfer a cautious style guide from them and say "(inferred from alt texts)" at the top. ${fmt}`, { maxTokens: 600, feature: "Cover style" });
      style = r.text.replace(/```/g, "").trim().slice(0, 1500); source = "alt"; used = 0;
    } else if (!canUseVision) {
      throw new BadRequestException("Could not analyze your previous cover images. Add at least 3 cover alt texts, configure a vision-capable AI model, or write the style by hand.");
    }
    if (style.length < 40) throw new BadGatewayException("The AI returned an empty style guide. Please try again.");
    const at = new Date();
    s.coverStyle = style; s.coverStyleSource = source; s.coverStyleAt = at;
    // mesures sur les pixels (ratio, palette) : plus fiables que la description du modèle
    const profile = loaded.length ? await coverProfile(loaded.map(x => x.img!.bytes!).filter(Boolean)).catch(() => null) : null;
    if (profile) s.coverProfile = profile;
    // mots-clés et « à éviter » proposés par l'analyse, sauf si vous les avez écrits à la main
    const kw = /^\s*KEYWORDS\s*[:：]\s*(.+)$/im.exec(style)?.[1]?.trim(), av = /^\s*AVOID\s*[:：]\s*(.+)$/im.exec(style)?.[1]?.trim();
    if (s.imageKeywordsSource !== "manual") { if (kw) s.imageKeywords = clip(kw, 600); if (av) s.imageNegative = clip(av, 400); if (kw || av) s.imageKeywordsSource = "auto"; }
    await s.save();
    return { style, source, used, at, profile: s.coverProfile ?? null, imageKeywords: s.imageKeywords, imageNegative: s.imageNegative, imageKeywordsSource: s.imageKeywordsSource };
  }

  /** Prompt prêt à coller dans un générateur d'images, aligné sur le style des couvertures précédentes */
  async coverPrompt(a: { title: string; cat?: string; meta?: string; sub?: string; t?: string[]; text?: string }, actor: Actor, internal = false) {
    if (!internal) this.throttle(actor.id ?? "x");
    const s = await this.load();
    const prev = await this.articles.find({ coverPrompt: { $nin: ["", null] }, title: { $ne: a.title } }).sort({ _id: -1 }).limit(3).select("coverPrompt").lean();
    const system = `You are an art director who writes prompts for AI image generators (Midjourney, DALL·E, Ideogram, Firefly) for the blog covers of "${BRAND}".
STYLE GUIDE derived from the blog's existing covers — follow it closely so the new cover looks like part of the same series:
${s.coverStyle || "No style guide has been defined yet. Use a clean, modern, premium editorial look suited to a fintech and UX brand: restrained palette, generous negative space, one clear focal metaphor."}
${prev.length ? `Previous cover prompts (keep the series coherent, but do NOT reuse their subject):\n${prev.map(p => `- ${clip(p.coverPrompt, 450)}`).join("\n")}\n` : ""}Rules: describe ONE concrete visual metaphor that expresses the article's idea; state the medium, composition and framing, colour palette (name the colours), lighting and mood. Never ask the generator to render text, letters, numbers, logos or recognisable real people (they come out garbled); if the style guide says covers carry a title, just leave clean space for it. Write 80–150 words in English, as one paragraph with no markdown. ${s.coverProfile ? `Measured on the existing covers: aspect ratio ${s.coverProfile.ratio}, dominant colours ${s.coverProfile.palette.slice(0, 5).join(", ")}. Use that aspect ratio and keep to that palette.` : "Pick an aspect ratio consistent with the style guide (default 16:9)."}
Output EXACTLY these blocks and nothing else:
[PROMPT]the image prompt[/PROMPT]
[NEGATIVE]comma-separated things to avoid[/NEGATIVE]
[RATIO]for example 16:9[/RATIO]
[ALT]alt text for the finished image, max 120 characters, in ${s.language}[/ALT]`;
    const user = `ARTICLE
Title: ${a.title}
Category: ${a.cat ?? ""} · Tags: ${(a.t ?? []).join(", ")}
Subtitle: ${a.sub ?? ""}
Meta description: ${a.meta ?? ""}
Excerpt: ${clip(a.text, 1500)}`;
    const { text } = await this.complete(system, user, { maxTokens: 900, feature: "Cover prompts" });
    const b = parseBlocks(text);
    const prompt = clip(b.PROMPT, 1400);
    if (prompt.length < 40) throw new BadGatewayException("The AI did not return a usable cover prompt. Please try again.");
    const ratio = /^\d{1,2}:\d{1,2}$/.test((b.RATIO ?? "").trim()) ? b.RATIO.trim() : s.coverProfile?.ratio ?? "16:9";
    const neg = clip(b.NEGATIVE, 300);
    return { coverPrompt: `${prompt}\n\nAspect ratio: ${ratio}${neg ? `\nAvoid: ${neg}` : ""}`, alt: clip(b.ALT, 140), ratio, hasStyle: !!s.coverStyle };
  }
}
