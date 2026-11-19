// "Get from Framer": a published Framer CMS item → article fields, and what differs from the admin's copy.
// Pure functions; framer.service.ts reads the collection and saves what the user picked.

export type Fld = { id: string; name: string; type: string; cases?: { id: string; name: string }[] };
export type Entry = { type: string; value: any };
export type Item = { id?: string; slug: string; draft?: boolean; fieldData: Record<string, Entry | undefined> };
/** The Framer field matched to each article field (same matching as publishing), and the "Tag 1, Tag 2…" fields if any */
export type Resolved = { title?: Fld; meta?: Fld; sub?: Fld; cat?: Fld; tags?: Fld; html?: Fld; img?: Fld; alt?: Fld; date?: Fld; tagFields: Fld[] };
export type Pulled = { slug: string; title?: string; meta?: string; sub?: string; cat?: string; t?: string[]; html?: string; img?: string; alt?: string; date?: string; time?: string };
export type Diffable = Omit<Pulled, "slug">;
export const DIFF_FIELDS = ["title", "meta", "sub", "cat", "t", "html", "img", "alt", "date"] as const;
export type DiffField = (typeof DIFF_FIELDS)[number];

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const plain = (s: string) => decode(String(s ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Framer's rich text, minus anything active: scripts, embeds, event handlers, javascript: links */
export function safeHtml(h: string) {
  return String(h ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|form|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|form|template|noscript)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .trim();
}

/** Text of a string or rich-text field */
const text = (e?: Entry) => (!e || e.value == null ? undefined : e.type === "formattedText" ? plain(e.value) : typeof e.value === "string" ? e.value.trim() : undefined);

/** Date and time (HH:mm) of an ISO instant in the publishing time zone */
export function localDate(iso: string, tz: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** One Framer item → the article fields it carries. A field missing from the collection stays undefined (never blanked). */
export function itemToArticle(it: Item, r: Resolved, tz: string): Pulled {
  const f = (x?: Fld) => (x ? it.fieldData[x.id] : undefined);
  const out: Pulled = { slug: it.slug };
  const set = <K extends keyof Pulled>(k: K, v: Pulled[K] | undefined) => { if (v !== undefined) out[k] = v; };
  set("title", text(f(r.title)));
  set("meta", text(f(r.meta)));
  set("sub", text(f(r.sub)));
  set("alt", text(f(r.alt)));
  const c = f(r.cat);
  if (c) set("cat", c.type === "enum" ? (r.cat!.cases ?? []).find((x) => x.id === c.value || x.name === c.value)?.name ?? "" : text(c) ?? "");
  if (r.tagFields.length) set("t", r.tagFields.map((x) => text(f(x)) ?? "").filter(Boolean).slice(0, 3));
  else if (r.tags) { const v = text(f(r.tags)); if (v !== undefined) set("t", v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3)); }
  const h = f(r.html);
  if (h) set("html", h.type === "formattedText" ? safeHtml(h.value ?? "") : typeof h.value === "string" && h.value.trim() ? `<p>${esc(h.value.trim())}</p>` : "");
  const im = f(r.img);
  if (im && im.type === "image") {
    set("img", im.value?.url ?? "");
    if (!r.alt && im.value?.altText) set("alt", String(im.value.altText).trim()); // the alt text lives in the image field
  }
  const d = f(r.date);
  if (d && d.type === "date" && d.value) { const l = localDate(d.value, tz); if (l) { out.date = l.date; out.time = l.time; } }
  return out;
}

const norm = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).join(",") : String(v ?? "").replace(/\s+/g, " ").trim()).toLowerCase();
/** The article fields Framer would change. Content is compared on its text, so Framer's own HTML formatting doesn't count as a change. */
export function diff(cur: Diffable, inc: Diffable): DiffField[] {
  return DIFF_FIELDS.filter((k) => {
    const v = inc[k];
    if (v === undefined) return false;
    if (k === "html") return plain(String(v)) !== plain(String(cur.html ?? ""));
    if (k === "img") return String(v).split("?")[0] !== String(cur.img ?? "").split("?")[0];
    return norm(v) !== norm(cur[k]);
  });
}
