"use client";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import ArticleDrawer from "./ArticleDrawer";

type DrawerState = { slug: string | null; date?: string; time?: string } | null;
type ArticleDrawerContextValue = {
  openArticle: (slug: string, date?: string) => void;
  openNewArticle: (date?: string, time?: string) => void;
  closeArticle: () => void;
};

const ArticleDrawerContext = createContext<ArticleDrawerContextValue | null>(null);

export function ArticleDrawerProvider({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const openArticle = useCallback((slug: string, date?: string) => setDrawer({ slug, date }), []);
  const openNewArticle = useCallback((date?: string, time?: string) => setDrawer({ slug: null, date, time }), []);
  const closeArticle = useCallback(() => setDrawer(null), []);
  const value = useMemo(() => ({ openArticle, openNewArticle, closeArticle }), [openArticle, openNewArticle, closeArticle]);

  return (
    <ArticleDrawerContext.Provider value={value}>
      {children}
      {drawer && <ArticleDrawer key={`${drawer.slug || "new"}:${drawer.date || ""}:${drawer.time || ""}`} slug={drawer.slug} date={drawer.date} time={drawer.time} onClose={closeArticle} />}
    </ArticleDrawerContext.Provider>
  );
}

export function useArticleDrawer() {
  const context = useContext(ArticleDrawerContext);
  if (!context) throw new Error("ArticleDrawerProvider manquant");
  return context;
}
