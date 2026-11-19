"use client";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, btn } from "@/components/ui";
import Opportunities from "@/components/Opportunities";
import { Pager, Sort, Sub, Table, TableCard, Td, Th, Ttl, cmp, pageCls } from "@/components/table";
import { useData, usePerf } from "@/lib/data";
import { fmtCtr, fmtN, fmtPos } from "@/lib/seo";

const DAYS = [7, 28, 90];
const noHost = (u: string) => u.replace(/^https?:\/\/[^/]+/, "");

export default function Page() { return <Suspense><SearchPage /></Suspense>; }

function SearchPage() {
  const { gsc, articles } = useData();
  const router = useRouter();
  const sp = useSearchParams();
  const [days, setDays] = useState(28), [kind, setKind] = useState(sp.get("tab") === "opportunities" ? 2 : 0), [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>({ k: "clicks", d: -1 });
  const { data: p } = usePerf(days);
  const pages = kind === 1;
  const T = p?.totals || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const art = (u: string) => articles.find((a) => u.includes("/blog/" + a.slug));
  const rows = useMemo(() => {
    const r = ((pages ? p?.pages : p?.queries) || []).map((x) => ({ k: x.key, clicks: x.clicks, imp: x.impressions, ctr: x.ctr, pos: x.position, a: pages ? art(x.key) : undefined }));
    const key = (x: (typeof r)[0]) => (sort.k === "k" ? (pages && x.a ? x.a.title : x.k) : (x as any)[sort.k]);
    return r.sort((a, b) => cmp(key(a), key(b), sort.d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, pages, sort, articles]);
  const onSort = (k: string) => { setSort((s) => (s.k === k ? { k, d: -s.d } : { k, d: k === "k" || k === "pos" ? 1 : -1 })); setPage(1); };
  const th = (k: string, label: string, cls = "", num = false) => <Th k={k} label={label} sort={sort} onSort={onSort} cls={cls} num={num} />;
  const kp = (l: string, v: string) => (
    <div className="min-w-0 rounded-10 border border-border-soft bg-icon p-[11px]"><span className="block truncate text-[11px] text-text-2">{l}</span><strong className="mt-2 block font-jakarta text-xl font-semibold leading-none tracking-[-0.03em]">{v}</strong></div>
  );
  return (
    <div className={pageCls}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[260px] max-w-full"><Tabs items={DAYS.map((d) => d + " days")} active={DAYS.indexOf(days)} onChange={(i) => { setDays(DAYS[i]); setPage(1); }} /></div>
        <span className={`rounded-6 px-[7px] py-1 text-[10px] font-medium ${gsc.connected ? "bg-positive-bg text-positive" : "bg-pill text-text-2"}`}>{gsc.connected ? "Live Search Console data" : "Not connected"}</span>
        <Sub className="flex-1">Blog articles only (/blog/)</Sub>
        {!gsc.connected && <Link href="/settings?s=gsc" className={btn("secondary")}>Connect Search Console</Link>}
      </div>
      <div className="grid grid-cols-4 gap-2 max-[560px]:grid-cols-2">{kp("Clicks", fmtN(T.clicks))}{kp("Impressions", fmtN(T.impressions))}{kp("Avg CTR", fmtCtr(T.impressions ? T.clicks / T.impressions : 0))}{kp("Avg position", fmtPos(T.position))}</div>
      <TableCard head={<div className="w-[360px] max-w-full"><Tabs items={["Queries", "Pages", "Opportunities"]} active={kind} onChange={(i) => { setKind(i); setPage(1); router.replace(i === 2 ? "/search?tab=opportunities" : "/search", { scroll: false }); }} /></div>}>
        {kind === 2 ? <Opportunities days={days === 90 ? 90 : 28} /> : <>
        {gsc.connected ? (
          <Table>
            <thead><tr>{th("k", pages ? "Article" : "Query")}{th("clicks", "Clicks", "", true)}{th("imp", "Impr.", "max-[640px]:hidden", true)}{th("ctr", "CTR", "max-[640px]:hidden", true)}{th("pos", "Position", "", true)}</tr></thead>
            <tbody>
              {rows.slice((page - 1) * 10, page * 10).map((r) => (
                <tr key={r.k} onClick={() => r.a && router.push(`/articles?edit=${encodeURIComponent(r.a.slug)}`)} className={r.a ? "cursor-pointer [&:hover>td]:bg-icon" : ""}>
                  <Td><Ttl>{pages && r.a ? r.a.title : r.k}</Ttl>{pages && <Sub>{noHost(r.k)}</Sub>}</Td>
                  <Td num>{fmtN(r.clicks)}</Td><Td num cls="max-[640px]:hidden">{fmtN(r.imp)}</Td><Td num cls="max-[640px]:hidden">{fmtCtr(r.ctr)}</Td><Td num>{fmtPos(r.pos)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 py-10 text-center text-xs text-text-3">Connect Search Console in Settings to see real clicks, queries and pages.</p>}
        <Pager total={rows.length} page={page} onPage={setPage} />
        </>}
      </TableCard>
    </div>
  );
}
