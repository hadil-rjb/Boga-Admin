// On-page SEO recommendations for the article editor, beyond the 7 checks of the SEO score (lib/seo.ts):
// target query placement, internal links, readability, structure and FAQ. Each failing item says what to do.
import { coverage, slugOf } from "./opportunities";

export type AuditItem = { id: string; group: "Query" | "Links" | "Reading" | "Structure"; ok: boolean; label: string; tip: string };
type A = { slug: string; title: string; meta: string; html: string; cat?: string; status?: string };
type Other = { slug: string; title: string; cat?: string; status?: string };

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const count = (s: string) => s.split(/\s+/).filter(Boolean).length;
const tags = (h: string, t: string) => [...h.matchAll(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, "gi"))].map((m) => text(m[1]));
/** Sentences of the plain text (split on . ! ? followed by a space) */
export const sentences = (s: string) => s.split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter((x) => count(x) >= 3);
/** Slugs of the internal blog links in the body (relative /blog/… or any absolute …/blog/…) */
export const internalLinks = (h: string) => [...new Set([...h.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((m) => slugOf(m[1])).filter((x): x is string => !!x))];
const has = (q: string, s: string) => coverage(q, s) >= 0.75;

export function audit(a: A, query: string, others: Other[] = []): AuditItem[] {
  const out: AuditItem[] = [], q = query.trim();
  const body = text(a.html), n = count(body), h2 = tags(a.html, "h2"), h3 = tags(a.html, "h3");
  const first = (tags(a.html, "p").find((p) => count(p) >= 8) ?? body).split(/\s+/).slice(0, 100).join(" ");

  if (q) {
    out.push({ id: "q-title", group: "Query", ok: has(q, a.title), label: "Query in the title", tip: `Use the words of “${q}” in the title, near the start if it reads well.` });
    out.push({ id: "q-meta", group: "Query", ok: has(q, a.meta), label: "Query in the meta description", tip: "Google bolds the searched words in the snippet: use them once in the meta description." });
    out.push({ id: "q-intro", group: "Query", ok: has(q, first), label: "Query in the first paragraph", tip: "Say early, in the first paragraph, that the article answers this search." });
    out.push({ id: "q-h2", group: "Query", ok: h2.some((x) => has(q, x)), label: "Query in an H2 heading", tip: "Give one section heading (H2) the words of the query." });
    if (a.status !== "Live") out.push({ id: "q-slug", group: "Query", ok: has(q, a.slug.replace(/-/g, " ")), label: "Query in the slug", tip: "A short slug with the query's main words. (Leave it once the article is Live: its URL is indexed.)" });
  }

  const links = internalLinks(a.html).filter((s) => s !== a.slug), need = n >= 600 ? 2 : 1;
  const linked = new Set(links), pool = others.filter((o) => o.slug !== a.slug && !linked.has(o.slug) && (o.status ?? "Live") === "Live");
  const ideas = [...pool.filter((o) => a.cat && o.cat === a.cat), ...pool.filter((o) => !a.cat || o.cat !== a.cat)].slice(0, 2).map((o) => `“${o.title}”`);
  out.push({ id: "links", group: "Links", ok: links.length >= need, label: `${need}+ internal links (${links.length} now)`, tip: `Link to related articles to pass authority and keep readers on the site${ideas.length ? `, e.g. ${ideas.join(" or ")}` : ""}.` });

  const S = sentences(body), long = S.filter((s) => count(s) > 30).length, avg = S.length ? S.reduce((t, s) => t + count(s), 0) / S.length : 0;
  out.push({ id: "sentences", group: "Reading", ok: !S.length || (avg <= 22 && long <= Math.max(1, Math.round(S.length * 0.1))), label: `Short sentences (avg. ${Math.round(avg)} words)`, tip: `${long} sentence${long === 1 ? "" : "s"} over 30 words. Split them: aim for 15–20 words on average.` });
  const bigP = tags(a.html, "p").filter((p) => count(p) > 150).length;
  out.push({ id: "paragraphs", group: "Reading", ok: !bigP, label: "Paragraphs under 150 words", tip: `${bigP} long paragraph${bigP === 1 ? "" : "s"}: break them up; most readers skim on a phone.` });

  const wantH2 = Math.max(1, Math.floor(n / 400));
  out.push({ id: "h2s", group: "Structure", ok: h2.length >= wantH2, label: `A heading every ~300–400 words (${h2.length} H2)`, tip: `For ${n} words, use at least ${wantH2} H2 headings so readers and Google can scan the sections.` });
  out.push({ id: "h1", group: "Structure", ok: !/<h1\b/i.test(a.html), label: "No H1 in the body", tip: "The title is the page's H1: turn the H1 in the body into an H2." });
  const imgs = [...a.html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]), noAlt = imgs.filter((i) => !/\balt=["'][^"']+["']/i.test(i)).length;
  if (imgs.length) out.push({ id: "img-alt", group: "Structure", ok: !noAlt, label: "Alt text on body images", tip: `${noAlt} image${noAlt === 1 ? "" : "s"} without alt text: describe each for accessibility and image search.` });
  if (n >= 900) out.push({ id: "faq", group: "Structure", ok: [...h2, ...h3].some((x) => /\b(faq|frequently asked|questions)\b|sık sorulan|questions fréquentes/i.test(x)), label: "FAQ section", tip: "Long guides win extra searches with a short FAQ: 3–5 real questions as H3, each with a direct answer." });
  return out;
}
