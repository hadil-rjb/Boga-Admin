import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { existsSync, promises as fs, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { randomUUID } from "crypto";

export type TtsEngine = "kokoro" | "piper" | "f5";
export type LocalVoice = {
  id: string; name: string; lang: string; language: string; gender?: "female" | "male"; engine: TtsEngine;
  /** F5 voices: the model and the built-in reference clip; group: how the editor's list heads them */
  model?: string; ref?: string; group?: string;
};
/** A brand's own reference clip for the F5 models: an audio file hosted by the API and what is said in it */
export type RefClip = { file: string; text: string };

/** Kokoro voices by language (the first letter of a voice id is its language, the second its gender) */
const KOKORO_LANGS: Record<string, { code: string; name: string }> = {
  a: { code: "en-us", name: "English (US)" }, b: { code: "en-gb", name: "English (UK)" }, e: { code: "es", name: "Spanish" },
  f: { code: "fr-fr", name: "French" }, i: { code: "it", name: "Italian" }, p: { code: "pt-br", name: "Portuguese (BR)" },
};
const PIPER_LANGS: Record<string, string> = { ar: "Arabic", de: "German", tr: "Turkish", en: "English", fr: "French", es: "Spanish" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const kokoroVoice = (id: string): LocalVoice | null => {
  const l = KOKORO_LANGS[id[0]]; if (!l || !/^[a-z][fm]_[a-z]+$/.test(id)) return null;
  return { id, name: cap(id.slice(3)), lang: l.code, language: l.name, gender: id[1] === "f" ? "female" : "male", engine: "kokoro" };
};
/** de_DE-thorsten-medium → "piper:de_DE-thorsten-medium", named "Thorsten" */
const piperVoice = (file: string, lang: string): LocalVoice => {
  const speaker = file.split("-")[1] || file;
  return { id: "piper:" + file, name: cap(speaker), lang, language: PIPER_LANGS[lang] ?? lang, engine: "piper" };
};

/**
 * The Arabic models built on F5-TTS, all Apache-2.0 (checked on their model cards):
 * SILMA TTS v1 (silma-ai/silma-tts) and the Habibi-TTS specialized checkpoints for MSA, Egyptian, Moroccan and Algerian
 * (SWivid/Habibi-TTS). Habibi's Unified, Saudi and Emirati checkpoints are CC-BY-NC-SA and are never offered.
 */
export const F5_MODELS: { id: string; group: string; dir: string; file: string }[] = [
  { id: "silma", group: "SILMA · Modern Standard", dir: "silma", file: "model.pt" },
  { id: "habibi-MSA", group: "Habibi · Modern Standard", dir: "habibi/MSA", file: "model_200000.safetensors" },
  { id: "habibi-EGY", group: "Habibi · Egyptian", dir: "habibi/EGY", file: "model_100000.safetensors" },
  { id: "habibi-MAR", group: "Habibi · Moroccan", dir: "habibi/MAR", file: "model_100000.safetensors" },
  { id: "habibi-ALG", group: "Habibi · Algerian", dir: "habibi/ALG", file: "model_100000.safetensors" },
];
/** Reference clips that ship with the engines and may be used commercially: SILMA's sample (MIT code, Apache-2.0 weights).
    Habibi's own sample prompts are not here: they come from the ElevenLabs voice library and an NC-licensed benchmark. */
const F5_REFS = [{ id: "silma", name: "Silma voice", file: "builtin:silma" }];

/** A Python worker answering one JSON line per request (tts/voice_worker.py, tts/f5_worker.py) */
export class PyWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<any> | null = null;
  private hello: any = null;
  private waiting = new Map<string, { ok: (r: any) => void; fail: (e: Error) => void; timer: NodeJS.Timeout; proc: ChildProcessWithoutNullStreams | null }>();
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  constructor(private log: Logger, private name: string, private python: string, private script: string, private env: Record<string, string>,
    private bootMs: number, private callMs: number, private idleMs: number) {}

  /** Starts the worker (once) and returns its first line ({ ready: true, … }) */
  start(): Promise<any> {
    if (this.proc && this.hello) return Promise.resolve(this.hello);
    if (this.starting) return this.starting;
    this.starting = new Promise<any>((ok, fail) => {
      const p = spawn(this.python, [this.script], { env: { ...process.env, ...this.env, PYTHONUNBUFFERED: "1" } });
      const timer = setTimeout(() => { fail(new ServiceUnavailableException(`The ${this.name} voice engine took too long to start`)); p.kill(); }, this.bootMs);
      let first = true;
      createInterface({ input: p.stdout }).on("line", (line) => {
        let msg: any; try { msg = JSON.parse(line); } catch { return; }
        if (first) {
          first = false; clearTimeout(timer);
          if (!msg.ready) { fail(new ServiceUnavailableException(`The ${this.name} voice engine could not start: ${msg.error ?? "unknown error"}`)); p.kill(); return; }
          this.proc = p; this.hello = msg; ok(msg); return;
        }
        const w = msg.id && this.waiting.get(msg.id); if (!w) return;
        this.waiting.delete(msg.id); clearTimeout(w.timer);
        msg.ok ? w.ok(msg) : w.fail(new Error(msg.error || "The voice could not be made"));
      });
      p.stderr.on("data", (b) => { const s = String(b).trim(); if (s && !/warn/i.test(s)) this.log.debug(`${this.name}: ${s.slice(0, 300)}`); });
      p.on("error", (e) => { clearTimeout(timer); fail(new ServiceUnavailableException(`The ${this.name} voice engine could not start: ${e.message}`)); });
      p.on("exit", () => {
        if (this.proc === p) { this.proc = null; this.hello = null; }
        // only this process's requests: a restarted worker may already have new ones waiting
        for (const [id, w] of this.waiting) if (w.proc === p) { clearTimeout(w.timer); w.fail(new Error("The voice engine stopped")); this.waiting.delete(id); }
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  /** One request; requests run one at a time. `out` is a temporary WAV the worker writes. */
  call(req: Record<string, unknown>): Promise<{ wav: Buffer; ms: number }> {
    const run = async () => {
      await this.start();
      const id = randomUUID(), out = join(tmpdir(), `tts-${id}.wav`);
      const res = await new Promise<{ ms: number }>((ok, fail) => {
        const timer = setTimeout(() => { this.waiting.delete(id); fail(new Error("The voice took too long")); this.stop(); }, this.callMs);
        this.waiting.set(id, { ok, fail, timer, proc: this.proc });
        this.proc!.stdin.write(JSON.stringify({ ...req, id, out }) + "\n");
      });
      try { return { wav: await fs.readFile(out), ms: res.ms }; } finally { fs.unlink(out).catch(() => {}); this.rest(); }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** One request whose raw reply message is returned (no WAV). Runs in the same queue as `call`. */
  ask(req: Record<string, unknown>, timeoutMs = this.callMs): Promise<any> {
    const run = async () => {
      await this.start();
      const id = randomUUID();
      try {
        return await new Promise<any>((ok, fail) => {
          const timer = setTimeout(() => { this.waiting.delete(id); fail(new Error("The worker took too long")); this.stop(); }, timeoutMs);
          this.waiting.set(id, { ok, fail, timer, proc: this.proc });
          this.proc!.stdin.write(JSON.stringify({ ...req, id }) + "\n");
        });
      } finally { this.rest(); }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** The models take memory: the worker stops after a while without requests and restarts on the next one */
  private rest() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.waiting.size) this.stop(); }, this.idleMs);
    this.idle.unref?.();
  }
  /** Also used after a timeout: a worker still busy with an abandoned request would make the next one wait behind it */
  stop() { this.proc?.kill(); this.proc = null; this.hello = null; }
}

/**
 * Voice-overs made on this server, free and offline:
 * - Kokoro (English, French, Spanish, Italian, Portuguese) and any Piper voice, through tts/voice_worker.py (ONNX);
 * - Arabic with SILMA TTS v1 and Habibi-TTS (MSA, Egyptian, Moroccan, Algerian), through tts/f5_worker.py (PyTorch).
 * Setup: backend/tts/setup.sh. Paths: TTS_PYTHON / TTS_F5_PYTHON (the venvs' python) and TTS_MODELS (the models folder).
 */
@Injectable()
export class LocalTtsService implements OnModuleDestroy {
  private log = new Logger("LocalTTS");
  private list: LocalVoice[] = [];

  /** The backend folder (dev runs from src, builds from dist/src) */
  private root = [process.cwd(), resolve(__dirname, "..", ".."), resolve(__dirname, "..", "..", "..")].find((d) => existsSync(join(d, "tts", "voice_worker.py"))) ?? process.cwd();
  private python = process.env.TTS_PYTHON || join(this.root, ".tts", "venv", "bin", "python");
  private f5python = process.env.TTS_F5_PYTHON || join(this.root, ".tts", "f5venv", "bin", "python");
  private models = process.env.TTS_MODELS || join(this.root, ".tts", "models");
  private onnx = new PyWorker(this.log, "Kokoro", this.python, join(this.root, "tts", "voice_worker.py"), { TTS_MODELS: this.models }, 90_000, 120_000, 10 * 60_000);
  // F5 models load in 10-30 s and a line takes a few seconds on an Apple GPU, much longer on a CPU
  private f5 = new PyWorker(this.log, "Arabic", this.f5python, join(this.root, "tts", "f5_worker.py"), { TTS_MODELS: this.models, HF_HOME: join(this.root, ".tts", "hf") }, 180_000, 600_000, 15 * 60_000);

  private onnxInstalled() {
    if (![this.python, join(this.root, "tts", "voice_worker.py")].every((p) => existsSync(p))) return false;
    const kokoro = existsSync(join(this.models, "kokoro-v1.0.onnx")) && existsSync(join(this.models, "voices-v1.0.bin"));
    let piper = false;
    try { piper = readdirSync(join(this.models, "piper")).some((f) => f.endsWith(".onnx")); } catch { /* no Piper folder */ }
    return kokoro || piper;
  }
  /** The F5 models whose checkpoint and vocabulary are on disk, when their worker and Python are too */
  f5Models() {
    if (![this.f5python, join(this.root, "tts", "f5_worker.py")].every((p) => existsSync(p))) return [];
    return F5_MODELS.filter((m) => existsSync(join(this.models, m.dir, m.file)) && existsSync(join(this.models, m.dir, "vocab.txt")));
  }
  installed() { return this.onnxInstalled() || this.f5Models().length > 0; }

  async voices(): Promise<LocalVoice[]> {
    if (!this.list.length && this.onnxInstalled()) {
      const hello = await this.onnx.start();
      this.list = [
        ...(hello.kokoro ?? []).map(kokoroVoice).filter((v: LocalVoice | null): v is LocalVoice => !!v),
        ...(hello.piper ?? []).map((v: { id: string; lang: string }) => piperVoice(v.id, v.lang)),
      ];
      this.log.log(`Local voices ready (Kokoro ${(hello.kokoro ?? []).length}, Piper ${(hello.piper ?? []).length})`);
    }
    // the Arabic models are listed from the disk: their worker only starts for the first Arabic line
    const f5 = this.f5Models().flatMap((m) => F5_REFS.map((r): LocalVoice => ({ id: `f5:${m.id}:${r.id}`, name: r.name, lang: "ar", language: "Arabic", engine: "f5", model: m.id, ref: r.id, group: m.group })));
    return [...this.list, ...f5];
  }

  /** One line of speech as a 16-bit mono WAV. `ref`: a brand's own clip, for the F5 models ("f5:<model>:custom"). */
  async speak(o: { text: string; voice: string; speed?: number; lang?: string; ref?: RefClip }): Promise<{ wav: Buffer; ms: number; engine: TtsEngine; voice: string }> {
    if (o.voice.startsWith("f5:")) {
      const [, model, refId] = o.voice.split(":");
      if (!this.f5Models().some((m) => m.id === model)) throw new Error("This Arabic model is not installed");
      const ref = refId === "custom" ? o.ref : F5_REFS.find((r) => r.id === refId) && { file: F5_REFS.find((r) => r.id === refId)!.file, text: "" };
      if (!ref) throw new Error("Choose a voice sample for this model");
      const r = await this.f5.call({ model, text: o.text, ref_audio: ref.file, ref_text: ref.text, speed: o.speed ?? 1 });
      return { ...r, engine: "f5", voice: o.voice };
    }
    const all = await this.voices(), local = all.filter((x) => x.engine !== "f5");
    const v = local.find((x) => x.id === o.voice) ?? local.find((x) => x.id === "af_heart") ?? local[0];
    if (!v) throw new Error("No voice is installed");
    const voice = v.engine === "piper" ? v.id.slice("piper:".length) : v.id;
    const r = await this.onnx.call({ engine: v.engine, text: o.text, voice, speed: o.speed ?? 1, lang: v.engine === "kokoro" ? o.lang || v.lang : undefined });
    return { ...r, engine: v.engine, voice: v.id };
  }

  onModuleDestroy() { this.onnx.stop(); this.f5.stop(); this.list = []; }
}
