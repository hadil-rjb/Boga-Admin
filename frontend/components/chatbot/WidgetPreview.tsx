"use client";
import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { Button } from "../ui";
import { apiUrl } from "@/lib/api";
import type { WidgetConfig } from "@/lib/chatbot";

/** Aperçu en direct : la page /chatbot/preview de l'API (faux site + vrai widget du serveur chatbot).
 *  Elle vit sur l'origine de l'API, pas celle de l'admin : le script du widget ne voit pas le jeton de connexion. */
export default function WidgetPreview({ apiUrl: botUrl, config }: { apiUrl: string; config: WidgetConfig }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [dark, setDark] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [n, setN] = useState(0);
  // recharge l'aperçu 600 ms après la dernière modification (pas à chaque touche)
  const [c, setC] = useState(config);
  useEffect(() => { const t = setTimeout(() => setC(config), 600); return () => clearTimeout(t); }, [config]);
  const src = useMemo(() => `${apiUrl("/chatbot/preview")}#${encodeURIComponent(JSON.stringify({ c, dark }))}`, [c, dark]);
  useEffect(() => { setState("loading"); }, [src, n, botUrl]);
  useEffect(() => {
    const from = new URL(apiUrl("/"), location.href).origin;
    const on = (e: MessageEvent) => { if (e.origin !== from) return; const v = e.data?.uxbPreview; if (v === "ready" || v === "error") setState(v); };
    addEventListener("message", on); return () => removeEventListener("message", on);
  }, []);
  const seg = (on: boolean) => `inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-8 px-2.5 text-[13px] font-medium ${on ? "bg-surface text-text-1 shadow-xs" : "text-text-2 hover:text-text-1"}`;

  return (
    <div className="overflow-hidden rounded-16 border border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-soft bg-icon px-3 py-2">
        <div className="flex gap-0.5 rounded-10 bg-pill p-0.5">
          <button className={seg(device === "desktop")} onClick={() => setDevice("desktop")} aria-pressed={device === "desktop"}><Icon k="desktop" size={15} />Desktop</button>
          <button className={seg(device === "mobile")} onClick={() => setDevice("mobile")} aria-pressed={device === "mobile"}><Icon k="mobile" size={15} />Mobile</button>
        </div>
        <div className="flex gap-0.5 rounded-10 bg-pill p-0.5">
          <button className={seg(!dark)} onClick={() => setDark(false)} aria-pressed={!dark} title="Light website" aria-label="Light website"><Icon k="sun" size={15} /></button>
          <button className={seg(dark)} onClick={() => setDark(true)} aria-pressed={dark} title="Dark website" aria-label="Dark website"><Icon k="moon" size={15} /></button>
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-text-3" aria-live="polite">
          <i className={`size-1.5 rounded-full ${state === "ready" ? "bg-positive" : state === "error" ? "bg-negative" : "animate-pulse bg-text-3"}`} />
          {state === "ready" ? "Live · click the bubble to chat" : state === "error" ? "Not loaded" : "Loading…"}
        </span>
        <Button size="icon-sm" variant="ghost" title="Restart preview" aria-label="Restart preview" onClick={() => setN(n + 1)}><Icon k="history" /></Button>
      </div>
      <div className="flex justify-center bg-[repeating-linear-gradient(45deg,var(--pill)_0_10px,transparent_10px_20px)] p-3">
        <iframe key={src + n + botUrl} title="Widget live preview" src={src}
          className={`h-[600px] rounded-12 border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,.12)] transition-[width] duration-300 ${device === "mobile" ? "w-[375px] max-w-full" : "w-full"}`} />
      </div>
      {state === "error" && <p className="flex items-start gap-2 border-t border-border-soft bg-negative-bg px-4 py-3 text-[13px] text-negative"><Icon k="alert" size={16} className="mt-px" />Couldn&apos;t load {botUrl}/widget/uxboga-chat.js. Check that the chatbot server is awake and serves the built widget.</p>}
    </div>
  );
}
