"use client";
import { useEffect, useMemo, useState } from "react";
import Icon from "./Icon";
import { Cta, IconBtn, PillBtn } from "./ui";
import { api } from "@/lib/api";
import type { Article } from "@/lib/types";
import { useData } from "@/lib/data";
import { queriesFor } from "@/lib/opportunities";
import { usePageQueries } from "@/lib/pageQueries";
import { fmtN, fmtPos } from "@/lib/seo";

type Mode = "fix" | "refresh" | "snippet";
const MODES: { k: Mode; t: string; d: string }[] = [
  { k: "fix", t: "Fix SEO checks", d: "Only what fails the 7 checks." },
  { k: "refresh", t: "Refresh for search", d: "Title, meta and content reworked around the queries below." },
  { k: "snippet", t: "Title & meta for clicks", d: "Only the search snippet, to raise the CTR." },
];

type Field = "title" | "meta" | "sub" | "alt" | "t" | "slug" | "html";
type Res = { changes: Partial<Record<Field, string | string[]>>; notes: string[]; issues: Field[]; model?: string };
const LABEL: Record<Field, string> = { title: "Title", meta: "Meta description", sub: "Subtitle", alt: "Image alt text", t: "Tags", slug: "Slug", html: "Content" };
const ISSUE: Record<Field, string> = { title: "Title ≤ 60 chars", meta: "Meta description 120–160 chars", sub: "Subtitle", alt: "Image alt text", t: "3 tags", slug: "Clean slug ≤ 75", html: "600+ words with H2" };
const ORDER: Field[] = ["title", "meta", "sub", "t", "alt", "slug", "html"];
const words = (h: string) => h.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
const show = (v: unknown) => (Array.isArray(v) ? v.filter(Boolean).join(", ") : String(v ?? ""));
const prose = "text-[13px] leading-[1.6] [&_a]:text-accent [&_a]:underline [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:list-disc";

/** "Fix with AI": asks the API for fixes to the article being edited, shows them side by side, and hands back the ones the user keeps (nothing is saved here) */
export default function ArticleFixDialog({ article, onApply, onClose, saved, mode: start, focus }: { article: Article; onApply: (p: Partial<Article>) => void; onClose: () => void; saved?: boolean; mode?: "refresh" | "snippet"; focus?: string }) {
  const { gsc } = useData();
  const pq = usePageQueries(28, gsc.connected && !!saved && !!article.slug);
  const queries = useMemo(() => (pq.data ? queriesFor(pq.data.rows, article.slug) : []), [pq.data, article.slug]);
  const [mode, setMode] = useState<Mode>(start ?? "fix");
  const [main, setMain] = useState(focus ?? "");
  const target = main || queries[0]?.query || "";
  const searchOk = queries.length > 0 || !!focus;
  const m: Mode = searchOk ? mode : "fix";
  const [proof, setProof] = useState(false);
  const [state, setState] = useState<"ask" | "busy" | "done" | "error">("ask");
  const [err, setErr] = useState("");
  const [res, setRes] = useState<Res | null>(null);
  const [keep, setKeep] = useState<Partial<Record<Field, boolean>>>({});
  const [open, setOpen] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); if (state !== "busy") onClose(); } }; window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true); }, [onClose, state]);

  const run = async () => {
    setState("busy"); setErr("");
    try {
      const a = article;
      const r = await api<Res>("/ai/fix-article", { method: "POST", body: { title: a.title, slug: a.slug, meta: a.meta, sub: a.sub, alt: a.alt, img: a.img.startsWith("data:") ? "uploaded" : a.img, cat: a.cat, t: a.t, html: a.html, status: a.status, proofread: m === "fix" && proof, ...(m !== "fix" && { mode: m, focus: target || undefined, queries }) } });
      setRes(r); setKeep(Object.fromEntries(Object.keys(r.changes).map((k) => [k, true]))); setState("done");
    } catch (e: any) { setErr(e.message || "Something went wrong"); setState("error"); }
  };
  const fields = ORDER.filter((k) => res?.changes[k] !== undefined);
  const n = fields.filter((k) => keep[k]).length;
  const apply = () => {
    const p: Partial<Article> = {};
    for (const k of fields) if (keep[k]) (p as any)[k] = res!.changes[k];
    onApply(p);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={(e) => e.target === e.currentTarget && state !== "busy" && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="fix-title" className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[20px] border border-border bg-surface shadow-[0_24px_64px_rgba(0,0,0,.4)] sm:w-[min(680px,100%)] sm:rounded-[20px]">
        <div className="flex items-start gap-3 border-b border-border-soft px-5 pb-4 pt-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-12 bg-accent/10 text-accent"><Icon k="sparkles" size={20} /></span>
          <div className="min-w-0 flex-1">
            <h3 id="fix-title" className="font-jakarta text-[17px] font-semibold leading-tight">{m === "fix" ? "Fix with AI" : "Refresh with AI"}</h3>
            <p className="mt-0.5 truncate text-[13px] text-text-2">{article.title || "Untitled article"}</p>
          </div>
          <IconBtn aria-label="Close" onClick={onClose} disabled={state === "busy"}><Icon k="x" /></IconBtn>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
          {(state === "ask" || state === "error") && (
            <>
              {(searchOk || pq.loading) && (
                <div className="grid grid-cols-3 gap-2 max-[560px]:grid-cols-1" role="radiogroup" aria-label="What to do">
                  {MODES.map((x) => (
                    <button key={x.k} type="button" role="radio" aria-checked={m === x.k} disabled={x.k !== "fix" && !searchOk} onClick={() => setMode(x.k)}
                      className={`cursor-pointer rounded-12 border px-3 py-2.5 text-left transition-colors disabled:cursor-wait disabled:opacity-50 ${m === x.k ? "border-accent bg-accent/[.05]" : "border-border-soft hover:border-text-3"}`}>
                      <b className="block text-[13px] font-medium text-text-1">{x.t}</b><span className="text-[11px] leading-snug text-text-3">{x.d}</span>
                    </button>
                  ))}
                </div>
              )}
              {m === "fix" ? <>
              <p className="text-[13px] leading-relaxed text-text-2">Claude rewrites what fails the SEO checks: a title over 60 characters, a meta description outside 120–160, a missing subtitle, alt text or tags, a messy slug, and content under 600 words or without H2 headings. You review every change before it goes into the editor; nothing is saved until you click Save.</p>
              {start && !pq.loading && !searchOk && <p className="rounded-10 bg-pill px-3 py-2 text-xs text-text-2">Search Console has no queries for this page in the last 28 days, so there is nothing to refresh it for yet.</p>}
              <label className="flex cursor-pointer items-start gap-2.5 rounded-12 border border-border-soft px-3.5 py-3">
                <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={proof} onChange={(e) => setProof(e.target.checked)} />
                <span><b className="block text-[13px] font-medium text-text-1">Also proofread the content</b><span className="text-xs text-text-3">Spelling, grammar and clumsy sentences, keeping your structure, links and voice.</span></span>
              </label>
              {article.status === "Live" && <p className="text-xs text-text-3">This article is Live, so its slug is left as it is.</p>}
              </> : (
                <div className="flex flex-col gap-2">
                  <p className="text-[13px] leading-relaxed text-text-2">{m === "refresh" ? "Claude reworks the title, meta description and content around what people really search to find this page: it keeps every section, fact and link, and adds what the searches below aren't answered by yet." : "Claude rewrites the title and meta description so they match these searches and earn more clicks. The content stays as it is."} Nothing is invented, and you review every change.</p>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">Main query · last 28 days</p>
                  <ul className="flex flex-col gap-1">
                    {(!target || queries.slice(0, 6).some((q) => q.query === target) ? queries.slice(0, 6) : [queries.find((q) => q.query === target) ?? { query: target, clicks: 0, impressions: 0, position: 0 }, ...queries.filter((q) => q.query !== target).slice(0, 5)]).map((q) => (
                      <li key={q.query}><label className={`flex cursor-pointer items-center gap-2.5 rounded-10 border px-3 py-2 text-xs ${target === q.query ? "border-accent/50 bg-accent/[.03]" : "border-border-soft"}`}>
                        <input type="radio" name="fix-q" className="accent-[var(--accent)]" checked={target === q.query} onChange={() => setMain(q.query)} />
                        <span className="min-w-0 flex-1 truncate text-text-1">{q.query}</span>
                        {q.impressions > 0 && <span className="shrink-0 text-text-3">{fmtN(q.impressions)} impr. · pos. {fmtPos(q.position)}</span>}
                      </label></li>
                    ))}
                  </ul>
                  {queries.length > 6 && <p className="text-[11px] text-text-3">The other {queries.length - 6} queries are sent too.</p>}
                </div>
              )}
              {state === "error" && <p className="flex items-start gap-2 rounded-10 bg-negative-bg px-3 py-2 text-xs text-negative"><Icon k="alert" size={15} />{err}</p>}
            </>
          )}

          {state === "busy" && (
            <div className="flex flex-col items-center gap-3 py-12 text-center" aria-live="polite">
              <span className="size-8 animate-spin rounded-full border-[3px] border-pill border-t-accent" />
              <p className="text-[13px] text-text-2">Reading the article and writing fixes…</p>
              <p className="text-xs text-text-3">Longer articles can take up to a minute.</p>
            </div>
          )}

          {state === "done" && res && (
            <>
              {!fields.length && <p className="rounded-12 bg-positive-bg px-4 py-3 text-[13px] text-positive">{res.notes.length ? "No change proposed." : "Nothing to fix: this article passes every check."}</p>}
              {fields.map((k) => {
                const before = (article as any)[k], after = res.changes[k];
                return (
                  <label key={k} className={`flex cursor-pointer gap-3 rounded-12 border px-3.5 py-3 transition-colors ${keep[k] ? "border-accent/50 bg-accent/[.03]" : "border-border-soft"}`}>
                    <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={!!keep[k]} onChange={(e) => setKeep({ ...keep, [k]: e.target.checked })} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">{LABEL[k]}</p>
                      {k === "html" ? (
                        <>
                          <p className="mt-1 text-[13px] text-text-1">{words(String(before))} → <b className="font-semibold">{words(String(after))} words</b>, {(String(after).match(/<h2/g) || []).length} H2 headings</p>
                          <button type="button" onClick={(e) => { e.preventDefault(); setOpen(!open); }} className="mt-1 flex cursor-pointer items-center gap-1 text-xs font-medium text-accent">{open ? "Hide" : "Preview"} the new content<Icon k="chevD" size={14} className={open ? "rotate-180" : ""} /></button>
                          {open && <div className={`mt-2 max-h-[340px] overflow-y-auto rounded-10 bg-pill p-3 text-text-1 ${prose}`} dangerouslySetInnerHTML={{ __html: String(after) }} />}
                        </>
                      ) : (
                        <>
                          {show(before) && <p className="mt-1 break-words text-[13px] text-text-3 line-through decoration-text-3/50">{show(before)}</p>}
                          <p className="mt-1 break-words text-[13px] text-text-1">{show(after)}</p>
                          {(k === "title" || k === "meta") && <p className="mt-1 text-[11px] text-text-3">{show(after).length} characters</p>}
                        </>
                      )}
                    </div>
                  </label>
                );
              })}
              {res.notes.length > 0 && (
                <div className="rounded-12 bg-pill px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">What changed</p>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-text-2">{res.notes.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              )}
              {res.issues.length > 0 && (
                <p className="flex items-start gap-2 text-xs text-text-3"><Icon k="alert" size={15} className="text-[#d99a1e]" />
                  <span>Still to do by hand: {res.issues.map((k) => ISSUE[k]).join(", ")}{res.issues.includes("alt") && !article.img ? " (add a cover image too)" : ""}.</span>
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-soft px-5 py-4 max-[520px]:grid max-[520px]:grid-cols-2">
          {(state === "ask" || state === "error") && <><PillBtn onClick={onClose}>Cancel</PillBtn><Cta onClick={run}><Icon k="sparkles" size={18} />{state === "error" ? "Try again" : m === "fix" ? "Find fixes" : "Propose changes"}</Cta></>}
          {state === "busy" && <PillBtn className="max-[520px]:col-span-2" disabled>Working…</PillBtn>}
          {state === "done" && (fields.length
            ? <><PillBtn onClick={onClose}>Discard</PillBtn><Cta onClick={apply} disabled={!n}>{n ? `Apply ${n} change${n === 1 ? "" : "s"}` : "Nothing selected"}</Cta></>
            : <Cta className="max-[520px]:col-span-2" onClick={onClose}>Close</Cta>)}
        </div>
      </div>
    </div>
  );
}
