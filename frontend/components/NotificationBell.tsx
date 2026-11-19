"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon, { IconKey } from "./Icon";
import { IconBtn, btn } from "./ui";
import { useData } from "@/lib/data";
import { ago, checks, today } from "@/lib/seo";
import { api } from "@/lib/api";

type N = { id: string; k: "seo" | "editorial" | "gsc" | "gscUp" | "gscDown"; t: string; d: string; href: string };
type Monitor = { week: { start: string; end: string } | null; alerts: { id: string; tone: "pos" | "neg"; text: string; href: string }[] };
const KIND: Record<N["k"], { icon: IconKey; cls: string }> = {
  seo: { icon: "alert", cls: "bg-negative-bg text-negative" },
  editorial: { icon: "cal", cls: "bg-accent/[.08] text-accent" },
  gsc: { icon: "search", cls: "bg-pill text-text-2" },
  gscUp: { icon: "trendUp", cls: "bg-positive-bg text-positive" },
  gscDown: { icon: "trendDown", cls: "bg-negative-bg text-negative" },
};
const KEY = "uxb.r";
const readIds = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };

/** Cloche + panneau de notifications : calculées à partir des articles, de Search Console et des préférences du profil */
export default function NotificationBell() {
  const { articles: A, gsc, user } = useData();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [rd, setRd] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setRd(readIds()), []);
  // weekly Search Console alerts (last week compared with the week before), computed by the API
  const [mon, setMon] = useState<Monitor | null>(null);
  const gscOn = gsc.connected && user.notifications?.gsc !== false && user.role !== "link";
  useEffect(() => { if (!gscOn) { setMon(null); return; } api<Monitor>("/gsc/monitor").then(setMon).catch(() => setMon(null)); }, [gscOn]);
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", d); window.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", d); window.removeEventListener("keydown", k); };
  }, [open]);

  const list = useMemo(() => {
    const L: N[] = [], t = today(), pr = user.notifications || {};
    const on = (k: "seo" | "editorial" | "gsc") => pr[k] !== false;
    const live = A.filter((a) => a.status === "Live");
    const last = live.length ? Math.min(...live.map(ago)) : 0;
    const dd = (d: string) => Math.round((new Date(d).getTime() - new Date(t).getTime()) / 864e5);
    const edit = (s: string) => `/articles?edit=${encodeURIComponent(s)}`;
    if (on("editorial")) {
      A.filter((a) => a.status === "Scheduled" && a.date >= t && dd(a.date) <= 7).forEach((a) => { const d = dd(a.date); L.push({ id: "s" + a.slug + a.date, k: "editorial", t: `“${a.title}” goes live ${d ? (d === 1 ? "tomorrow" : "in " + d + " days") : "today"}`, d: d ? "In " + d + " days" : "Today", href: edit(a.slug) }); });
      live.filter((a) => ago(a) <= 14).forEach((a) => L.push({ id: "p" + a.slug, k: "editorial", t: `“${a.title}” was published`, d: ago(a) + " days ago", href: edit(a.slug) }));
      if (last > 60) L.push({ id: "g" + Math.floor(last / 30), k: "editorial", t: `No article published in ${last} days`, d: "Publishing", href: "/calendar" });
    }
    if (on("seo")) ([["meta", 1, "articles have a meta description outside 120–160 characters"], ["alt", 2, "articles are missing cover image alt text"], ["title", 0, "titles are longer than 60 characters"]] as const).forEach(([k, i, x]) => {
      const c = A.filter((a) => !checks(a)[i][1]).length;
      if (c) L.push({ id: k + c, k: "seo", t: `${c} ${x}`, d: "SEO", href: `/articles?issue=${k}` });
    });
    if (on("gsc") && mon?.week) {
      const wk = "Search Console · week to " + new Date(mon.week.end + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric" });
      mon.alerts.forEach((a) => L.push({ id: "w" + a.id, k: a.tone === "pos" ? "gscUp" : "gscDown", t: a.text, d: wk, href: a.href }));
    }
    if (on("gsc") && !gsc.connected) L.push({ id: "gsc", k: "gsc", t: "Search Console is not connected — no performance data yet", d: "Search Console", href: "/settings?s=gsc" });
    return L;
  }, [A, gsc.connected, user.notifications, mon]);

  const unread = list.filter((n) => !rd.includes(n.id));
  const view = tab === "unread" ? unread : list;
  const mark = (ids: string[]) => { const n = [...new Set([...rd, ...ids])]; setRd(n); localStorage.setItem(KEY, JSON.stringify(n.slice(-200))); };
  const openN = (n: N) => { mark([n.id]); setOpen(false); router.push(n.href); };

  return (
    <div ref={box} className="relative">
      <IconBtn title="Notifications" aria-label="Notifications" onClick={() => setOpen(!open)} className="relative">
        <Icon k="bell" />
        {unread.length > 0 && <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-bg bg-accent px-1 text-[10px] font-semibold leading-none text-white">{unread.length > 9 ? "9+" : unread.length}</span>}
      </IconBtn>
      {open && (
        <div className="absolute right-0 top-full z-[60] mt-2 flex max-h-[calc(100vh-88px)] w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-16 border border-border bg-surface shadow-[0_16px_40px_rgba(15,23,42,.18),0_4px_12px_rgba(15,23,42,.08)] max-[640px]:fixed max-[640px]:inset-x-3 max-[640px]:right-auto max-[640px]:top-[68px] max-[640px]:mt-0 max-[640px]:max-h-[calc(100vh-80px)] max-[640px]:w-auto">
          <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5">
            <b className="text-[15px] font-semibold">Notifications</b>
            {unread.length > 0 && <span className="rounded-full bg-accent px-1.5 py-px text-[11px] font-semibold text-white">{unread.length}</span>}
            <span className="flex-1" />
            {unread.length > 0 && <button onClick={() => mark(list.map((n) => n.id))} className={btn("link", "sm")}><Icon k="check" />Mark all as read</button>}
          </div>
          <div className="flex gap-1 border-b border-border px-3">
            {(["all", "unread"] as const).map((k) => (
              <button key={k} onClick={() => setTab(k)} className={`-mb-px cursor-pointer border-b-2 px-2 py-2 text-[13px] font-medium ${tab === k ? "border-accent text-accent" : "border-transparent text-text-2"}`}>{k === "all" ? "All" : "Unread" + (unread.length ? ` (${unread.length})` : "")}</button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {view.map((n) => {
              const r = rd.includes(n.id), K = KIND[n.k];
              return (
                <button key={n.id} onClick={() => openN(n)} className="flex w-full cursor-pointer items-start gap-3 border-b border-border-soft px-4 py-3 text-left hover:bg-icon">
                  <span className={`flex size-8 shrink-0 items-center justify-center rounded-8 ${K.cls}`}><Icon k={K.icon} size={17} /></span>
                  <span className="min-w-0 flex-1"><span className={`block text-[13px] leading-[1.4] ${r ? "font-normal text-text-2" : "font-medium"}`}>{n.t}</span><span className="mt-[3px] block text-[11px] text-text-3">{n.d}</span></span>
                  <i className={`mt-1.5 size-2 shrink-0 rounded-full bg-accent ${r ? "invisible" : ""}`} />
                </button>
              );
            })}
            {!view.length && (
              <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-positive-bg text-positive"><Icon k="check" size={20} /></span>
                <b className="text-sm font-medium">You’re all caught up</b>
                <span className="text-xs text-text-3">{tab === "unread" ? "No unread notifications." : "New alerts will show up here."}</span>
              </div>
            )}
          </div>
          <button onClick={() => { setOpen(false); router.push("/profile?s=notif"); }} className="flex cursor-pointer items-center gap-2 border-t border-border px-4 py-3 text-[13px] text-text-2 hover:bg-icon"><Icon k="settings" size={16} />Notification settings</button>
        </div>
      )}
    </div>
  );
}
