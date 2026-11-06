import { BadGatewayException, BadRequestException, ConflictException, HttpException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { InferenceClient } from "@huggingface/inference";
import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Model } from "mongoose";
import { Media, MediaDocument } from "../media/media.schema";
import { Actor } from "../share/activity.service";
import { AiService } from "./ai.service";
import { LocalTtsService } from "./local-tts.service";
import { AUDIO_EXT, AUDIO_MAX, MUSIC_MODEL, audioFail, compose, sniffAudio } from "./audio";
import { MusicDto, VoiceoverDto } from "./dto/ai.dto";

const HOURLY_LIMIT = 40;
const NO_TOKEN = "Add your Hugging Face token in Settings → Cover images to generate music.";
export const NO_VOICES = "No voice engine is installed on this server. Run backend/tts/setup.sh once, then restart the API.";

/** Voice-overs (local, free: Kokoro and Piper), music made with AI, and the audio files of the video editor, hosted by the API */
@Injectable()
export class AudioService {
  /** Replaceable in tests */
  makeClient = (token: string) => new InferenceClient(token) as any;
  private hits = new Map<string, number[]>();
  private busy = new Set<string>();
  constructor(@InjectModel(Media.name) private media: Model<MediaDocument>, private ai: AiService, private tts: LocalTtsService) {}

  /** Stores the bytes once (same file = same record) and returns its id and type */
  async store(buf: Buffer, by: string | undefined, model = "") {
    const mime = sniffAudio(buf);
    if (!mime) throw new BadRequestException("This is not an MP3, WAV, OGG, FLAC, M4A or WebM audio file");
    if (buf.length > AUDIO_MAX) throw new BadRequestException("This audio file is larger than 12 MB");
    const sha = createHash("sha256").update(buf).digest("hex");
    let doc = await this.media.findOne({ kind: "audio", sha });
    if (!doc) doc = await this.media.create({ data: buf, mime, size: buf.length, kind: "audio", sha, model, createdBy: by });
    return { id: String(doc._id), mime: doc.mime, bytes: doc.size };
  }

  /** One generation at a time per person, and an hourly cap */
  private async limit<T>(actor: Actor, fn: () => Promise<T>, perHour = HOURLY_LIMIT) {
    const uid = actor.id ?? "x", now = Date.now(), h = (this.hits.get(uid) ?? []).filter((t) => now - t < 3_600_000);
    if (h.length >= perHour) throw new HttpException("Hourly audio generation limit reached. Try again later.", 429);
    if (this.busy.has(uid)) throw new ConflictException("Audio is already being generated");
    this.busy.add(uid); // lock set before any await: a double click never starts two generations
    try { h.push(now); this.hits.set(uid, h); return await fn(); } finally { this.busy.delete(uid); }
  }
  private guard<T>(actor: Actor, fn: (token: string) => Promise<T>) {
    return this.limit(actor, async () => {
      const token = await this.ai.hfKey();
      if (!token) throw new BadRequestException(NO_TOKEN);
      return fn(token);
    });
  }

  /** A voice-over made on this server (Kokoro for English and French; SILMA and Habibi for Arabic): no account, no token,
      no cost; a WAV file */
  voiceover(d: VoiceoverDto, actor: Actor) {
    if (!this.tts.installed()) throw new ServiceUnavailableException(NO_VOICES);
    return this.limit(actor, async () => {
      const voice = d.voice || "af_heart";
      let ref: { file: string; text: string } | undefined;
      if (/^f5:[\w-]+:custom$/.test(voice)) ref = await this.refClip(d.refMedia, d.refText);
      let r: Awaited<ReturnType<LocalTtsService["speak"]>>;
      try { r = await this.tts.speak({ text: d.text.trim(), voice, speed: d.speed, lang: d.lang, ref }); }
      catch (e: any) { throw new BadGatewayException(`The voice could not be made: ${e?.message ?? e}`); }
      finally { if (ref) fs.unlink(ref.file).catch(() => {}); }
      const model = r.engine === "piper" ? `piper:${r.voice.slice("piper:".length)}` : r.engine === "f5" ? r.voice.split(":")[1].replace(/^silma$/, "silma-tts-v1") : "kokoro-v1.0";
      return { ...(await this.store(r.wav, actor.id ?? undefined, model)), model, ms: r.ms };
    }, 300);
  }
  /** A brand's voice sample, from the audio files the API hosts, written to a temporary file for the voice engine */
  private async refClip(id?: string, text?: string) {
    if (!id || !text?.trim()) throw new BadRequestException("A voice sample needs its audio file and what is said in it");
    const doc = await this.media.findOne({ _id: id, kind: "audio" }).select("+data mime");
    if (!doc) throw new BadRequestException("This voice sample no longer exists");
    const file = join(tmpdir(), `ref-${randomUUID()}.${AUDIO_EXT[doc.mime] || "bin"}`);
    await fs.writeFile(file, doc.data);
    return { file, text: text.trim() };
  }

  music(d: MusicDto, actor: Actor) {
    return this.guard(actor, async (token) => {
      let buf: Buffer;
      try { buf = await compose(this.makeClient(token), { model: MUSIC_MODEL, prompt: d.prompt.trim(), seconds: d.seconds ?? 20, signal: AbortSignal.timeout(150_000) }); }
      catch (e) { throw audioFail(e, "music"); }
      return { ...(await this.store(buf, actor.id ?? undefined, MUSIC_MODEL)), model: MUSIC_MODEL };
    });
  }
}
