import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common";
import { Public } from "../common/public.decorator";
import { Roles } from "../common/roles.decorator";
import { previewPage } from "./preview.page";
import { IngestDto, UpdateChatbotSettingsDto, UpdateWidgetDto } from "./chatbot.dto";
import { ChatbotService } from "./chatbot.service";

const FILES: Record<string, [string, string]> = {
  "conversations.csv": ["/conversations.csv", "chatbot-conversations"],
  "report.pdf": ["/analytics-report.pdf", "chatbot-report"],
};

/** Espace « Chatbot Admin » : relais authentifié vers le serveur RAG */
@Roles("admin", "editor")
@Controller("chatbot")
export class ChatbotController {
  constructor(private s: ChatbotService) {}
  @Get("settings") settings() { return this.s.view(); }
  @Roles("admin") @Put("settings") save(@Body() d: UpdateChatbotSettingsDto) { return this.s.update(d); }
  @Roles("admin") @Put("widget") widget(@Body() d: UpdateWidgetDto) { return this.s.saveWidget(d); }
  @Roles("admin") @Delete("settings") disconnect() { return this.s.disconnect(); }

  /** Aperçu en direct du widget (iframe de Chatbot Settings → Widget). Public : ne contient aucune donnée privée. */
  @Public() @Get("preview") async preview(@Res() res: any) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(previewPage(await this.s.publicUrl()));
  }

  @Get("analytics") analytics() { return this.s.json("/analytics"); }
  @Get("conversations") conversations(@Query("limit") limit?: string) { return this.s.json(`/conversations?limit=${Math.min(Number(limit) || 1000, 1000)}`); }
  @Get("unanswered") unanswered() { return this.s.json("/unanswered"); }
  @Get("leads") leads() { return this.s.json("/leads"); }
  @Get("knowledge") knowledge() { return this.s.json("/knowledge-status"); }
  @Roles("admin") @Post("ingest") @HttpCode(202) ingest(@Body() d: IngestDto) { return this.s.json("/ingest", { method: "POST", body: JSON.stringify(d.startUrl ? { startUrl: d.startUrl } : {}) }); }

  @Get("export/:name") async export(@Param("name") name: string, @Res() res: any) {
    const f = FILES[name];
    if (!f) return res.status(404).json({ message: "Unknown export" });
    const { body, type } = await this.s.file(f[0]);
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `attachment; filename="${f[1]}-${new Date().toISOString().slice(0, 10)}.${name.split(".").pop()}"`);
    res.send(body);
  }
}
