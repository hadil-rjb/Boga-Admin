"use client";
import { useEffect, useMemo, useState } from "react";
import Icon from "./Icon";
import { Cta, IconBtn, PillBtn } from "./ui";
import { api } from "@/lib/api";
import { replaceQuote, type Flag, type Review } from "@/lib/accuracy";
import type { Article } from "@/lib/types";

const KIND: Record<Flag["kind"], string> = { statistic: "Unsourced figure", source: "Unnamed source", absolute: "Absolute claim", outdated: "May be outdated", doubtful: "Doubtful", vague: "Vague" };
const FIX: Record<Flag["fix"], string> = { cite: "Add a source", soften: "Soften", remove: "Remove", check: "Check" };

/** Accuracy review: flags claims that need a source or more care. It never adds sources; suggested softer wordings can be applied, everything else is for the author. */
export default function ArticleReviewDialog({ article, onApply, onClose }: { article: Article; onApply: (html: string, n: number) => void; onClose: () => void }) {
  const [state, setState] = useState<"busy" | "done" | "error">("busy");
  const [err, setErr] = useState("");
  const [res, setRes] = useState<Review | null>(null);
  const [keep, setKeep] = useState<Record<number, boolean>>({});
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); } }; window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true); }, [onClose]);
  const run = async () => {
    setState("busy"); setErr("");
    try { const r = await api<Review>("/ai/review-article", { method: "POST", body: { title: article.title || "Untitled", html: article.html } }); setRes(r); setKeep({}); setState("done"); }
    catch (e: any) { setErr(e.message || "Something went wrong"); setState("error"); }
  };
  useEffect(() => { void run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // which rewrites can go straight into the HTML (the sentence must be plain text in one place)
  const can = useMemo(() => (res?.flags ?? []).map((f) => !!f.rewrite && replaceQuote(article.html, f.quote, f.rewrite) !== null), [res, article.html]);
  const picked = (res?.flags ?? []).map((f, i) => [f, i] as const).filter(([, i]) => keep[i] && can[i]);
  const apply = () => {
    let h = article.html;
    for (const [f] of picked) h = replaceQuote(h, f.quote, f.rewrite!) ?? h;
    onApply(h, picked.length);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="review-title" className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[20px] border border-border bg-surface shadow-[0_24px_64px_rgba(0,0,0,.4)] sm:w-[min(680px,100%)] sm:rounded-[20px]">
        <div className="flex items-start gap-3 border-b border-border-soft px-5 pb-4 pt-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-12 bg-accent/10 text-accent"><Icon k="shield" size={20} /></span>
          <div className="min-w-0 flex-1">
            <h3 id="review-title" className="font-jakarta text-[17px] font-semibold leading-tight">Accuracy review</h3>
            <p className="mt-0.5 truncate text-[13px] text-text-2">{article.title || "Untitled article"}</p>
          </div>
          <IconBtn aria-label="Close" onClick={onClose}><Icon k="x" /></IconBtn>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-5">
          {state === "busy" && (
            <div className="flex flex-col items-center gap-3 py-12 text-center" aria-live="polite">
              <span className="size-8 animate-spin rounded-full border-[3px] border-pill border-t-accent" />
              <p className="text-[13px] text-text-2">Reading the claims in the article…</p>
            </div>
          )}
          {state === "error" && <p className="flex items-start gap-2 rounded-10 bg-negative-bg px-3 py-2 text-xs text-negative"><Icon k="alert" size={15} />{err}</p>}
          {state === "done" && res && (
            <>
              <p className="text-xs leading-relaxed text-text-3">Claims a reader could doubt: figures and research with no source linked, absolutes, and anything that may be wrong or out of date. Nothing is invented: when a claim needs a source, you add it.</p>
              {res.note && <p className="flex items-start gap-2 rounded-10 bg-pill px-3 py-2 text-xs text-text-2"><Icon k="alert" size={15} className="shrink-0 text-[#d99a1e]" /><span>{res.ai ? res.note : <>Only the rule-based checks ran. {res.note}</>}</span></p>}
              {!res.flags.length && <p className="rounded-12 bg-positive-bg px-4 py-3 text-[13px] text-positive">No claim needs attention.</p>}
              <ul className="flex flex-col gap-2">
                {res.flags.map((f, i) => (
                  <li key={i} className={`rounded-12 border px-3.5 py-3 ${keep[i] && can[i] ? "border-accent/50 bg-accent/[.03]" : "border-border-soft"}`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-6 bg-[rgba(217,154,30,.16)] px-[7px] py-0.5 text-[10px] font-medium text-[#b7790f] dark:text-[#e0a83a]">{KIND[f.kind]}</span>
                      <span className="rounded-6 bg-pill px-[7px] py-0.5 text-[10px] font-medium text-text-2">{FIX[f.fix]}</span>
                      {f.by === "rules" && <span className="text-[10px] text-text-3">Rule check</span>}
                    </div>
                    <blockquote className="mt-2 border-l-2 border-border pl-2.5 text-[13px] leading-relaxed text-text-1">{f.quote}</blockquote>
                    <p className="mt-1.5 text-xs leading-relaxed text-text-2">{f.why}</p>
                    {f.rewrite && (
                      <label className={`mt-2 flex items-start gap-2.5 rounded-10 bg-pill px-3 py-2 ${can[i] ? "cursor-pointer" : ""}`}>
                        <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" disabled={!can[i]} checked={!!keep[i] && can[i]} onChange={(e) => setKeep({ ...keep, [i]: e.target.checked })} />
                        <span className="text-xs"><b className="block font-medium text-text-1">Suggested wording</b><span className="text-text-2">{f.rewrite}</span>{!can[i] && <span className="mt-0.5 block text-text-3">This sentence has links or formatting: change it by hand.</span>}</span>
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-soft px-5 py-4 max-[520px]:grid max-[520px]:grid-cols-2">
          {state === "busy" && <PillBtn className="max-[520px]:col-span-2" disabled>Working…</PillBtn>}
          {state === "error" && <><PillBtn onClick={onClose}>Cancel</PillBtn><Cta onClick={run}>Try again</Cta></>}
          {state === "done" && (picked.length || can.some(Boolean)
            ? <><PillBtn onClick={onClose}>Close</PillBtn><Cta onClick={apply} disabled={!picked.length}>{picked.length ? `Apply ${picked.length} rewrite${picked.length === 1 ? "" : "s"}` : "Nothing selected"}</Cta></>
            : <Cta className="max-[520px]:col-span-2" onClick={onClose}>Close</Cta>)}
        </div>
      </div>
    </div>
  );
}
