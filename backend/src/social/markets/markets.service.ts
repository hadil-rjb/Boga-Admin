import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import { translateWithClaude } from "../calendar/analyze";
import { news, NEWS_SOURCES, NewsItem, NewsSource, parseTopics, photo, quotes, validSymbol } from "./markets";

@Injectable()
export class MarketsService {
  private log = new Logger("Markets");
  constructor(private ai: AiService) {}
  /** Translations already made: "<lang>|<text>" → text (headlines come back every refresh: they are translated once) */
  private tr = new Map<string, string>();
  async quotes(list?: string) {
    const symbols = [...new Set((list || "").split(",").map((s) => s.trim().toUpperCase()).filter(validSymbol))].slice(0, 10);
    if (!symbols.length) throw new BadRequestException("Give one or more symbols, e.g. OANDA:XAUUSD");
    try {
      return await quotes(symbols);
    } catch (e: any) {
      throw new BadGatewayException(e?.message || "The price sources didn't answer");
    }
  }

  /**
   * Headlines. With translate=ar, the source's English stories (their photos and summaries) come back translated into
   * Arabic by Claude, so an Arabic slide shows the same news as the English one; without a Claude key they stay in
   * English (translated: "none").
   */
  async news(q: { source?: string; q?: string; lang?: string; limit?: string; topics?: string; translate?: string }) {
    const source = (NEWS_SOURCES as readonly string[]).includes(q.source || "") ? (q.source as NewsSource) : "fxstreet";
    const to = q.translate === "ar" ? "ar" : null;
    const lang = to ? "en" : q.lang === "ar" ? "ar" : "en";
    const limit = Math.min(30, Math.max(1, Number(q.limit) || 12));
    let r: Awaited<ReturnType<typeof news>>;
    try {
      r = await news(source, String(q.q || "").trim().slice(0, 120), lang, limit, parseTopics(q.topics));
    } catch (e: any) {
      throw new BadGatewayException(e?.message || "The news feed didn't answer");
    }
    if (!to) return r;
    const translated = await this.translate(r.items, to);
    return { ...r, items: translated.items, translated: translated.engine };
  }

  /** Titles and summaries into `to`, the ones not translated yet in one Claude call; the rest from memory */
  private async translate(items: NewsItem[], to: "ar"): Promise<{ items: NewsItem[]; engine: "claude" | "none" }> {
    const key = (t: string) => `${to}|${t}`;
    const todo: { id: string; text: string }[] = [];
    items.forEach((x, i) => {
      if (x.title && !this.tr.has(key(x.title))) todo.push({ id: `t${i}`, text: x.title.slice(0, 600) });
      if (x.summary && !this.tr.has(key(x.summary))) todo.push({ id: `s${i}`, text: x.summary.slice(0, 600) });
    });
    let engine: "claude" | "none" = "claude";
    if (todo.length) {
      const apiKey = await this.ai.anthropicKey();
      if (!apiKey) engine = "none";
      else {
        try {
          const out = await translateWithClaude(apiKey, { items: todo, to, what: "news" });
          const byId = new Map(out.items.filter((x) => x.translated).map((x) => [x.id, x.text]));
          todo.forEach((t) => { const v = byId.get(t.id); if (v) this.tr.set(key(t.text), v); });
          if (this.tr.size > 3000) this.tr = new Map([...this.tr].slice(-1500)); // oldest out
        } catch (e: any) { this.log.warn(`News translation failed: ${e?.message || e}`); engine = "none"; }
      }
    }
    const tr = (t: string) => (t ? this.tr.get(key(t)) ?? t : t);
    return { items: items.map((x) => ({ ...x, title: tr(x.title), summary: tr(x.summary || "") })), engine };
  }

  async photo(url?: string) {
    if (!url || url.length > 2000) throw new BadRequestException("Give the picture's URL");
    try {
      return { url, dataUrl: await photo(url) };
    } catch (e: any) {
      throw new BadGatewayException(e?.message || "The picture could not be loaded");
    }
  }
}
