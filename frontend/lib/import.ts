// Import articles from a spreadsheet (.xlsx, .xls, .csv).
// Pure helpers (parsing, column mapping, row validation, the import runner) so they can be unit tested;
// the dialog in components/ImportArticlesDialog.tsx only wires them to the UI.
import { slugify } from "./seo";

export type Cell = string | number | boolean | Date | null | undefined;
export type Grid = Cell[][];

// ───────── Reading files ─────────

/** RFC 4180 CSV: quoted fields with "" escapes and line breaks, BOM, CRLF; the delimiter (, ; or tab) is guessed from the first line */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const d = guessDelimiter(s);
  const out: string[][] = [];
  let row: string[] = [], f = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"' && f === "") q = true;
    else if (c === d) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(f); out.push(row); row = []; f = "";
    } else f += c;
  }
  if (f !== "" || row.length) { row.push(f); out.push(row); }
  return out;
}
function guessDelimiter(s: string): string {
  let q = false; const n: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (const c of s) {
    if (c === '"') q = !q;
    else if (!q && (c === "\n" || c === "\r")) break;
    else if (!q && c in n) n[c]++;
  }
  const [best, count] = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return count ? best : ",";
}

export const isCsv = (name: string) => /\.(csv|tsv|txt)$/i.test(name);
export const ACCEPT = ".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv";

export type Book = { sheets: { name: string; rows: Grid }[] };
/** Excel workbook (xlsx or xls) → every sheet as rows of cells. SheetJS is loaded only when needed. */
export async function parseWorkbook(buf: ArrayBuffer): Promise<Book> {
  const X = await import("xlsx");
  const wb = X.read(new Uint8Array(buf), { type: "array", cellDates: false, dense: true });
  return { sheets: wb.SheetNames.map((name) => ({ name, rows: X.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: "", blankrows: false }) })) };
}
/** A picked file → sheets. CSV is parsed as text (keeps HTML content and dates exactly as written). */
export async function readFile(file: File): Promise<Book> {
  if (isCsv(file.name)) return { sheets: [{ name: file.name, rows: parseCsv(await file.text()) }] };
  if (!/\.(xlsx|xlsm|xls)$/i.test(file.name)) throw new Error("Choose an .xlsx, .xls or .csv file");
  return parseWorkbook(await file.arrayBuffer());
}

// ───────── Columns → article fields ─────────

export type Field = "title" | "slug" | "cat" | "status" | "date" | "time" | "sub" | "html" | "meta" | "img" | "alt" | "tags" | "t1" | "t2" | "t3" | "coverPrompt";
export const FIELDS: { k: Field; label: string; aliases: string[] }[] = [
  // the first alias of each field is the "Export CSV" column name, so an export re-imports as is
  { k: "title", label: "Title", aliases: ["Title", "Name", "Headline", "Post title", "Article title", "Titre"] },
  { k: "slug", label: "Slug", aliases: ["Slug", "URL", "Permalink", "Path", "Link"] },
  { k: "cat", label: "Category", aliases: ["Category", "Cat", "Categories", "Section", "Topic", "Catégorie"] },
  { k: "status", label: "Status", aliases: ["Status", "State", "Statut"] },
  { k: "date", label: "Date", aliases: ["Date", "Publish date", "Published", "Published at", "Publication date", "Pub date", "Scheduled date"] },
  { k: "time", label: "Time", aliases: ["Time", "Publish time", "Heure"] },
  { k: "sub", label: "Subtitle", aliases: ["Subtitle", "Excerpt", "Summary", "Intro", "Sous-titre", "Résumé"] },
  { k: "html", label: "Content", aliases: ["Content", "Body", "HTML", "Text", "Article", "Contenu"] },
  { k: "meta", label: "Meta description", aliases: ["Meta Description", "Meta", "SEO description", "Description", "Meta desc"] },
  { k: "img", label: "Cover image", aliases: ["Cover Image", "Cover", "Image", "Image URL", "Cover image URL", "Featured image", "Thumbnail", "Img"] },
  { k: "alt", label: "Cover alt text", aliases: ["Cover Image:alt", "Alt", "Alt text", "Image alt", "Cover alt"] },
  { k: "tags", label: "Tags (list)", aliases: ["Tags", "Keywords", "Labels"] },
  { k: "t1", label: "Tag 1", aliases: ["Tag 1", "Tag1", "Tag"] },
  { k: "t2", label: "Tag 2", aliases: ["Tag 2", "Tag2"] },
  { k: "t3", label: "Tag 3", aliases: ["Tag 3", "Tag3"] },
  { k: "coverPrompt", label: "Cover prompt", aliases: ["Cover prompt", "Image prompt", "Prompt"] },
];
const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
const ALIAS = new Map<string, Field>(FIELDS.flatMap((f) => f.aliases.map((a) => [norm(a), f.k] as [string, Field])));

/** Mapping: one entry per column, the article field it fills or "" (ignored) */
export type Mapping = (Field | "")[];
/** Guess the field of each column from its header; each field is used by at most one column (the first that matches) */
export function autoMap(headers: Cell[]): Mapping {
  const used = new Set<Field>();
  const pick = (h: Cell): Field | "" => {
    const n = norm(h);
    if (!n) return "";
    let k = ALIAS.get(n);
    // looser match: "Article Title (EN)" → title, "SEO Meta Description" → meta (longest alias contained in the header)
    if (!k) k = [...ALIAS.entries()].filter(([a]) => a.length >= 4 && n.includes(a)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    if (!k || used.has(k)) return "";
    used.add(k);
    return k;
  };
  return headers.map(pick);
}
/** The header row: the first row with at least two filled cells (title rows above a table are skipped) */
export function headerIndex(rows: Grid): number {
  const i = rows.findIndex((r) => r.filter((c) => String(c ?? "").trim() !== "").length >= 2);
  return i < 0 ? 0 : i;
}

// ───────── Rows → article bodies ─────────

export type Body = { slug: string; title: string; img: string; alt: string; meta: string; sub: string; cat: string; t: string[]; html: string; coverPrompt: string; date: string; time: string; status: "Live" | "Scheduled" | "Draft" };
export type Row = {
  line: number;           // 1-based line in the sheet, as Excel shows it
  slug: string; title: string;
  fields: Partial<Body>;  // only the fields the file fills (used as is for updates)
  body: Body;             // fields + defaults (used for new articles)
  exists: boolean;        // an article with this slug already exists
  errors: string[];       // the row can't be imported
  warnings: string[];     // imported, with something changed or dropped
};
const LIMITS: Partial<Record<keyof Body, number>> = { alt: 300, meta: 400, sub: 400, cat: 80, coverPrompt: 3000 };
const STATUS: Record<string, Body["status"]> = { live: "Live", published: "Live", publish: "Live", public: "Live", online: "Live", publie: "Live", enligne: "Live", scheduled: "Scheduled", schedule: "Scheduled", planned: "Scheduled", programme: "Scheduled", planifie: "Scheduled", draft: "Draft", brouillon: "Draft", unpublished: "Draft", private: "Draft" };
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Any date a sheet may hold → "YYYY-MM-DD"; null when it can't be read */
export function toDate(v: Cell): string | null {
  if (v == null || v === "") return "";
  if (v instanceof Date) return isNaN(+v) ? null : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === "number") {
    // Excel serial day (1900 system): 45000 ≈ 2023
    if (v < 1 || v > 2958465) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/) || s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  // 07/10/2025 or 07.10.2025: day first unless the first number can't be a day… or the second can't be a month
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3], a = +m[1], b = +m[2]; return b > 12 ? valid(y, a, b) : valid(y, b, a); }
  // "Nov 04, 2026", "4 November 2026"
  m = s.match(/^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return valid(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
  m = s.match(/^(\d{1,2})\s+([a-z]{3,})\.?,?\s+(\d{4})$/i);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return valid(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
  return null;
}
function valid(y: number, mo: number, d: number) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}
export function toTime(v: Cell): string | null {
  if (v == null || v === "") return "";
  if (typeof v === "number" && v >= 0 && v < 1) { const m = Math.round(v * 1440); return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; }
  const m = String(v).trim().match(/^(\d{1,2})[:h](\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1];
  if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return h < 24 && +m[2] < 60 ? `${pad(h)}:${m[2]}` : null;
}
/** "https://site.com/blog/my-post/" or "/blog/my-post" → "my-post" */
export function cleanSlug(v: string): string {
  const s = v.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  return slugify(s.includes("/") ? s.split("/").pop()! : s);
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Plain text → paragraphs; HTML is kept as is */
export function toHtml(v: string): string {
  const s = v.trim();
  if (!s) return "";
  if (/<(p|h[1-6]|ul|ol|li|div|br|img|a|strong|em|blockquote|figure|table)\b/i.test(s)) return s;
  return s.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
}
const str = (v: Cell) => (v == null ? "" : v instanceof Date ? toDate(v) || "" : String(v)).trim();

export function buildRows(rows: Grid, head: number, map: Mapping, existing: Iterable<string>): Row[] {
  const known = new Set(existing), seen = new Map<string, number>(), out: Row[] = [];
  for (let i = head + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => str(c) !== "")) continue;
    const raw: Partial<Record<Field, Cell>> = {};
    map.forEach((k, j) => { if (k) raw[k] = r[j]; });
    const errors: string[] = [], warnings: string[] = [], f: Partial<Body> = {};
    const text = (k: Field) => str(raw[k]);
    const has = (k: Field) => k in raw && text(k) !== "";

    const title = text("title").replace(/\s+/g, " ");
    if (!title) errors.push("Missing title");
    else if (title.length > 200) errors.push("Title is longer than 200 characters");
    else f.title = title;

    let slug = has("slug") ? cleanSlug(text("slug")) : "";
    if (has("slug") && !slug) warnings.push("Slug unreadable, made from the title");
    if (!slug) slug = slugify(title);
    if (title && !slug) errors.push("Can't make a slug from this title");
    if (slug) {
      f.slug = slug;
      const prev = seen.get(slug);
      if (prev) errors.push(`Same slug as line ${prev}`); else seen.set(slug, i + 1);
    }

    for (const k of ["cat", "sub", "meta", "alt", "coverPrompt"] as const) if (has(k)) {
      let v = text(k); const max = LIMITS[k]!;
      if (v.length > max) { v = v.slice(0, max); warnings.push(`${FIELDS.find((x) => x.k === k)!.label} cut to ${max} characters`); }
      f[k] = v;
    }
    if (has("html")) f.html = toHtml(text("html"));
    if (has("img")) {
      const v = text("img");
      if (/^(https?:\/\/|\/)\S+$/i.test(v)) f.img = v; else warnings.push("Cover image is not a URL, left empty");
    }
    const tags = [...(has("tags") ? text("tags").split(/[,;|]/) : []), text("t1"), text("t2"), text("t3")].map((x) => x.trim()).filter(Boolean);
    if (has("tags") || has("t1") || has("t2") || has("t3")) {
      if (tags.length > 3) warnings.push(`Only the first 3 of ${tags.length} tags are kept`);
      f.t = [0, 1, 2].map((x) => tags[x] || "");
    }
    if (has("date")) { const d = toDate(raw.date); if (d == null) warnings.push(`Date "${text("date")}" not understood, left empty`); else f.date = d; }
    if (has("time")) { const t = toTime(raw.time); if (t == null) warnings.push(`Time "${text("time")}" not understood, 09:00 used`); else f.time = t; }
    if (has("status")) {
      const st = STATUS[norm(text("status"))];
      if (!st) warnings.push(`Status "${text("status")}" not understood, imported as Draft`);
      f.status = st || "Draft";
    }
    if (f.status === "Scheduled" && !f.date) { warnings.push("Scheduled without a date, imported as Draft"); f.status = "Draft"; }

    const body: Body = { slug, title, img: "", alt: "", meta: "", sub: "", cat: "", t: ["", "", ""], html: "", coverPrompt: "", date: "", time: "09:00", status: "Draft", ...f };
    out.push({ line: i + 1, slug, title, fields: f, body, exists: !!slug && known.has(slug), errors, warnings });
  }
  return out;
}

// ───────── Sending ─────────

export type Mode = "skip" | "update";
export type Outcome = { line: number; slug: string; title: string; result: "created" | "updated" | "skipped" | "failed"; reason?: string };
type Api = (path: string, o: { method: string; body: unknown; signal?: AbortSignal }) => Promise<unknown>;
const TRANSIENT = new Set([0, 408, 429, 502, 503, 504]);

/** Whether a row will be sent, and how */
export const plan = (r: Row, mode: Mode): "created" | "updated" | "skipped" | "invalid" => (r.errors.length ? "invalid" : r.exists ? (mode === "update" ? "updated" : "skipped") : "created");

/**
 * One article at a time (the API runs on a small plan): POST new slugs, PATCH existing ones in "update" mode
 * with only the fields the file fills. When the server doesn't answer (restarting, 502/503/504) the same
 * article is retried after a growing pause instead of failing the rest of the file.
 */
export async function runImport(rows: Row[], mode: Mode, o: {
  api: Api; onProgress?: (done: number, total: number, last: Outcome, waiting?: string) => void;
  signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; waits?: number[];
}): Promise<Outcome[]> {
  const sleep = o.sleep || ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const waits = o.waits || [2000, 4000, 8000, 15000, 30000, 30000, 60000];
  const out: Outcome[] = [];
  const todo = rows.filter((r) => plan(r, mode) !== "invalid");
  let done = 0;
  const push = (x: Outcome) => { out.push(x); o.onProgress?.(++done, todo.length, x); };
  for (const r of rows) {
    const base = { line: r.line, slug: r.slug, title: r.title };
    const p = plan(r, mode);
    if (p === "invalid") { out.push({ ...base, result: "skipped", reason: r.errors.join("; ") }); continue; }
    if (o.signal?.aborted) { push({ ...base, result: "skipped", reason: "Import stopped" }); continue; }
    if (p === "skipped") { push({ ...base, result: "skipped", reason: "Slug already exists" }); continue; }
    for (let attempt = 0; ; attempt++) {
      try {
        if (p === "updated") {
          const { slug: _s, ...patch } = r.fields;
          await o.api("/articles/" + encodeURIComponent(r.slug), { method: "PATCH", body: patch, signal: o.signal });
        } else await o.api("/articles", { method: "POST", body: r.body, signal: o.signal });
        push({ ...base, result: p });
        break;
      } catch (e: any) {
        if (e?.name === "AbortError" || o.signal?.aborted) { push({ ...base, result: "skipped", reason: "Import stopped" }); break; }
        const st = typeof e?.status === "number" ? e.status : 0;
        if (TRANSIENT.has(st) && attempt < waits.length) {
          o.onProgress?.(done, todo.length, { ...base, result: "failed" }, `Server not answering, retrying in ${Math.round(waits[attempt] / 1000)} s…`);
          await sleep(waits[attempt]);
          continue;
        }
        push(st === 409 ? { ...base, result: "skipped", reason: "Slug already exists" } : { ...base, result: "failed", reason: e?.message || "Error" });
        break;
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
