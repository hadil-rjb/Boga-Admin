import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common";
import { news, NEWS_SOURCES, NewsSource, parseTopics, photo, quotes, validSymbol } from "./markets";

@Injectable()
export class MarketsService {
  async quotes(list?: string) {
    const symbols = [...new Set((list || "").split(",").map((s) => s.trim().toUpperCase()).filter(validSymbol))].slice(0, 10);
    if (!symbols.length) throw new BadRequestException("Give one or more symbols, e.g. OANDA:XAUUSD");
    try {
      return await quotes(symbols);
    } catch (e: any) {
      throw new BadGatewayException(e?.message || "The price sources didn't answer");
    }
  }

  async news(q: { source?: string; q?: string; lang?: string; limit?: string; topics?: string }) {
    const source = (NEWS_SOURCES as readonly string[]).includes(q.source || "") ? (q.source as NewsSource) : "fxstreet";
    const lang = q.lang === "ar" ? "ar" : "en";
    const limit = Math.min(30, Math.max(1, Number(q.limit) || 12));
    try {
      return await news(source, String(q.q || "").trim().slice(0, 120), lang, limit, parseTopics(q.topics));
    } catch (e: any) {
      throw new BadGatewayException(e?.message || "The news feed didn't answer");
    }
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
