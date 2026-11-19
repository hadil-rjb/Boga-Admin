"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Icon, { type IconKey } from "@/components/Icon";
import { PillBtn, btn } from "@/components/ui";
import { pageCls } from "@/components/table";
import { useFeedback } from "@/components/feedback";
import { IdeasPanel, useIdeas } from "@/components/IdeasPanel";
import { CalBar, ListView, MonthGrid, UnscheduledView, WeekGrid, type CalCtx } from "@/components/CalendarViews";
import { api } from "@/lib/api";
import { useData } from "@/lib/data";
import { useArticleDrawer } from "@/components/ArticleDrawerHost";
import { ds, slugify, today } from "@/lib/seo";
import { addDays, dropTime, monday, monthCells, moveStatus } from "@/lib/calendar";
import type { Article } from "@/lib/types";

type View = "week" | "month" | "list";
const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleString("en", o);
const store = (k: string, v?: string) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };

/** True under a width (the week grid shows one day on a phone, like the Planner) */
function useNarrow(q = "(max-width: 760px)") {
  return useSyncExternalStore((cb) => { const m = matchMedia(q); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); }, () => matchMedia(q).matches, () => false);
}

/** The Filter button: categories to show (several can be on; none = all), with a count when some are picked */
function CategoryFilter({ cats, on, set }: { cats: string[]; on: Set<string>; set: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", out); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", out); document.removeEventListener("keydown", esc); };
  }, [open]);
  const flip = (c: string) => { const s = new Set(on); s.has(c) ? s.delete(c) : s.add(c); set(s); };
  const box = (b: boolean) => `grid size-4 shrink-0 place-items-center rounded-[5px] border ${b ? "border-accent bg-accent text-white" : "border-border"}`;
  const row = "flex w-full cursor-pointer items-center gap-2.5 rounded-8 px-2.5 py-2 text-left text-sm hover:bg-pill";
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`Filter by category${on.size ? `, ${on.size} active` : ""}`}
        className={btn("secondary", "md", `w-full ${open ? "!border-accent shadow-[0_0_0_3px_rgba(253,14,53,.14)]" : ""}`)}>
        <Icon k="filter" size={16} className="text-text-2" />Filter{!!on.size && <em className="grid size-[18px] place-items-center rounded-full bg-accent text-[11px] font-semibold not-italic text-white">{on.size}</em>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-30 flex max-h-[360px] w-[240px] flex-col overflow-y-auto rounded-12 border border-border bg-surface p-1.5 shadow-[0_12px_32px_rgba(15,23,42,.16)] max-[700px]:left-0 max-[700px]:right-auto">
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[.05em] text-text-3">Category</div>
          <button type="button" role="menuitemcheckbox" aria-checked={!on.size} className={row} onClick={() => set(new Set())}><span className={box(!on.size)}>{!on.size && <Icon k="check" size={12} />}</span>All categories</button>
          {cats.map((c) => <button key={c} type="button" role="menuitemcheckbox" aria-checked={on.has(c)} className={row} onClick={() => flip(c)}><span className={box(on.has(c))}>{on.has(c) && <Icon k="check" size={12} />}</span><span className="truncate">{c || "No category"}</span></button>)}
          {!!on.size && <><div className="my-1 border-t border-border-soft" /><button type="button" className={`${row} text-accent`} onClick={() => { set(new Set()); setOpen(false); }}>Clear filters</button></>}
        </div>
      )}
    </div>
  );
}

export default function CalendarPage() {
  const { articles: A, user, reload } = useData();
  const { toast, ask } = useFeedback();
  const { openArticle, openNewArticle } = useArticleDrawer();
  const can = user.role === "admin" || user.role === "editor";
  const narrow = useNarrow();
  const [view, setView] = useState<View>("week");
  const [ws, setWs] = useState(() => monday(new Date()));
  const [mo, setMo] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [focus, setFocus] = useState(() => today());
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState(""), [cats, setCats] = useState<Set<string>>(new Set());
  const [side, setSide] = useState(true);
  const [drag, setDrag] = useState<string | null>(null), [dIdea, setDIdea] = useState<string | null>(null), [over, setOver] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const search = useRef<HTMLInputElement>(null);
  const ih = useIdeas();
  const t = ds(now);

  useEffect(() => { setSide(store("uxb.calside") !== "0"); }, []);
  // the grid follows the clock: the "now" line and the past hours
  useEffect(() => { const i = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(i); }, []);
  // ⌘1 / Ctrl 1 jumps to the search, like the Planner
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "1") { e.preventDefault(); search.current?.focus(); search.current?.select(); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iP/.test(navigator.platform)), []);

  const catList = useMemo(() => [...new Set(A.map((a) => a.cat || ""))].sort(), [A]);
  const days = useMemo(() => [...Array(7)].map((_, i) => addDays(ws, i)), [ws]);
  const cells = useMemo(() => monthCells(mo), [mo]);
  useEffect(() => { if (!days.some((d) => ds(d) === focus)) setFocus(days.some((d) => ds(d) === t) ? t : ds(days[0])); }, [days, focus, t]);

  const fl = (a: Article) => (!q || (a.title + " " + a.cat).toLowerCase().includes(q.toLowerCase())) && (!cats.size || cats.has(a.cat || ""));
  const [k0, k1] = view === "week" ? [ds(days[0]), ds(days[6])] : view === "month" ? [ds(cells[0]), ds(cells[cells.length - 1])] : ["", "￿"];
  const inR = A.filter((a) => fl(a) && a.date && a.date >= k0 && a.date <= k1);
  const unscheduled = A.filter((a) => fl(a) && !a.date);
  const cnt = (s: string) => inR.filter((a) => a.status === s).length;
  const vis = inR.filter((a) => tab === "all" || tab === "ideas" || a.status === tab);
  const tabs: [string, string, IconKey, number][] = [["all", "All", "tbl", inR.length], ["Live", "Live", "globe", cnt("Live")], ["Scheduled", "Scheduled", "clock", cnt("Scheduled")], ["Draft", "Drafts", "penLine", cnt("Draft")], ["ideas", "Unscheduled", "inbox", unscheduled.length]];

  const nav = (d: number) => {
    if (view === "month") setMo(d ? new Date(mo.getFullYear(), mo.getMonth() + d, 1) : (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); })());
    else { setWs(d ? addDays(ws, 7 * d) : monday(new Date())); if (!d) setFocus(t); }
  };
  const goToday = () => { const n = new Date(); setWs(monday(n)); setMo(new Date(n.getFullYear(), n.getMonth(), 1)); setFocus(t); if (tab === "ideas") setTab("all"); };
  const pickView = (v: View) => {
    if (v === "month" && view === "week") { const c = addDays(ws, 3); setMo(new Date(c.getFullYear(), c.getMonth(), 1)); }
    if (v === "week" && view === "month") { const n = new Date(); setWs(n.getMonth() === mo.getMonth() && n.getFullYear() === mo.getFullYear() ? monday(n) : monday(mo)); }
    setView(v); if (tab === "ideas") setTab("all");
  };
  const toggleSide = () => { store("uxb.calside", side ? "0" : "1"); setSide(!side); };

  const end = () => { setDrag(null); setDIdea(null); setOver(null); };
  // date, time and status follow the calendar (future = Scheduled, past = Draft, live stays live)
  const drop = async (k: string, hour?: number) => {
    const slug = drag, idea = dIdea; end();
    if (idea) { if (can && k) ih.write(idea, k); return; }
    if (!can || !slug) return;
    const a = A.find((x) => x.slug === slug);
    if (!a) return;
    const time = hour === undefined ? a.time || "09:00" : dropTime(a.time, hour);
    if (k === (a.date || "") && time === (a.time || "09:00")) return;
    if (!k && a.status === "Live") return toast("Published articles keep their date");
    const st = moveStatus(a.status, k, t);
    if (a.status === "Live" && st === "Scheduled" && !(await ask({ t: "Move a published article?", p: `“${a.title}” is live. Moving it to a future date will set it back to Scheduled.`, ok: "Move" }))) return;
    try {
      await api("/articles/" + encodeURIComponent(a.slug), { method: "PATCH", body: { date: k, time, status: st } });
      await reload();
      toast(k ? `Moved to ${fmt(new Date(k + "T00:00:00"), { month: "short", day: "numeric" })}${hour === undefined ? "" : " at " + time} · ${st}` : "Moved to Unscheduled");
    } catch (e: any) { toast(e.message); }
  };
  const addIdea = async (title: string) => {
    if (!can || !title.trim()) return;
    try { await api("/articles", { method: "POST", body: { slug: slugify(title), title: title.trim(), cat: catList.find(Boolean) || "", date: "", status: "Draft" } }); await reload(); } catch (e: any) { toast(e.message); }
  };
  const dz = (k: string, hour?: number) => {
    const key = `${k}|${hour ?? ""}`;
    return {
      onDragOver: (e: React.DragEvent) => { if (!drag && !dIdea) return; e.preventDefault(); if (over !== key) setOver(key); },
      onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === key ? null : o)); },
      onDrop: (e: React.DragEvent) => { e.preventDefault(); drop(k, hour); },
    };
  };
  const c: CalCtx = { list: vis, today: t, can, dragging: !!(drag || dIdea), over, open: (s) => openArticle(s), create: (d, tm) => can && openNewArticle(d || undefined, tm), dragStart: setDrag, dragEnd: end, dz };

  const showSide = side && user.role !== "link";
  const emptyMsg = !vis.length && tab !== "ideas" && view !== "list";
  return (
    <div className={pageCls}>
      {/* toolbar: Today and the views on the left; search, filter and the side panel on the right */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <PillBtn onClick={goToday}>Today</PillBtn>
          <div role="tablist" aria-label="View" className="inline-flex h-10 rounded-10 bg-pill p-1">
            {(["week", "month", "list"] as View[]).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} onClick={() => pickView(v)}
                className={`h-8 cursor-pointer rounded-[7px] px-3.5 text-sm font-medium capitalize ${view === v ? "bg-surface font-semibold text-text-1 shadow-[0_1px_3px_rgba(15,23,42,.12)]" : "text-text-2 hover:text-text-1"}`}>{v}</button>
            ))}
          </div>
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 max-[1100px]:ml-0 max-[1100px]:basis-full max-[1100px]:justify-start">
          <label className="flex h-10 w-[300px] max-w-full items-center gap-2 rounded-10 border border-border bg-surface pl-3 pr-1.5 text-text-3 shadow-xs transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(253,14,53,.12)] max-[1100px]:w-auto max-[1100px]:flex-[1_1_150px]">
            <Icon k="search" size={18} />
            <input ref={search} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search articles..." aria-label="Search articles" autoComplete="off"
              className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-text-1 outline-0 placeholder:text-text-3 [&::-webkit-search-cancel-button]:hidden" />
            <kbd className="shrink-0 rounded-6 border border-border px-1.5 font-sans text-[11px] font-medium leading-4 text-text-3 max-[700px]:hidden">{mac ? "⌘" : "Ctrl "}1</kbd>
          </label>
          <CategoryFilter cats={catList} on={cats} set={setCats} />
          {user.role !== "link" && (
            <button onClick={toggleSide} aria-pressed={side} title={`${side ? "Hide" : "Show"} the side panel`} aria-label="Side panel: unscheduled articles and ideas"
              className={btn("secondary", "icon", side ? "!border-accent/40 !bg-accent/5 !text-accent" : "!text-text-2")}><Icon k="panelR" size={18} /></button>
          )}
        </div>
      </div>

      {/* tabs, underlined in red, with their counts */}
      <div role="tablist" aria-label="Show" className="-mt-1 flex gap-7 overflow-x-auto border-b border-border [scrollbar-width:none] max-[760px]:gap-5">
        {tabs.map(([k, l, ic, n]) => { const on = tab === k; return (
          <button key={k} role="tab" aria-selected={on} onClick={() => setTab(k)}
            className={`relative flex h-[46px] shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap px-0.5 text-[15px] font-medium transition-colors ${on ? "text-text-1" : "text-text-2 hover:text-text-1"}`}>
            <Icon k={ic} size={18} className={on ? "text-accent" : "text-text-2"} />{l}
            <span className="rounded-full bg-pill px-2 py-px text-xs text-text-2">{n}</span>
            {on && <i className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ); })}
      </div>

      <div className={`grid items-start gap-4 ${showSide ? "min-[1180px]:grid-cols-[minmax(0,1fr)_320px]" : ""}`}>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="overflow-hidden rounded-16 border border-border bg-surface">
            {tab === "ideas" ? <UnscheduledView c={c} list={unscheduled} add={addIdea} />
              : view === "week" ? <WeekGrid c={c} days={days} focus={focus} setFocus={setFocus} narrow={narrow} nav={nav} now={now} />
              : view === "month" ? <MonthGrid c={c} cells={cells} month={mo} nav={nav} more={(k) => { setView("week"); setWs(monday(new Date(k + "T00:00:00"))); setFocus(k); }} />
              : <ListView c={c} />}
          </div>
          {emptyMsg && <p className="px-0.5 text-[13px] text-text-2">Nothing {tab === "all" ? "planned" : tabs.find((x) => x[0] === tab)![1].toLowerCase()} in this {view} — click {view === "week" ? "an hour" : "a day"} to plan an article{showSide ? ", or drag one from the side panel" : ""}.</p>}
          {drag && !showSide && (
            <div {...dz("")} className={`flex items-center justify-center gap-2 rounded-[14px] border-2 border-dashed p-3.5 text-[13px] ${over === "|" ? "border-accent bg-accent/[.06] text-accent" : "border-border text-text-2"}`}>
              <Icon k="x" size={16} />Drop here to unschedule
            </div>
          )}
        </div>

        {showSide && (
          <aside className="flex min-w-0 flex-col gap-4 min-[1180px]:sticky min-[1180px]:top-4 min-[1180px]:max-h-[calc(100vh-32px)] min-[1180px]:overflow-y-auto min-[1180px]:[scrollbar-width:thin]">
            <div {...dz("")} className={`flex flex-col gap-2 overflow-hidden rounded-16 border bg-surface transition-colors ${over === "|" ? "border-accent bg-accent/[.04]" : drag ? "border-dashed border-accent/60" : "border-border"}`}>
              <CalBar title="Unscheduled" n={unscheduled.length} />
              <div className="flex flex-col gap-2 px-3 pb-3">
                <p className="text-xs text-text-3">{drag ? "Drop here to unschedule." : can ? "Drag an article onto a day or an hour to schedule it." : "Articles without a date."}</p>
                {can && <input className="rounded-10 border border-transparent bg-pill px-3 py-2 text-sm text-text-1 outline-0 focus:border-accent" placeholder="Add a title and press Enter" onKeyDown={(e) => { if (e.key === "Enter") { addIdea(e.currentTarget.value); e.currentTarget.value = ""; } }} />}
                <div className="flex max-h-[260px] flex-col gap-1.5 overflow-y-auto">
                  {unscheduled.map((a) => (
                    <div key={a.slug} role="button" tabIndex={0} draggable={can} onClick={() => openArticle(a.slug)} onKeyDown={(e) => { if (e.key === "Enter") openArticle(a.slug); }}
                      onDragStart={(e) => { e.dataTransfer.setData("text/plain", a.slug); e.dataTransfer.effectAllowed = "move"; setDrag(a.slug); }} onDragEnd={end}
                      className={`flex cursor-pointer items-center gap-2.5 rounded-10 border border-border p-2 hover:border-text-3 ${can ? "active:cursor-grabbing" : ""} ${drag === a.slug ? "opacity-50" : ""}`}>
                      {a.img ? <img src={a.img} alt="" className="size-9 shrink-0 rounded-6 object-cover" /> : <span className="grid size-9 shrink-0 place-items-center rounded-6 bg-pill text-text-3"><Icon k="doc" size={18} /></span>}
                      <span className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{a.title || "Untitled"}</p><small className="text-xs text-text-3">{a.cat || "No category"} · {a.status}</small></span>
                    </div>
                  ))}
                  {!unscheduled.length && <p className="py-2 text-xs text-text-3">Every article has a date.</p>}
                </div>
              </div>
            </div>
            <IdeasPanel h={ih} onDrag={setDIdea} onEnd={end} />
          </aside>
        )}
      </div>
    </div>
  );
}
