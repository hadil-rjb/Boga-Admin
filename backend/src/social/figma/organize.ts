/**
 * Turns a Figma page laid out as a library (rows of frames, each row labelled on its left: "News Post Template",
 * "Q&A Templates"…) into categories → templates → versions, the way the brand kit keeps them.
 *
 * - Category: the Figma section the frame is in, else the text label to the left of its row (the nearest one
 *   vertically), else the page name.
 * - Template: frames of one category whose names share a stem ("News 1-Blue", "News 1-White" → "News 1"), or the
 *   same name (a post and a story of one layout).
 * - Versions: those frames in reading order (top to bottom, left to right). The first is the original. A version
 *   is named by what follows the stem ("Blue"), with its size when two would otherwise share a name.
 *
 * Pure: no Figma calls, so it is tested on its own.
 */

export type OrgFrame = { id: string; name: string; page: string; section?: string; x: number; y: number; w: number; h: number; ratio: string; width: number; height: number; thumb?: string | null };
export type OrgLabel = { text: string; page: string; section?: string; x: number; y: number; w: number; h: number };
export type OrgVersion = { id: string; name: string; ratio: string; width: number; height: number; thumb: string | null };
export type OrgTemplate = { name: string; versions: OrgVersion[] };
export type OrgCategory = { name: string; page: string; templates: OrgTemplate[] };

/** Most versions a template keeps besides its original (the API's limit) */
export const MAX_TEMPLATE_VERSIONS = 24;

const SEP = /^(.*?\S)\s*[-–—·/_|]\s*([^-–—·/_|]+?)\s*$/;

/** "News 1-Blue" → { stem: "News 1", variant: "Blue" }; a name without a separator is its own stem */
export function splitName(name: string): { stem: string; variant: string } {
  const n = String(name || "").trim(), m = SEP.exec(n);
  return m ? { stem: m[1].trim(), variant: m[2].trim() } : { stem: n, variant: "" };
}

/** Label text as a category name: one line, at most 60 characters */
const clean = (t: string) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 60);

/** The category of a frame: its section, else the nearest label on its left whose middle is level with the frame's row */
export function categoryOf(f: OrgFrame, labels: OrgLabel[]): string {
  if (f.section) return clean(f.section);
  const mid = f.y + f.h / 2;
  let best: { l: OrgLabel; d: number } | null = null;
  for (const l of labels) {
    if (l.page !== f.page || l.x + l.w > f.x + 4) continue; // on the frame's page, to its left
    const d = Math.abs(l.y + l.h / 2 - mid);
    if (d > Math.max(f.h * 1.6, 120)) continue; // level with the row (a label between two rows reaches both, even a short top row)
    if (!best || d < best.d - 1 || (Math.abs(d - best.d) <= 1 && l.x > best.l.x)) best = { l, d };
  }
  return best ? clean(best.l.text) : clean(f.page) || "Templates";
}

export function organize(frames: OrgFrame[], labels: OrgLabel[]): OrgCategory[] {
  const pages: string[] = [];
  frames.forEach((f) => { if (!pages.includes(f.page)) pages.push(f.page); });
  // reading order: page, then rows (frames whose tops are close are on one row), then left to right
  const sorted = [...frames].sort((a, b) => pages.indexOf(a.page) - pages.indexOf(b.page) || (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x));
  const cats = new Map<string, OrgCategory>(), groups = new Map<string, { cat: OrgCategory; name: string; items: { f: OrgFrame; variant: string }[] }>();
  for (const f of sorted) {
    const cname = categoryOf(f, labels), ckey = f.page + "\u0000" + cname.toLowerCase();
    let cat = cats.get(ckey);
    if (!cat) { cat = { name: cname, page: f.page, templates: [] }; cats.set(ckey, cat); }
    const { stem, variant } = splitName(f.name), gkey = ckey + "\u0000" + stem.toLowerCase();
    let g = groups.get(gkey);
    if (!g) { g = { cat, name: stem || f.name || "Template", items: [] }; groups.set(gkey, g); }
    g.items.push({ f, variant });
  }
  for (const g of groups.values()) {
    const items = g.items.slice(0, MAX_TEMPLATE_VERSIONS + 1);
    const base = items.map(({ f, variant }) => variant || f.ratio);
    const versions = items.map(({ f }, i) => {
      // a name two versions share gets the size, then a number
      let name = base[i];
      if (base.filter((x) => x === name).length > 1) name = base[i] === f.ratio ? name : `${name} · ${f.ratio}`;
      return { id: f.id, name, ratio: f.ratio, width: f.width, height: f.height, thumb: f.thumb ?? null };
    });
    const seen = new Map<string, number>();
    versions.forEach((v) => { const k = v.name.toLowerCase(), n = (seen.get(k) || 0) + 1; seen.set(k, n); if (n > 1) v.name = `${v.name} ${n}`; });
    g.cat.templates.push({ name: g.name.slice(0, 80), versions });
  }
  return [...cats.values()];
}
