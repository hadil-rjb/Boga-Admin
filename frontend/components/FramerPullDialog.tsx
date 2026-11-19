"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Icon from "./Icon";
import { Cta, IconBtn, PillBtn, btn } from "./ui";
import { useFeedback } from "./feedback";
import { api } from "@/lib/api";
import { useData } from "@/lib/data";

type Row = { slug: string; title: string; date: string; img: string; state: "new" | "changed" | "same"; changes: string[]; status: string | null };
type Preview = { items: Row[]; drafts: number };
const FIELD: Record<string, string> = { title: "Title", meta: "Meta description", sub: "Subtitle", cat: "Category", t: "Tags", html: "Content", img: "Cover image", alt: "Alt text", date: "Date" };
const fd = (d: string) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" }) : "No date");

/** "Get from Framer": reads the published articles of the Framer CMS collection, shows what is new or different, and imports the ones picked */
export default function FramerPullDialog({ onClose }: { onClose: () => void }) {
  const { reload } = useData();
  const { toast } = useFeedback();
  const [state, setState] = useState<"busy" | "done" | "error" | "saving">("busy");
  const [err, setErr] = useState("");
  const [p, setP] = useState<Preview | null>(null);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [showSame, setShowSame] = useState(false);
  const load = async () => {
    setState("busy"); setErr("");
    try { const r = await api<Preview>("/framer/pull"); setP(r); setPick(Object.fromEntries(r.items.filter((x) => x.state === "new").map((x) => [x.slug, true]))); setState("done"); }
    catch (e: any) { setErr(e.message || "Could not read Framer"); setState("error"); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && state !== "saving") { e.stopImmediatePropagation(); onClose(); } }; window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true); }, [onClose, state]);

  const group = useMemo(() => ({ new: p?.items.filter((x) => x.state === "new") ?? [], changed: p?.items.filter((x) => x.state === "changed") ?? [], same: p?.items.filter((x) => x.state === "same") ?? [] }), [p]);
  const chosen = Object.keys(pick).filter((k) => pick[k]);
  const nNew = group.new.filter((x) => pick[x.slug]).length, nUpd = group.changed.filter((x) => pick[x.slug]).length;
  const all = (rows: Row[], v: boolean) => setPick((s) => ({ ...s, ...Object.fromEntries(rows.map((x) => [x.slug, v])) }));
  const save = async () => {
    setState("saving");
    try {
      const r = await api<{ created: number; updated: number }>("/framer/pull", { method: "POST", body: { slugs: chosen } });
      await reload();
      toast([r.created && `${r.created} article${r.created === 1 ? "" : "s"} added`, r.updated && `${r.updated} updated`].filter(Boolean).join(", ") + " from Framer");
      onClose();
    } catch (e: any) { toast(e.message || "Import failed"); setState("done"); }
  };

  const item = (x: Row) => {
    const on = !!pick[x.slug], sel = x.state !== "same";
    return (
      <li key={x.slug}>
        <label className={`flex gap-3 rounded-12 border px-3 py-2.5 ${sel ? "cursor-pointer" : ""} ${on ? "border-accent/50 bg-accent/[.03]" : "border-border-soft"}`}>
          {sel && <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={on} onChange={(e) => setPick({ ...pick, [x.slug]: e.target.checked })} />}
          {x.img ? <img src={x.img} alt="" className="size-10 shrink-0 rounded-8 bg-pill object-cover" /> : <span className="flex size-10 shrink-0 items-center justify-center rounded-8 bg-pill text-text-3"><Icon k="image" size={16} /></span>}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-text-1">{x.title}</span>
            <span className="block truncate text-[11px] text-text-3">/blog/{x.slug} · {fd(x.date)}{x.status && x.status !== "Live" ? ` · ${x.status} in the admin` : ""}</span>
            {x.state === "changed" && <span className="mt-1 flex flex-wrap gap-1">{x.changes.map((c) => <span key={c} className="rounded-6 bg-[rgba(217,154,30,.14)] px-1.5 py-px text-[10px] font-medium text-[#b7790f] dark:text-[#e0a83a]">{FIELD[c] ?? c}</span>)}</span>}
          </span>
        </label>
      </li>
    );
  };
  const head = (t: string, n: number, hint: string, rows?: Row[]) => (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1"><p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">{t} · {n}</p><p className="text-xs text-text-3">{hint}</p></div>
      {rows && rows.length > 1 && <button type="button" onClick={() => all(rows, !rows.every((x) => pick[x.slug]))} className="shrink-0 cursor-pointer text-xs font-medium text-accent">{rows.every((x) => pick[x.slug]) ? "Select none" : "Select all"}</button>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={(e) => e.target === e.currentTarget && state !== "saving" && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="pull-title" className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[20px] border border-border bg-surface shadow-[0_24px_64px_rgba(0,0,0,.4)] sm:w-[min(640px,100%)] sm:rounded-[20px]">
        <div className="flex items-start gap-3 border-b border-border-soft px-5 pb-4 pt-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-12 bg-accent/10 text-accent"><Icon k="download" size={20} /></span>
          <div className="min-w-0 flex-1">
            <h3 id="pull-title" className="font-jakarta text-[17px] font-semibold leading-tight">Get from Framer</h3>
            <p className="mt-0.5 text-[13px] text-text-2">Published articles of your Framer CMS collection</p>
          </div>
          <IconBtn aria-label="Close" onClick={onClose} disabled={state === "saving"}><Icon k="x" /></IconBtn>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
          {state === "busy" && (
            <div className="flex flex-col items-center gap-3 py-12 text-center" aria-live="polite">
              <span className="size-8 animate-spin rounded-full border-[3px] border-pill border-t-accent" />
              <p className="text-[13px] text-text-2">Reading your Framer collection…</p>
            </div>
          )}
          {state === "error" && (
            <div className="flex flex-col items-start gap-3">
              <p className="flex items-start gap-2 rounded-10 bg-negative-bg px-3 py-2 text-xs text-negative"><Icon k="alert" size={15} className="shrink-0" />{err}</p>
              {/configur|project url|api key/i.test(err) && <Link href="/settings?s=framer" className={btn("secondary", "sm")}><Icon k="settings" />Open Framer settings</Link>}
            </div>
          )}
          {(state === "done" || state === "saving") && p && (
            <>
              <p className="text-xs leading-relaxed text-text-3">Nothing is sent to Framer. New articles are added as Live; for the others, Framer&apos;s version replaces the fields shown.</p>
              {!p.items.length && <p className="rounded-12 border border-dashed border-border px-4 py-8 text-center text-xs text-text-3">No published article in the Framer collection.</p>}
              {group.new.length > 0 && <div className="flex flex-col gap-2">{head("New on Framer", group.new.length, "Not in the admin yet.", group.new)}<ul className="flex flex-col gap-1.5">{group.new.map(item)}</ul></div>}
              {group.changed.length > 0 && <div className="flex flex-col gap-2">{head("Different on Framer", group.changed.length, "Tick an article to take Framer's version of the fields listed.", group.changed)}<ul className="flex flex-col gap-1.5">{group.changed.map(item)}</ul></div>}
              {group.same.length > 0 && (
                <div className="flex flex-col gap-2">
                  <button type="button" onClick={() => setShowSame(!showSame)} className="flex cursor-pointer items-center gap-1 self-start text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">Up to date · {group.same.length}<Icon k="chevD" size={14} className={showSame ? "rotate-180" : ""} /></button>
                  {showSame && <ul className="flex flex-col gap-1.5">{group.same.map(item)}</ul>}
                </div>
              )}
              {p.drafts > 0 && <p className="text-[11px] text-text-3">{p.drafts} draft{p.drafts === 1 ? "" : "s"} in Framer {p.drafts === 1 ? "was" : "were"} skipped.</p>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-soft px-5 py-4 max-[520px]:grid max-[520px]:grid-cols-2">
          {state === "error" && <><PillBtn onClick={onClose}>Cancel</PillBtn><Cta onClick={load}>Try again</Cta></>}
          {state === "busy" && <PillBtn className="max-[520px]:col-span-2" disabled>Reading…</PillBtn>}
          {(state === "done" || state === "saving") && (group.new.length || group.changed.length
            ? <><PillBtn onClick={onClose} disabled={state === "saving"}>Cancel</PillBtn><Cta onClick={save} disabled={!chosen.length || state === "saving"}>{state === "saving" ? "Importing…" : !chosen.length ? "Nothing selected" : [nNew && `Add ${nNew}`, nUpd && `update ${nUpd}`].filter(Boolean).join(", ").replace(/^u/, "U")}</Cta></>
            : <Cta className="max-[520px]:col-span-2" onClick={onClose}>Close</Cta>)}
        </div>
      </div>
    </div>
  );
}
