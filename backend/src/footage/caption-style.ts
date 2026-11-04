import { BadRequestException } from "@nestjs/common";

/** No Claude key in Settings → AI */
export class NoAnthropicKey extends BadRequestException {
  constructor() { super("Add a Claude API key in Settings → AI first"); }
}

/** What the caption-style step needs from AiService (provided to JobsService as FOOTAGE_AI) */
export type CaptionAi = { captionStyle(images: { media: string; data: string }[], sampled: { text: string | null; highlight: string | null }, actor: { id: string | null; name: string }, band?: [number, number]): Promise<{ style: Record<string, any>; model: string }> };
export const FOOTAGE_AI = "FOOTAGE_AI";

/** Subtitle style of a reference video: what the editor applies to the captions (shape of frontend/studio/captions.js DEFAULT_STYLE) */
export type CaptionStyle = {
  font: "sans-bold" | "sans" | "serif" | "display"; family?: string;
  size: number; weight: number; case: "none" | "upper"; color: string;
  stroke: { color: string; width: number } | null;
  shadow: { color: string; blur: number; y: number } | null;
  box: { color: string; radius: number; pad: number } | null;
  highlight: { mode: "box" | "color" | "scale" | "none"; color: string; text: string; radius: number };
  y: number; maxWords: number; maxChars: number; lines: number; anim: "none" | "pop" | "fade";
};
export type Sampled = { text?: string | null; highlight?: string | null };

export const NOTE_NO_TEXT = "No subtitles found in the reference. Using the default style.";
export const NOTE_NO_KEY = "Add an Anthropic key in Settings, AI to copy the subtitle style.";
export const NOTE_UNREADABLE = "The subtitle style could not be read from the reference. Using the default style.";
export const NOTE_AI_FAILED = "The subtitle style could not be read from the reference. Using the default style with the detected colors.";

const HEX = /^#[0-9a-fA-F]{6}$/;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const hex = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim().toUpperCase() : d);
const clamp = (v: unknown, lo: number, hi: number, d: number, round = false) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  const c = Math.min(hi, Math.max(lo, n));
  return round ? Math.round(c) : Math.round(c * 10000) / 10000;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : d);

/** The first {...} of a model answer, parsed; anything else is null */
export function parseJsonLoose(text: unknown): unknown {
  if (typeof text !== "string") return null;
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

/**
 * Validates whatever the model answered (any type) against the CaptionStyle shape. Every field is checked and clamped,
 * the rest comes from `defaults`. Colors measured on the pixels always win over the model's.
 */
export function mergeStyle(ai: unknown, sampled: Sampled, defaults: CaptionStyle): { style: CaptionStyle; note?: string } {
  const a: Record<string, any> = isObj(ai) ? ai : isObj(parseJsonLoose(ai)) ? (parseJsonLoose(ai) as Record<string, any>) : {};
  const d = defaults;
  const style: CaptionStyle = JSON.parse(JSON.stringify(d));
  style.font = oneOf(a.font, ["sans-bold", "sans", "serif", "display"], d.font);
  style.size = clamp(a.size, 0.02, 0.12, d.size);
  style.weight = clamp(a.weight, 300, 900, d.weight, true);
  style.case = oneOf(a.case, ["none", "upper"], d.case);
  style.color = hex(sampled.text, hex(a.color, d.color));
  style.y = clamp(a.y, 0.05, 0.95, d.y);
  style.maxWords = clamp(a.maxWords, 1, 8, d.maxWords, true);
  style.maxChars = clamp(a.maxChars, 8, 40, d.maxChars, true);
  style.lines = clamp(a.lines, 1, 2, d.lines, true);
  style.anim = oneOf(a.anim, ["none", "pop", "fade"], d.anim);

  // stroke / shadow / box: null from the model means none, a missing key keeps the default
  if ("stroke" in a) style.stroke = isObj(a.stroke) ? { color: hex(a.stroke.color, d.stroke?.color ?? "#000000"), width: clamp(a.stroke.width, 0, 0.02, d.stroke?.width ?? 0.004) } : null;
  if (style.stroke && !(style.stroke.width > 0)) style.stroke = null;
  if ("shadow" in a) {
    const s = a.shadow, ds = d.shadow ?? { color: "rgba(0,0,0,.55)", blur: 0.006, y: 0.002 };
    style.shadow = isObj(s) ? { color: hex(s.color, ds.color), blur: clamp(s.blur, 0, 0.03, ds.blur), y: clamp(s.y, 0, 0.02, ds.y) } : null;
  }
  if ("box" in a) {
    const b = a.box, db = d.box ?? { color: "rgba(0,0,0,.6)", radius: 0.18, pad: 0.012 };
    style.box = isObj(b) ? { color: hex(b.color, db.color), radius: clamp(b.radius, 0, 0.5, db.radius), pad: clamp(b.pad, 0, 0.05, db.pad) } : null;
  }

  const h = isObj(a.highlight) ? a.highlight : {};
  style.highlight = {
    mode: oneOf(h.mode, ["box", "color", "scale", "none"], d.highlight.mode),
    color: hex(sampled.highlight, hex(h.color, d.highlight.color)),
    text: hex(h.text, h.textLight === true ? "#FFFFFF" : d.highlight.text),
    radius: clamp(h.radius, 0, 0.5, d.highlight.radius),
  };
  return { style };
}
