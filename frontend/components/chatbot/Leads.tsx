"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import Icon from "../Icon";
import EmptyState from "../EmptyState";
import { Button } from "../ui";
import { Pager, Sort, Table, TableCard, Td, Th, cmp, fieldCls, pageCls } from "../table";
import { Pa } from "../split";
import { since } from "@/lib/seo";
import { BotLead, useBot } from "@/lib/chatbot";
import { Chip, ErrorCard, PageSkeleton } from "./shared";

function csv(rows: BotLead[]) {
  const q = (s: unknown) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
  const h = ["Date", "Name", "Email", "Company", "Message", "Session"];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([[h, ...rows.map((l) => [l.createdAt, l.name, l.email, l.company, l.message, l.sessionId])].map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" }));
  a.download = `chatbot-leads-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
}

export default function Leads() {
  const l = useBot<{ items: BotLead[] }>("/chatbot/leads");
  const [q, setQ] = useState(""), [page, setPage] = useState(1), [sort, setSort] = useState<Sort>({ k: "createdAt", d: -1 });
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (l.data?.items || []).filter((x) => !s || [x.name, x.email, x.company, x.message].some((v) => v?.toLowerCase().includes(s))).sort((a, b) => cmp((a as any)[sort.k], (b as any)[sort.k], sort.d));
  }, [l.data, q, sort]);
  const onSort = (k: string) => setSort((s) => ({ k, d: s.k === k ? -s.d : k === "createdAt" ? -1 : 1 }));

  if (l.error) return <div className={pageCls}><ErrorCard error={l.error} onRetry={l.reload} /></div>;
  if (!l.data) return <PageSkeleton />;
  const all = l.data.items, week = all.filter((x) => Date.now() - new Date(x.createdAt).getTime() < 7 * 864e5).length;
  const size = 12, view = rows.slice((page - 1) * size, page * size);

  return (
    <div className={pageCls}>
      <TableCard head={<>
        <div className="mr-auto flex items-center gap-2"><Icon k="users" size={20} className="text-text-2" /><span className="text-base font-medium">Leads</span><Chip>{all.length}</Chip>{week > 0 && <Chip tone="pos">+{week} this week</Chip>}</div>
        <div className="relative w-[260px] max-sm:w-full">
          <Icon k="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search name, email, company…" aria-label="Search leads" className={`${fieldCls} w-full pl-9`} />
        </div>
        <Button onClick={() => csv(rows)} disabled={!rows.length} className="max-sm:w-full"><Icon k="download" />Export CSV</Button>
      </>}>
        {!rows.length ? (
          <div className="py-10"><EmptyState fill={false} icon={q ? "search" : "users"} title={q ? "No match" : "No leads yet"} text={q ? "Try another name or email." : "When a visitor shows buying intent, the assistant offers a contact form. Their details land here."} /></div>
        ) : (
          <>
            <Table>
              <thead><tr>
                <Th k="name" label="Contact" sort={sort} onSort={onSort} />
                <Th k="company" label="Company" sort={sort} onSort={onSort} cls="max-[800px]:hidden" />
                <Th k="message" label="Message" sort={sort} onSort={onSort} cls="max-[1000px]:hidden" />
                <Th k="createdAt" label="Received" sort={sort} onSort={onSort} />
                <th className="h-11 bg-icon pr-5" />
              </tr></thead>
              <tbody>
                {view.map((x, i) => (
                  <tr key={x.sessionId + i} className="hover:bg-icon/50">
                    <Td><div className="flex items-center gap-2.5"><Pa name={x.name || x.email || "?"} id={x.email} size={32} /><div className="min-w-0"><p className="truncate text-[13px] font-medium text-text-1">{x.name || "Unnamed"}</p><p className="truncate text-[11px] text-text-3">{x.email || "No email"}</p></div></div></Td>
                    <Td cls="max-[800px]:hidden">{x.company || "—"}</Td>
                    <Td cls="max-w-[360px] max-[1000px]:hidden"><span className="line-clamp-2">{x.message || "—"}</span></Td>
                    <Td cls="whitespace-nowrap" ><span title={new Date(x.createdAt).toLocaleString("en")}>{since(x.createdAt)}</span></Td>
                    <Td cls="w-0 whitespace-nowrap">
                      <div className="flex justify-end gap-1">
                        {x.sessionId && <Link href={`/bot/conversations?id=${encodeURIComponent(x.sessionId)}`} title="Read the conversation" aria-label="Read the conversation" className="inline-flex size-8 items-center justify-center rounded-10 text-text-2 hover:bg-icon hover:text-text-1"><Icon k="chat" size={16} /></Link>}
                        {x.email && <a href={`mailto:${x.email}?subject=${encodeURIComponent("Following up on your chat with UX Boğa")}`} className="inline-flex h-8 items-center gap-1.5 rounded-10 border border-border px-3 text-[13px] font-medium text-text-1 hover:bg-icon"><Icon k="mail" size={15} /><span className="max-sm:hidden">Email</span></a>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager total={rows.length} page={page} onPage={setPage} size={size} />
          </>
        )}
      </TableCard>
    </div>
  );
}
