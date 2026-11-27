"use client";
import Link from "next/link";
import { ReactNode, useMemo, useRef, useState } from "react";
import Icon, { IconKey } from "../Icon";
import EmptyState from "../EmptyState";
import { LinkBtn, Skeleton, Widget } from "../ui";
import { pageCls } from "../table";
import { ds } from "@/lib/seo";

export const label = "text-[11px] font-medium uppercase tracking-[0.04em] text-text-3";

export const Head = ({ icon, title, sub, right }: { icon: IconKey; title: ReactNode; sub?: ReactNode; right?: ReactNode }) => (
  <div className="flex flex-wrap items-center gap-2 gap-y-2.5">
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <Icon k={icon} size={22} className="shrink-0 text-text-2" />
      <div className="min-w-0"><p className="truncate text-base font-medium">{title}</p>{sub && <p className="text-xs text-text-3">{sub}</p>}</div>
    </div>
    {right}
  </div>
);

export const Chip = ({ tone = "flat", children, title }: { tone?: "pos" | "neg" | "warn" | "flat" | "accent"; children: ReactNode; title?: string }) => {
  const t = { pos: "bg-positive-bg text-positive", neg: "bg-negative-bg text-negative", warn: "bg-[#d99a1e]/15 text-[#b7791f] dark:text-[#fbbf24]", flat: "bg-pill text-text-2", accent: "bg-accent/[.08] text-accent" }[tone];
  return <span title={title} className={`inline-flex shrink-0 items-center gap-1 rounded-6 px-[7px] py-1 text-[10px] font-medium leading-none ${t}`}>{children}</span>;
};

/** Bloc d'erreur (serveur endormi, clé refusée…) avec relance */
export function ErrorCard({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Widget className="min-h-[260px]">
      <EmptyState icon="alert" tone="bad" title="Couldn't reach the chatbot" text={error}>
        <button onClick={onRetry} className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-10 border border-border bg-surface px-4 text-sm font-medium shadow-xs hover:bg-icon"><Icon k="history" size={18} />Try again</button>
        <LinkBtn href="/bot/settings" variant="ghost">Check connection</LinkBtn>
      </EmptyState>
    </Widget>
  );
}

/** Écran affiché tant que le serveur chatbot n'est pas relié */
export function NotConnected({ own }: { own: boolean }) {
  return (
    <div className={pageCls}>
      <Widget className="items-center gap-5 px-6 py-14 text-center">
        <div className="flex size-[52px] items-center justify-center rounded-12 bg-accent/[.08] text-accent"><Icon k="chat" size={24} /></div>
        <div className="space-y-1.5">
          <p className="font-jakarta text-lg font-semibold">Connect your website assistant</p>
          <p className="mx-auto max-w-[460px] text-[13px] leading-relaxed text-text-2">Link the UX Boğa chatbot server to see what visitors ask, which answers miss, and the leads it captures, all inside this admin.</p>
        </div>
        <ol className="grid w-full max-w-[640px] grid-cols-3 gap-2.5 text-left max-sm:grid-cols-1">
          {[["globe", "Server URL", "Where the chatbot API runs, e.g. on Render."], ["lock", "Admin key", "The ADMIN_API_KEY from its .env. Stored encrypted."], ["chart", "Insights", "Conversations, gaps and leads appear here."]].map(([i, t, d], n) => (
            <li key={t} className="flex gap-3 rounded-12 bg-icon p-3.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-text-1 shadow-xs">{n + 1}</span>
              <div><p className="flex items-center gap-1.5 text-[13px] font-medium"><Icon k={i as IconKey} size={14} className="text-text-2" />{t}</p><p className="mt-0.5 text-xs text-text-2">{d}</p></div>
            </li>
          ))}
        </ol>
        {own ? <LinkBtn href="/bot/settings" variant="primary"><Icon k="link" />Connect chatbot</LinkBtn> : <p className="text-xs text-text-3">Ask the workspace owner to connect the chatbot.</p>}
      </Widget>
    </div>
  );
}

export const PageSkeleton = () => (
  <div className={pageCls} aria-busy="true" aria-label="Loading">
    <Skeleton className="h-[108px] w-full rounded-16" />
    <Skeleton className="h-[280px] w-full rounded-16" />
    <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1"><Skeleton className="h-[260px] rounded-16" /><Skeleton className="h-[260px] rounded-16" /></div>
  </div>
);

/** Liste classée avec barre de part (questions, sujets) */
export function RankList({ rows, empty, href }: { rows: { label: string; count: number; sub?: string }[]; empty: ReactNode; href?: (i: number) => string }) {
  if (!rows.length) return <>{empty}</>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <ol className="flex flex-col gap-1">
      {rows.map((r, i) => {
        const inner = (
          <>
            <span className="w-5 shrink-0 text-right text-xs tabular-nums text-text-3">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3"><span className="truncate text-[13px] text-text-1" title={r.label}>{r.label}</span><b className="shrink-0 text-[13px] font-semibold tabular-nums">{r.count}</b></div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-track"><i className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(4, (r.count / max) * 100)}%`, opacity: 1 - i * 0.07 }} /></div>
            </div>
          </>
        );
        return <li key={r.label + i}>{href ? <Link href={href(i)} className="flex items-center gap-3 rounded-10 px-2 py-2 hover:bg-icon">{inner}</Link> : <div className="flex items-center gap-3 px-2 py-2">{inner}</div>}</li>;
      })}
    </ol>
  );
}

/** Questions par jour (jours vides remplis), survol = détail du jour */
const W = 1000, H = 220, PL = 34, PR = 10, PT = 14, PB = 26;
export function DayChart({ data, days = 30 }: { data: { date: string; count: number }[]; days?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState<number | null>(null);
  const pts = useMemo(() => {
    const m = new Map(data.map((d) => [d.date, d.count])), out: { key: string; v: number }[] = [];
    const d = new Date(); d.setDate(d.getDate() - days + 1);
    for (let i = 0; i < days; i++, d.setDate(d.getDate() + 1)) out.push({ key: ds(d), v: m.get(ds(d)) || 0 });
    return out;
  }, [data, days]);
  const n = pts.length, max = Math.max(4, Math.ceil(Math.max(...pts.map((p) => p.v)) / 2) * 2);
  const X = (i: number) => PL + (i * (W - PL - PR)) / Math.max(1, n - 1), Y = (v: number) => PT + (1 - v / max) * (H - PT - PB);
  let d = `M${X(0)},${Y(pts[0].v)}`;
  for (let i = 1; i < n; i++) { const mx = (X(i - 1) + X(i)) / 2; d += ` C${mx},${Y(pts[i - 1].v)} ${mx},${Y(pts[i].v)} ${X(i)},${Y(pts[i].v)}`; }
  const step = Math.ceil(n / 6), total = pts.reduce((s, p) => s + p.v, 0);
  const move = (e: React.PointerEvent) => { const r = box.current!.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W; setHi(Math.max(0, Math.min(n - 1, Math.round(((x - PL) / (W - PL - PR)) * (n - 1))))); };
  const fd = (k: string, o: Intl.DateTimeFormatOptions) => new Date(k + "T00:00:00").toLocaleDateString("en", o);
  const p = hi !== null ? pts[hi] : null, px = hi !== null ? (X(hi) / W) * 100 : 0;
  return (
    <div ref={box} onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHi(null)} role="img" aria-label={`Questions per day over the last ${days} days, ${total} in total. Hover to see each day.`} className="relative h-[220px] cursor-crosshair touch-pan-y max-sm:h-[180px]">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className="size-full overflow-visible">
        <defs><linearGradient id="bot-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".2" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        {[0, max / 2, max].map((t, k) => <line key={k} x1={PL} x2={W - PR} y1={Y(t)} y2={Y(t)} stroke="currentColor" className="text-border-soft" strokeDasharray={k ? "3 4" : undefined} vectorEffect="non-scaling-stroke" />)}
        <path d={`${d} L${X(n - 1)},${H - PB} L${X(0)},${H - PB} Z`} fill="url(#bot-fill)" />
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2.2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {[0, max / 2, max].map((t, k) => <span key={k} className="pointer-events-none absolute left-0 -translate-y-1/2 text-[10px] tabular-nums text-text-3" style={{ top: `${(Y(t) / H) * 100}%` }}>{t}</span>)}
      {pts.map((x, k) => (k % step === 0 || k === n - 1) && (k === n - 1 || n - 1 - k >= step / 2) ? <span key={x.key} className="pointer-events-none absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[10px] text-text-3" style={{ left: `${(X(k) / W) * 100}%` }}>{fd(x.key, { month: "short", day: "numeric" })}</span> : null)}
      {p && (
        <>
          <i aria-hidden className="pointer-events-none absolute w-px bg-text-3/40" style={{ left: `${px}%`, top: `${(PT / H) * 100}%`, bottom: `${(PB / H) * 100}%` }} />
          <i aria-hidden className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface" style={{ left: `${px}%`, top: `${(Y(p.v) / H) * 100}%` }} />
          <div role="tooltip" className={`pointer-events-none absolute top-0 z-20 w-max rounded-10 border border-border bg-surface px-3 py-2 text-xs shadow-[0_8px_24px_rgba(0,0,0,.2)] ${px < 18 ? "left-[34px]" : px > 82 ? "right-0" : "-translate-x-1/2"}`} style={px < 18 || px > 82 ? undefined : { left: `${px}%` }}>
            <b className="block font-semibold">{fd(p.key, { weekday: "short", month: "short", day: "numeric" })}</b>
            <span className="mt-1 flex items-center gap-2 text-text-2"><i className="size-2 rounded-full bg-accent" />Questions<b className="ml-auto pl-4 font-semibold tabular-nums text-text-1">{p.v}</b></span>
          </div>
        </>
      )}
    </div>
  );
}
