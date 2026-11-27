"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import Icon, { IconKey } from "../Icon";
import EmptyState from "../EmptyState";
import { Button, LinkBtn, Tabs, Widget } from "../ui";
import { pageCls } from "../table";
import { useFeedback } from "../feedback";
import { since } from "@/lib/seo";
import { BotAnalytics, BotLead, BotMessage, downloadExport, fmtMs, toGaps, toThreads, useBot } from "@/lib/chatbot";
import { Chip, DayChart, ErrorCard, Head, PageSkeleton, RankList } from "./shared";

export default function Overview() {
  const { toast } = useFeedback();
  const a = useBot<BotAnalytics>("/chatbot/analytics");
  const c = useBot<{ total: number; items: BotMessage[] }>("/chatbot/conversations?limit=1000");
  const l = useBot<{ items: BotLead[] }>("/chatbot/leads");
  const [range, setRange] = useState(1);
  const [busy, setBusy] = useState("");
  const threads = useMemo(() => toThreads(c.data?.items || [], l.data?.items || []), [c.data, l.data]);
  const gaps = useMemo(() => toGaps((c.data?.items || []).filter((m) => !m.answered)), [c.data]);
  const reload = () => Promise.all([a.reload(), c.reload(), l.reload()]);
  const exp = async (n: "conversations.csv" | "report.pdf") => { setBusy(n); try { await downloadExport(n); toast(n.endsWith("pdf") ? "Report downloaded" : "CSV downloaded"); } catch (e: any) { toast(e.message); } setBusy(""); };

  if (a.error) return <div className={pageCls}><ErrorCard error={a.error} onRetry={reload} /></div>;
  if (!a.data) return <PageSkeleton />;
  const A = a.data, leads = l.data?.items.length ?? 0;
  const conv = threads.length ? Math.round((threads.filter((t) => t.lead).length / threads.length) * 100) : 0;
  const KPI: { icon: IconKey; label: string; value: string; hint: string; tone?: string; href?: string }[] = [
    { icon: "chat", label: "Conversations", value: A.totalConversations.toLocaleString("en"), hint: `${A.totalQuestions.toLocaleString("en")} questions asked` },
    { icon: "checkCircle", label: "Answer rate", value: `${A.answerRate}%`, hint: `${A.answeredCount} grounded in your site`, tone: A.answerRate >= 80 ? "text-positive" : A.answerRate >= 60 ? "text-[#d99a1e]" : "text-negative" },
    { icon: "alert", label: "Unanswered", value: String(A.unansweredCount), hint: gaps.length ? `${gaps.length} unique gaps to fix` : "Nothing to fix", href: "/bot/knowledge" },
    { icon: "users", label: "Leads", value: String(leads), hint: `${conv}% of conversations`, href: "/bot/leads" },
    { icon: "clock", label: "Avg response", value: fmtMs(A.averageResponseTimeMs), hint: "Time to first answer" },
  ];

  return (
    <div className={pageCls}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-text-3 max-sm:hidden">Live data from your chatbot server</p>
        <Button onClick={reload} disabled={a.loading} title="Refresh" aria-label="Refresh"><Icon k="history" className={a.loading ? "animate-spin" : ""} /><span className="max-sm:hidden">Refresh</span></Button>
        <Button onClick={() => exp("conversations.csv")} disabled={!!busy} className="max-sm:flex-1"><Icon k="download" />{busy === "conversations.csv" ? "Exporting…" : "CSV"}</Button>
        <Button variant="primary" onClick={() => exp("report.pdf")} disabled={!!busy} className="max-sm:flex-1"><Icon k="chart" />{busy === "report.pdf" ? "Building report…" : "PDF report"}</Button>
      </div>

      <div className="grid grid-cols-5 gap-px overflow-hidden rounded-16 border border-border bg-border-soft max-[1100px]:grid-cols-6 max-[640px]:grid-cols-2">
        {KPI.map((k, i) => {
          const body = (
            <>
              <span className="flex items-center gap-2 text-[13px] text-text-2"><span className="flex size-6 items-center justify-center rounded-8 bg-pill text-text-1"><Icon k={k.icon} size={14} /></span>{k.label}{k.href && <Icon k="arrowR" size={14} className="ml-auto text-text-3 opacity-0 transition group-hover:opacity-100" />}</span>
              <b className={`font-jakarta text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums max-sm:text-[22px] ${k.tone || ""}`}>{k.value}</b>
              <span className="text-[11px] text-text-3">{k.hint}</span>
            </>
          );
          const cls = `group flex flex-col gap-2.5 bg-surface px-5 py-4 max-[700px]:px-4 ${i < 3 ? "max-[1100px]:col-span-2" : "max-[1100px]:col-span-3"} ${i === 4 ? "max-[640px]:col-span-2" : "max-[640px]:col-span-1"}`;
          return k.href ? <Link key={k.label} href={k.href} className={`${cls} transition-colors hover:bg-icon`}>{body}</Link> : <div key={k.label} className={cls}>{body}</div>;
        })}
      </div>

      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4 max-[1100px]:grid-cols-1">
        <Widget>
          <Head icon="chart" title="Questions over time" sub="Every question visitors asked the assistant" right={<div className="w-[200px] max-sm:w-full"><Tabs items={["7d", "30d", "90d"]} active={range} onChange={setRange} /></div>} />
          {A.totalQuestions ? <DayChart data={A.conversationsByDay} days={[7, 30, 90][range]} /> : <EmptyState icon="chat" title="No questions yet" text="Once the widget is live on your site, activity shows up here." />}
        </Widget>
        <Widget>
          <Head icon="alert" title="Needs attention" sub="Questions the bot couldn't answer from your site" right={gaps.length > 0 && <Chip tone="neg">{gaps.length}</Chip>} />
          {gaps.length ? (
            <>
              <ul className="flex flex-1 flex-col divide-y divide-border-soft">
                {gaps.slice(0, 5).map((g) => (
                  <li key={g.question}><Link href={`/bot/conversations?id=${encodeURIComponent(g.sessions[0])}`} className="flex items-start gap-3 rounded-8 px-1 py-2.5 hover:bg-icon">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-negative" />
                    <span className="min-w-0 flex-1"><span className="line-clamp-2 text-[13px] text-text-1">{g.question}</span><span className="text-[11px] text-text-3">{since(g.last)}{g.count > 1 ? ` · asked ${g.count}×` : ""}</span></span>
                  </Link></li>
                ))}
              </ul>
              <LinkBtn href="/bot/knowledge" className="w-full">Fix knowledge gaps<Icon k="arrowR" /></LinkBtn>
            </>
          ) : <EmptyState icon="check" tone="good" title="All caught up" text="Every recent question got an answer grounded in your website." />}
        </Widget>
      </div>

      <div className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2 max-[760px]:grid-cols-1">
        <Widget>
          <Head icon="sparkles" title="Most asked" sub="What visitors want to know" />
          <RankList rows={A.mostAskedQuestions.slice(0, 6).map((q) => ({ label: q.question, count: q.count }))} empty={<EmptyState icon="chat" title="No data yet" />} />
        </Widget>
        <Widget>
          <Head icon="book" title="Top topics" sub="Site sections used in answers" />
          <RankList rows={A.mostViewedTopics.slice(0, 6).map((t) => ({ label: t.topic || "Other", count: t.count }))} empty={<EmptyState icon="book" title="No sources used yet" />} />
        </Widget>
        <Widget className="max-[1100px]:col-span-full">
          <Head icon="inbox" title="Recent conversations" right={<Link href="/bot/conversations" className="text-[13px] font-medium text-accent hover:underline">View all</Link>} />
          {threads.length ? (
            <ul className="flex flex-col divide-y divide-border-soft">
              {threads.slice(0, 5).map((t) => (
                <li key={t.id}><Link href={`/bot/conversations?id=${encodeURIComponent(t.id)}`} className="flex items-center gap-3 rounded-8 px-1 py-2.5 hover:bg-icon">
                  <span className="min-w-0 flex-1"><span className="block truncate text-[13px] text-text-1">{t.messages[0].question}</span><span className="text-[11px] text-text-3">{since(t.last)} · {t.messages.length} {t.messages.length > 1 ? "messages" : "message"}</span></span>
                  {t.lead && <Chip tone="accent">Lead</Chip>}{t.unanswered > 0 && <Chip tone="neg">{t.unanswered} missed</Chip>}
                </Link></li>
              ))}
            </ul>
          ) : <EmptyState icon="inbox" title="No conversations yet" />}
        </Widget>
      </div>
    </div>
  );
}
