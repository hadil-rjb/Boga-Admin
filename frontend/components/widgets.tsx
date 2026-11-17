"use client";
import Link from "next/link";
import { ReactNode, useMemo, useRef, useState } from "react";
import Icon, { IconKey } from "./Icon";
import EmptyState from "./EmptyState";
import FitList from "./FitList";
import { Button, LinkBtn, Tabs, Widget, btn } from "./ui";
import { useData, usePerf } from "@/lib/data";
import { useArticleDrawer } from "./ArticleDrawerHost";
import { Delta, ago, calcDelta, calcPp, checks, dayDiff, ds, fmtCtr, fmtN, fmtPos, plural, relDateTime, score, shares, today } from "@/lib/seo";
import type { Article, Perf } from "@/lib/types";

const label = "text-[11px] font-medium uppercase tracking-[0.04em] text-text-3";
const Divider = () => <div className="h-px shrink-0 bg-border-soft" />;
const noHost = (u: string) => u.replace(/^https?:\/\/[^/]+/, "");
const Head = ({ icon, title, right }: { icon: IconKey; title: string; right?: ReactNode }) => (
  <div className="flex min-h-8 items-center gap-2">
    <div className="flex min-w-0 flex-1 items-center gap-2 text-base font-medium"><Icon k={icon} size={22} className="shrink-0 text-text-2" /><span className="truncate">{title}</span></div>
    {right}
  </div>
);
const FullBtn = ({ href, children }: { href: string; children: ReactNode }) => <Link href={href} className={btn("secondary", "md", "w-full shrink-0")}>{children}</Link>;
const Tips = ({ items, icon = "check" }: { items: string[]; icon?: IconKey }) => (
  <ul className="flex shrink-0 flex-col gap-2 rounded-12 bg-icon p-3.5 text-[13px] text-text-2">
    {items.map((t) => <li key={t} className="flex items-start gap-2"><Icon k={icon} size={16} className="mt-px shrink-0 text-positive" /><span>{t}</span></li>)}
  </ul>
);
const Skel = ({ className }: { className: string }) => <div className={`animate-pulse rounded-10 bg-pill ${className}`} />;

/** Pastille de variation (+12%, −8%, New) */
const TONE = { pos: "bg-positive-bg text-positive", neg: "bg-negative-bg text-negative", flat: "bg-pill text-text-2" };
function DeltaChip({ d, title, trend }: { d: Delta | null; title?: string; trend?: boolean }) {
  if (!d) return null;
  return (
    <span title={title} className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium leading-4 ${TONE[d.tone]}`}>
      {trend && d.up !== null && <Icon k={d.up ? "trendUp" : "trendDown"} size={13} />}{d.text}
    </span>
  );
}

// ───────────────────────── Search Console ─────────────────────────
type Pt = { key: string; clicks: number; impressions: number };
/** Série complète jour par jour (GSC n'envoie pas les jours à 0) */
function fillSeries(p: Perf): Pt[] {
  const m = new Map(p.series.map((x) => [x.key, x])), out: Pt[] = [];
  const e = new Date(p.range.end + "T00:00:00");
  for (const d = new Date(p.range.start + "T00:00:00"); d <= e; d.setDate(d.getDate() + 1)) { const k = ds(d), r = m.get(k); out.push({ key: k, clicks: r?.clicks || 0, impressions: r?.impressions || 0 }); }
  return out;
}
const W = 300, H = 56;
function Spark({ pts }: { pts: Pt[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState<number | null>(null);
  const g = useMemo(() => {
    const v = pts.map((x) => x.clicks), mx = Math.max(...v, 0), mn = Math.min(...v, 0);
    const X = (i: number) => (pts.length > 1 ? 4 + (i * (W - 8)) / (pts.length - 1) : W / 2);
    const Y = (x: number) => (mx === mn ? H - 6 : 6 + (1 - (x - mn) / (mx - mn)) * (H - 12));
    let d = `M${X(0)},${Y(v[0])}`;
    for (let i = 1; i < v.length; i++) { const m = (X(i - 1) + X(i)) / 2; d += v.length > 45 ? ` L${X(i)},${Y(v[i])}` : ` C${m},${Y(v[i - 1])} ${m},${Y(v[i])} ${X(i)},${Y(v[i])}`; }
    return { d, X, Y };
  }, [pts]);
  const i = hi ?? pts.length - 1, p = pts[i];
  const px = (g.X(i) / W) * 100, py = (g.Y(p.clicks) / H) * 100;
  const move = (e: React.PointerEvent) => { const r = box.current!.getBoundingClientRect(); setHi(Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1))))); };
  const fd = (k: string) => new Date(k + "T00:00:00").toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  return (
    <div ref={box} onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHi(null)} role="img" aria-label={`Clicks per day, ${fmtN(pts.reduce((n, x) => n + x.clicks, 0))} in total. Hover to see each day.`} className="relative h-14 touch-pan-y cursor-crosshair">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className="size-full overflow-visible">
        <defs><linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".25" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        <path d={`${g.d} L${g.X(pts.length - 1)},${H} L${g.X(0)},${H} Z`} fill="url(#spark-fill)" />
        <path d={g.d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {hi !== null && <i aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-accent/40" style={{ left: `${px}%` }} />}
      <i aria-hidden className={`pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-bg dark:ring-[#0b1220] ${hi === null ? "" : "scale-110"}`} style={{ left: `${px}%`, top: `${py}%` }} />
      {hi !== null && (
        <div role="tooltip" className={`pointer-events-none absolute bottom-[calc(100%+4px)] z-20 w-max min-w-[132px] rounded-10 border border-border bg-surface px-3 py-2 text-xs text-text-1 shadow-[0_8px_24px_rgba(0,0,0,.25)] ${px < 22 ? "left-0" : px > 78 ? "right-0" : "-translate-x-1/2"}`} style={px < 22 || px > 78 ? undefined : { left: `${px}%` }}>
          <b className="block font-semibold">{fd(p.key)}</b>
          <span className="mt-1 flex items-center gap-2"><i className="size-2 rounded-full bg-accent" />Clicks<b className="ml-auto pl-3 font-semibold">{fmtN(p.clicks)}</b></span>
          <span className="mt-0.5 flex items-center gap-2"><i className="size-2 rounded-full bg-accent-2" />Impressions<b className="ml-auto pl-3 font-semibold">{fmtN(p.impressions)}</b></span>
        </div>
      )}
    </div>
  );
}

function csv(name: string, head: string[], rows: (string | number)[][]) {
  const q = (s: unknown) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([[head, ...rows].map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" }));
  a.download = name; a.click();
}

const PERIODS = [7, 28, 90, 365], PL = ["7d", "28d", "3m", "12m"], PN = ["7 days", "28 days", "3 months", "12 months"];
export function SearchConsole() {
  const { gsc, articles, user } = useData();
  const own = user.role === "admin";
  const [wd, setWd] = useState(28), [tab, setTab] = useState(0);
  const { data: p, loading, error, retry } = usePerf(wd);
  const pts = useMemo(() => (p ? fillSeries(p) : []), [p]);
  const dev = useMemo(() => {
    const D = p?.devices || [], by = D.reduce((n, x) => n + x.clicks, 0) > 0 ? "clicks" : "impressions";
    const sh = shares(D.map((x) => x[by])), get = (k: string) => { const i = D.findIndex((x) => x.key === k); return i < 0 ? null : sh[i]; };
    return [["Desktop", get("DESKTOP"), "desktop"], ["Mobile", get("MOBILE"), "mobile"], ["Tablet", get("TABLET"), "tablet"]] as const;
  }, [p]);
  const wrap = "min-[821px]:max-[1200px]:col-span-full min-[1201px]:row-span-2";
  // carte sans données aussi : toute la hauteur de la colonne (le message se centre, les conseils restent en bas)
  const short = wrap;
  const head = (right?: ReactNode) => <Head icon="search" title="Search Console" right={right} />;

  if (!gsc.connected) return (
    <Widget className={short}>
      {head()}
      <EmptyState icon="search" title="Connect Search Console" text="See real clicks, impressions and rankings for your blog, right on the dashboard.">
        {own ? <LinkBtn href="/settings?s=gsc" variant="primary">Connect Search Console</LinkBtn> : <span className="text-xs text-text-3">Ask the workspace owner to connect it.</span>}
      </EmptyState>
      <Tips items={["Clicks and impressions trend, day by day", "Top queries and top-performing pages", "Device split and click-through rate"]} />
    </Widget>
  );

  const t = p?.totals, pv = p?.previous;
  const ctr = t && t.impressions ? t.clicks / t.impressions : 0, pCtr = pv && pv.impressions ? pv.clicks / pv.impressions : 0;
  const vs = `Compared with the previous ${PN[PERIODS.indexOf(wd)]}`;
  const hasData = !!t && (t.clicks > 0 || t.impressions > 0);
  const pages = tab === 1;
  const rows = ((pages ? p?.pages : p?.queries) || []).slice(0, 4);
  const art = (u: string): Article | undefined => articles.find((a) => u.includes("/blog/" + a.slug));
  const exp = p ? <Button size="sm" onClick={() => csv("search-console-queries.csv", ["Query", "Clicks", "Impressions", "CTR", "Position"], p.queries.map((x) => [x.key, x.clicks, x.impressions, x.ctr, x.position]))}><Icon k="download" />Export</Button> : undefined;

  return (
    <Widget className={loading && !p ? wrap : error || !hasData ? short : wrap}>
      {head(exp)}
      <Tabs items={PL} active={PERIODS.indexOf(wd)} onChange={(i) => setWd(PERIODS[i])} />
      {loading && !p ? <><Skel className="h-[172px]" /><Skel className="h-16" /><Skel className="h-40" /></>
        : error ? <EmptyState icon="alert" tone="bad" title="Couldn’t load Search Console" text={error}><Button onClick={retry}>Try again</Button></EmptyState>
        : !hasData ? <EmptyState icon="inbox" title="No search data yet" text="Search Console reports with about a 2-day delay, and new pages take a few days to appear. Try a longer period."><Button onClick={() => setWd(90)}>Show last 3 months</Button></EmptyState>
        : <>
          <div className="relative rounded-16 border border-border bg-bg p-4 dark:bg-[#0b1220]">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm text-text-2">Total clicks</p>
              <DeltaChip trend d={calcDelta(t!.clicks, pv!.clicks)} title={vs} />
            </div>
            <p className="mb-3 mt-6 font-jakarta text-[32px] font-medium leading-none tracking-[-0.01em] max-sm:text-[26px]">{fmtN(t!.clicks)}</p>
            <Spark pts={pts} />
            
          </div>
          <div className="flex flex-col gap-0.5">
            {([["Impressions", fmtN(t!.impressions), calcDelta(t!.impressions, pv!.impressions)], ["Avg. CTR", fmtCtr(ctr), calcPp(ctr, pCtr)], ["Avg. position", fmtPos(t!.position), null]] as [string, string, Delta | null][]).map(([k, v, d]) => (
              <div key={k} className="flex items-center justify-between gap-2 py-1 text-sm"><span className="text-text-2">{k}</span><span className="flex items-center gap-2"><DeltaChip d={d} title={vs} /><b className="min-w-12 text-right font-medium tabular-nums">{v}</b></span></div>
            ))}
          </div>
          <Divider />
          <Tabs items={["Queries", "Pages"]} active={tab} onChange={setTab} />
          <div>
            <p className={`${label} mb-1`}>{pages ? "Top pages" : "Top queries"}</p>
            {rows.map((x) => {
              const a = pages ? art(x.key) : undefined;
              return (
                <div key={x.key} className="flex items-center gap-3 py-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-pill"><Icon k={pages ? "doc" : "search"} size={17} className="text-text-1" /></span>
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{pages ? (a ? a.title : noHost(x.key)) : x.key}</p><p className="truncate text-xs text-text-2">Position {fmtPos(x.position)} · CTR {fmtCtr(x.ctr)}</p></div>
                  <div className="shrink-0 text-right"><p className="text-sm font-medium tabular-nums">{fmtN(x.clicks)}</p><p className="text-xs text-text-2">{x.clicks === 1 ? "click" : "clicks"}</p></div>
                </div>
              );
            })}
            {!rows.length && <p className="py-4 text-center text-xs text-text-3">No {pages ? "pages" : "queries"} for this period.</p>}
          </div>
          <FullBtn href="/search"><span>{pages ? "View all pages" : "View all queries"}</span><Icon k="arrowR" /></FullBtn>
          <Divider />
          <div>
  <p className={`${label} mb-2.5`}>Device breakdown</p>
  <div className="grid grid-cols-3 divide-x divide-black/5 dark:divide-white/5">
    {dev.map(([name, v, ic]) => (
      <div
        key={name}
        className="flex flex-col items-center gap-1.5  text-center"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-icon text-text-1 shadow-xs">
          <Icon k={ic} size={17} />
        </span>
        <p className="text-xs text-text-2">{name}</p>
        <p className="text-sm font-medium tabular-nums">
          {v === null ? "—" : v + "%"}
        </p>
      </div>
    ))}
  </div>
</div>
        </>}
    </Widget>
  );
}

export function UpcomingContent() {
  const { upcoming, user } = useData();
  const { openArticle, openNewArticle } = useArticleDrawer();
  const can = user.role === "admin" || user.role === "editor";

  const head = <Head icon="cal" title="Upcoming Content" right={<Link href="/calendar" className={btn("ghost", "sm")}>Calendar<Icon k="arrowUR" /></Link>} />;
  if (!upcoming.length) return (
    <Widget>{head}
      <EmptyState icon="calPlus" title="Nothing scheduled" text="Schedule an article and it will show up here with its publish date.">
        {can && <Button variant="primary" onClick={() => openNewArticle()}><Icon k="plus" />New article</Button>}
      </EmptyState>
    </Widget>
  );

  return (
    <Widget>{head}
      <div className="flex flex-col">
        {upcoming.slice(0, 8).map((a) => {
          const d = new Date(`${a.date}T12:00:00`);
          const sub = `${relDateTime(a.scheduledAt)} · ${d.toLocaleDateString("en", { month: "short", day: "numeric" })} at ${a.time}`;
          return (
            <button type="button" key={a.slug} onClick={() => openArticle(a.slug)} className="group flex min-h-[60px] w-full cursor-pointer items-center gap-3 border-b border-border-soft py-2 text-left last:border-b-0 hover:bg-icon">
              <span className="flex h-11 w-10 shrink-0 flex-col items-center justify-center rounded-8 border border-border bg-surface">
                <span className="text-[9px] font-semibold tracking-[0.06em] text-text-3">{d.toLocaleString("en", { month: "short" }).toUpperCase()}</span>
                <b className="font-jakarta text-[15px] font-semibold leading-tight">{String(d.getDate()).padStart(2, "0")}</b>
              </span>
              <span className="min-w-0 flex-1"><b className="block truncate text-[13px] font-medium">{a.title}</b><span className="mt-0.5 block truncate text-[11px] text-text-3">{sub}</span></span>
              <span className="shrink-0 rounded-6 bg-accent/[.08] px-[7px] py-1 text-[10px] font-medium text-accent">Scheduled</span>
            </button>
          );
        })}
      </div>
      <FullBtn href="/calendar"><span>{upcoming.length > 8 ? `View all ${upcoming.length} in calendar` : "Open calendar"}</span><Icon k="arrowUR" /></FullBtn>
    </Widget>
  );
}

// ───────────────────────── Needs Attention ─────────────────────────
type Sev = "high" | "medium" | "info";
type Issue = { id: string; sev: Sev; icon: IconKey; title: string; sample: string; cta: string; href: string; weight: number };
const SEV: Record<Sev, string> = { high: "bg-negative-bg text-negative", medium: "bg-[rgba(217,119,6,.12)] text-[#d97706]", info: "bg-pill text-text-2" };
const SEO: [string, number, string, string][] = [
  ["meta", 1, "has a meta description outside 120–160 characters", "have a meta description outside 120–160 characters"],
  ["alt", 2, "has no cover image alt text", "have no cover image alt text"],
  ["title", 0, "has a title over 60 characters", "have a title over 60 characters"],
  ["sub", 3, "has no subtitle", "have no subtitle"],
  ["tags", 4, "has fewer than 3 tags", "have fewer than 3 tags"],
  ["slug", 5, "has an unclean slug", "have an unclean slug"],
  ["words", 6, "is under 600 words or lacks an H2", "are under 600 words or lack an H2"],
];
const sampleOf = (L: Article[]) => L.slice(0, 2).map((a) => a.title).join(", ") + (L.length > 2 ? ` +${L.length - 2} more` : "");

export function NeedsAttention() {
  const { articles: A, gsc } = useData();
  const t = today();
  const { issues, avg } = useMemo(() => {
    const L: Issue[] = [];
    SEO.forEach(([k, i, one, many]) => {
      const bad = A.filter((a) => !checks(a)[i][1]);
      if (bad.length) L.push({ id: k, sev: bad.length / A.length >= 0.5 ? "high" : "medium", icon: "alert", title: bad.length === 1 ? `1 article ${one}` : `${bad.length} articles ${many}`, sample: sampleOf(bad), cta: "Review", href: `/articles?issue=${k}`, weight: bad.length });
    });
    const over = A.filter((a) => a.status === "Scheduled" && a.date && a.date < t);
    if (over.length) L.push({ id: "overdue", sev: "high", icon: "cal", title: `${plural(over.length, "scheduled article")} ${over.length === 1 ? "is" : "are"} overdue`, sample: sampleOf(over), cta: "Review", href: "/articles?status=Scheduled", weight: 1000 });
    const live = A.filter((a) => a.status === "Live" && a.date), last = live.length ? Math.min(...live.map(ago)) : 0;
    if (last > 60) L.push({ id: "gap", sev: "medium", icon: "clock", title: `No article published in ${last} days`, sample: "A steady rhythm helps your rankings", cta: "Plan", href: "/calendar", weight: 500 });
    if (!gsc.connected) L.push({ id: "gsc", sev: "medium", icon: "search", title: "Search Console isn’t connected", sample: "Connect it to track clicks and rankings", cta: "Connect", href: "/settings?s=gsc", weight: 600 });
    const rank = { high: 0, medium: 1, info: 2 };
    L.sort((a, b) => rank[a.sev] - rank[b.sev] || b.weight - a.weight);
    return { issues: L, avg: Math.round(A.reduce((n, a) => n + score(a), 0) / (A.length || 1)) };
  }, [A, gsc.connected, t]);

  const count = <span className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ${issues.length ? "bg-negative-bg text-negative" : "bg-positive-bg text-positive"}`}>{issues.length ? issues.length : <Icon k="check" size={13} />}</span>;
  const head = <Head icon="alert" title="Needs Attention" right={count} />;
  if (!A.length) return <Widget>{head}<EmptyState icon="doc" title="Nothing to check yet" text="Once you add articles, SEO and publishing issues will be flagged here."><LinkBtn href="/articles?new=1" variant="primary"><Icon k="plus" />New article</LinkBtn></EmptyState><Tips icon="shield" items={["Meta descriptions, titles and slugs", "Image alt text, subtitles and tags", "Content length and publishing rhythm"]} /></Widget>;
  if (!issues.length) return (
    <Widget>{head}
      <EmptyState icon="shield" tone="good" title="All clear" text={<>No SEO or publishing issues across your {plural(A.length, "article")}. Average SEO score: <b className="text-text-1">{avg}/100</b>.</>}>
        <LinkBtn href="/articles">Browse articles</LinkBtn>
      </EmptyState>
      <ul className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-2 rounded-12 bg-icon p-3.5 text-xs text-text-2 max-[420px]:grid-cols-1">
        {["Meta descriptions", "Image alt text", "Title length", "Subtitles", "3 tags per article", "Clean slugs", "Content length"].map((c) => <li key={c} className="flex items-center gap-1.5"><Icon k="checkCircle" size={15} className="shrink-0 text-positive" />{c}</li>)}
      </ul>
    </Widget>
  );

  const passing = SEO.filter(([, i]) => A.every((a) => checks(a)[i][1])).length;
  return (
    <Widget>{head}
      <FitList items={issues} rowH={64} minRows={4} max={8}
        row={(x, i, cls) => (
          <Link key={x.id} href={x.href} className={`flex items-center gap-3 border-b border-border-soft py-2 last:border-b-0 hover:bg-icon ${cls}`}>
            <span className={`flex size-8 shrink-0 items-center justify-center rounded-8 ${SEV[x.sev]}`}><Icon k={x.icon} size={17} /></span>
            <span className="min-w-0 flex-1"><b className="line-clamp-2 text-[13px] font-medium leading-snug">{x.title}</b><span className="mt-0.5 block truncate text-[11px] text-text-3">{x.sample}</span></span>
            <span className={btn("secondary", "sm")}>{x.cta}</span>
          </Link>
        )}
        footer={(hidden) => <FullBtn href="/articles?issue=any"><span>{hidden ? `View all ${issues.length} issues` : "Review articles"}</span><Icon k="arrowR" /></FullBtn>}
      />
    </Widget>
  );
}
