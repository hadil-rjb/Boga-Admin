"use client";

import { useEffect } from "react";

/**
 * Headless renderer for the API (backend/src/social/publishing/live-render.service.ts).
 *
 * A live post (economic calendar, price alert, news) scheduled with no studio tab open still has to go
 * out with fresh data: that day's events, the latest price or the latest headlines.
 * The API opens this page in headless Chromium, calls bogaBoot() with the post's brand, design and
 * settings, then bogaRender(): the studio engine itself applies the live data and renders the slides,
 * so the files are identical to what "Schedule" in the studio uploads.
 *
 * The page holds no data and makes no API calls: requests the engine makes go to window.bogaApi,
 * which the API exposes to the page (only live data is answered: calendar events, quotes, news, photos).
 *
 * ?mode=captions (backend/src/footage/export.service.ts): the studio is not booted. The page loads captions.js and the
 * subtitle web fonts, and exposes window.bogaCaptions(lines, style, w, h, times): one transparent PNG data URL per time,
 * drawn by captions.draw exactly as the footage editor's preview draws it.
 */
type Renderer = { renderPost: (designId: string, postId: string) => Promise<{ images: string[]; live: unknown[]; texts?: string[] }> };
type Win = Window & {
  bogaApi?: (path: string) => Promise<unknown>;
  bogaBoot?: (state: unknown) => Promise<boolean>;
  bogaRender?: (designId: string, postId: string) => Promise<{ images: string[]; live: unknown[]; texts?: string[] }>;
  bogaReady?: boolean;
  bogaCaptions?: (lines: unknown[], style: Record<string, unknown> | null, w: number, h: number, times: number[]) => Promise<string[]>;
};

/** Subtitle frames for the footage export: fonts loaded first (the style's font at its pixel size, for the words' characters) */
async function captionsMode(w: Win) {
  const C = await import("@/studio/captions.js");
  const css = new Promise<void>((ok) => {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = C.FONTS_CSS; l.onload = () => ok(); l.onerror = () => ok(); // without the fonts the fallbacks draw
    document.head.append(l);
  });
  w.bogaCaptions = async (lines, style, W, H, times) => {
    await css;
    const st = (style || C.DEFAULT_STYLE) as typeof C.DEFAULT_STYLE;
    const text = (lines as { words?: { t: string }[] }[]).flatMap((l) => (l.words || []).map((x) => x.t)).join(" ");
    const chars = [...new Set(text + text.toUpperCase() + text.toLowerCase())].join("") || "a";
    await document.fonts.load(C.fontOf(st, st.size * H), chars).catch(() => []);
    await document.fonts.ready;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas");
    return times.map((t) => {
      ctx.clearRect(0, 0, W, H);
      C.draw(ctx, lines, st, t, W, H);
      return cv.toDataURL("image/png");
    });
  };
}

/** The only requests the engine makes while rendering: live data */
const LIVE_PATHS = /^\/social\/(calendar\/events|markets\/(quotes|news|photo))\?/;

const persist = {
  readOnly: true,
  init() {},
  load: async () => null,
  onConflict() {},
  save() {},
  watch() {},
  flush: async () => true,
  dispose() {},
  reset: async () => false,
  signOut() {},
};

export default function StudioRenderPage() {
  useEffect(() => {
    const w = window as Win;
    if (new URLSearchParams(location.search).get("mode") === "captions") {
      captionsMode(w).then(() => { w.bogaReady = true; }, (e) => console.error("captions mode", e));
      return;
    }
    w.bogaBoot = async (initialState) => {
      const { bootStudio } = await import("@/studio/engine");
      let renderer: Renderer | null = null;
      const api = async (path: string, o?: { method?: string }) => {
        if ((!o?.method || o.method === "GET") && LIVE_PATHS.test(path) && w.bogaApi) return w.bogaApi(path);
        throw new Error("Not available while rendering");
      };
      bootStudio({
        initialState, persist, user: { name: "Boğa", email: "", role: "viewer" }, blogArticles: null,
        navigate: () => {}, api, headless: (r: Renderer) => { renderer = r; },
      });
      if (!renderer) throw new Error("The studio engine has no headless renderer");
      w.bogaRender = (designId, postId) => renderer!.renderPost(designId, postId);
      return true;
    };
    w.bogaReady = true;
  }, []);

  return (
    <div aria-hidden="true" style={{ position: "fixed", inset: 0, overflow: "hidden", opacity: 0, pointerEvents: "none" }}>
      <div id="shell">
        <div className="scrim" id="scrim" hidden></div>
        <aside className="side" id="side"></aside>
        <div className="main">
          <header className="top" id="top"></header>
          <main id="view"></main>
        </div>
      </div>
      <div id="editor" hidden></div>
      <div id="modal-root"></div>
    </div>
  );
}
