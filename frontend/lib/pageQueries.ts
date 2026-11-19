"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import type { PageQueries } from "./opportunities";

// GET /gsc/page-queries (28 or 90 days), kept for 10 minutes in this tab like the server's own cache
const cache = new Map<number, { at: number; p: Promise<PageQueries> }>();
export function loadPageQueries(days: 28 | 90, fresh = false) {
  const hit = cache.get(days);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.p;
  const p = api<PageQueries>("/gsc/page-queries?days=" + days);
  p.catch(() => cache.delete(days));
  cache.set(days, { at: Date.now(), p });
  return p;
}

export function usePageQueries(days: 28 | 90, enabled = true) {
  const [s, setS] = useState<{ data: PageQueries | null; loading: boolean; error: string }>({ data: null, loading: enabled, error: "" });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) { setS({ data: null, loading: false, error: "" }); return; }
    let off = false;
    setS((x) => ({ ...x, loading: true, error: "" }));
    loadPageQueries(days, n > 0).then((data) => !off && setS({ data, loading: false, error: "" })).catch((e) => !off && setS({ data: null, loading: false, error: e.message }));
    return () => { off = true; };
  }, [days, enabled, n]);
  return { ...s, retry: () => setN((x) => x + 1) };
}
