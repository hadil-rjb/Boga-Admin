// Weekly Search Console monitoring: which week to snapshot, and the alerts that one week brings compared with the
// week before. Pure functions; the snapshot job lives in monitor.service.ts.

export type SnapRow = { key: string; clicks: number; impressions: number; position: number };
export type Snap = { start: string; end: string; totals: { clicks: number; impressions: number; position: number }; pages: SnapRow[]; queries: SnapRow[] };
export type Alert = { id: string; kind: "traffic" | "page-drop" | "striking" | "lost-top10"; tone: "pos" | "neg"; text: string; href: string };

export const ROWS = 250;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The last full week (Monday–Sunday, UTC) whose data Search Console has settled: its Sunday is at least 3 days ago */
export function weekFor(now: Date) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 3 * 864e5);
  const back = d.getUTCDay(); // 0 = Sunday
  const end = new Date(d.getTime() - back * 864e5), start = new Date(end.getTime() - 6 * 864e5);
  return { start: iso(start), end: iso(end) };
}
export const weekBefore = (w: { start: string }) => {
  const s = new Date(w.start + "T00:00:00Z");
  return { start: iso(new Date(s.getTime() - 7 * 864e5)), end: iso(new Date(s.getTime() - 864e5)) };
};

/** "/blog/slug" of a URL, or the URL without its host */
const path = (u: string) => u.replace(/^https?:\/\/[^/]+/, "") || "/";
const slugOf = (u: string) => /\/blog\/([^/?#]+)\/?(?:[?#]|$)/.exec(u)?.[1]?.toLowerCase() ?? null;
const pct = (a: number, b: number) => Math.round(Math.abs((a - b) / b) * 100);

/** The alerts of week `cur` compared with week `prev`. `titles` maps article slugs to titles for readable alerts. */
export function compareWeeks(cur: Snap, prev: Snap, titles: Record<string, string> = {}): Alert[] {
  const out: Alert[] = [], id = (k: string, key = "") => `${cur.end}:${k}${key ? ":" + key : ""}`;
  const name = (u: string) => { const s = slugOf(u); return (s && titles[s]) || path(u); };
  const edit = (u: string) => { const s = slugOf(u); return s && titles[s] ? `/articles?edit=${encodeURIComponent(s)}` : "/search?tab=opportunities"; };

  // 1. Site clicks, ±20% on at least 20 clicks
  const c = cur.totals.clicks, p = prev.totals.clicks;
  if (p >= 20 && Math.abs(c - p) >= p * 0.2)
    out.push({ id: id("traffic"), kind: "traffic", tone: c > p ? "pos" : "neg", text: `Search clicks ${c > p ? "up" : "down"} ${pct(c, p)}% last week (${p} → ${c})`, href: "/search" });

  // 2. Pages that lost 30%+ of their clicks (at least 8 the week before)
  const now = new Map(cur.pages.map((r) => [r.key, r]));
  const drops = prev.pages.filter((r) => {
    if (r.clicks < 8) return false;
    const n = now.get(r.key);
    if (!n && cur.pages.length >= ROWS) return false; // may only have dropped out of the top rows
    return (n?.clicks ?? 0) <= r.clicks * 0.7;
  }).sort((a, b) => (b.clicks - (now.get(b.key)?.clicks ?? 0)) - (a.clicks - (now.get(a.key)?.clicks ?? 0)));
  for (const r of drops.slice(0, 3)) {
    const n = now.get(r.key)?.clicks ?? 0;
    out.push({ id: id("page-drop", r.key), kind: "page-drop", tone: "neg", text: `“${name(r.key)}” lost ${pct(n, r.clicks)}% of its clicks last week (${r.clicks} → ${n})`, href: edit(r.key) });
  }
  if (drops.length > 3) out.push({ id: id("page-drop", "more"), kind: "page-drop", tone: "neg", text: `${drops.length - 3} more pages lost 30%+ of their clicks last week`, href: "/search?tab=opportunities" });

  // 3. Queries that newly reached positions 5–20 with 20+ impressions
  const before = new Map(prev.queries.map((r) => [r.key, r]));
  const near = cur.queries.filter((r) => r.position >= 4.5 && r.position <= 20 && r.impressions >= 20 && !((before.get(r.key)?.position ?? 99) <= 20));
  if (near.length) out.push({ id: id("striking", String(near.length)), kind: "striking", tone: "pos", text: near.length === 1 ? `“${near[0].key}” reached position ${near[0].position.toFixed(1)}: close to page 1` : `${near.length} searches reached positions 5–20 last week, e.g. “${near.sort((a, b) => b.impressions - a.impressions)[0].key}”`, href: "/search?tab=opportunities" });

  // 4. Queries that dropped out of the top 10 (20+ impressions)
  const lost = cur.queries.filter((r) => { const b = before.get(r.key); return b && b.position <= 10 && b.impressions >= 20 && r.position > 10; }).sort((a, b) => b.impressions - a.impressions);
  for (const r of lost.slice(0, 2)) out.push({ id: id("lost-top10", r.key), kind: "lost-top10", tone: "neg", text: `“${r.key}” fell out of the top 10 (position ${before.get(r.key)!.position.toFixed(1)} → ${r.position.toFixed(1)})`, href: "/search?tab=opportunities" });
  return out;
}
