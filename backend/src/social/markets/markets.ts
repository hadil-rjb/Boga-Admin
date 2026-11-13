import { createHash } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import sharp from "sharp";
import { cached, fetchJson, UA } from "../calendar/feeds";

/**
 * Market feeds for the studio's live templates, no API key needed:
 * - Prices: TradingView's scanner (forex, metals, crypto, indices, stocks); Binance for crypto pairs
 *   when TradingView doesn't answer.
 * - News: RSS feeds (FXStreet, CNBC, MarketWatch) and Google News, which also covers Arabic.
 * Both are cached in memory so previews and auto-updates don't hammer them.
 */

export type Quote = {
  /** TradingView symbol, e.g. "OANDA:XAUUSD" */
  symbol: string;
  name: string;
  price: number;
  /** Change since the previous close, absolute and in % */
  change: number;
  changePct: number;
  high: number | null;
  low: number | null;
  /** Decimals the market quotes with (EUR/USD 5, gold 2…) */
  decimals: number;
  currency: string;
  source: "tradingview" | "cnbc" | "coinbase" | "binance";
  /** When it was fetched; `stale` when every source failed and this is the last good quote */
  at?: string;
  stale?: boolean;
};

export type NewsItem = {
  id: string;
  title: string;
  summary: string;
  /** Publisher, e.g. "Reuters" */
  source: string;
  url: string;
  image: string | null;
  /** ISO instant */
  at: string;
};

export const NEWS_SOURCES = ["fxstreet", "google", "cnbc", "marketwatch"] as const;
export type NewsSource = (typeof NEWS_SOURCES)[number];

const SYMBOL_RE = /^[A-Z0-9_.]{1,20}:[A-Z0-9_.!&-]{1,30}$/;
export const validSymbol = (s: string) => SYMBOL_RE.test(s);

/* ---------- prices ---------- */
/* TradingView first; it rate-limits busy servers (HTTP 429), so after one it rests for a while and
   CNBC's quote service answers instead (forex, metals, energy, indices, stocks); crypto also comes
   from Coinbase or Binance. When every source fails, the last good quote is served, marked stale. */
const COLUMNS = ["close", "change", "change_abs", "high", "low", "description", "pricescale", "currency"];
const decimalsOf = (scale: unknown) => (typeof scale === "number" && scale > 1 ? Math.round(Math.log10(scale)) : 2);
const LAST_GOOD_MS = 12 * 3600_000;
const lastQuote = new Map<string, Quote>();
let tvRestUntil = 0;

async function tradingView(symbols: string[]): Promise<Quote[]> {
  if (Date.now() < tvRestUntil) throw new Error("resting after a rate limit");
  const json: any = await cached(`tvq:${symbols.join(",")}`, 60_000, async () => {
    const res = await fetch("https://scanner.tradingview.com/global/scan", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json", Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/" },
      body: JSON.stringify({ symbols: { tickers: symbols }, columns: COLUMNS }),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 429 || res.status === 403) tvRestUntil = Date.now() + 2 * 60_000;
    if (!res.ok) throw new Error(`HTTP ${res.status} from scanner.tradingview.com`);
    return res.json();
  });
  if (!Array.isArray(json?.data)) throw new Error("TradingView: unexpected response");
  return json.data
    .filter((r: any) => Array.isArray(r?.d) && typeof r.d[0] === "number")
    .map((r: any): Quote => {
      const [close, pct, abs, high, low, description, scale, currency] = r.d;
      return {
        symbol: r.s, name: String(description || r.s.split(":")[1]), price: close,
        change: typeof abs === "number" ? abs : 0, changePct: typeof pct === "number" ? pct : 0,
        high: typeof high === "number" ? high : null, low: typeof low === "number" ? low : null,
        decimals: decimalsOf(scale), currency: currency || "", source: "tradingview",
      };
    });
}

/** The same market on CNBC: "FX_IDC:EURUSD" → "EUR=", "OANDA:XAUUSD" → "XAU=", "SP:SPX" → ".SPX", "NASDAQ:AAPL" → "AAPL" */
const CNBC_FIXED: Record<string, string> = {
  "TVC:DXY": ".DXY", "TVC:GOLD": "@GC.1", "TVC:SILVER": "@SI.1", "NYMEX:CL1!": "@CL.1", "TVC:USOIL": "@CL.1", "ICEEUR:BRN1!": "@LCO.1", "TVC:UKOIL": "@LCO.1",
  "NYMEX:NG1!": "@NG.1", "COMEX:GC1!": "@GC.1", "COMEX:SI1!": "@SI.1", "SP:SPX": ".SPX", "TVC:SPX": ".SPX", "NASDAQ:NDX": ".NDX", "DJ:DJI": ".DJI", "TVC:DJI": ".DJI",
  "XETR:DAX": ".GDAXI", "TVC:DEU40": ".GDAXI", "TVC:UKX": ".FTSE", "TVC:NI225": ".N225", "TVC:VIX": ".VIX", "TVC:US10Y": "US10Y",
};
function cnbcSymbol(sym: string): string | null {
  if (CNBC_FIXED[sym]) return CNBC_FIXED[sym];
  const [ex, t] = sym.split(":");
  const fx = /^([A-Z]{3})([A-Z]{3})$/.exec(t);
  if (fx && /^(FX|FX_IDC|OANDA|FOREXCOM|FXCM|PEPPERSTONE|ICMARKETS|SAXO|CAPITALCOM)$/.test(ex)) {
    const [, a, b] = fx;
    if (b === "USD") return `${a}=`; // EUR=, GBP=, XAU=, XAG=
    if (a === "USD") return `${b}=`; // JPY=, CHF=, CAD=
    return `${a}${b}=`;
  }
  if (/^(NASDAQ|NYSE|AMEX|NYSEARCA|BATS)$/.test(ex) && /^[A-Z.]{1,6}$/.test(t)) return t;
  const crypto = /^([A-Z]{2,6})(USDT|USD|USDC)$/.exec(t);
  if (crypto) return `${crypto[1]}.CM=`;
  return null;
}
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[,%+\s]/g, "")); return Number.isFinite(n) ? n : null; };
async function cnbc(symbols: string[]): Promise<Quote[]> {
  const map = symbols.map((s) => ({ s, c: cnbcSymbol(s) })).filter((x) => x.c) as { s: string; c: string }[];
  if (!map.length) return [];
  const list = [...new Set(map.map((x) => x.c))].join("|");
  const json: any = await cached(`cnbc:${list}`, 60_000, () => fetchJson(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(list)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`));
  const rows: any[] = [].concat(json?.FormattedQuoteResult?.FormattedQuote || []);
  const by = new Map(rows.map((r) => [r.symbol, r]));
  return map.flatMap(({ s, c }) => {
    const r = by.get(c), price = num(r?.last);
    if (!r || price == null) return [];
    const dec = (String(r.last).split(".")[1] || "").length;
    return [{ symbol: s, name: String(r.name || c), price, change: num(r.change) ?? 0, changePct: num(r.change_pct) ?? 0, high: num(r.high) || null, low: num(r.low) || null, decimals: dec, currency: r.currencyCode || "", source: "cnbc" as const }];
  });
}

const cryptoPair = (sym: string) => /^([A-Z0-9]{2,10})(USDT|USDC|USD)$/.exec(sym.split(":")[1] || "");
/** Crypto from Coinbase (24 h change) */
async function coinbase(symbols: string[]): Promise<Quote[]> {
  const out: Quote[] = [];
  for (const s of symbols) {
    const m = cryptoPair(s); if (!m) continue;
    const r: any = await cached(`cb:${m[1]}`, 60_000, () => fetchJson(`https://api.exchange.coinbase.com/products/${m[1]}-USD/stats`)).catch(() => null);
    const last = num(r?.last), open = num(r?.open);
    if (last == null || open == null) continue;
    out.push({ symbol: s, name: `${m[1]}/USD`, price: last, change: last - open, changePct: open ? ((last - open) / open) * 100 : 0, high: num(r.high), low: num(r.low), decimals: last >= 100 ? 2 : 4, currency: "USD", source: "coinbase" });
  }
  return out;
}
/** Crypto pairs from Binance (blocked in some regions, so last) */
async function binance(symbols: string[]): Promise<Quote[]> {
  const out: Quote[] = [];
  for (const s of symbols) {
    const pair = s.split(":")[1] || "";
    if (!/^[A-Z0-9]{2,12}(USDT|USDC|BTC|ETH|EUR)$/.test(pair)) continue;
    const r: any = await cached(`bn:${pair}`, 60_000, () => fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`)).catch(() => null);
    const price = Number(r?.lastPrice);
    if (!Number.isFinite(price)) continue;
    const dec = String(r.lastPrice).replace(/0+$/, "").split(".")[1]?.length ?? 2;
    out.push({ symbol: s, name: pair, price, change: Number(r.priceChange) || 0, changePct: Number(r.priceChangePercent) || 0, high: Number(r.highPrice) || null, low: Number(r.lowPrice) || null, decimals: Math.min(8, Math.max(2, dec)), currency: pair.replace(/^.*?(USDT|USDC|BTC|ETH|EUR)$/, "$1"), source: "binance" });
  }
  return out;
}
const PROVIDERS: [string, (s: string[]) => Promise<Quote[]>][] = [["tradingview", tradingView], ["cnbc", cnbc], ["coinbase", coinbase], ["binance", binance]];

/** Quotes in the order asked, each from the first source that has it; symbols no source knows are `missing` */
export async function quotes(symbols: string[]) {
  const errors: string[] = [], by = new Map<string, Quote>();
  for (const [name, fn] of PROVIDERS) {
    const left = symbols.filter((s) => !by.has(s));
    if (!left.length) break;
    try { (await fn(left)).forEach((q) => { if (!by.has(q.symbol)) by.set(q.symbol, q); }); } catch (e: any) { errors.push(`${name}: ${e?.message || e}`); }
  }
  const now = Date.now();
  by.forEach((q) => lastQuote.set(q.symbol, { ...q, at: new Date(now).toISOString() }));
  // a source that's down shouldn't blank the slide: the last good quote, marked stale
  symbols.forEach((s) => { const old = lastQuote.get(s); if (!by.has(s) && old && now - Date.parse(old.at!) < LAST_GOOD_MS) by.set(s, { ...old, stale: true }); });
  if (!by.size) throw new Error(`No price source answered${errors.length ? ` (${errors.join("; ")})` : ""}`);
  return { quotes: symbols.map((s) => by.get(s)).filter(Boolean) as Quote[], missing: symbols.filter((s) => !by.has(s)), errors, fetchedAt: new Date(now).toISOString() };
}

/* ---------- news ---------- */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m));
const plain = (s: string) => decode(decode(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (xml: string, name: string) => { const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml); return m ? m[1] : ""; };
const attr = (xml: string, name: string, a: string) => { const m = new RegExp(`<${name}\\b[^>]*\\b${a}="([^"]+)"`, "i").exec(xml); return m ? decode(m[1]) : null; };

function feedUrl(source: NewsSource, q: string, lang: "en" | "ar") {
  if (source === "google" || lang === "ar") {
    const query = encodeURIComponent(q || (lang === "ar" ? "الأسواق المالية OR الذهب OR الدولار" : "forex OR gold OR stocks OR dollar"));
    return lang === "ar" ? `https://news.google.com/rss/search?q=${query}&hl=ar&gl=SA&ceid=SA:ar` : `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  }
  return { fxstreet: "https://www.fxstreet.com/rss/news", cnbc: "https://www.cnbc.com/id/10000664/device/rss/rss.html", marketwatch: "https://feeds.content.dowjones.io/public/rss/mw_topstories" }[source];
}
const PUBLISHER: Record<string, string> = { fxstreet: "FXStreet", cnbc: "CNBC", marketwatch: "MarketWatch" };

function parseRss(xml: string, source: NewsSource): NewsItem[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map((it) => {
    const google = source === "google" || /news\.google\.com/.test(tag(it, "link"));
    const publisher = google ? plain(tag(it, "source")) : PUBLISHER[source] || "";
    let title = plain(tag(it, "title"));
    // Google News titles end with " - Publisher"
    if (google && publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -publisher.length - 3).trim();
    const link = plain(tag(it, "link"));
    const at = new Date(plain(tag(it, "pubDate")) || Date.now());
    return {
      id: "n-" + createHash("md5").update(link || title).digest("hex").slice(0, 12),
      title,
      summary: google ? "" : plain(tag(it, "description")).slice(0, 400),
      source: publisher,
      url: link,
      image: attr(it, "media:content", "url") || attr(it, "media:thumbnail", "url") || attr(it, "enclosure", "url"),
      at: (Number.isNaN(at.getTime()) ? new Date() : at).toISOString(),
    };
  }).filter((n) => n.title);
}

const lastNews = new Map<string, { at: number; items: NewsItem[]; source: NewsSource }>();
async function feed(source: NewsSource, q: string, lang: "en" | "ar") {
  const url = feedUrl(source, q, lang);
  const xml = await cached(`news:${url}`, 5 * 60_000, async () => {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res.text();
  });
  const items = parseRss(xml, source === "google" || lang === "ar" ? "google" : source).sort((a, b) => b.at.localeCompare(a.at));
  if (!items.length) throw new Error(`${new URL(url).host} returned no headlines`);
  return items;
}

/** "gold, silver,Trading" → ["gold", "silver", "trading"]: at most 12 topics of 1 to 40 characters, no duplicates */
export function parseTopics(raw?: string): string[] {
  const out: string[] = [];
  String(raw || "").split(/[,\n]/).map((t) => t.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40)).forEach((t) => { if (t && !out.includes(t)) out.push(t); });
  return out.slice(0, 12);
}
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Does a headline talk about one of the topics? Latin words match whole words (with a plural s: "stock" finds "stocks",
 * "gold" doesn't find "golden"); Arabic and other scripts match anywhere, as their words take prefixes ("الذهب", "بالذهب").
 */
export function aboutTopics(item: { title: string; summary?: string }, topics: string[]) {
  if (!topics.length) return true;
  const text = `${item.title} ${item.summary || ""}`.toLowerCase();
  return topics.some((t) => (/^[\x00-\x7f]+$/.test(t) ? new RegExp(`(^|[^a-z0-9])${escRe(t)}(e?s)?($|[^a-z0-9])`, "i").test(text) : text.includes(t)));
}
/** Google News search for the topics: "gold" OR "silver" … */
const topicQuery = (topics: string[]) => topics.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(" OR ");

/**
 * Latest headlines, newest first. A feed that blocks this server (some answer 403 to data centres)
 * hands over to the other feeds, then Google News; when none answers, the last good headlines are served.
 * With topics, only headlines about them are kept; when the feed has too few, Google News adds stories on them.
 */
export async function news(source: NewsSource, q: string, lang: "en" | "ar", limit: number, topics: string[] = []) {
  const want: NewsSource = source === "google" || lang === "ar" ? "google" : source;
  const order: NewsSource[] = [want, ...(["fxstreet", "cnbc", "marketwatch", "google"] as NewsSource[]).filter((x) => x !== want && lang === "en")];
  if (lang === "ar" && !order.includes("google")) order.push("google");
  const errors: string[] = [], key = `${want}|${q}|${lang}|${topics.join(",")}`;
  // on Google News the topics are the search itself (a typed topic first)
  const gq = [q, topics.length ? topicQuery(topics) : ""].filter(Boolean).join(" OR ");
  for (const src of order) {
    try {
      let items = await feed(src, src === "google" ? gq : "", lang);
      if (topics.length) {
        items = items.filter((x) => aboutTopics(x, topics));
        if (items.length < limit && src !== "google") {
          // few stories on them: the other news feeds first (their stories have photos), then a Google News search
          const seen = new Set(items.map((x) => x.title.toLowerCase())), add = (list: NewsItem[]) => list.filter((x) => {
            const k = x.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true;
          });
          const others = (["fxstreet", "cnbc", "marketwatch"] as NewsSource[]).filter((x) => x !== src);
          const more = await Promise.all(others.map((o) => feed(o, "", lang).then((l) => l.filter((x) => aboutTopics(x, topics))).catch(() => [] as NewsItem[])));
          items = [...items, ...add(more.flat())].sort((a, b) => b.at.localeCompare(a.at));
          if (items.length < limit) items = [...items, ...add(await feed("google", topicQuery(topics), lang).catch(() => [] as NewsItem[]))];
        }
        if (!items.length) throw new Error(`no headlines about ${topics.join(", ")}`);
      }
      items = items.slice(0, limit);
      if (src === want) lastNews.set(key, { at: Date.now(), items, source: src });
      return { items, source: src, requested: want, errors, fetchedAt: new Date().toISOString() };
    } catch (e: any) { errors.push(`${src}: ${e?.message || e}`); }
  }
  const old = lastNews.get(key);
  if (old && Date.now() - old.at < LAST_GOOD_MS) return { items: old.items, source: old.source, requested: want, errors, stale: true, fetchedAt: new Date(old.at).toISOString() };
  throw new Error(`No news feed answered (${errors.join("; ")})`);
}

/* ---------- headline photos ---------- */
/** Addresses a photo URL must never reach (this server, its network, cloud metadata) */
const PRIVATE = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1?$/, /^f[cd]/i, /^fe80/i, /^::ffff:(10|127|169\.254|192\.168)\./i];
async function publicUrl(raw: string) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error("Only public http(s) pictures");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some((a) => PRIVATE.some((r) => r.test(a)))) throw new Error("This picture's address is not public");
  return u;
}
const photos = new Map<string, Promise<string>>();
/**
 * A headline's photo as a data URL (JPEG, at most 1400 px wide). The studio's exporter can't read
 * pictures from news sites (no CORS), so the slide embeds this copy instead.
 */
export function photo(url: string): Promise<string> {
  const hit = photos.get(url);
  if (hit) return hit;
  const p = (async () => {
    let u = await publicUrl(url), res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(u, { headers: { "User-Agent": UA, Accept: "image/*" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const next = res.status >= 300 && res.status < 400 && res.headers.get("location");
      if (!next) break;
      u = await publicUrl(new URL(next, u).href);
    }
    if (!res?.ok) throw new Error(`HTTP ${res?.status} for the picture`);
    if (!/^image\//.test(res.headers.get("content-type") || "")) throw new Error("Not a picture");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 12e6) throw new Error("The picture is too large");
    const out = await sharp(buf).rotate().resize({ width: 1400, withoutEnlargement: true }).flatten({ background: "#0b1220" }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  })();
  photos.set(url, p);
  p.catch(() => photos.delete(url));
  if (photos.size > 60) photos.delete(photos.keys().next().value as string); // a small cache: oldest first
  return p;
}
