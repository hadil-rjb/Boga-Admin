"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import EmptyState from "../EmptyState";
import { Button, Widget } from "../ui";
import { Pager, Table, TableCard, Td, fieldCls, pageCls } from "../table";
import { useFeedback } from "../feedback";
import { api } from "@/lib/api";
import { useData } from "@/lib/data";
import { since } from "@/lib/seo";
import { BotKnowledge, BotMessage, scoreTone, toGaps, useBot } from "@/lib/chatbot";
import { Chip, ErrorCard, Head, PageSkeleton } from "./shared";

const STEPS = [
  ["search", "Spot the gap", "Questions the assistant couldn't answer from your site."],
  ["penLine", "Publish the answer", "Add it to a page, a case study or a blog article."],
  ["history", "Re-crawl", "The assistant reads the site again and learns it."],
] as const;

export default function Knowledge() {
  const { user } = useData();
  const { toast, ask } = useFeedback();
  const own = user.role === "admin";
  const k = useBot<BotKnowledge>("/chatbot/knowledge");
  const u = useBot<{ items: BotMessage[] }>("/chatbot/unanswered");
  const [url, setUrl] = useState(""), [page, setPage] = useState(1), [q, setQ] = useState("");
  const was = useRef(false);
  const gaps = useMemo(() => toGaps(u.data?.items || []), [u.data]);
  const shown = useMemo(() => gaps.filter((g) => g.question.toLowerCase().includes(q.trim().toLowerCase())), [gaps, q]);
  const running = !!k.data?.ingestionRunning;

  // pendant l'indexation : relit l'état toutes les 4 s et prévient à la fin
  useEffect(() => {
    if (running) { was.current = true; const t = setTimeout(k.reload, 4000); return () => clearTimeout(t); }
    if (was.current) { was.current = false; toast("Knowledge base updated"); }
    // eslint-disable-next-line
  }, [running, k.data]);

  const crawl = async () => {
    const ok = await ask({ t: "Re-crawl the website?", p: "The assistant reads every page again and rebuilds its knowledge. It keeps answering with the current version until it's done (usually 1–3 minutes).", ok: "Start re-crawl" });
    if (!ok) return;
    try { await api("/chatbot/ingest", { method: "POST", body: url.trim() ? { startUrl: url.trim() } : {} }); toast("Re-crawl started"); k.reload(); } catch (e: any) { toast(e.message); }
  };

  if (k.error) return <div className={pageCls}><ErrorCard error={k.error} onRetry={() => { k.reload(); u.reload(); }} /></div>;
  if (!k.data) return <PageSkeleton />;
  const K = k.data;
  const st = running ? { t: "Indexing…", c: "bg-accent/[.08] text-accent", d: "Reading your website. You can leave this page." } : K.empty ? { t: "Empty", c: "bg-negative-bg text-negative", d: "The assistant has nothing to answer from yet. Run a crawl." } : { t: "Ready", c: "bg-positive-bg text-positive", d: "The assistant answers from this content." };
  const size = 10, rows = shown.slice((page - 1) * size, page * size);

  return (
    <div className={pageCls}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4 max-[1000px]:grid-cols-1">
        <Widget>
          <Head icon="database" title="Website knowledge" right={<span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${st.c}`}>{running && <span className="size-1.5 animate-pulse rounded-full bg-current" />}{st.t}</span>} />
          <div className="flex items-end gap-3">
            <b className="font-jakarta text-[34px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{K.vectors.toLocaleString("en")}</b>
            <span className="pb-1 text-[13px] text-text-2">passages indexed</span>
          </div>
          <p className="-mt-2 text-xs text-text-3">{st.d}</p>
          {running && <div className="h-1.5 overflow-hidden rounded-full bg-track"><i className="block h-full w-1/3 animate-[bot-load_1.4s_ease-in-out_infinite] rounded-full bg-accent" /></div>}
          <style>{`@keyframes bot-load{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
          <div className="mt-auto flex flex-col gap-2 border-t border-border-soft pt-4">
            {own ? (
              <>
                <label htmlFor="crawl-url" className="text-[13px] font-medium">Start page <span className="font-normal text-text-3">(optional)</span></label>
                <div className="flex gap-2 max-sm:flex-col">
                  <input id="crawl-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.uxboga.com/" className={`${fieldCls} min-w-0 flex-1`} disabled={running} />
                  <Button variant="primary" onClick={crawl} disabled={running}><Icon k="history" className={running ? "animate-spin" : ""} />{running ? "Re-crawling…" : "Re-crawl site"}</Button>
                </div>
                <p className="text-xs text-text-3">Leave empty to use the site set on the chatbot server.</p>
              </>
            ) : <p className="text-xs text-text-3">Only the workspace owner can re-crawl the website.</p>}
          </div>
        </Widget>
        <Widget>
          <Head icon="sparkles" title="Teach the assistant" sub="It only knows what's published on your website" />
          <ol className="grid flex-1 grid-cols-3 gap-2.5 max-sm:grid-cols-1">
            {STEPS.map(([i, t, d], n) => (
              <li key={t} className="flex flex-col gap-2 rounded-12 bg-icon p-3.5">
                <span className="flex items-center justify-between"><span className="flex size-8 items-center justify-center rounded-8 bg-surface text-text-1 shadow-xs"><Icon k={i} size={16} /></span><span className="text-[11px] font-medium text-text-3">Step {n + 1}</span></span>
                <p className="text-[13px] font-medium">{t}</p>
                <p className="text-xs leading-relaxed text-text-2">{d}</p>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2"><Link href="/articles" className="text-[13px] font-medium text-accent hover:underline">Write a blog article →</Link><span className="text-text-3">·</span><Link href="/portfolio" className="text-[13px] font-medium text-accent hover:underline">Update a case study →</Link></div>
        </Widget>
      </div>

      <TableCard head={<>
        <div className="mr-auto flex items-center gap-2"><Icon k="alert" size={20} className="text-text-2" /><span className="text-base font-medium">Knowledge gaps</span>{gaps.length > 0 && <Chip tone="neg">{gaps.length}</Chip>}</div>
        <div className="relative w-[260px] max-sm:w-full">
          <Icon k="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search questions…" aria-label="Search knowledge gaps" className={`${fieldCls} w-full pl-9`} />
        </div>
      </>}>
        {u.error ? <div className="p-5 text-sm text-negative">{u.error}</div> : !u.data ? <div className="p-5 text-sm text-text-3">Loading…</div> : !shown.length ? (
          <div className="py-6"><EmptyState fill={false} icon={q ? "search" : "check"} tone={q ? "neutral" : "good"} title={q ? "No match" : "No knowledge gaps"} text={q ? undefined : "Every question was answered from your website. Nice."} /></div>
        ) : (
          <>
            <Table>
              <thead><tr>{["Question", "Asked", "Best match", "Last asked", ""].map((h, i) => <th key={i} className={`h-11 bg-icon px-4 text-left text-[11px] font-medium uppercase tracking-[0.05em] text-text-3 first:pl-5 last:pr-5 ${i === 1 || i === 2 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.question} className="hover:bg-icon/50">
                    <Td cls="max-w-[520px]"><span className="line-clamp-2 text-[13px] text-text-1">{g.question}</span></Td>
                    <Td num>{g.count}×</Td>
                    <Td num><span className={`rounded-6 px-1.5 py-0.5 text-[11px] font-medium ${scoreTone(g.best)}`}>{g.best.toFixed(2)}</span></Td>
                    <Td cls="whitespace-nowrap">{since(g.last)}</Td>
                    <Td cls="w-0 whitespace-nowrap text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="icon-sm" variant="ghost" title="Copy question" aria-label="Copy question" onClick={() => navigator.clipboard.writeText(g.question).then(() => toast("Question copied"))}><Icon k="copy" /></Button>
                        <Link href={`/bot/conversations?id=${encodeURIComponent(g.sessions[0])}`} title="Open conversation" aria-label="Open conversation" className="inline-flex size-8 items-center justify-center rounded-10 text-text-2 hover:bg-icon hover:text-text-1"><Icon k="chat" size={16} /></Link>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager total={shown.length} page={page} onPage={setPage} size={size} />
          </>
        )}
      </TableCard>
    </div>
  );
}
