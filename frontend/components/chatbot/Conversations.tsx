"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Icon from "../Icon";
import EmptyState from "../EmptyState";
import { Button, IconBtn, Tabs } from "../ui";
import { fieldCls, pageCls } from "../table";
import { useFeedback } from "../feedback";
import { since } from "@/lib/seo";
import { BotLead, BotMessage, Thread, downloadExport, fmtMs, langName, pathOf, plain, scoreTone, toThreads, useBot } from "@/lib/chatbot";
import { Chip, ErrorCard, PageSkeleton } from "./shared";

const FILTERS = ["All", "Missed", "Leads"];
const dt = (t: string) => new Date(t).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const short = (id: string) => (id.length > 10 ? id.slice(0, 8) : id);

/** Rendu léger du markdown des réponses (gras, liens, listes) — texte échappé d'abord */
function Md({ text }: { text: string }) {
  const html = useMemo(() => {
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" class="text-accent underline-offset-2 hover:underline">$1</a>')
      .replace(/^\s*[-*•]\s+(.+)$/gm, "<li>$1</li>")
      .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul class="my-1 list-disc space-y-0.5 pl-4">${m}</ul>`)
      .replace(/\n{2,}/g, "<br/><br/>").replace(/\n(?!<)/g, "<br/>");
  }, [text]);
  return <div className="text-[13px] leading-relaxed text-text-1 [&_b]:font-semibold" dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function Conversations() {
  const c = useBot<{ total: number; items: BotMessage[] }>("/chatbot/conversations?limit=1000");
  const l = useBot<{ items: BotLead[] }>("/chatbot/leads");
  const { toast } = useFeedback();
  const router = useRouter(), sp = useSearchParams();
  const [q, setQ] = useState(""), [f, setF] = useState(0);
  const threads = useMemo(() => toThreads(c.data?.items || [], l.data?.items || []), [c.data, l.data]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return threads.filter((t) => (f === 1 ? t.unanswered > 0 : f === 2 ? !!t.lead : true) && (!s || t.messages.some((m) => m.question.toLowerCase().includes(s) || m.answer.toLowerCase().includes(s)) || t.lead?.email.toLowerCase().includes(s)));
  }, [threads, q, f]);
  const id = sp.get("id");
  const cur = threads.find((t) => t.id === id) || null;
  const open = (t: string | null) => router.replace(t ? `/bot/conversations?id=${encodeURIComponent(t)}` : "/bot/conversations", { scroll: false });
  // grand écran : ouvre la plus récente pour ne jamais laisser le panneau vide
  useEffect(() => { if (!id && list.length && window.matchMedia("(min-width: 1024px)").matches) open(list[0].id); /* eslint-disable-next-line */ }, [id, list.length]);
  // ↑ / ↓ pour passer d'une conversation à l'autre
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea") || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
      const i = list.findIndex((t) => t.id === id), n = list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (n) { e.preventDefault(); open(n.id); document.getElementById("t-" + n.id)?.scrollIntoView({ block: "nearest" }); }
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
    // eslint-disable-next-line
  }, [list, id]);

  if (c.error) return <div className={pageCls}><ErrorCard error={c.error} onRetry={c.reload} /></div>;
  if (!c.data) return <PageSkeleton />;
  const counts = [threads.length, threads.filter((t) => t.unanswered).length, threads.filter((t) => t.lead).length];

  return (
    <div className={pageCls}>
      <div className="grid h-[calc(100dvh-132px)] min-h-[520px] grid-cols-[360px_minmax(0,1fr)] overflow-hidden rounded-16 border border-border bg-surface max-[1023px]:h-auto max-[1023px]:min-h-0 max-[1023px]:grid-cols-1">
        {/* Liste */}
        <aside className={`flex min-h-0 flex-col border-r border-border-soft max-[1023px]:border-r-0 ${cur ? "max-[1023px]:hidden" : ""}`}>
          <div className="flex flex-col gap-2.5 border-b border-border-soft p-3">
            <div className="relative">
              <Icon k="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search questions, answers, emails…" aria-label="Search conversations" className={`${fieldCls} w-full pl-9`} />
            </div>
            <Tabs items={FILTERS.map((x, i) => `${x} ${counts[i]}`)} active={f} onChange={setF} />
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5 max-[1023px]:max-h-none" role="listbox" aria-label="Conversations">
            {list.map((t) => {
              const on = t.id === id;
              return (
                <li key={t.id} id={"t-" + t.id} role="option" aria-selected={on}>
                  <button onClick={() => open(t.id)} className={`flex w-full cursor-pointer flex-col gap-1.5 rounded-10 px-3 py-2.5 text-left transition-colors ${on ? "bg-pill" : "hover:bg-icon"}`}>
                    <span className="flex items-center gap-2">
                      <span className={`size-1.5 shrink-0 rounded-full ${t.unanswered ? "bg-negative" : "bg-positive"}`} title={t.unanswered ? `${t.unanswered} unanswered` : "All answered"} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-1">{t.messages[0].question}</span>
                      <span className="shrink-0 text-[11px] text-text-3">{since(t.last)}</span>
                    </span>
                    <span className="line-clamp-1 pl-3.5 text-xs text-text-2">{plain(t.messages[t.messages.length - 1].answer)}</span>
                    <span className="flex flex-wrap items-center gap-1.5 pl-3.5">
                      <Chip>{t.messages.length} {t.messages.length > 1 ? "msgs" : "msg"}</Chip>
                      <Chip>{t.language?.toUpperCase() || "—"}</Chip>
                      {t.lead && <Chip tone="accent"><Icon k="user" size={10} />Lead</Chip>}
                      {t.unanswered > 0 && <Chip tone="neg">{t.unanswered} missed</Chip>}
                    </span>
                  </button>
                </li>
              );
            })}
            {!list.length && <EmptyState icon={q ? "search" : "inbox"} title={q ? "No match" : f === 1 ? "No missed questions" : f === 2 ? "No leads yet" : "No conversations yet"} text={q ? "Try another word, or clear the filter." : f ? undefined : "Conversations appear as soon as visitors use the widget."} />}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t border-border-soft px-3 py-2 text-[11px] text-text-3">
            <span>{list.length} of {threads.length} conversations</span>
            <button onClick={() => downloadExport("conversations.csv").then(() => toast("CSV downloaded"), (e) => toast(e.message))} className="inline-flex cursor-pointer items-center gap-1 rounded-6 px-1.5 py-1 font-medium text-text-2 hover:bg-icon hover:text-text-1"><Icon k="download" size={13} />Export CSV</button>
          </div>
        </aside>

        {/* Détail */}
        <section className={`flex min-h-0 flex-col ${cur ? "" : "max-[1023px]:hidden"}`}>
          {cur ? <Transcript t={cur} onBack={() => open(null)} /> : <EmptyState icon="chat" title="Select a conversation" text="Pick one on the left to read the full exchange, the sources used and the confidence of each answer." />}
        </section>
      </div>
    </div>
  );
}

function Transcript({ t, onBack }: { t: Thread; onBack: () => void }) {
  const { toast } = useFeedback();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.parentElement?.scrollTo({ top: 0 }); }, [t.id]);
  const avg = t.messages.reduce((s, m) => s + m.responseTimeMs, 0) / t.messages.length;
  const copy = (s: string, m: string) => navigator.clipboard.writeText(s).then(() => toast(m));
  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b border-border-soft px-5 py-3.5 max-sm:px-4">
        <IconBtn title="Back to list" onClick={onBack} className="min-[1024px]:hidden"><Icon k="chevL" /></IconBtn>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{t.lead?.name || `Visitor ${short(t.id)}`}</p>
          <p className="text-xs text-text-3">{dt(t.first)} · {langName(t.language)} · avg {fmtMs(avg)}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => copy(t.id, "Session ID copied")} title={t.id}><Icon k="copy" />Session ID</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={end} />
        {t.lead && (
          <div className="mx-5 mt-4 flex flex-wrap items-center gap-3 rounded-12 border border-accent/20 bg-accent/[.04] p-3.5 max-sm:mx-4">
            <span className="flex size-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white">{(t.lead.name || t.lead.email || "?")[0].toUpperCase()}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{t.lead.name || "Unnamed lead"}{t.lead.company && <span className="text-text-2"> · {t.lead.company}</span>}</p>
              <p className="truncate text-xs text-text-2">{t.lead.email || "No email"}{t.lead.message && ` — “${t.lead.message}”`}</p>
            </div>
            {t.lead.email && <a href={`mailto:${t.lead.email}?subject=${encodeURIComponent("Following up on your chat with UX Boğa")}`} className="inline-flex h-8 items-center gap-1.5 rounded-10 bg-accent px-3 text-[13px] font-medium text-white hover:bg-[#e60c30]"><Icon k="mail" size={16} />Reply by email</a>}
          </div>
        )}
        <ol className="flex flex-col gap-5 px-5 py-5 max-sm:px-4">
          {t.messages.map((m, i) => (
            <li key={i} className="flex flex-col gap-2">
              <div className="flex justify-end">
                <div className="max-w-[78%] rounded-[16px_16px_4px_16px] bg-pill px-3.5 py-2.5 text-[13px] text-text-1 max-sm:max-w-[90%]">{m.question}</div>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-white"><Icon k="sparkles" size={14} /></span>
                <div className={`min-w-0 max-w-[85%] flex-1 rounded-[4px_16px_16px_16px] border px-3.5 py-2.5 ${m.answered ? "border-border-soft" : "border-negative/30 bg-negative-bg/40"}`}>
                  {!m.answered && <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-negative"><Icon k="alert" size={13} />Not answered from your site — knowledge gap</p>}
                  <Md text={m.answer} />
                  {m.sources.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-border-soft pt-2.5">
                      {m.sources.slice(0, 4).map((s, k) => (
                        <a key={k} href={s.url} target="_blank" rel="noreferrer" title={`${s.title} · relevance ${s.score.toFixed(2)}`} className="inline-flex max-w-[220px] items-center gap-1 rounded-6 bg-icon px-2 py-1 text-[11px] text-text-2 hover:text-text-1">
                          <Icon k="link" size={11} /><span className="truncate">{s.title || pathOf(s.url)}</span>
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-text-3">
                    <span className={`rounded-6 px-1.5 py-0.5 font-medium ${scoreTone(m.topScore)}`} title="Relevance of the best matching page (0–1)">score {m.topScore.toFixed(2)}</span>
                    <span>{fmtMs(m.responseTimeMs)}</span><span>·</span><span>{dt(m.timestamp)}</span>
                    {!m.answered && <button onClick={() => copy(m.question, "Question copied")} className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-6 px-1.5 py-0.5 font-medium text-text-2 hover:bg-icon"><Icon k="copy" size={11} />Copy question</button>}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
