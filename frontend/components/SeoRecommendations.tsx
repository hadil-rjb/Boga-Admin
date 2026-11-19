"use client";
import { useEffect, useMemo, useState } from "react";
import Icon from "./Icon";
import { useData } from "@/lib/data";
import { queriesFor } from "@/lib/opportunities";
import { usePageQueries } from "@/lib/pageQueries";
import { audit } from "@/lib/seoAudit";
import { fmtN, fmtPos } from "@/lib/seo";
import type { Article } from "@/lib/types";

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } };

/** The editor's on-page recommendations: a target query (by default the page's top Search Console query) and what to improve */
export default function SeoRecommendations({ a, saved }: { a: Article; saved: boolean }) {
  const { articles, gsc } = useData();
  const pq = usePageQueries(28, gsc.connected && saved && !!a.slug);
  const queries = useMemo(() => (pq.data && a.slug ? queriesFor(pq.data.rows, a.slug, 5) : []), [pq.data, a.slug]);
  const [open, setOpen] = useState(() => get("seo-reco-open") !== "0");
  const [typed, setTyped] = useState<string | null>(() => (a.slug ? get("seo-kw:" + a.slug) : null));
  const q = typed ?? queries[0]?.query ?? "";
  useEffect(() => put("seo-reco-open", open ? "1" : "0"), [open]);
  const items = useMemo(() => audit(a, q, articles), [a, q, articles]);
  const done = items.filter((x) => x.ok).length;
  const setQ = (v: string) => { setTyped(v); if (a.slug) put("seo-kw:" + a.slug, v); };
  const id = "seo-reco";

  return (
    <div className="border-b border-border-soft py-3">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-2 text-left">
        <Icon k="checkCircle" size={16} className="text-text-3" />
        <span className="flex-1 text-[13px] font-medium">Recommendations</span>
        <span className={`rounded-6 px-2 py-0.5 text-[11px] font-medium ${done === items.length ? "bg-positive-bg text-positive" : "bg-pill text-text-2"}`}>{done}/{items.length} done</span>
        <Icon k="chevD" size={16} className={`text-text-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div id={id} className="mt-3 flex flex-col gap-3">
          <div>
            <label htmlFor="seo-q" className="text-xs text-text-2">Target search query</label>
            <input id="seo-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. ux audit checklist" maxLength={120}
              className="mt-1 w-full rounded-10 border border-transparent bg-pill px-3 py-2 text-sm text-text-1 outline-0 focus:border-accent disabled:opacity-60" />
            {queries.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-text-3">Real searches, last 28 days:</span>
                {queries.map((r) => (
                  <button key={r.query} type="button" onClick={() => setQ(r.query)} title={`${fmtN(r.impressions)} impressions · position ${fmtPos(r.position)}`}
                    className={`max-w-full cursor-pointer truncate rounded-full border px-2 py-0.5 text-[11px] ${q === r.query ? "border-accent text-accent" : "border-border text-text-2 hover:border-text-3"}`}>{r.query}</button>
                ))}
              </div>
            ) : <p className="mt-1 text-[11px] text-text-3">{gsc.connected && saved ? (pq.loading ? "Loading this page's searches…" : "No Search Console queries for this page yet: type the search you want it to rank for.") : "Type the search you want this article to rank for."}</p>}
          </div>
          <ul className="flex flex-col gap-1">
            {[...items].sort((x, y) => Number(x.ok) - Number(y.ok)).map((x) => (
              <li key={x.id} className="flex gap-2.5 rounded-10 px-2 py-1.5 hover:bg-icon">
                <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${x.ok ? "bg-positive-bg text-positive" : "bg-[rgba(217,154,30,.16)] text-[#b7790f] dark:text-[#e0a83a]"}`}><Icon k={x.ok ? "check" : "alert"} size={11} /></span>
                <div className="min-w-0 flex-1">
                  <p className={`text-[13px] ${x.ok ? "text-text-2" : "text-text-1"}`}>{x.label}<span className="ml-1.5 text-[10px] uppercase tracking-[0.06em] text-text-3">{x.group}</span></p>
                  {!x.ok && <p className="text-xs leading-relaxed text-text-3">{x.tip}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
