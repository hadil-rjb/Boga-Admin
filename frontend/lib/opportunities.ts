// SEO opportunities found in real Search Console data (GET /gsc/page-queries). Pure functions, no AI and no
// outside benchmark: "expected" CTRs come from this site's own pages at the same position.

export type PQ = { page: string; query: string; clicks: number; impressions: number; ctr: number; position: number };
export type PageRow = { key: string; clicks: number; impressions: number; ctr: number; position: number };
export type PageQueries = { range: { start: string; end: string; days: number }; previous: { start: string; end: string }; rows: PQ[]; pages: PageRow[]; prevPages: PageRow[] };
export type Art = { slug: string; title: string; status?: string };

export type OppKind = "striking" | "ctr" | "decay" | "gap" | "cannibal";
export type OppPage = { slug: string; title: string; page: string; clicks: number; impressions: number; position: number };
export type Opportunity = {
  id: string; kind: OppKind; score: number;
  query?: string; slug?: string; title?: string; page?: string;
  clicks: number; impressions: number; ctr: number; position: number;
  prevClicks?: number; prevPosition?: number; expectedCtr?: number; estClicks?: number;
  pages?: OppPage[];
  action: "refresh" | "snippet" | "idea" | "review";
  why: string;
};

/** Upper row limits of GET /gsc/page-queries: when a list is full, a page missing from it may only be ranked lower */
export const PAGE_LIMIT = 250;

/** The article slug of a blog URL: "/blog/<slug>", exactly (so /blog/seo never matches /blog/seo-tips) */
export function slugOf(url: string): string | null {
  const m = /\/blog\/([^/?#]+)\/?(?:[?#]|$)/.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

const STOP = new Set("a an and are as at be by for from how i in is it of on or the to what when where which who why with your you vs de des du la le les un une et en pour sur avec dans que qui est au aux ce ces son sa ses il ve bir ile için ne nasıl".split(" "));
/** Lowercase words without accents (ğ → g, ı → i), stop words dropped */
export function terms(s: string): string[] {
  return s.toLowerCase().replace(/ı/g, "i").normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
}
/** Share of the query's words found in the text (words match on their first 5 letters, so design ≈ designer) */
export function coverage(query: string, text: string): number {
  const q = terms(query); if (!q.length) return 0;
  const t = terms(text), stem = (w: string) => w.slice(0, 5);
  const have = new Set(t.map(stem));
  return q.filter((w) => have.has(stem(w))).length / q.length;
}

const BUCKETS: [number, number][] = [[0, 2], [2, 3], [3, 4], [4, 6], [6, 11], [11, 21]];
const bucketOf = (p: number) => BUCKETS.findIndex(([a, b]) => p >= a && p < b);
type Bucket = { clicks: number; impressions: number; pages: number };

/** This site's own click-through rate per position band, from its page totals */
export function ctrCurve(pages: PageRow[]): Bucket[] {
  const b: Bucket[] = BUCKETS.map(() => ({ clicks: 0, impressions: 0, pages: 0 }));
  for (const p of pages) { const i = bucketOf(p.position); if (i < 0 || !p.impressions) continue; b[i].clicks += p.clicks; b[i].impressions += p.impressions; b[i].pages++; }
  return b;
}
/** Expected CTR at a position from the other pages of the band; undefined when there is too little data to say */
export function expectedCtr(curve: Bucket[], position: number, self?: { clicks: number; impressions: number }): number | undefined {
  const i = bucketOf(position); if (i < 0) return undefined;
  const c = curve[i].clicks - (self?.clicks ?? 0), imp = curve[i].impressions - (self?.impressions ?? 0), n = curve[i].pages - (self ? 1 : 0);
  if (n < 2 || imp < 300) return undefined;
  return c / imp;
}
/** CTR of this site's pages in the top 3 (for "estimated extra clicks"), when there is enough data */
function top3Ctr(curve: Bucket[]): number | undefined {
  const s = curve.slice(0, 3).reduce((a, b) => ({ clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions, pages: a.pages + b.pages }), { clicks: 0, impressions: 0, pages: 0 });
  return s.pages >= 2 && s.impressions >= 300 ? s.clicks / s.impressions : undefined;
}

export type OppOptions = { brand?: string[] };
const pct = (x: number) => (x * 100 < 1 ? (x * 100).toFixed(2) : (x * 100).toFixed(1)) + "%";
const r1 = (x: number) => x.toFixed(1);

export function findOpportunities(d: PageQueries, articles: Art[], o: OppOptions = {}): Opportunity[] {
  const days = d.range.days, long = days >= 90;
  const minPair = long ? 60 : 20, minPage = long ? 300 : 100, minPrev = long ? 30 : 10;
  const bySlug = new Map(articles.map((a) => [a.slug.toLowerCase(), a]));
  const art = (url: string) => { const s = slugOf(url); return s ? bySlug.get(s) : undefined; };
  // a brand query names the brand as a whole ("ux boga", "uxboga"), not just one of its words ("ux")
  const flat = (s: string) => s.toLowerCase().replace(/ı/g, "i").normalize("NFD").replace(/[^a-z0-9]/g, "");
  const brand = (o.brand ?? []).map(flat).filter((b) => b.length >= 3);
  const isBrand = (q: string) => brand.some((b) => flat(q).includes(b));
  const curve = ctrCurve(d.pages), top3 = top3Ctr(curve);
  const out: Opportunity[] = [];

  // 1. Striking distance: a query this article already ranks for at ~5–20
  for (const r of d.rows) {
    const a = art(r.page);
    if (!a || r.position < 4.5 || r.position > 20 || r.impressions < minPair || isBrand(r.query)) continue;
    const est = top3 !== undefined ? Math.max(0, Math.round(r.impressions * top3 - r.clicks)) : undefined;
    out.push({
      id: `striking:${a.slug}:${r.query}`, kind: "striking", score: est ?? r.impressions / 10, query: r.query, slug: a.slug, title: a.title, page: r.page,
      clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, estClicks: est, action: "refresh",
      why: `Ranks at ${r1(r.position)} for “${r.query}” with ${r.impressions} impressions. Working this query into the title, a heading and the content can move it onto the first page.`,
    });
  }

  // 2. Low CTR for its position, compared with this site's other pages at the same position
  for (const p of d.pages) {
    const a = art(p.key);
    if (!a || p.position >= 11 || p.impressions < minPage) continue;
    const exp = expectedCtr(curve, p.position, p);
    if (exp === undefined || p.ctr >= exp * 0.5) continue;
    const est = Math.max(0, Math.round(p.impressions * exp - p.clicks));
    out.push({
      id: `ctr:${a.slug}`, kind: "ctr", score: est, slug: a.slug, title: a.title, page: p.key,
      clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position, expectedCtr: exp, estClicks: est, action: "snippet",
      why: `CTR ${pct(p.ctr)} at position ${r1(p.position)}, while your other pages at that position get ${pct(exp)}. The title and meta description aren't earning the click.`,
    });
  }

  // 3. Decaying: clicks down 30%+ on the previous period of the same length
  const cur = new Map(d.pages.map((p) => [p.key, p]));
  for (const p of d.prevPages) {
    const a = art(p.key);
    if (!a || p.clicks < minPrev) continue;
    const c = cur.get(p.key);
    if (!c && d.pages.length >= PAGE_LIMIT) continue; // may only have dropped out of the top rows: not enough to say
    const now = c?.clicks ?? 0;
    if (now > p.clicks * 0.7) continue;
    out.push({
      id: `decay:${a.slug}`, kind: "decay", score: p.clicks - now, slug: a.slug, title: a.title, page: p.key,
      clicks: now, impressions: c?.impressions ?? 0, ctr: c?.ctr ?? 0, position: c?.position ?? 0, prevClicks: p.clicks, prevPosition: p.position, action: "refresh",
      why: `${p.clicks} → ${now} clicks compared with the previous ${days} days${c ? `, average position ${r1(p.position)} → ${r1(c.position)}` : ""}. Refresh it with what people search for now.`,
    });
  }

  // 4. Content gaps & 5. cannibalisation, per query
  const byQ = new Map<string, PQ[]>();
  for (const r of d.rows) { const l = byQ.get(r.query); l ? l.push(r) : byQ.set(r.query, [r]); }
  for (const [q, rows] of byQ) {
    if (isBrand(q)) continue;
    const imp = rows.reduce((s, r) => s + r.impressions, 0), clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const best = Math.min(...rows.map((r) => r.position));
    const cover = Math.max(0, ...articles.map((a) => coverage(q, `${a.title} ${a.slug.replace(/-/g, " ")}`)));
    if (imp >= minPair * 1.5 && best > 10 && cover < 0.6 && terms(q).length) {
      out.push({
        id: `gap:${q}`, kind: "gap", score: imp / 5, query: q, clicks, impressions: imp, ctr: imp ? clicks / imp : 0, position: best, action: "idea",
        why: `${imp} impressions for “${q}”, best position ${r1(best)}, and no article is about it. A dedicated article could rank for it.`,
      });
    }
    const pages = rows.map((r) => ({ r, a: art(r.page) })).filter((x): x is { r: PQ; a: Art } => !!x.a && x.r.impressions >= 10 && x.r.impressions >= imp * 0.2);
    const uniq = [...new Map(pages.map((x) => [x.a.slug, x])).values()];
    if (uniq.length >= 2 && imp >= minPair) {
      uniq.sort((x, y) => y.r.clicks - x.r.clicks || x.r.position - y.r.position);
      out.push({
        id: `cannibal:${q}`, kind: "cannibal", score: imp / 8, query: q, clicks, impressions: imp, ctr: imp ? clicks / imp : 0, position: best, action: "review",
        pages: uniq.map(({ r, a }) => ({ slug: a.slug, title: a.title, page: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position })),
        why: `${uniq.length} articles compete for “${q}”. Make “${uniq[0].a.title}” the main page for it, and give the others a different angle or a link to it.`,
      });
    }
  }
  // where two articles compete for a query, only its main page should be pushed for it
  const second = new Set(out.filter((x) => x.kind === "cannibal").flatMap((x) => x.pages!.slice(1).map((p) => `${p.slug}:${x.query}`)));
  return out.filter((x) => x.kind !== "striking" || !second.has(`${x.slug}:${x.query}`)).sort((a, b) => b.score - a.score);
}

/** The real queries one article gets, most impressions first (to feed a content refresh) */
export function queriesFor(rows: PQ[], slug: string, max = 15) {
  return rows.filter((r) => slugOf(r.page) === slug.toLowerCase()).sort((a, b) => b.impressions - a.impressions).slice(0, max)
    .map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 }));
}
