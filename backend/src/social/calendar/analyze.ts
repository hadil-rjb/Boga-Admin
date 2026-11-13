import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { trackClaude } from "../../ai/usage";
import { z } from "zod";

/**
 * Reads a slide (its layers, plus a small render when available) and finds the economic calendar
 * in it: which text layer is each row's time, currency, event name, values and impact, and which
 * layer shows the date. The studio then rewrites only those texts with live data, so the design
 * itself (colours, fonts, spacing, positions) never changes.
 *
 * Each mapped text keeps its own wording through a template, e.g. "Actual {actual} · Forecast {forecast}".
 * Row placeholders: {time} {currency} {country} (code) {countryName} (full name) {flag} {event} {actual} {forecast} {previous} {value} {impact}
 * Date placeholders: {weekday} {day} {month} {year}; time zone label: {tz}
 * {flag} goes on an image layer (the country flag); every other placeholder on text.
 *
 * Two engines produce the same mapping: Claude (when a key is set in Settings → AI) and a
 * layout heuristic (no key, or as a fallback when Claude is unavailable).
 */

export type Layer = {
  id: string; type: string; name?: string; text?: string;
  x: number; y: number; w: number; h: number;
  size?: number; weight?: number | string; color?: string; fill?: string; locked?: boolean; hidden?: boolean;
};

export const ROW_PLACEHOLDERS = ["time", "currency", "country", "countryName", "flag", "event", "actual", "forecast", "previous", "value", "impact"] as const;
export const DATE_PLACEHOLDERS = ["weekday", "wd", "day", "month", "mon", "year"] as const;
/** Placeholders for slide texts outside the rows: the post's day, its week (Mon–Fri) and the time zone */
export const TEXT_PLACEHOLDERS = ["weekday", "wd", "day", "month", "mon", "year", "weekStartDay", "weekStartMon", "weekStartMonth", "weekEndDay", "weekEndMon", "weekEndMonth", "tz"] as const;

const WeekSchema = z.object({
  container: z.string().nullable().describe("The panel/card shape the day blocks sit in (its bottom edge is where content must stop), or null"),
  dayBar: z.string().nullable().describe("Shape behind the first day's heading (e.g. a coloured bar), or null"),
  dayHeader: z.object({ layerId: z.string(), template: z.string().describe("The first day heading's text with {weekday} {wd} {day} {month} {mon} {year}") }),
  groupHeader: z.object({ layerId: z.string(), template: z.string().describe("The first group heading inside a day (usually a country) with {flag} (flag emoji) {country} (code, e.g. US) {countryName} (full name, e.g. United States) {currency}; use the form the design shows") }).nullable(),
  list: z.object({ layerId: z.string(), lineTemplate: z.string().describe("ONE line of the first events list with its data replaced, e.g. '• {event} – {time} {tz}'; placeholders {time} {currency} {country} {countryName} {flag} {event} {actual} {forecast} {previous} {value} {impact} {tz}") }),
  groupFlag: z.string().nullable().describe("The flag picture next to the first group heading (a separate image layer), or null"),
  slotLayerIds: z.array(z.string()).describe("Every layer of the day blocks (all day bars, day headings, flag pictures, group headings and event lists) - they are rebuilt from the first ones"),
  period: z.enum(["day", "week"]).describe("day: the slide shows ONE day's events (a single day heading); week: several day blocks or a Monday-Friday range"),
});

const MappingSchema = z.object({
  isCalendar: z.boolean().describe("true when the slide shows a list of economic calendar events"),
  layout: z.enum(["rows", "week"]).describe("rows: one row (card/line) per event; week: blocks per day, each listing several events (often grouped by country) inside text lists"),
  week: WeekSchema.nullable().describe("For layout 'week' only"),
  reason: z.string().describe("One short sentence a designer can read, e.g. '5 rows found: time, currency, event, values and impact.'"),
  date: z.object({
    layerId: z.string(),
    template: z.string().describe("The layer's text with the date parts replaced by {weekday} {day} {month} {year}; short names (Mon, Oct) use {wd} and {mon}"),
  }).nullable().describe("The text layer showing the calendar's day, or null"),
  tz: z.object({
    layerId: z.string(),
    template: z.string().describe("The layer's text with the time zone replaced by {tz}, e.g. 'Times in {tz}'"),
  }).nullable().describe("The text layer naming the time zone (e.g. 'GMT+4'), or null"),
  impactSymbol: z.string().nullable().describe("The character repeated to show impact (e.g. ★ or ●), or null when impact is written as a word"),
  texts: z.array(z.object({
    layerId: z.string(),
    kind: z.enum(["title", "subtitle", "label", "date", "brand", "website", "legal", "other"]).describe("What this text is on the design"),
    template: z.string().nullable().describe("When the text shows the post's day, week or time zone: its exact text with those parts replaced by placeholders ({weekday} {wd} {day} {month} {mon} {year} {weekStartDay} {weekStartMon} {weekStartMonth} {weekEndDay} {weekEndMon} {weekEndMonth} {tz}), keeping every other character and line break. null for text that never changes"),
    translate: z.boolean().describe("true when the text is words a reader of another language needs translated (titles, labels, captions); false for brand names, websites, handles, codes and numbers"),
  })).describe("Every text layer that is not part of a row, in layer order"),
  needs: z.object({
    impact: z.enum(["ok", "convertPictures", "addStars", "notNeeded"]).describe("ok: impact is a text field already; convertPictures: impact is drawn with pictures that should become editable stars; addStars: the design clearly expects an impact rating per row but has none; notNeeded: the design shows no impact"),
    note: z.string().describe("One short sentence for the designer about anything else the template needs, or an empty string"),
  }),
  rows: z.array(z.object({
    layerIds: z.array(z.string()).describe("Every layer that belongs to this row: its texts plus its background card, badges and dividers"),
    fields: z.array(z.object({
      layerId: z.string(),
      role: z.enum(ROW_PLACEHOLDERS).describe("The main kind of data this text shows"),
      template: z.string().describe("The layer's text with its data replaced by placeholders; keep labels and separators, e.g. 'Actual {actual} · Forecast {forecast}'"),
    })),
  })).describe("One entry per calendar row, top to bottom"),
});
export type Mapping = z.infer<typeof MappingSchema> & { engine: "claude" | "heuristic"; model?: string };
export type WeekMap = z.infer<typeof WeekSchema>;

/* ---------------- sanitizing (both engines) ---------------- */

const PH = /\{(\w+)\}/g;
const hasPh = (t: string, allowed: readonly string[]) => [...t.matchAll(PH)].some((m) => allowed.includes(m[1]));

/** Drops ids that aren't on the slide, templates without a usable placeholder, empty rows; orders rows top to bottom */
export function sanitize(m: Omit<Mapping, "engine">, layers: Layer[]): Omit<Mapping, "engine"> {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const isText = (id: string) => byId.get(id)?.type === "text";
  const isPic = (id: string) => ["image", "rect", "ellipse"].includes(byId.get(id)?.type || "");
  const rows = m.rows
    .map((r) => {
      const fields = r.fields
        .map((f) => (f.role === "flag" ? { ...f, template: "{flag}" } : f))
        .filter((f) => (f.role === "flag" ? isPic(f.layerId) : isText(f.layerId) && hasPh(f.template, ROW_PLACEHOLDERS)));
      const ids = [...new Set([...r.layerIds.filter((id) => byId.has(id)), ...fields.map((f) => f.layerId)])];
      return { layerIds: ids, fields };
    })
    .filter((r) => r.fields.length)
    .sort((a, b) => top(a, byId) - top(b, byId));
  let week = m.layout === "week" && m.week ? m.week : null;
  if (week) {
    const okText = (id?: string | null) => !!id && isText(id);
    if (!okText(week.dayHeader?.layerId) || !okText(week.list?.layerId) || !hasPh(week.list.lineTemplate, [...ROW_PLACEHOLDERS, "tz"])) week = null;
    else {
      const groupHeader = week.groupHeader && okText(week.groupHeader.layerId) ? week.groupHeader : null;
      // flag pictures just left of the group headings: the first one is redrawn with each country's flag, all are part of the blocks
      const gh = groupHeader ? byId.get(groupHeader.layerId)! : null;
      const flagOf = (t: Layer) => layers.find((l) => !l.hidden && isPic(l.id) && l.w <= 96 && l.h <= 72 && l.w >= 8 && l.x + l.w <= t.x + 6 && l.x + l.w >= t.x - 48 && Math.abs(l.y + l.h / 2 - (t.y + t.h / 2)) <= Math.max(14, t.h * 0.6));
      const heads = gh ? layers.filter((l) => isText(l.id) && Math.abs(l.x - gh.x) < 30 && Math.abs((l.size || 0) - (gh.size || 0)) < 2) : [];
      const flags = heads.map(flagOf).filter(Boolean) as Layer[];
      const groupFlag = gh && !/\{flag\}/.test(groupHeader!.template) ? (week.groupFlag && isPic(week.groupFlag) ? week.groupFlag : flagOf(gh)?.id ?? null) : null;
      week = {
        ...week,
        container: week.container && byId.has(week.container) ? week.container : null,
        dayBar: week.dayBar && byId.has(week.dayBar) ? week.dayBar : null,
        groupHeader, groupFlag,
        slotLayerIds: [...new Set([...week.slotLayerIds.filter((id) => byId.has(id)), week.dayHeader.layerId, week.list.layerId, ...(groupHeader ? [groupHeader.layerId] : []), ...(week.dayBar ? [week.dayBar] : []), ...(groupFlag ? flags.map((f) => f.id) : [])])],
      };
      // one day heading is a day calendar; several, or a "Oct 19 – 23" text, a week
      const dayHeads = week.slotLayerIds.filter((id) => { const t = byId.get(id); return t?.type === "text" && !!dateTemplate(t.text || "") && !/[-–—]/.test(t.text || ""); }).length;
      const range = (m.texts || []).some((t) => /\{week(Start|End)/.test(t.template || ""));
      week.period = range || dayHeads >= 2 ? "week" : dayHeads === 1 ? "day" : week.period === "day" ? "day" : "week";
    }
  }
  const date = m.date && isText(m.date.layerId) && hasPh(m.date.template, DATE_PLACEHOLDERS) ? m.date : null;
  const tz = m.tz && isText(m.tz.layerId) && m.tz.template.includes("{tz}") ? m.tz : null;
  const inRows = new Set([...rows.flatMap((r) => r.layerIds), ...(week ? week.slotLayerIds : [])]);
  const seen = new Set<string>();
  const texts = (m.texts || [])
    .filter((t) => isText(t.layerId) && !inRows.has(t.layerId) && !seen.has(t.layerId) && seen.add(t.layerId))
    .map((t) => ({ ...t, template: t.template && hasPh(t.template, TEXT_PLACEHOLDERS) ? t.template : null }));
  // date / tz layers are described by their text entry when there is one (it can hold several parts)
  const covered = new Set(texts.filter((t) => t.template).map((t) => t.layerId));
  const layout = week ? "week" : "rows";
  return { ...m, layout, week, rows: week ? [] : rows, texts, needs: m.needs || { impact: "ok", note: "" }, date: date && !covered.has(date.layerId) ? date : null, tz: tz && !covered.has(tz.layerId) ? tz : null, isCalendar: m.isCalendar && (week ? true : rows.length > 0) };
}
const top = (r: { fields: { layerId: string }[] }, byId: Map<string, Layer>) => Math.min(...r.fields.map((f) => byId.get(f.layerId)?.y ?? 0));

/* ---------------- heuristic engine ---------------- */

const TIME_RE = /^\s*\d{1,2}[:.]\d{2}\s*(am|pm)?\s*$/i;
const CUR_RE = /^\s*(USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|CNY|CNH|SEK|NOK|MXN|ZAR|TRY|INR|KRW|SGD|HKD)\s*$/i;
const WORD_IMPACT_RE = /^\s*(high|medium|med|low|عالي|عالية|متوسط|متوسطة|منخفض|منخفضة)\s*$/i;
const NUM = String.raw`[-+]?\d[\d.,]*\s*[%KMBTkmbt]?`;
const VALUE_RE = new RegExp(`^\\s*${NUM}\\s*$`);
const LABELS: [RegExp, string][] = [
  [/(actual|act\.?|الفعلي|فعلي)/i, "actual"],
  [/(forecast|fcst\.?|consensus|cons\.?|exp\.?|expected|المتوقع|متوقع|التوقع)/i, "forecast"],
  [/(previous|prev\.?|prior|السابق|سابق)/i, "previous"],
];
const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b|(الإثنين|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت|الأحد)/gi;
const MONTHS = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b|(يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)/gi;

const cx = (l: Layer) => l.x + l.w / 2, cy = (l: Layer) => l.y + l.h / 2;
const inside = (outer: Layer, x: number, y: number) => x >= outer.x && x <= outer.x + outer.w && y >= outer.y && y <= outer.y + outer.h;
const isSymbolRun = (t: string) => { const s = [...t.trim()]; return s.length > 0 && s.length <= 5 && !/[\p{L}\p{N}]/u.test(s[0]) && s.every((c) => c === s[0] || /[☆○◇□△✧·]/u.test(c)); };

/** "Actual 0.4% · Forecast 0.3%" → "Actual {actual} · Forecast {forecast}" */
function valueTemplate(text: string): string | null {
  if (VALUE_RE.test(text)) return "{value}";
  let t = text, hit = false;
  for (const [label, ph] of LABELS) {
    t = t.replace(new RegExp(`(${label.source})(\\s*:?\\s*)(${NUM})`, "i"), (_m, a, _b, s) => { hit = true; return `${a}${s}{${ph}}`; });
  }
  return hit ? t : null;
}

const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
/** Day, week range and time zone inside any text ("GMT+4\nOct 21-Oct 25") → template, or null */
function textTemplate(text: string): string | null {
  let t = text, hit = false;
  const range = new RegExp(`\\b(${MON})(\\s*)(\\d{1,2})(\\s*[-–—]\\s*)(?:(${MON})(\\s*))?(\\d{1,2})\\b(,?\\s*(?:19|20)\\d{2}\\b)?`, "i");
  t = t.replace(range, (_m, _m1, _a, s1, _d1, sep, m2, _b, s2, _d2, yr) => { hit = true; return `{weekStartMon}${s1}{weekStartDay}${sep}${m2 ? `{weekEndMon}${s2}` : ""}{weekEndDay}${yr ? yr.replace(/(19|20)\d{2}/, "{year}") : ""}`; });
  t = t.replace(/\b(GMT|UTC)\s*[+-]\s*\d{1,2}(:\d{2})?\b/i, () => { hit = true; return "{tz}"; });
  if (!hit) { const d = dateTemplate(text); return d && !/[-–—]/.test(text) ? d : null; }
  return t;
}

/** "Tuesday, 20 October 2026" → "{weekday}, {day} {month} {year}" */
function dateTemplate(text: string): string | null {
  const wd = text.match(WEEKDAYS), mo = text.match(MONTHS), num = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(text);
  if (!mo && !num && !wd) return null;
  if (num) return text.replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/, "{day} {month} {year}");
  // a short name stays short: "Mon, Oct 19" → "{wd}, {mon} {day}" (the full names are longer and could wrap)
  const short = (m: string) => /^[a-z]{3,4}\.?$/i.test(m);
  let t = text.replace(WEEKDAYS, (m) => (short(m) ? "{wd}" : "{weekday}")).replace(MONTHS, (m) => (short(m) && !/^may$/i.test(m) ? "{mon}" : "{month}")).replace(/\b(19|20)\d{2}\b|[١٢][٠-٩]{3}/, "{year}");
  t = t.replace(/(^|[^\d{])(\d{1,2}|[٠-٩]{1,2})(?=[^\d}]|$)/, "$1{day}");
  return /\{(month|weekday|mon|wd)\}/.test(t) ? t : null;
}

const LINE_RE = /^\s*([•·\-–*▪◦])?\s*.+?\s*[-–—|:]\s*\d{1,2}[:.]\d{2}/;
/** Full English names of the calendar's countries ("United States", "Euro Area"), longest first */
const REGION = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRY_NAMES = ["US", "EU", "GB", "JP", "CN", "CA", "AU", "NZ", "CH", "DE", "FR", "IT", "ES"]
  .flatMap((c) => (c === "EU" ? ["Euro Area", "Eurozone", "European Union"] : c === "GB" ? ["United Kingdom", "Great Britain"] : c === "US" ? ["United States"] : [REGION.of(c) || c]))
  .sort((a, b) => b.length - a.length);
/** "🇺🇸 United States" → "{flag} {countryName}"; "🇺🇸 US" → "{flag} {country}"; "USD" → "{currency}" */
export function countryTemplate(text: string) {
  const t = text.replace(/(\p{Regional_Indicator}{2})/u, "{flag}");
  const name = COUNTRY_NAMES.find((n) => new RegExp(`(^|[^\\p{L}])${n}(?![\\p{L}])`, "u").test(t));
  if (name) return t.replace(name, "{countryName}");
  return t.replace(/\b([A-Z]{2,3})\b(?!.*\b[A-Z]{2,3}\b)/, (m) => (m.length === 3 ? "{currency}" : "{country}"));
}

/** Weekly layouts: day headings, then (country) headings, then multi-line event lists */
function weekHeuristic(texts: Layer[], vis: Layer[], w: number, h: number): Omit<Mapping, "engine"> | null {
  const lists = texts.filter((l) => { const lines = l.text!.split("\n").filter((x) => x.trim()); return lines.length >= 1 && lines.filter((x) => LINE_RE.test(x)).length >= Math.max(1, lines.length * 0.6); }).sort((a, b) => a.y - b.y);
  // two lists, or one list of at least two event lines (a single day with one country)
  if (!lists.length || (lists.length < 2 && lists[0].text!.split("\n").filter((x) => LINE_RE.test(x)).length < 2)) return null;
  const list = lists[0], line = list.text!.split("\n").find((x) => LINE_RE.test(x))!;
  const lineTemplate = line.replace(/\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?/i, "{time}").replace(/\b(GMT|UTC)\s*[+-]\s*\d{1,2}(:\d{2})?\b/i, "{tz}").replace(/^(\s*[•·\-–*▪◦]?\s*)(.+?)(\s*[-–—|:]\s*\{time\})/, "$1{event}$3");
  if (!lineTemplate.includes("{event}")) return null;
  const above = (l: Layer, pool: Layer[]) => pool.filter((o) => o.y + o.h <= l.y + 2 && o.y > l.y - 80).sort((a, b) => b.y - a.y)[0];
  const sameCol = (a: Layer, b: Layer) => Math.abs(a.x - b.x) < 60;
  const heads = texts.filter((t) => !lists.includes(t) && t.text!.length < 24 && lists.some((l) => sameCol(t, l) && above(l, [t]) === t));
  const days = texts.filter((t) => !lists.includes(t) && !heads.includes(t) && dateTemplate(t.text!) && !/[-–—]/.test(t.text!) && sameCol(t, list) && t.y < list.y + h).sort((a, b) => a.y - b.y);
  if (!days.length) return null;
  const day0 = days[0], gh = heads.filter((t) => t.y > day0.y).sort((a, b) => a.y - b.y)[0] || null;
  const bars = vis.filter((s) => s.type !== "text" && days.some((d) => d.x >= s.x - 2 && d.x + Math.min(d.w, 200) <= s.x + s.w + 2 && d.y >= s.y - 2 && d.y + d.h <= s.y + s.h + 2 && s.h < 120));
  const container = vis.filter((s) => s.type !== "text" && !s.locked && s.x <= list.x && s.y <= day0.y && s.x + s.w >= list.x + list.w && s.y + s.h >= list.y + list.h && s.h > h * 0.15).sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
  const groupTpl = gh ? countryTemplate(gh.text!) : null;
  const slot = [...days, ...heads.filter((t) => t.y > day0.y), ...lists, ...bars].map((l) => l.id);
  return {
    isCalendar: true, layout: "week",
    reason: days.length >= 2 ? `Weekly layout: ${days.length} day blocks with ${lists.length} event lists. Rebuilt from the first day with live events.` : `Daily layout: one day with ${lists.length} event list${lists.length === 1 ? "" : "s"}, grouped by country. Rebuilt with that day's live events.`,
    week: { period: days.length >= 2 ? "week" : "day", groupFlag: null, container: container?.id ?? null, dayBar: bars.find((b) => day0.y >= b.y - 2 && day0.y + day0.h <= b.y + b.h + 2)?.id ?? null, dayHeader: { layerId: day0.id, template: dateTemplate(day0.text!)! }, groupHeader: gh && groupTpl && /\{(flag|country|countryName|currency)\}/.test(groupTpl) ? { layerId: gh.id, template: groupTpl } : null, list: { layerId: list.id, lineTemplate }, slotLayerIds: slot },
    rows: [], date: null, tz: null, impactSymbol: null, texts: [], needs: { impact: "notNeeded", note: "" },
  };
}

export function heuristic(layers: Layer[], w: number, h: number): Omit<Mapping, "engine"> {
  const vis = layers.filter((l) => !l.hidden);
  const texts = vis.filter((l) => l.type === "text" && (l.text || "").trim());
  const wk = weekHeuristic(texts, vis, w, h);
  if (wk) {
    const slot = new Set(wk.week!.slotLayerIds);
    wk.texts = texts.filter((l) => !slot.has(l.id)).map((l) => {
      const t = l.text!, tpl = textTemplate(t), web = /(https?:\/\/|www\.|\.[a-z]{2,4}\b|@\w)/i.test(t);
      return { layerId: l.id, kind: (web ? "website" : tpl ? "date" : (l.size || 0) >= 56 ? "title" : "label") as "website" | "date" | "title" | "label", template: tpl, translate: !web && /[\p{L}]{2,}/u.test(t.replace(/\b(GMT|UTC)\b|\b[A-Z]{3}\b/g, "")) };
    });
    return wk;
  }
  const times = texts.filter((l) => TIME_RE.test(l.text!)).sort((a, b) => cy(a) - cy(b));
  if (times.length < 2) return { isCalendar: false, layout: "rows", week: null, reason: "No calendar rows found: a calendar needs at least two times like 13:30.", date: null, tz: null, impactSymbol: null, rows: [], texts: [], needs: { impact: "notNeeded", note: "" } };

  // each time anchors a row; a text belongs to the row whose band contains its centre
  const bands = times.map((t, i) => {
    const prev = times[i - 1], next = times[i + 1], gap = Math.min(prev ? cy(t) - cy(prev) : Infinity, next ? cy(next) - cy(t) : Infinity);
    const half = Number.isFinite(gap) ? gap / 2 : t.h * 1.5;
    return { time: t, lo: cy(t) - half, hi: cy(t) + half };
  });
  const used = new Set<string>(times.map((t) => t.id));
  let impactSymbol: string | null = null;
  const rows = bands.map(({ time, lo, hi }) => {
    const fields: Mapping["rows"][number]["fields"] = [{ layerId: time.id, role: "time", template: "{time}" }];
    const mine = texts.filter((l) => !used.has(l.id) && cy(l) >= lo && cy(l) < hi);
    const rest: Layer[] = [];
    for (const l of mine) {
      const t = l.text!.trim();
      if (CUR_RE.test(t)) fields.push({ layerId: l.id, role: "currency", template: "{currency}" });
      else if (isSymbolRun(t)) {
        // two ratings on top of each other: the one behind is the empty "track", it stays as designed
        const front = mine.filter((o) => o !== l && isSymbolRun(o.text!) && Math.abs(o.x - l.x) < l.w * 0.5 && vis.indexOf(o) > vis.indexOf(l));
        if (!front.length) { impactSymbol = impactSymbol || [...t][0]; fields.push({ layerId: l.id, role: "impact", template: "{impact}" }); }
      }
      else if (WORD_IMPACT_RE.test(t)) fields.push({ layerId: l.id, role: "impact", template: "{impact}" });
      else rest.push(l);
      used.add(l.id);
    }
    // the longest wording is the event name; texts with figures become value templates
    const valued = rest.map((l) => ({ l, tpl: valueTemplate(l.text!) }));
    const words = valued.filter((v) => !v.tpl).sort((a, b) => b.l.text!.length - a.l.text!.length);
    if (words[0]) fields.push({ layerId: words[0].l.id, role: "event", template: "{event}" });
    valued.filter((v) => v.tpl).forEach((v) => fields.push({ layerId: v.l.id, role: v.tpl === "{value}" ? "value" : "actual", template: v.tpl! }));
    // shapes behind the row (card, currency badge, dividers)
    const shapes = vis.filter((s) => s.type !== "text" && !(s.locked && s.w >= w * 0.98 && s.h >= h * 0.98) && cy(s) >= lo && cy(s) < hi && s.h <= (hi - lo) * 1.6);
    // a small, roughly square picture in the row is its country flag
    const flag = shapes.find((s) => s.type === "image" && s.w <= (hi - lo) * 1.2 && Math.abs(s.w - s.h) <= Math.max(s.w, s.h) * 0.35 && s.x < (time.x + w) / 2);
    if (flag) fields.push({ layerId: flag.id, role: "flag", template: "{flag}" });
    return { layerIds: [...mine.map((l) => l.id), time.id, ...shapes.map((s) => s.id)], fields };
  });

  const dateLayer = texts.filter((l) => !used.has(l.id) && dateTemplate(l.text!) && !/[-–—]/.test(l.text!)).sort((a, b) => Math.abs(cy(a) - cy(times[0])) - Math.abs(cy(b) - cy(times[0])))[0];
  const TZ_RE = /\b(GMT|UTC)\s*[+-]\s*\d{1,2}(:\d{2})?\b|\b(GMT|UTC)\b/i;
  const tzLayer = texts.find((l) => !used.has(l.id) && l !== dateLayer && TZ_RE.test(l.text!) && l.text!.length < 40);
  const kinds = new Set(rows.flatMap((r) => r.fields.map((f) => f.role)));
  // every other text: what it is, whether it changes (day, week, time zone) and whether to translate it
  const inRows = new Set(rows.flatMap((r) => r.layerIds));
  const others = texts.filter((l) => !inRows.has(l.id) && !used.has(l.id));
  const textEntries = others.map((l) => {
    const t = l.text!, tpl = textTemplate(t), web = /(https?:\/\/|www\.|\.[a-z]{2,4}\b|@\w)/i.test(t);
    const kind = web ? "website" : tpl ? "date" : (l.size || 0) >= 56 ? "title" : "label";
    return { layerId: l.id, kind: kind as "website" | "date" | "title" | "label", template: tpl, translate: !web && /[\p{L}]{2,}/u.test(t.replace(/\b(GMT|UTC)\b|\b[A-Z]{3}\b/g, "")) };
  });
  const hasImpact = rows.some((r) => r.fields.some((f) => f.role === "impact"));
  const pics = vis.filter((l) => l.type === "image" && !rows.some((r) => r.fields.some((f) => f.layerId === l.id)) && l.w < w * 0.3 && l.x > w * 0.5);
  return {
    layout: "rows", week: null,
    texts: textEntries.filter((e) => e.layerId !== dateLayer?.id && e.layerId !== tzLayer?.id || e.template),
    needs: { impact: hasImpact ? "ok" : pics.length >= rows.length ? "convertPictures" : "notNeeded", note: "" },
    isCalendar: true,
    reason: `${rows.length} rows found: ${[...kinds].join(", ")}.`,
    date: dateLayer ? { layerId: dateLayer.id, template: dateTemplate(dateLayer.text!)! } : null,
    tz: tzLayer ? { layerId: tzLayer.id, template: tzLayer.text!.replace(TZ_RE, "{tz}") } : null,
    impactSymbol,
    rows,
  };
}

/* ---------------- Claude engine ---------------- */

export const ANALYZE_MODEL = "claude-opus-5-5";

const SYSTEM = `You analyse social media slides for a design studio and find economic calendar tables in them.

You get the slide's layers as JSON (id, type, name, text, position and size in pixels, font size and colour) and usually a picture of the slide. Text layers can be edited; shapes are backgrounds, cards, badges and dividers.

Decide whether the slide shows a list of economic calendar events (release times, currencies or countries, indicator names, actual/forecast/previous values, impact), and which layout it uses:
- "rows": one row (card or line) per event, with separate text layers for its parts. Describe "rows" below; "week" is null.
- "week": blocks per day (a day heading, often on a bar), each with one or more groups (usually a country heading) whose events are written as lines inside one text layer, e.g. "• US Housing Starts – 13:30 GMT+4". Return "week" built from the FIRST day and FIRST group (the studio rebuilds every day and group from them with live data, keeping their style and spacing) and leave "rows" empty: give the day heading template, the group heading template ({flag} is a flag emoji, {country} a country code), ONE line template for the events list, the container panel and the first day bar, the flag picture next to the first group heading ("groupFlag", when the flag is a separate picture), every layer of the day blocks in "slotLayerIds", and "period": "day" when the slide shows a single day (one day heading, even with several country groups), "week" when it shows several days or a Monday-Friday range.
For "rows", describe every row, top to bottom:
- "fields": each text layer of the row that shows data, with its role and a template. The template is the layer's exact text with the data replaced by placeholders: {time} {currency} {country} (code) {countryName} (full name) {event} {actual} {forecast} {previous} {value} {impact}. A country flag picture in the row is a field too: role "flag", template "{flag}". Keep labels, punctuation and separators exactly as written, e.g. "Actual 0.4% · Forecast 0.3%" becomes "Actual {actual} · Forecast {forecast}". Use {value} for a lone figure without a label. A time like 13:30 is "{time}"; a currency code is "{currency}"; stars or dots showing impact are "{impact}".
- "layerIds": every layer that belongs to the row, including its background card, badges and dividers, so the row can be hidden when there are fewer events than rows.
Text that stays the same on every post (titles, headings, column headers, brand name, website, legal notes) is not a field. When a rating is drawn twice on top of itself (all symbols in a faint colour behind, the filled ones in front), only the front layer is the impact field.

If one text layer shows only the calendar's day, return it as "date" with a template using {weekday} {day} {month} {year} ({wd} and {mon} where the design writes short names like "Mon" or "Oct"), keeping the original order and separators. If a text layer is only the time zone (e.g. "GMT+4"), return it as "tz" with {tz}. Set "impactSymbol" to the repeated character used for impact (e.g. ★), or null.

Then list every other text layer in "texts" and decide, for each, what the template needs:
- Texts that show the post's day, its week or the time zone get a template, even when they hold several parts, e.g. "GMT+4\nOct 21-Oct 25" becomes "{tz}\n{weekStartMon} {weekStartDay}-{weekEndMon} {weekEndDay}" and "Monday, 21 October" becomes "{weekday}, {day} {month}". The week is Monday to Friday of the post's day. {mon} and {wd} are short names ("Oct", "Mon").
- Texts that never change (titles, headings, labels, brand, website, legal) have template null.
- "translate" is true for words a reader of another language needs (titles, labels such as "HIGH IMPACT"); false for brand names, websites, handles and codes.
Finally fill "needs": whether impact is already a text field, is drawn with pictures that should become editable stars, should be added because every row clearly has room for a rating, or isn't part of this design; and one short note on anything else missing (or "").

Only use layer ids from the input. If the slide is not a calendar, return isCalendar false with no rows. "reason" is one short sentence for the designer.`;

function compactLayers(layers: Layer[]) {
  return layers.filter((l) => !l.hidden).map((l) => ({
    id: l.id, type: l.type, ...(l.name ? { name: l.name } : {}), ...(l.type === "text" ? { text: (l.text || "").slice(0, 300) } : {}),
    x: Math.round(l.x), y: Math.round(l.y), w: Math.round(l.w), h: Math.round(l.h),
    ...(l.size ? { size: l.size } : {}), ...(l.weight ? { weight: l.weight } : {}), ...(l.color ? { color: l.color } : {}),
  }));
}

/** Claude's reading of the slide. Throws when the request fails, so the caller can fall back. */
export async function analyzeWithClaude(apiKey: string, input: { layers: Layer[]; w: number; h: number; image?: string }) {
  const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 });
  const img = input.image && /^data:image\/(png|jpeg|webp);base64,/.exec(input.image);
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (img) content.push({ type: "image", source: { type: "base64", media_type: `image/${img[1]}` as "image/png" | "image/jpeg" | "image/webp", data: input.image!.slice(img[0].length) } });
  content.push({ type: "text", text: `Canvas: ${input.w}×${input.h} px.\nLayers (bottom to top):\n${JSON.stringify(compactLayers(input.layers))}` });

  const res = await client.beta.messages.create({
    model: ANALYZE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: zodOutputFormat(MappingSchema) },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  });
  trackClaude("Calendar slides", res.model, res.usage);
  if (res.stop_reason === "refusal") throw new Error("Claude declined to analyse this slide");
  if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off");
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const parsed = MappingSchema.parse(JSON.parse(text));
  return { mapping: sanitize(parsed, input.layers), model: res.model };
}

/* ---------------- importing a picture as editable layers ---------------- */

/** Fonts the studio ships; Claude picks the closest one */
export const STUDIO_FONTS = ["Inter", "Plus Jakarta Sans", "Poppins", "Montserrat", "DM Sans", "Space Grotesk", "Playfair Display", "Cairo", "Tajawal"] as const;

const ImportSchema = z.object({
  background: z.string().describe("CSS background of the whole design: a hex colour or a CSS linear-/radial-gradient matching the picture"),
  layers: z.array(z.object({
    kind: z.enum(["text", "rect", "ellipse", "image"]).describe("text: any readable text; rect/ellipse: flat or gradient shapes (cards, badges, pills, dividers, buttons); image: photos, illustrations, logos, icons, charts or anything that can't be drawn as a flat shape - it is cropped from the picture"),
    name: z.string().describe("Short layer name, e.g. 'Title', 'Row 2 card', 'USD badge', 'Logo'"),
    x: z.number(), y: z.number(), w: z.number(), h: z.number(),
    text: z.string().nullable().describe("For text: the exact text, with \\n between lines exactly as wrapped in the picture"),
    font: z.enum(STUDIO_FONTS).nullable(),
    size: z.number().nullable().describe("Font size in picture pixels (cap height ≈ 0.7 × size)"),
    weight: z.number().nullable().describe("400, 500, 600, 700 or 800"),
    color: z.string().nullable().describe("Text colour, hex"),
    align: z.enum(["left", "center", "right"]).nullable(),
    letterSpacing: z.number().nullable().describe("Extra spacing between letters in px, e.g. 4 for spaced capitals, else 0"),
    fill: z.string().nullable().describe("Shape fill: hex, rgba(...) or a CSS gradient"),
    radius: z.number().nullable().describe("Corner radius in px"),
    stroke: z.string().nullable().describe("Border colour, or null"),
  })).describe("Every element, from back to front (backgrounds first, text last)"),
});
export type ImportedDesign = z.infer<typeof ImportSchema>;

const IMPORT_SYSTEM = `You turn a picture of a social media design into editable layers for a design studio, so it can be edited and reused as a template. Reproduce the design as faithfully as possible.

Coordinates are in pixels of the picture you receive (origin top-left). For every element give a tight bounding box.
- Text: one layer per text block that shares one style; keep the exact wording and line breaks. Estimate font size from the glyph height, the weight, colour, alignment and letter spacing, and pick the closest font from the list (Arabic text: Cairo or Tajawal).
- Shapes: cards, rows, badges, pills, buttons, dividers and flat decorative blobs as rect or ellipse with their colour (use rgba for translucent cards over a background, CSS gradients where you see them) and corner radius.
- Images: photos, people, logos, flags, charts and textured or 3D artwork as kind "image": the studio crops that area from the picture, so draw its box tightly around the element alone, and give round ones (circular flags, avatars) a radius of half their width. Never let an image box cover text or rows: everything inside it is copied as pixels and would show behind the new layers.
- Soft glows, blurred light and colour washes are not images: draw them as rect or ellipse layers with a CSS radial-gradient or linear-gradient fill (with transparency) at the right place, or include them in the background gradient.
- Star or dot ratings: two text layers at exactly the same box and style: first (behind) all the symbols in the empty colour, then (in front) only the filled symbols in the filled colour, e.g. "★★★" dark and "★★" green. Use the ★ character for stars.
- Background: the design's base colour or gradient; don't add it as a layer.
Order layers back to front. Don't skip small texts such as dates, footers, website addresses or star ratings.`;

/** Claude's rebuild of a picture. Throws when the request fails. */
export async function importWithClaude(apiKey: string, input: { image: string; imgW: number; imgH: number }) {
  const m = /^data:image\/(png|jpeg|webp);base64,/.exec(input.image);
  if (!m) throw new Error("Expected a PNG, JPEG or WebP image");
  const client = new Anthropic({ apiKey, timeout: 300_000, maxRetries: 1 });
  // long structured answers: stream, then read the final message
  const stream = client.beta.messages.stream({
    model: ANALYZE_MODEL,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: zodOutputFormat(ImportSchema) },
    system: [{ type: "text", text: IMPORT_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: `image/${m[1]}` as "image/png" | "image/jpeg" | "image/webp", data: input.image.slice(m[0].length) } },
      { type: "text", text: `The picture is ${input.imgW}×${input.imgH} px. Rebuild it as layers.` },
    ] }],
  });
  const res = await stream.finalMessage();
  trackClaude("Picture import", res.model, res.usage);
  if (res.stop_reason === "refusal") throw new Error("Claude declined to read this picture");
  if (res.stop_reason === "max_tokens") throw new Error("The design is too detailed to rebuild in one pass");
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const design = ImportSchema.parse(JSON.parse(text));
  // keep boxes inside the picture
  const cl = (v: number, max: number) => Math.max(0, Math.min(max, Number.isFinite(v) ? v : 0));
  design.layers = design.layers
    .map((l) => ({ ...l, x: cl(l.x, input.imgW), y: cl(l.y, input.imgH), w: cl(l.w, input.imgW), h: cl(l.h, input.imgH) }))
    .filter((l) => l.w > 1 && l.h > 1 && (l.kind !== "text" || (l.text || "").trim()));
  return { design, model: res.model };
}

/* ---------------- reading a rating picture (stars drawn as an image) ---------------- */

const RatingSchema = z.object({
  isRating: z.boolean().describe("true when the picture is a row of rating symbols (stars, dots, bars, flames…)"),
  symbol: z.string().describe("The single Unicode character closest to one symbol, e.g. ★ for stars, ● for dots, ■ for squares, ▮ for bars"),
  total: z.number().describe("How many symbols in the row, filled or not"),
  filled: z.number().describe("How many are filled / highlighted"),
  filledColor: z.string().describe("Hex colour of the filled symbols"),
  emptyColor: z.string().describe("Hex colour of the empty symbols (or a faint version of the filled colour if none are empty)"),
});
export type Rating = z.infer<typeof RatingSchema>;

/** Claude's reading of a rating picture: which symbol, how many, which colours */
export async function ratingWithClaude(apiKey: string, image: string) {
  const m = /^data:image\/(png|jpeg|webp);base64,/.exec(image);
  if (!m) throw new Error("Expected a PNG, JPEG or WebP image");
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  const res = await client.beta.messages.create({
    model: ANALYZE_MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: zodOutputFormat(RatingSchema) },
    system: "You read small pictures cropped from social media designs. Describe the rating symbols in the picture exactly: their kind, how many there are, how many are filled, and their colours.",
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: `image/${m[1]}` as "image/png" | "image/jpeg" | "image/webp", data: image.slice(m[0].length) } },
      { type: "text", text: "Describe this rating." },
    ] }],
  });
  trackClaude("Rating pictures", res.model, res.usage);
  if (res.stop_reason === "refusal") throw new Error("Claude declined to read this picture");
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const r = RatingSchema.parse(JSON.parse(text));
  const hex = (c: string, d: string) => (/^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : d);
  return { ...r, total: Math.max(1, Math.min(10, Math.round(r.total))), filled: Math.max(0, Math.min(10, Math.round(r.filled))), symbol: [...(r.symbol || "★")][0] || "★", filledColor: hex(r.filledColor, "#FFC107"), emptyColor: hex(r.emptyColor, "#444444"), model: res.model };
}

/* ---------------- translating a slide's texts ---------------- */

const TranslateSchema = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string() })).describe("One entry per input text, same ids"),
});

/** Translates the fixed texts and templates of a slide; {placeholders}, line breaks, numbers and brand names stay as they are */
export async function translateWithClaude(apiKey: string, input: { items: { id: string; text: string }[]; to: "ar" | "en"; brand?: string; what?: "slide" | "news" }) {
  const client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
  const lang = input.to === "ar" ? "Arabic (Modern Standard Arabic, the wording financial news in the Gulf uses)" : "English";
  const res = await client.beta.messages.create({
    model: ANALYZE_MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: zodOutputFormat(TranslateSchema) },
    system: input.what === "news"
      ? `You translate financial news headlines and their one-paragraph summaries into ${lang}, for social media posts of a trading brand. Write them the way financial news in the region reads: natural, accurate, the same facts and figures, no additions.
Rules: keep numbers, percentages, currency codes, tickers, company and person names as they are known in ${lang} (or as written when they have no usual form); keep it about as short as the original so it fits the same space. Return one item per input id.`
      : `You translate the texts of an economic calendar social media post into ${lang}. They are short design texts: titles, labels and templates.
Rules: keep every {placeholder} exactly as written (same braces and name) and put it where the grammar of the target language needs it; keep line breaks (\\n) in the same places; keep numbers, currency codes, GMT/UTC, websites, handles${input.brand ? ` and the brand name "${input.brand}"` : ""} unchanged; keep it as short as the original so it fits the same space; use the usual financial terms (Actual, Forecast, Previous, High impact…). Return one item per input id.`,
    messages: [{ role: "user", content: JSON.stringify(input.items) }],
  });
  trackClaude("Translation", res.model, res.usage);
  if (res.stop_reason === "refusal") throw new Error("Claude declined to translate");
  const out = TranslateSchema.parse(JSON.parse(res.content.map((b) => (b.type === "text" ? b.text : "")).join("")));
  const byId = new Map(out.items.map((i) => [i.id, i.text]));
  // a translation that lost a placeholder would break the template: keep the original then
  const phs = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  return { items: input.items.map((i) => { const t = byId.get(i.id); return { id: i.id, text: t && phs(t) === phs(i.text) ? t : i.text, translated: !!t && phs(t) === phs(i.text) }; }), model: res.model };
}
