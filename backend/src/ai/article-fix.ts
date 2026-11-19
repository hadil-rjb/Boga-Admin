// "Fix with AI" for one article in the editor: which SEO checks fail, the prompt that asks the model to fix
// only those (plus an optional proofread), and the parsing that turns its answer into safe, in-limit changes.
// The same 7 checks as the admin's SEO score (frontend/lib/seo.ts).
// Two more modes work from the page's real Search Console queries: "refresh" (title, meta and content reworked
// around what people search) and "snippet" (title and meta only, to earn more clicks). Nothing is ever invented.
import { cleanHtml, words } from "./html";

export type FixInput = { title: string; slug: string; meta?: string; sub?: string; alt?: string; img?: string; cat?: string; t?: string[]; html?: string; status?: string; proofread?: boolean;
  mode?: FixMode; focus?: string; queries?: SearchQuery[] };
export type FixMode = "fix" | "refresh" | "snippet";
export type SearchQuery = { query: string; clicks: number; impressions: number; position: number };
export type FixField = "title" | "meta" | "sub" | "alt" | "t" | "slug" | "html";
export type FixResult = { changes: Partial<Record<FixField, string | string[]>>; notes: string[]; issues: string[] };

const plainText = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** Cut at a word boundary, never past n characters */
export const cutWords = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n + 1).replace(/\s+\S*$/, "").replace(/[\s,;:–—-]+$/, "").trim() || s.slice(0, n));
export const slugOk = (s: string) => /^[a-z0-9-]+$/.test(s) && s.length <= 75;
const slugify = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const modeOf = (a: FixInput): FixMode => (a.mode === "refresh" || a.mode === "snippet") && (a.queries?.length || a.focus?.trim()) ? a.mode : "fix";
/** The page's queries as clean lines for the prompt: "query | clicks | impressions | position" */
export function queryLines(q: SearchQuery[] = []) {
  return q.filter((r) => r && typeof r.query === "string" && r.query.trim()).slice(0, 20)
    .map((r) => `${clip(r.query, 100)} | ${Math.round(Number(r.clicks) || 0)} | ${Math.round(Number(r.impressions) || 0)} | ${(Number(r.position) || 0).toFixed(1)}`);
}

/** Failing checks, by key */
export function failing(a: FixInput) {
  const html = a.html ?? "", t = (a.t ?? []).filter((x) => x.trim());
  return {
    title: !(a.title.length > 0 && a.title.length <= 60),
    meta: !((a.meta ?? "").length >= 120 && (a.meta ?? "").length <= 160),
    alt: !a.alt,
    sub: !a.sub,
    t: t.length !== 3,
    // a Live article's URL is already indexed and linked: never propose a new slug for it
    slug: !slugOk(a.slug) && a.status !== "Live",
    html: !(words(html) >= 600 && /<h2/i.test(html)),
  };
}

export function fixPrompt(a: FixInput, o: { brand: string; language: string; brief?: string; related: { title: string; slug: string }[] }) {
  const f = failing(a), html = a.html ?? "", mode = modeOf(a), seo = mode !== "fix";
  const focus = clip(a.focus, 120), lines = queryLines(a.queries);
  const asks: string[] = [];
  if (seo) {
    asks.push(`[TITLE] — rewrite the SEO title in 45–60 characters so it earns the click for the searches below${focus ? `, leading with the words of “${focus}”` : ", using the words of the top queries"}. Promise only what the article delivers.`);
    asks.push(`[META] — write a meta description of 140–158 characters that answers the searches below${focus ? ` (main one: “${focus}”)` : ""} and ends on a clear benefit. No claims the article doesn't support.`);
  }
  if (mode === "refresh") {
    asks.push(`[CONTENT] — refresh the body for the searches below: return the full body as HTML. Keep every existing section, fact, link and the author's voice; never shorten it. Where a query isn't answered yet, add or expand a section for it under a clear <h2>${focus ? `; use the words of “${focus}” in the first paragraph and in one <h2>` : ""}. If several queries are questions, add an FAQ (<h2>FAQ</h2>, each question as <h3> with a short <p> answer). Don't stuff keywords: write for the reader.`);
  }
  if (f.title && !seo) asks.push(`[TITLE] — the SEO title is ${a.title.length} characters: rewrite it in 45–60 characters, same meaning and main keyword.`);
  if (f.meta && !seo) asks.push(`[META] — the meta description is ${(a.meta ?? "").length} characters: write one of 140–158 characters with the main keyword, ending on a clear benefit.`);
  if (mode !== "snippet" && f.sub) asks.push("[SUBTITLE] — there is no subtitle: write a one-sentence subtitle (max 160 characters).");
  if (mode !== "snippet" && f.alt) asks.push(`[ALT] — the cover image has no alt text: write one (max 120 characters)${a.img ? " describing a cover that fits the article" : " for a cover that would fit the article"}.`);
  if (mode !== "snippet" && f.t) asks.push(`[TAGS] — the article needs exactly 3 tags (now: ${(a.t ?? []).filter(Boolean).join(", ") || "none"}): give 3 short tags, comma-separated, keeping good existing ones.`);
  if (f.slug && !seo) asks.push(`[SLUG] — the slug "${a.slug}" is not clean: give a lowercase-hyphenated slug, max 70 characters, a-z 0-9 and hyphens only.`);
  const thin = words(html) < 600, noH2 = !/<h2/i.test(html);
  if (mode === "refresh") { /* the content is already asked for above */ }
  else if (f.html) asks.push(`[CONTENT] — the body ${thin ? `has ${words(html)} words (needs 600+)` : ""}${thin && noH2 ? " and " : ""}${noH2 ? "has no <h2> section headings" : ""}: return the full body as HTML${thin ? ", expanded to 650–900 words by developing what is already there (explanations, examples, steps), never padding" : ""}${noH2 ? ", organised under 3–6 <h2> headings" : ""}. Keep every existing link, keep the author's voice and all existing facts.`);
  else if (a.proofread && html.trim()) asks.push("[CONTENT] — proofread the body: fix spelling, grammar, punctuation and clumsy sentences only. Keep the structure, headings, links, length and voice; return the full body as HTML. If nothing needs fixing, leave this block out.");

  const system = `You are the editor of the blog "${o.brand}". You fix an article that is being edited, in ${o.language} (keep the article's own language if it is written in another one).
${o.brief ? `Brand & strategy notes from the owner:\n${o.brief}\n` : ""}Be accurate: never invent statistics, studies, quotes, company facts or URLs; when you lack a verified number, speak qualitatively.
Only fix what is asked. Reply with ONLY the tagged blocks asked for (each as [NAME]value[/NAME]), then one [NOTES]…[/NOTES] block with one short line per change explaining what you did. Nothing before or after.
HTML rules for [CONTENT]: allowed tags h2, h3, p, ul, ol, li, strong, em, a, blockquote, table, thead, tbody, tr, th, td. No <h1>, no images, no inline styles, no scripts. Internal links only as <a href="/blog/SLUG">…</a> with slugs from the list provided.`;
  const search = seo ? `\nREAL SEARCH CONSOLE QUERIES FOR THIS PAGE (query | clicks | impressions | average position):\n${lines.join("\n") || "none"}${focus ? `\nMain query to target: ${focus}` : ""}\nThese are the only search data you have: never quote a number that is not in this list, and don't invent search volumes.\n` : "";
  const full = f.html || a.proofread || mode === "refresh";
  const user = `FIX THESE:
${asks.map((x) => `- ${x}`).join("\n")}

ARTICLE
Title: ${a.title}
Slug: ${a.slug}
Category: ${a.cat ?? ""}
Tags: ${(a.t ?? []).filter(Boolean).join(", ")}
Subtitle: ${a.sub ?? ""}
Meta description: ${a.meta ?? ""}
Cover alt text: ${a.alt ?? ""}
Body (HTML):
${full ? html : clip(plainText(html), 2500)}
${search}${full ? `\nEXISTING ARTICLES YOU MAY LINK TO (title — slug):\n${o.related.map((r) => `${clip(r.title, 80)} — ${r.slug}`).join("\n") || "none"}` : ""}`;
  return { system, user, asks: asks.length, maxTokens: full ? Math.min(8000, 2500 + Math.round(words(html) * 2.2)) : 900 };
}

/** The model's tagged blocks → changes that pass the checks; anything unchanged or unusable is dropped */
export function parseFix(b: Record<string, string>, a: FixInput, slugs: Set<string>): FixResult {
  const f = failing(a), ch: FixResult["changes"] = {}, notes: string[] = [];
  const mode = modeOf(a), seo = mode !== "fix";
  const unq = (s: string) => s.replace(/^["“'«]\s*|\s*["”'»]$/g, "").trim();
  if ((f.title || seo) && b.TITLE) { const v = cutWords(clip(unq(b.TITLE), 200), 60); if (v && v !== a.title) ch.title = v; }
  if ((f.meta || seo) && b.META) {
    let v = clip(unq(b.META), 400);
    if (v.length > 160) v = cutWords(v, 157).replace(/[.,;:]?$/, ".");
    // a rewrite for clicks must not break a meta that already passes the 120–160 check
    if (v !== a.meta && v.length >= (seo && !f.meta ? 120 : 60)) ch.meta = v;
  }
  if (f.sub && b.SUBTITLE) { const v = cutWords(clip(unq(b.SUBTITLE), 400), 160); if (v) ch.sub = v; }
  if (f.alt && b.ALT) { const v = cutWords(clip(unq(b.ALT), 300), 120); if (v) ch.alt = v; }
  if (f.t && b.TAGS) {
    const v = b.TAGS.split(/[,\n]/).map((x) => clip(x.replace(/^[-•#\s]+/, ""), 30)).filter(Boolean).slice(0, 3);
    if (v.length === 3) ch.t = v;
  }
  if (f.slug && !seo && b.SLUG) { const v = slugify(b.SLUG).slice(0, 70).replace(/-$/, ""); if (v && slugOk(v) && v !== a.slug) ch.slug = v; }
  if (b.CONTENT && (f.html || a.proofread || mode === "refresh")) {
    const v = cleanHtml(b.CONTENT.replace(/^```(?:html)?\s*|```\s*$/gi, ""), slugs);
    // never take a body that lost text (a cut-off or summarised answer): an expansion must not be shorter, a proofread keeps ~the same length
    const before = words(a.html ?? ""), min = f.html || mode === "refresh" ? Math.max(before, 300) : before * 0.85;
    if (v && v !== (a.html ?? "").trim() && words(v) >= min && (mode !== "refresh" || /<h2/i.test(v))) ch.html = v;
  }
  if (b.NOTES) notes.push(...b.NOTES.split("\n").map((x) => clip(x.replace(/^[-•*\s]+/, ""), 200)).filter(Boolean).slice(0, 8));
  const left = failing({ ...a, ...ch } as FixInput);
  const issues = (Object.keys(left) as FixField[]).filter((k) => left[k]);
  return { changes: ch, notes, issues };
}
