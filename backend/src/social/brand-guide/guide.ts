import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { trackClaude } from "../../ai/usage";
import { z } from "zod";

/**
 * Brand guide → brand kit. The studio renders the pages of a brand guide or company profile (PDF) and sends
 * them with their text; Claude reads the brand: who it is and how it speaks, its palette, its fonts (mapped to
 * the families the studio loads) and where its logos are, so the studio can cut them out of the pages.
 */

export const GUIDE_MODEL = "claude-opus-5-5";
/** Families the studio loads (app/layout.tsx) */
export const STUDIO_FONTS = ["Poppins", "Inter", "Plus Jakarta Sans", "Montserrat", "DM Sans", "Space Grotesk", "Playfair Display", "Georgia"] as const;
export const ARABIC_FONTS = ["Cairo", "Tajawal"] as const;
export const LANGS = ["English", "French", "Spanish", "German", "Arabic", "Italian", "Portuguese"] as const;

const Font = <T extends readonly [string, ...string[]]>(list: T) => z.object({
  found: z.string().describe("The family the guide names or that the pages show (\"\" when unknown)"),
  studio: z.enum(list).describe("The closest family the studio has"),
});

const GuideSchema = z.object({
  isBrandGuide: z.boolean().describe("true when the pages describe one brand or company (brand guide, company profile, pitch, website export)"),
  name: z.string().describe("Brand name as written in the logo or the text"),
  initials: z.string().describe("2 or 3 letters for the brand's avatar, e.g. NM for Neomarkets"),
  handle: z.string().describe("Social handle when shown (\"@name\"), else \"\""),
  website: z.string().describe("Website domain without https, e.g. brand.com, else \"\""),
  industry: z.string().describe("Short industry label, e.g. \"Financial services · Online trading broker\""),
  tagline: z.string().describe("The slogan, exactly as written, else \"\""),
  about: z.string().describe("2 to 4 sentences: what the brand does, for whom, key facts (licenses, products, markets). In English"),
  audience: z.string().describe("One sentence: who the brand talks to"),
  voice: z.string().describe("Tone of voice in one or two sentences, from how the pages are written"),
  dos: z.string().describe("3 to 5 short guidelines for social posts, one per line, from the guide or implied by it (e.g. regulated businesses: mention the license, add the disclaimer)"),
  donts: z.string().describe("3 to 5 short things to avoid, one per line"),
  hashtags: z.string().describe("4 to 6 relevant hashtags separated by spaces"),
  cta: z.string().describe("Default call to action, usually the website"),
  lang: z.enum(LANGS).describe("Main language of the brand's content"),
  languages: z.string().describe("All languages the guide uses, e.g. \"English + Arabic\""),
  colors: z.array(z.object({
    name: z.string().describe("A short color name, e.g. \"Royal blue\", or the guide's own name"),
    hex: z.string().describe("#RRGGBB. Use the guide's exact codes when it lists them; otherwise read them from the pages"),
    role: z.enum(["primary", "dark", "light", "accent", "neutral", "other"]),
  })).describe("3 to 8 brand colors, most important first. Ignore the colors of photos"),
  fonts: z.object({ heading: Font(STUDIO_FONTS), body: Font(STUDIO_FONTS), arabic: Font(ARABIC_FONTS) }),
  logos: z.array(z.object({
    page: z.number().int().describe("Page number (1-based, as labelled in the request) where this logo is clearest and largest"),
    box: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).describe("Bounding box on that page, as fractions of its width and height (0 to 1). Include the whole logo with a little margin, nothing else"),
    kind: z.enum(["full", "icon"]).describe("full: symbol and/or wordmark together; icon: the symbol alone"),
    background: z.enum(["dark", "light", "photo"]).describe("What is behind the logo there"),
    ink: z.string().describe("#RRGGBB main color of the logo itself (e.g. #FFFFFF for a white logo)"),
  })).describe("The full logo once (where it is largest), and the symbol alone once if it appears alone. Prefer places on a plain or gradient background over photos"),
  design: z.object({
    layout: z.string().describe("What the guide states about layout: grid, margins, spacing, logo placement. \"\" when it is silent"),
    imagery: z.string().describe("What the guide states about photos, illustration and their treatment. \"\" when it is silent"),
    logoUse: z.string().describe("What the guide states about logo use: clear space, minimum size, versions, misuse. \"\" when it is silent"),
    typography: z.string().describe("What the guide states about type: hierarchy, sizes, case, spacing. \"\" when it is silent"),
    rules: z.array(z.object({
      text: z.string().describe("One short, concrete statement the guide makes, e.g. \"Never stretch the logo\""),
      kind: z.enum(["do", "dont"]),
    })).describe("The guide's own do and don't statements about design, at most 12. Only what the document states; empty when it has none"),
  }).describe("What the document says about design. Only what the document states; every field empty when it is silent"),
  note: z.string().describe("One sentence on anything missing or uncertain, else \"\""),
});
export type Guide = z.infer<typeof GuideSchema>;

const SYSTEM = `You read brand guides, company profiles and other brand documents and turn them into a brand kit for a social media design studio.
Read every page you are given: the logo and its versions, color swatches and codes, typography pages, the tone of the copy, the slogan, the contact details.
- Prefer what the document states (color codes, font names, slogan) over what you infer. When the document gives no color codes, read the brand colors from the pages (logo, backgrounds, accents), not from photographs.
- Map each font to the closest family the studio has; keep the real name in "found".
- Logos: give the page and a bounding box that contains the whole logo with a small margin and nothing else (no text around it). Page images are labelled "Page N".
- Design rules: report only what the document states or shows on a rules page; leave a field empty when the document is silent; do not turn general impressions into rules.
- Write the descriptive fields in English, short and factual. Never invent facts that the document doesn't support.`;

const hexOk = (c: string) => /^#?[0-9a-f]{6}$/i.test(String(c || "").trim());
const hex = (c: string) => "#" + String(c).trim().replace(/^#/, "").toUpperCase();
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

export async function readGuideWithClaude(apiKey: string, input: { pages: { n: number; image: string }[]; text: string; fileName?: string }) {
  const client = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 1 });
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const p of input.pages) {
    const m = /^data:image\/(png|jpeg|webp);base64,/.exec(p.image);
    if (!m) continue;
    content.push({ type: "text", text: `Page ${p.n}` });
    content.push({ type: "image", source: { type: "base64", media_type: `image/${m[1]}` as "image/png" | "image/jpeg" | "image/webp", data: p.image.slice(m[0].length) } });
  }
  content.push({ type: "text", text: `${input.fileName ? `File: ${input.fileName}\n` : ""}Text of the document:\n${input.text.slice(0, 30_000) || "(no text layer)"}\n\nRead this brand.` });
  const res = await client.beta.messages.stream({
    model: GUIDE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(GuideSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  }).finalMessage();
  trackClaude("Brand guides", res.model, res.usage);
  if (res.stop_reason === "refusal") throw new Error("Claude declined to read this document");
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { guide: tidy(GuideSchema.parse(JSON.parse(text)), input.pages.map((p) => p.n)), model: res.model };
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** What the guide says about design: trimmed, cut to 400 characters a field and 12 rules of at most 160, empty rules dropped. Tolerates a missing object. */
export function tidyDesign(d: unknown): Guide["design"] {
  const o = d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  const rules = (Array.isArray(o.rules) ? o.rules : []).map((r) => {
    const x = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const t = text(x.text, 160);
    return t ? { text: t, kind: (x.kind === "do" ? "do" : "dont") as "do" | "dont" } : null;
  }).filter((r): r is NonNullable<typeof r> => !!r).slice(0, 12);
  return { layout: text(o.layout, 400), imagery: text(o.imagery, 400), logoUse: text(o.logoUse, 400), typography: text(o.typography, 400), rules };
}

/** Valid codes only, no duplicates, boxes inside the page and on a page that was sent */
function tidy(g: Guide, pages: number[]): Guide {
  const seen = new Set<string>();
  const colors = g.colors.filter((c) => hexOk(c.hex)).map((c) => ({ ...c, hex: hex(c.hex), name: c.name.trim().slice(0, 40) || "Color" }))
    .filter((c) => !seen.has(c.hex) && seen.add(c.hex)).slice(0, 8);
  const logos = g.logos.filter((l) => pages.includes(l.page)).map((l) => {
    const b = { x0: clamp01(Math.min(l.box.x0, l.box.x1)), y0: clamp01(Math.min(l.box.y0, l.box.y1)), x1: clamp01(Math.max(l.box.x0, l.box.x1)), y1: clamp01(Math.max(l.box.y0, l.box.y1)) };
    return { ...l, box: b, ink: hexOk(l.ink) ? hex(l.ink) : "#FFFFFF" };
  }).filter((l) => l.box.x1 - l.box.x0 > 0.01 && l.box.y1 - l.box.y0 > 0.01)
    // one full logo and one icon: the largest one of each (the sharpest cut-out)
    .sort((a, b) => (b.box.x1 - b.box.x0) * (b.box.y1 - b.box.y0) - (a.box.x1 - a.box.x0) * (a.box.y1 - a.box.y0))
    .filter((l, i, all) => all.findIndex((o) => o.kind === l.kind) === i);
  const website = g.website.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return { ...g, name: g.name.trim().slice(0, 40), initials: (g.initials || g.name).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3).toUpperCase(), website, colors, logos, design: tidyDesign(g.design) };
}
