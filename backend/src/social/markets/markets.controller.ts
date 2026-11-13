import { Controller, Get, Query } from "@nestjs/common";
import { MarketsService } from "./markets.service";

/** Live market data for the studio's price alert and news templates */
@Controller("social/markets")
export class MarketsController {
  constructor(private svc: MarketsService) {}

  /** ?symbols=OANDA:XAUUSD,FX_IDC:EURUSD */
  @Get("quotes")
  quotes(@Query("symbols") symbols?: string) {
    return this.svc.quotes(symbols);
  }

  /** ?source=fxstreet|google|cnbc|marketwatch&q=gold&lang=en|ar&limit=12&topics=gold,silver (headlines about one of the topics) */
  @Get("news")
  news(@Query("source") source?: string, @Query("q") q?: string, @Query("lang") lang?: string, @Query("limit") limit?: string, @Query("topics") topics?: string, @Query("translate") translate?: string) {
    return this.svc.news({ source, q, lang, limit, topics, translate });
  }

  /** ?url=https://… → { dataUrl }: a headline photo the slide can embed and export */
  @Get("photo")
  photo(@Query("url") url?: string) {
    return this.svc.photo(url);
  }
}
