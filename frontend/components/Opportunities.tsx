"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Icon, { type IconKey } from "./Icon";
import { Button } from "./ui";
import { Pager } from "./table";
import { useFeedback } from "./feedback";
import { api } from "@/lib/api";
import { useData } from "@/lib/data";
import { findOpportunities, type OppKind, type Opportunity } from "@/lib/opportunities";
import { usePageQueries } from "@/lib/pageQueries";
import { fmtCtr, fmtN, fmtPos } from "@/lib/seo";

const KINDS: { k: OppKind; label: string; short: string; icon: IconKey; tone: string }[] = [
  { k: "striking", label: "Striking distance", short: "Near page 1", icon: "trendUp", tone: "bg-accent/10 text-accent" },
  { k: "ctr", label: "Low CTR", short: "Low CTR", icon: "eye", tone: "bg-[rgba(217,154,30,.14)] text-[#b7790f] dark:text-[#e0a83a]" },
  { k: "decay", label: "Declining", short: "Declining", icon: "trendDown", tone: "bg-negative-bg text-negative" },
  { k: "gap", label: "Content gaps", short: "Content gap", icon: "plus", tone: "bg-positive-bg text-positive" },
  { k: "cannibal", label: "Competing pages", short: "Competing", icon: "copy", tone: "bg-pill text-text-2" },
];
const KIND = Object.fromEntries(KINDS.map((x) => [x.k, x])) as Record<OppKind, (typeof KINDS)[0]>;
const SIZE = 8;

/** SEO opportunities from real Search Console data, each with its next step */
export default function Opportunities({ days }: { days: 28 | 90 }) {
  const { articles, gsc, user } = useData();
  const { toast } = useFeedback();
  const router = useRouter();
  const can = user.role === "admin" || user.role === "editor";
  const { data, loading, error, retry } = usePageQueries(days, gsc.connected);
  const [kind, setKind] = useState<OppKind | "">(""), [page, setPage] = useState(1), [busy, setBusy] = useState("");
  const all = useMemo(() => {
    if (!data) return [];
    const host = (gsc.domain || "").split(".")[0];
    return findOpportunities(data, articles, { brand: ["ux boga", "uxboga", host].filter(Boolean) });
  }, [data, articles, gsc.domain]);
  const list = kind ? all.filter((o) => o.kind === kind) : all;
  const count = (k: OppKind) => all.filter((o) => o.kind === k).length;

  const edit = (slug: string, mode: "refresh" | "snippet", q?: string) => router.push(`/articles?edit=${encodeURIComponent(slug)}&refresh=${mode}${q ? "&q=" + encodeURIComponent(q) : ""}`);
  const plan = async (o: Opportunity) => {
    setBusy(o.id);
    try {
      await api("/ai/ideas/generate", { method: "POST", body: { count: 2, focus: `Search Console content gap: “${o.query}” (${o.impressions} impressions, best position ${fmtPos(o.position)})`.slice(0, 200) } });
      toast("2 article ideas added to the Calendar");
    } catch (e: any) { toast(e.message); }
    setBusy("");
  };

  if (!gsc.connected) return <p className="px-5 py-10 text-center text-xs text-text-3">Connect Search Console in Settings to find opportunities in your real clicks, queries and pages.</p>;
  if (loading) return <div className="flex flex-col gap-2 p-4">{[0, 1, 2].map((i) => <div key={i} className="h-[92px] animate-pulse rounded-12 bg-pill" />)}</div>;
  if (error) return <div className="flex flex-col items-center gap-3 px-5 py-10 text-center text-xs text-text-3"><span>{error}</span><Button size="sm" onClick={retry}>Try again</Button></div>;

  return (
    <div className="flex flex-col gap-3 p-4 max-[700px]:p-3">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Opportunity type">
        <Chip on={!kind} onClick={() => { setKind(""); setPage(1); }}>All <b className="font-semibold">{all.length}</b></Chip>
        {KINDS.map((x) => <Chip key={x.k} on={kind === x.k} onClick={() => { setKind(x.k); setPage(1); }} disabled={!count(x.k)}>{x.label} <b className="font-semibold">{count(x.k)}</b></Chip>)}
      </div>
      <p className="text-[11px] leading-relaxed text-text-3">
        From your Search Console data, {data!.range.start} → {data!.range.end}, compared with the {days} days before. Estimated clicks use your own pages&apos; CTR. Search volumes and competitor rankings need a keyword data source, which isn&apos;t connected.
      </p>
      {!list.length && <p className="rounded-12 border border-dashed border-border px-4 py-8 text-center text-xs text-text-3">{all.length ? "Nothing of this type right now." : "No opportunity found in this period. Try 90 days for more data."}</p>}
      <ul className="flex flex-col gap-2">
        {list.slice((page - 1) * SIZE, page * SIZE).map((o) => <Card key={o.id} o={o} can={can} busy={busy === o.id} onEdit={edit} onPlan={plan} onOpen={(s) => router.push(`/articles?edit=${encodeURIComponent(s)}`)} />)}
      </ul>
      <Pager total={list.length} page={page} onPage={setPage} size={SIZE} />
    </div>
  );
}

const Chip = ({ on, children, ...p }: { on: boolean; children: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
  <button type="button" role="tab" aria-selected={on} {...p}
    className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs transition-colors disabled:cursor-default disabled:opacity-45 ${on ? "border-text-1 bg-text-1 text-surface" : "border-border text-text-2 hover:enabled:border-text-3 hover:enabled:text-text-1"}`}>{children}</button>
);

function Card({ o, can, busy, onEdit, onPlan, onOpen }: { o: Opportunity; can: boolean; busy: boolean; onEdit: (s: string, m: "refresh" | "snippet", q?: string) => void; onPlan: (o: Opportunity) => void; onOpen: (s: string) => void }) {
  const K = KIND[o.kind];
  const head = o.kind === "gap" || o.kind === "cannibal" ? `“${o.query}”` : o.title;
  const stat = (l: string, v: string, cls = "") => <span className={cls}><span className="text-text-3">{l} </span><b className="font-medium text-text-1">{v}</b></span>;
  return (
    <li className="flex gap-3 rounded-12 border border-border-soft p-3.5 max-[560px]:flex-col">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-10 max-[560px]:hidden ${K.tone}`}><Icon k={K.icon} size={17} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`rounded-6 px-[7px] py-0.5 text-[10px] font-medium ${K.tone}`}>{K.short}</span>
          {o.kind === "striking" && <span className="truncate text-[11px] text-text-3">“{o.query}”</span>}
        </div>
        <p className="mt-1 break-words text-sm font-medium text-text-1">{head}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-text-2">{o.why}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {o.kind === "decay" ? stat("Clicks", `${fmtN(o.prevClicks ?? 0)} → ${fmtN(o.clicks)}`) : stat("Clicks", fmtN(o.clicks))}
          {stat("Impr.", fmtN(o.impressions))}
          {o.kind !== "decay" && stat("CTR", fmtCtr(o.ctr))}
          {o.position > 0 && stat(o.kind === "gap" || o.kind === "cannibal" ? "Best pos." : "Pos.", fmtPos(o.position))}
          {o.estClicks ? stat("Est.", `+${fmtN(o.estClicks)} clicks`, "text-positive [&_b]:text-positive") : null}
        </div>
        {o.pages && (
          <ul className="mt-2 flex flex-col gap-1">
            {o.pages.map((p, i) => (
              <li key={p.slug}><button type="button" onClick={() => onOpen(p.slug)} className="flex w-full cursor-pointer items-center gap-2 rounded-8 bg-pill px-2.5 py-1.5 text-left text-xs hover:bg-icon">
                <span className="min-w-0 flex-1 truncate text-text-1">{i === 0 && <b className="mr-1 font-semibold text-positive">Main</b>}{p.title}</span>
                <span className="shrink-0 text-text-3">{fmtN(p.impressions)} impr. · pos. {fmtPos(p.position)}</span>
              </button></li>
            ))}
          </ul>
        )}
      </div>
      {can && o.kind !== "cannibal" && (
        <div className="flex shrink-0 items-start max-[560px]:[&>button]:w-full">
          {o.action === "refresh" && <Button size="sm" onClick={() => onEdit(o.slug!, "refresh", o.query)}><Icon k="sparkles" />Refresh with AI</Button>}
          {o.action === "snippet" && <Button size="sm" onClick={() => onEdit(o.slug!, "snippet")}><Icon k="sparkles" />Rewrite title & meta</Button>}
          {o.action === "idea" && <Button size="sm" disabled={busy} onClick={() => onPlan(o)}><Icon k={busy ? "clock" : "calPlus"} />{busy ? "Planning…" : "Plan an article"}</Button>}
        </div>
      )}
    </li>
  );
}
