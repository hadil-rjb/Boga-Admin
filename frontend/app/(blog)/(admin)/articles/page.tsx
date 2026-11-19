"use client";
import Select from "@/components/Select";
import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ArticleDrawer from "@/components/ArticleDrawer";
import ImportArticlesDialog from "@/components/ImportArticlesDialog";
import Icon from "@/components/Icon";
import { PillBtn } from "@/components/ui";
import { Pager, Sort, StatusBadge, Sub, Table, TableCard, Td, Th, Ttl, cmp, fieldCls, pageCls } from "@/components/table";
import { useData, usePerf } from "@/lib/data";
import { exportArticlesCsv } from "@/lib/export";
import { checks, fmtN, score, scoreClass } from "@/lib/seo";

const SL: Record<string, string> = { title: "Title", cat: "Category", status: "Status", date: "Date", seo: "SEO", clicks: "Clicks" };
const TXT = ["title", "cat", "status"];
// Problèmes SEO filtrables (index = critère dans checks())
const ISSUES: [string, string, number][] = [["title", "Title too long", 0], ["meta", "Meta description", 1], ["alt", "Image alt text", 2], ["sub", "Subtitle missing", 3], ["tags", "Tags (3 required)", 4], ["slug", "Slug format", 5], ["words", "Content length", 6]];
const IX: Record<string, number> = Object.fromEntries(ISSUES.map(([k, , i]) => [k, i]));
const fd = (d: string) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en", { month: "short", day: "2-digit", year: "numeric" }) : "—");

function Articles() {
  const { articles: A, user } = useData();
  const canEdit = user.role === "admin" || user.role === "editor";
  const [importing, setImporting] = useState(false);
  const router = useRouter();
  const sp = useSearchParams();
  const [q, setQ] = useState(""), [st, setSt] = useState(sp.get("status") || ""), [cat, setCat] = useState("");
  const [issue, setIssue] = useState(sp.get("issue") || "");
  const [sort, setSort] = useState<Sort>({ k: "date", d: -1 });
  const [page, setPage] = useState(1);
  const edit = sp.get("edit"), isNew = sp.get("new") === "1", nd = sp.get("date") || undefined;
  const closeDrawer = () => router.replace("/articles");
  const { data: perf } = usePerf(28);
  const clicks = (slug: string) => perf?.pages.find((x) => x.key.includes("/blog/" + slug))?.clicks ?? null;
  const cats = useMemo(() => [...new Set(A.map((a) => a.cat))].sort(), [A]);

  const list = useMemo(() => {
    const K: Record<string, (a: (typeof A)[0]) => any> = { title: (a) => a.title, cat: (a) => a.cat, status: (a) => ({ Live: 0, Scheduled: 1, Draft: 2 } as any)[a.status], date: (a) => a.date, seo: score, clicks: (a) => clicks(a.slug) };
    return A.filter((a) => (!q || (a.title + a.slug).toLowerCase().includes(q.toLowerCase())) && (!st || a.status === st) && (!cat || a.cat === cat) && (!issue || (issue === "any" ? score(a) < 100 : !checks(a)[IX[issue]]?.[1])))
      .sort((a, b) => cmp(K[sort.k](a), K[sort.k](b), sort.d) || a.title.localeCompare(b.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [A, q, st, cat, issue, sort, perf]);
  const rows = list.slice((page - 1) * 10, page * 10);
  const issueCount = (i: number) => A.filter((a) => !checks(a)[i][1]).length;
  const anyIssue = A.filter((a) => score(a) < 100).length;
  const onSort = (k: string) => { setSort((s) => (s.k === k ? { k, d: -s.d } : { k, d: TXT.includes(k) ? 1 : -1 })); setPage(1); };
  const th = (k: string, cls = "", num = false) => <Th k={k} label={SL[k]} sort={sort} onSort={onSort} cls={cls} num={num} />;

  return (
    <div className={pageCls}>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${fieldCls} min-w-[200px] flex-1`} placeholder="Search articles…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <Select  value={st} onChange={(v) => { setSt(v); setPage(1); }}>
          <option value="">All statuses</option>{["Live", "Scheduled", "Draft"].map((s) => <option key={s}>{s}</option>)}
        </Select>
        <Select  value={cat} onChange={(v) => { setCat(v); setPage(1); }}>
          <option value="">All categories</option>{cats.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <Select aria-label="Needs attention" className={issue ? "!border-accent" : ""} value={issue} onChange={(v) => { setIssue(v); setPage(1); router.replace(v ? `/articles?issue=${v}` : "/articles"); }}>
          <option value="">Needs attention</option>
          <option value="any">All issues ({anyIssue})</option>
          {ISSUES.map(([k, l, i]) => <option key={k} value={k}>{l} ({issueCount(i)})</option>)}
        </Select>
        {canEdit && <PillBtn onClick={() => setImporting(true)}><Icon k="upload" />Import</PillBtn>}
        <PillBtn onClick={() => exportArticlesCsv(A)}><Icon k="download" />Export CSV</PillBtn>
      </div>
      <TableCard head={<span className="text-xs text-text-3">{list.length} article{list.length === 1 ? "" : "s"} · sorted by {SL[sort.k]} {sort.d > 0 ? "↑" : "↓"}</span>}>
        <Table>
          <thead><tr><th className="h-11 w-[76px] bg-icon pl-5 max-[700px]:pl-4" />{th("title")}{th("cat", "max-[640px]:hidden")}{th("status")}{th("date", "max-[640px]:hidden")}{th("seo", "", true)}{th("clicks", "max-[900px]:hidden", true)}</tr></thead>
          <tbody>
            {rows.map((a) => {
              const s = score(a), c = clicks(a.slug);
              return (
                <tr key={a.slug} onClick={() => router.push(`/articles?edit=${encodeURIComponent(a.slug)}`)} className="cursor-pointer [&:hover>td]:bg-icon">
                  <Td cls="w-[76px] !pr-0">{a.img ? <img src={a.img} alt="" className="block size-10 rounded-10 bg-pill object-cover" /> : <span className="grid size-11 place-items-center rounded-10 bg-pill font-jakarta text-base font-semibold text-text-3">{(a.title || "?")[0]}</span>}</Td>
                  <Td><Ttl>{a.title}</Ttl><Sub>/blog/{a.slug}</Sub></Td>
                  <Td cls="max-[640px]:hidden"><span className="inline-block whitespace-nowrap rounded-full bg-pill px-2.5 py-1 text-xs text-text-2">{a.cat}</span></Td>
                  <Td><StatusBadge s={a.status} /></Td>
                  <Td cls="max-[640px]:hidden">{fd(a.date)}</Td>
                  <Td num><span className={`mr-2.5 inline-block h-1.5 w-14 overflow-hidden rounded-full bg-pill align-middle ${scoreClass(s)}`}><i className="block h-full rounded-full bg-current" style={{ width: s + "%" }} /></span><b className={`font-semibold ${scoreClass(s)}`}>{s}</b></Td>
                  <Td num cls="max-[900px]:hidden">{c == null ? "—" : fmtN(c)}</Td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7} className="p-8 text-center text-[11px] text-text-3">No articles match.</td></tr>}
          </tbody>
        </Table>
        <Pager total={list.length} page={page} onPage={setPage} />
      </TableCard>
      {importing && <ImportArticlesDialog onClose={() => setImporting(false)} />}
      {(edit || isNew) && <ArticleDrawer key={edit || "new"} slug={edit} date={nd} onClose={closeDrawer} refresh={sp.get("refresh") === "snippet" ? "snippet" : sp.get("refresh") ? "refresh" : undefined} focus={sp.get("q") || undefined} />}
    </div>
  );
}
export default function Page() { return <Suspense><Articles /></Suspense>; }
