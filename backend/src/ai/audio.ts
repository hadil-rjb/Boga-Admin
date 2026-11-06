import { BadGatewayException } from "@nestjs/common";

/** Largest audio file kept (bytes): a Mongo document holds 16 MB */
export const AUDIO_MAX = 12 * 1024 * 1024;
export const AUDIO_EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "audio/mp4": "m4a", "audio/webm": "weba" };

/** What an audio file really is, from its first bytes (never from the name the browser sends) */
export function sniffAudio(b: Buffer): string | null {
  if (b.length < 12) return null;
  const s = (a: number, e: number) => b.toString("latin1", a, e);
  if (s(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (s(0, 4) === "RIFF" && s(8, 12) === "WAVE") return "audio/wav";
  if (s(0, 4) === "OggS") return "audio/ogg";
  if (s(0, 4) === "fLaC") return "audio/flac";
  if (s(4, 8) === "ftyp") return "audio/mp4"; // m4a / mp4 audio
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  return null;
}

export const MUSIC_MODEL = "facebook/musicgen-small";
/** Music only: voice-overs are made locally (local-tts.service.ts) */
export type AudioHf = { textToAudio?: (a: any, o?: any) => Promise<Blob> };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Calls the provider with the parameters, then without them if the model refuses extra parameters; waits once if the model is loading */
async function attempt<T>(tries: (() => Promise<T>)[], signal?: AbortSignal): Promise<T> {
  let last: any, warm = false;
  for (let i = 0; i < tries.length; i++) {
    try { return await tries[i](); }
    catch (e: any) {
      last = e;
      const msg = String(e?.message ?? e), status = e?.httpResponse?.status ?? 0;
      if (signal?.aborted) break;
      if (/401|403|Unauthorized|Forbidden|invalid.*token/i.test(msg) || status === 401 || status === 403) break;
      if (/loading|503|warm|cold start/i.test(msg) && !warm) { warm = true; await sleep(8000); i--; }
    }
  }
  throw last;
}
export const audioFail = (e: any, what: string) => {
  const msg = String(e?.message ?? e);
  if (/401|403|Unauthorized|Forbidden|token/i.test(msg)) return new BadGatewayException("Hugging Face rejected the token. Check it in Settings → Cover images.");
  if (/402|credit|quota|limit|billing/i.test(msg)) return new BadGatewayException("The Hugging Face account is out of credits for this model.");
  if (/404|not found|not supported|no provider/i.test(msg)) return new BadGatewayException(`No provider serves this ${what} model right now. Try another one.`);
  return new BadGatewayException(`The ${what} could not be generated. Try again in a moment.`);
};

export async function compose(client: AudioHf, o: { model: string; prompt: string; seconds: number; signal?: AbortSignal }) {
  if (!client.textToAudio) throw new BadGatewayException("Music generation isn't available");
  const base = { provider: "auto", model: o.model, inputs: o.prompt };
  const blob = await attempt<Blob>([
    () => client.textToAudio!({ ...base, parameters: { max_new_tokens: Math.round(o.seconds * 50) } }, { outputType: "blob", signal: o.signal }),
    () => client.textToAudio!(base, { outputType: "blob", signal: o.signal }),
  ], o.signal);
  return Buffer.from(await blob.arrayBuffer());
}
