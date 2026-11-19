"use client";
/* The Editorial Calendar's views, laid out like the Social Media Planner: one card with a bar on top
   (‹ › · period · count), then a week time grid, a month grid or a list. */
import { useEffect, useRef } from "react";
import Icon from "./Icon";
import { StatusBadge } from "./table";
import { ds, score, scoreClass } from "@/lib/seo";
import { addDays, gmtLabel, hourLanes, minutesOf, tileTop } from "@/lib/calendar";
import type { Article } from "@/lib/types";

export const HH = 104; // px per hour on the week grid
const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleString("en", o);
const day = (k: string) => new Date(k + "T00:00:00");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const bar: Record<string, string> = { Live: "bg-positive", Scheduled: "bg-[#3b82f6]", Draft: "bg-text-3" };
const hatch = { backgroundImage: "repeating-linear-gradient(135deg,transparent 0 6px,color-mix(in srgb,var(--text-3) 9%,transparent) 6px 7px)" };
const headBg = "bg-[color-mix(in_srgb,var(--pill)_55%,var(--surface))]";
const byTime = (a: Article, b: Article) => minutesOf(a.time) - minutesOf(b.time);

/** What every view needs from the page: data, who can edit, and the drag and drop plumbing */
export type CalCtx = {
  list: Article[]; today: string; can: boolean; dragging: boolean; over: string | null;
  open: (slug: string) => void; create: (date: string, time?: string) => void;
  dragStart: (slug: string) => void; dragEnd: () => void;
  dz: (date: string, hour?: number) => React.HTMLAttributes<HTMLElement>;
};

/** The bar on top of the card: previous / next, the period and how many articles it holds */
export function CalBar({ title, n, unit, nav, gut }: { title: string; n: number; unit?: string; nav?: (d: number) => void; gut?: boolean }) {
  const b = "grid cursor-pointer place-items-center text-text-2 hover:bg-pill hover:text-text-1";
  return (
    <div className="flex h-11 shrink-0 items-stretch border-b border-border bg-surface">
      {nav && (
        <div className={`grid shrink-0 grid-cols-2 border-r border-border ${gut ? "w-[var(--gut)]" : "w-[88px]"}`}>
          <button className={b} onClick={() => nav(-1)} title={`Previous ${unit}`} aria-label={`Previous ${unit}`}><Icon k="chevL" size={16} /></button>
          <button className={`${b} border-l border-border`} onClick={() => nav(1)} title={`Next ${unit}`} aria-label={`Next ${unit}`}><Icon k="chevR" size={16} /></button>
        </div>
      )}
      <b aria-live="polite" className="flex min-w-0 items-center truncate px-4 text-base font-medium text-text-1">{title}</b>
      <span className="ml-auto flex shrink-0 items-center px-4 text-[13px] text-text-3">{plural(n, "article")}</span>
    </div>
  );
}

function Cover({ a, size }: { a: Article; size: number }) {
  return a.img
    ? <img src={a.img} alt="" width={size} height={size} className="shrink-0 rounded-6 object-cover" style={{ width: size, height: size }} />
    : <span className="grid shrink-0 place-items-center rounded-6 bg-pill text-text-3" style={{ width: size, height: size }}><Icon k="doc" size={Math.round(size * 0.55)} /></span>;
}

/** An article on the grids: a status bar on the left, its cover, title and time */
function Tile({ a, c, style, chip }: { a: Article; c: CalCtx; style?: React.CSSProperties; chip?: boolean }) {
  return (
    <div role="button" tabIndex={0} draggable={c.can} style={style}
      title={`${a.title} · ${a.time || "09:00"} · ${a.status}${a.cat ? " · " + a.cat : ""}`} aria-label={`${a.title}, ${a.time || "09:00"}, ${a.status}`}
      onClick={(e) => { e.stopPropagation(); c.open(a.slug); }} onKeyDown={(e) => { if (e.key === "Enter") c.open(a.slug); }}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", a.slug); e.dataTransfer.effectAllowed = "move"; c.dragStart(a.slug); }} onDragEnd={c.dragEnd}
      className={`flex cursor-pointer items-center overflow-hidden border border-border bg-surface text-left transition-[box-shadow,transform] hover:z-[4] hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(15,23,42,.18)] ${c.can ? "active:cursor-grabbing" : ""} ${c.dragging ? "pointer-events-none" : ""} ${a.status === "Live" ? "opacity-90" : ""}
        ${chip ? "relative h-[26px] w-full shrink-0 gap-1.5 rounded-[7px] pl-2.5 pr-2 text-xs" : "absolute z-[2] h-[50px] gap-[7px] rounded-[9px] py-[5px] pl-[9px] pr-[7px] shadow-[0_2px_8px_rgba(15,23,42,.1)]"}`}>
      <i className={`absolute inset-y-0 left-0 w-[3px] ${bar[a.status] || bar.Draft}`} />
      {chip ? <>
        <span className="shrink-0 font-semibold tabular-nums text-text-2 @max-[150px]:hidden">{a.time || "09:00"}</span>
        <b className="min-w-0 flex-1 truncate font-medium text-text-1">{a.title || "Untitled"}</b>
      </> : <>
        <span className="@max-[150px]:hidden"><Cover a={a} size={30} /></span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[11.5px] text-text-2">{a.title || "Untitled"}</span>
          <b className="text-[11px] font-bold tabular-nums text-text-1">{a.time || "09:00"}</b>
        </span>
      </>}
    </div>
  );
}

/** The week: hours down the side, days across, each article at its time; click a free hour to plan one there */
export function WeekGrid({ c, days, focus, setFocus, narrow, nav, now }: { c: CalCtx; days: Date[]; focus: string; setFocus: (k: string) => void; narrow: boolean; nav: (d: number) => void; now: Date }) {
  const body = useRef<HTMLDivElement>(null);
  const shown = narrow ? days.filter((d) => ds(d) === focus) : days;
  const nowM = now.getHours() * 60 + now.getMinutes(), k0 = ds(days[0]), k6 = ds(days[6]), thisWeek = c.today >= k0 && c.today <= k6;
  const inWeek = c.list.filter((a) => a.date >= k0 && a.date <= k6);
  const title = days[0].getMonth() === days[6].getMonth() ? fmt(days[0], { month: "long", year: "numeric" }) : `${fmt(days[0], { month: "short" })} – ${fmt(days[6], { month: "short", year: "numeric" })}`;
  // first look at a week: the current time in the middle (this week), else 7:00 at the top
  useEffect(() => {
    const b = body.current; if (!b) return;
    b.scrollTop = thisWeek ? (nowM / 60) * HH - b.clientHeight / 2 : 7 * HH;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k0, narrow]);
  const cols = { gridTemplateColumns: `var(--gut) repeat(${shown.length},minmax(0,1fr))` };
  return (
    <div className="flex flex-col [--gut:72px] max-[760px]:[--gut:56px]">
      <CalBar title={title} n={inWeek.length} unit="week" nav={nav} gut />
      {narrow && (
        <div role="tablist" aria-label="Day" className="grid grid-cols-7 gap-1 border-b border-border p-2">
          {days.map((d) => { const k = ds(d), on = k === focus, n = inWeek.filter((a) => a.date === k).length; return (
            <button key={k} role="tab" aria-selected={on} onClick={() => setFocus(k)} className={`relative flex cursor-pointer flex-col items-center gap-0.5 rounded-10 py-1.5 ${on ? "bg-accent text-white" : ""}`}>
              <small className={`text-[10.5px] uppercase tracking-[.04em] ${on ? "text-white" : "text-text-3"}`}>{fmt(d, { weekday: "short" })}</small>
              <b className={`font-jakarta text-[15px] font-semibold ${on ? "text-white" : k === c.today ? "text-accent" : "text-text-1"}`}>{d.getDate()}</b>
              {!!n && <i className={`absolute bottom-[3px] size-1 rounded-full ${on ? "bg-white" : "bg-accent"}`} />}
            </button>
          ); })}
        </div>
      )}
      <div className="relative z-[3] grid border-b border-border bg-surface" style={cols}>
        <div className="flex items-center justify-center"><small className="whitespace-nowrap text-[10.5px] text-text-3" title={Intl.DateTimeFormat().resolvedOptions().timeZone}>{gmtLabel(now.getTimezoneOffset())}</small></div>
        {shown.map((d) => { const k = ds(d); return (
          <div key={k} className={`flex h-[42px] items-center justify-center border-l border-border text-[13px] uppercase tracking-[.02em] ${headBg} ${k === c.today ? "font-semibold text-accent" : "font-medium text-text-3"}`}>
            {d.getDate()} {fmt(d, { weekday: "short" })}
          </div>
        ); })}
      </div>
      <div ref={body} className="relative h-[min(calc(100vh-330px),980px)] min-h-[420px] overflow-y-auto overscroll-contain [scrollbar-width:thin] max-[760px]:h-[calc(100vh-360px)] max-[760px]:min-h-[360px]">
        <div className="relative grid" style={cols}>
          <div className="grid" style={{ gridTemplateRows: `repeat(24,${HH}px)` }}>
            {[...Array(24)].map((_, h) => <span key={h} className="flex items-center justify-center border-t border-border-soft text-[15px] tabular-nums text-text-1 first:border-t-0 max-[760px]:text-xs">{pad(h)}:00</span>)}
          </div>
          {shown.map((d) => {
            const k = ds(d), isT = k === c.today, ps = inWeek.filter((a) => a.date === k).sort(byTime), lanes = hourLanes(ps);
            return (
              <div key={k} className={`@container relative grid border-l border-border ${isT ? "bg-accent/[.03]" : ""}`} style={{ gridTemplateRows: `repeat(24,${HH}px)` }}>
                {[...Array(24)].map((_, h) => {
                  const past = k < c.today || (isT && (h + 1) * 60 <= nowM), cur = isT && h === now.getHours();
                  const t = cur ? pad(h) + ":" + pad(Math.min(59, Math.ceil((now.getMinutes() + 1) / 5) * 5)) : pad(h) + ":00", key = `${k}|${h}`;
                  const make = c.can && !past;
                  return (
                    <div key={h} {...c.dz(k, h)} style={past ? hatch : undefined}
                      {...(make ? { role: "button", tabIndex: -1, "aria-label": `New article on ${fmt(d, { weekday: "long", month: "long", day: "numeric" })} at ${t}`, onClick: () => c.create(k, t) } : {})}
                      className={`group relative border-t border-border-soft first:border-t-0 ${make ? "cursor-pointer" : ""} ${c.over === key ? "shadow-[inset_0_0_0_2px_var(--accent)]" : ""}`}>
                      {make && <span className={`pointer-events-none absolute inset-[3px] flex items-center justify-center gap-1 rounded-8 border-[1.5px] border-dashed border-accent bg-surface/75 text-[11.5px] font-semibold text-accent transition-opacity ${c.over === key ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}><Icon k="plus" size={14} />{t}</span>}
                    </div>
                  );
                })}
                {ps.map((a, i) => { const { i: l, n } = lanes[i], w = 100 / n; return (
                  <Tile key={a.slug} a={a} c={c} style={{ top: tileTop(a.time, HH), left: `calc(${(l * w).toFixed(3)}% + 3px)`, width: `calc(${w.toFixed(3)}% - 6px)` }} />
                ); })}
                {isT && <div className="pointer-events-none absolute -left-px right-0 z-[3] h-0 border-t-2 border-accent" style={{ top: (nowM / 60) * HH }}><i className="absolute -left-[5px] -top-[6px] size-2.5 rounded-full bg-accent" /></div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The month: whole weeks, each day with up to three articles and a count */
export function MonthGrid({ c, cells, month, nav, more }: { c: CalCtx; cells: Date[]; month: Date; nav: (d: number) => void; more: (k: string) => void }) {
  const ym = ds(month).slice(0, 7), n = c.list.filter((a) => a.date.slice(0, 7) === ym).length;
  return (
    <div className="flex flex-col">
      <CalBar title={fmt(month, { month: "long", year: "numeric" })} n={n} unit="month" nav={nav} />
      <div className={`grid grid-cols-7 border-b border-border ${headBg}`}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w, i) => <span key={w} className={`grid h-[42px] place-items-center text-[13px] font-medium uppercase tracking-[.02em] text-text-3 max-[760px]:text-[11px] ${i ? "border-l border-border" : ""}`}>{w}</span>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const k = ds(d), other = d.getMonth() !== month.getMonth(), isT = k === c.today, ps = c.list.filter((a) => a.date === k).sort(byTime);
          const show = ps.slice(0, ps.length > 3 ? 2 : 3), make = c.can && k >= c.today;
          return (
            <div key={k} {...c.dz(k)} onClick={() => make && c.create(k)} style={k < c.today ? hatch : undefined}
              className={`@container flex min-h-[112px] min-w-0 flex-col gap-1.5 border-b border-border p-2 transition-colors max-[760px]:min-h-[76px] max-[760px]:p-1 ${(i + 1) % 7 ? "border-r" : ""} ${other ? headBg : ""} ${make ? "cursor-pointer hover:bg-[color-mix(in_srgb,var(--pill)_60%,var(--surface))]" : ""} ${c.over === `${k}|` ? "!bg-accent/[.06] shadow-[inset_0_0_0_2px_var(--accent)]" : ""}`}>
              <div className="flex min-h-[22px] items-center gap-1.5">
                <b className={`mr-auto text-sm font-medium ${isT ? "-ml-[3px] grid size-6 place-items-center rounded-full bg-accent text-white" : other ? "text-text-3" : "text-text-2"}`}>{d.getDate()}</b>
                {!!ps.length && <small className="text-xs text-text-3 max-[760px]:hidden">{plural(ps.length, "article")}</small>}
              </div>
              {show.map((a) => <Tile key={a.slug} a={a} c={c} chip />)}
              {ps.length > 3 && <button onClick={(e) => { e.stopPropagation(); more(k); }} className="cursor-pointer self-start rounded-6 px-1.5 text-xs font-medium text-text-2 hover:bg-pill hover:text-text-1">+{ps.length - 2} more</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One row of the list: time, cover, title and category, status, SEO score */
function Row({ a, c, time }: { a: Article; c: CalCtx; time?: boolean }) {
  const s = score(a);
  return (
    <div role="button" tabIndex={0} draggable={c.can} onClick={() => c.open(a.slug)} onKeyDown={(e) => { if (e.key === "Enter") c.open(a.slug); }}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", a.slug); e.dataTransfer.effectAllowed = "move"; c.dragStart(a.slug); }} onDragEnd={c.dragEnd}
      className={`grid cursor-pointer items-center gap-3 rounded-12 p-2 hover:bg-pill ${time ? "grid-cols-[54px_40px_minmax(0,1fr)_auto_auto] max-[700px]:grid-cols-[48px_minmax(0,1fr)_auto]" : "grid-cols-[40px_minmax(0,1fr)_auto_auto] max-[700px]:grid-cols-[minmax(0,1fr)_auto]"}`}>
      {time && <span className="text-[13px] font-semibold tabular-nums">{a.time || "09:00"}</span>}
      <span className="max-[700px]:hidden"><Cover a={a} size={40} /></span>
      <div className="min-w-0"><p className="truncate text-[13px] font-medium">{a.title || "Untitled"}</p><small className="text-xs text-text-2">{a.cat || "No category"}</small></div>
      <StatusBadge s={a.status} />
      <span className={`text-xs font-semibold max-[700px]:hidden ${scoreClass(s)}`}>SEO {s}</span>
    </div>
  );
}

const Empty = ({ t, p, c, date }: { t: string; p: string; c: CalCtx; date?: string }) => (
  <div className="flex flex-col items-center gap-2 px-4 py-9 text-center text-text-2">
    <Icon k="cal" size={28} /><b className="text-[15px] text-text-1">{t}</b><p className="text-[13px]">{p}</p>
    {c.can && <button onClick={() => c.create(date || "")} className="mt-1 inline-flex h-8 cursor-pointer items-center gap-2 rounded-10 bg-accent px-3 text-[13px] font-medium text-white hover:bg-[#e60c30]"><Icon k="plus" size={16} />New article</button>}
  </div>
);

/** Every dated article, grouped by day */
export function ListView({ c }: { c: CalCtx }) {
  const ps = [...c.list].sort((a, b) => (a.date + pad(minutesOf(a.time))).localeCompare(b.date + pad(minutesOf(b.time))));
  const tomorrow = ds(addDays(day(c.today), 1));
  let last = "";
  return (
    <div className="flex flex-col">
      <CalBar title="All dated articles" n={ps.length} />
      {!ps.length ? <Empty t="No articles match these filters" p="Clear a filter, or plan something new." c={c} /> : (
        <div className="flex flex-col p-2.5">
          {ps.map((a) => {
            const h = a.date !== last; last = a.date;
            return (
              <div key={a.slug}>
                {h && <div className="flex items-center gap-2 px-1 pb-1.5 pt-3.5 text-[13px] font-semibold">{fmt(day(a.date), { weekday: "long", day: "numeric", month: "long", year: a.date.slice(0, 4) === c.today.slice(0, 4) ? undefined : "numeric" })}{a.date === c.today ? <small className="font-medium text-accent">Today</small> : a.date === tomorrow ? <small className="font-medium text-accent">Tomorrow</small> : null}</div>}
                <Row a={a} c={c} time />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Articles without a date: add one by title, open it, or drag it onto the calendar */
export function UnscheduledView({ c, list, add }: { c: CalCtx; list: Article[]; add: (title: string) => void }) {
  return (
    <div className="flex flex-col">
      <CalBar title="Unscheduled" n={list.length} />
      <div className="flex flex-col gap-2 p-2.5">
        {c.can && <input className="rounded-10 border border-transparent bg-pill px-3 py-[9px] text-sm text-text-1 outline-0 focus:border-accent" placeholder="Add a title and press Enter" onKeyDown={(e) => { if (e.key === "Enter") { add(e.currentTarget.value); e.currentTarget.value = ""; } }} />}
        {list.length ? list.map((a) => <Row key={a.slug} a={a} c={c} />) : <p className="px-1 py-3 text-[13px] text-text-2">Nothing unscheduled.{c.can ? " Type a title above and press Enter." : ""}</p>}
        {!!list.length && c.can && <p className="px-1 text-xs text-text-3">To schedule one, open it and pick a date, or drag it from the side panel onto the Week or Month view.</p>}
      </div>
    </div>
  );
}
