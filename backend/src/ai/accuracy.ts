// Accuracy review of an article: flags claims that need a source or more care, never adds sources itself.
// A rule-based pass finds statistics, "studies show"-style claims and absolutes with no link next to them;
// the AI pass reviews the text for doubtful or unsupported claims. Every flag must quote the article verbatim.

export type FlagKind = "statistic" | "source" | "absolute" | "outdated" | "doubtful" | "vague";
export type FlagFix = "cite" | "soften" | "remove" | "check";
export type Flag = { quote: string; kind: FlagKind; why: string; fix: FlagFix; rewrite?: string; by: "rules" | "ai" };

const KINDS: FlagKind[] = ["statistic", "source", "absolute", "outdated", "doubtful", "vague"];
const FIXES: FlagFix[] = ["cite", "soften", "remove", "check"];
const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const norm = (s: string) => decode(s).replace(/\s+/g, " ").trim();
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Text blocks of the body (paragraphs, list items, cells, quotes), each with whether it links somewhere */
export function blocks(html: string) {
  return [...html.matchAll(/<(p|li|td|th|blockquote|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => ({ text: norm(m[2].replace(/<[^>]+>/g, " ")), linked: /<a\b[^>]*href=["'](https?:)?\/\//i.test(m[2]), heading: /^h/i.test(m[1]) }))
    .filter((b) => b.text);
}
export const sentencesOf = (t: string) => t.split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ0-9“"«(])/).map((x) => x.trim()).filter(Boolean);
/** Plain text of the body, for checking that a quote really is in the article */
export const plain = (html: string) => norm(html.replace(/<[^>]+>/g, " "));

const STAT = /\d+(?:[.,]\d+)?\s?%|\b\d+(?:[.,]\d+)?\s?(?:x|times|percent|per cent|million|billion|milliard|milyon|bin)\b|[$€£]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:out of|in)\s\d+\b/i;
const SOURCE = /\b(stud(?:y|ies)|research(?:ers)?|surveys?|reports?|according to|experts? (?:say|agree)|statistics|data shows?|scientists|studies show)\b|\bselon\b|\bétudes?\b|\baraştırma/i;
const ABSOLUTE = /\b(always|never|guaranteed?|guarantees|proven|the best|number one|#1|everyone|nobody)\b|\b100\s?%/i;

/** Rule-based flags: claims of these kinds in a block with no outside link (headings are skipped) */
export function precheck(html: string, max = 20): Flag[] {
  const out: Flag[] = [], seen = new Set<string>();
  for (const b of blocks(html)) {
    if (b.heading || b.linked) continue;
    for (const s of sentencesOf(b.text)) {
      if (seen.has(s) || s.split(" ").length < 4) continue;
      const k: FlagKind | null = STAT.test(s) ? "statistic" : SOURCE.test(s) ? "source" : ABSOLUTE.test(s) ? "absolute" : null;
      if (!k) continue;
      seen.add(s);
      out.push(k === "statistic" ? { quote: s, kind: k, fix: "cite", by: "rules", why: "A figure with no source linked. Link the original study or report, or speak about it qualitatively." }
        : k === "source" ? { quote: s, kind: k, fix: "cite", by: "rules", why: "Refers to research or experts without saying which. Name and link the source, or rephrase as your own view." }
        : { quote: s, kind: k, fix: "soften", by: "rules", why: "An absolute claim (always, never, the best…) is hard to defend. Qualify it unless you can back it up." });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function reviewPrompt(o: { title: string; html: string; brand: string; language: string; pre: Flag[] }) {
  const system = `You are a careful fact-checking editor for the blog "${o.brand}". Review the article for accuracy and quality, in ${o.language} (keep the article's own language).
Flag only factual claims that a reader could reasonably doubt: statistics or figures without a source, "studies show"-style claims with no named source, claims that are likely wrong or outdated, absolutes stated as fact, and vague claims that need precision. Do not flag the author's opinions, advice or the brand's own offer.
You have no access to the web: never invent, name or link a source, study, statistic or URL. When a claim needs a source, say so (fix "cite"); the author will find one.
For each flag, "quote" must be copied EXACTLY from the article text (one sentence or a clause of it). "rewrite" (optional, only for fix "soften") is the same sentence made accurate without the unsupported part: it must not contain any number, name or fact that is not already in the quote.
Return ONLY JSON: {"flags":[{"quote":"","issue":"statistic|source|absolute|outdated|doubtful|vague","why":"one short sentence","fix":"cite|soften|remove|check","rewrite":""}]}. At most 12 flags, the most important first. {"flags":[]} if nothing needs attention.`;
  const user = `TITLE: ${o.title}

ARTICLE TEXT:
${plain(o.html).slice(0, 14000)}
${o.pre.length ? `\nSENTENCES A RULE-BASED CHECK ALREADY NOTICED (review them too, they may be fine):\n${o.pre.map((f) => `- ${f.quote}`).join("\n")}` : ""}`;
  return { system, user, maxTokens: 2500 };
}

const digits = (s: string) => new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? []);
/** The model's flags → only those quoting the article verbatim; rewrites that add numbers or links are dropped. Rule flags it didn't cover are kept. */
export function parseReview(j: unknown, html: string, pre: Flag[]): Flag[] {
  const text = plain(html).toLowerCase(), out: Flag[] = [], seen = new Set<string>();
  const raw: any[] = Array.isArray((j as any)?.flags) ? (j as any).flags : [];
  for (const r of raw.slice(0, 20)) {
    const quote = norm(clip(r?.quote, 600)).replace(/^["“«]\s*|\s*["”»]$/g, "");
    if (quote.length < 12 || !text.includes(quote.toLowerCase()) || seen.has(quote.toLowerCase())) continue;
    const kind: FlagKind = KINDS.includes(r.issue) ? r.issue : "doubtful", fix: FlagFix = FIXES.includes(r.fix) ? r.fix : "check";
    let rewrite = fix === "soften" ? clip(r.rewrite, 600) : "";
    const have = digits(quote);
    if (rewrite && (/https?:|www\.|\.com\b/i.test(rewrite) || [...digits(rewrite)].some((d) => !have.has(d)) || rewrite === quote)) rewrite = "";
    seen.add(quote.toLowerCase());
    out.push({ quote, kind, fix, why: clip(r.why, 240) || "Check this claim.", ...(rewrite && { rewrite }), by: "ai" });
    if (out.length >= 12) break;
  }
  const covered = (q: string) => out.some((f) => f.quote.toLowerCase().includes(q.toLowerCase()) || q.toLowerCase().includes(f.quote.toLowerCase()));
  return [...out, ...pre.filter((p) => !covered(p.quote))].slice(0, 20);
}
