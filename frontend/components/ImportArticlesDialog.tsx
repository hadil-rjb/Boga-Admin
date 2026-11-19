"use client";
import Select from "./Select";
import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon";
import { Button, Cta, IconBtn, PillBtn } from "./ui";
import { StatusBadge } from "./table";
import { useFeedback } from "./feedback";
import { api } from "@/lib/api";
import { useData } from "@/lib/data";
import { plural } from "@/lib/seo";
import { ACCEPT, FIELDS, autoMap, buildRows, headerIndex, plan, readFile, runImport, type Book, type Field, type Mapping, type Mode, type Outcome } from "@/lib/import";

const MAX_MB = 20, SHOWN = 150;
const Label = ({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-2"><h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">{children}</h4>{right}</div>
);
const Chip = ({ tone, children }: { tone: "pos" | "acc" | "neg" | "warn" | "mute"; children: React.ReactNode }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${{ pos: "bg-positive-bg text-positive", acc: "bg-accent/[.08] text-accent", neg: "bg-negative-bg text-negative", warn: "bg-[#d99a1e]/[.12] text-[#b07a10] dark:text-[#e5ad3a]", mute: "bg-pill text-text-2" }[tone]}`}>{children}</span>
);
const plain = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;|&lt;|&gt;/g, " ").replace(/\s+/g, " ").trim();
const fd = (d: string) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en", { month: "short", day: "2-digit", year: "numeric" }) : "");

export default function ImportArticlesDialog({ onClose }: { onClose: () => void }) {
  const { articles, reload } = useData();
  const { toast } = useFeedback();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [sheet, setSheet] = useState(0);
  const [map, setMap] = useState<Mapping>([]);
  const [mode, setMode] = useState<Mode>("skip");
  const [only, setOnly] = useState(false), [cols, setCols] = useState(false);
  const [busy, setBusy] = useState(false), [drag, setDrag] = useState(false);
  const [run, setRun] = useState<{ done: number; total: number; last?: string; wait?: string } | null>(null);
  const [result, setResult] = useState<Outcome[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = !!run && !result;

  const close = () => { if (running) return; onClose(); };
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && close(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); });
  // leaving mid-import (page closed or reloaded) would stop it half way
  useEffect(() => { if (!running) return; const b = (e: BeforeUnloadEvent) => e.preventDefault(); window.addEventListener("beforeunload", b); return () => window.removeEventListener("beforeunload", b); }, [running]);

  const grid = book?.sheets[sheet]?.rows || [];
  const head = useMemo(() => headerIndex(grid), [grid]);
  const headers = useMemo(() => (grid[head] || []).map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`), [grid, head]);
  const rows = useMemo(() => buildRows(grid, head, map, articles.map((a) => a.slug)), [grid, head, map, articles]);
  const n = useMemo(() => {
    const c = { created: 0, updated: 0, skipped: 0, invalid: 0, warn: 0 };
    rows.forEach((r) => { c[plan(r, mode)]++; if (!r.errors.length && r.warnings.length) c.warn++; });
    return c;
  }, [rows, mode]);
  const existing = rows.filter((r) => r.exists && !r.errors.length).length;
  const sched = rows.filter((r) => plan(r, mode) !== "invalid" && plan(r, mode) !== "skipped" && r.body.status === "Scheduled").length;
  const live = rows.filter((r) => plan(r, mode) === "created" && r.body.status === "Live").length;
  const sending = n.created + n.updated;
  const shown = (only ? rows.filter((r) => r.errors.length || r.warnings.length) : rows);
  const mapped = new Set(map.filter(Boolean));

  const pick = async (f?: File | null) => {
    if (!f) return;
    if (f.size > MAX_MB * 1048576) return toast(`This file is over ${MAX_MB} MB`);
    setBusy(true);
    try {
      const b = await readFile(f);
      // the first sheet with a Title column, else the one with most rows
      const titled = b.sheets.findIndex((s) => s.rows.length > 1 && autoMap(s.rows[headerIndex(s.rows)] || []).includes("title"));
      const i = titled >= 0 ? titled : b.sheets.reduce((m, s, j) => (s.rows.length > b.sheets[m].rows.length ? j : m), 0);
      if (!b.sheets.some((s) => s.rows.length)) throw new Error("This file is empty");
      setFile(f); setBook(b); selectSheet(b, i);
    } catch (e: any) { toast(e?.message || "Could not read this file"); }
    setBusy(false);
    if (input.current) input.current.value = "";
  };
  const selectSheet = (b: Book, i: number) => { const g = b.sheets[i].rows; setSheet(i); const m = autoMap(g[headerIndex(g)] || []); setMap(m); setCols(false); setOnly(false); };
  const setCol = (i: number, k: string) => setMap((m) => m.map((x, j) => (j === i ? (k as Field | "") : k && x === k ? "" : x)));
  const reset = () => { setFile(null); setBook(null); setMap([]); setResult(null); setRun(null); };

  const start = async () => {
    abort.current = new AbortController();
    setRun({ done: 0, total: sending });
    const out = await runImport(rows, mode, {
      api: (p, o) => api(p, o), signal: abort.current.signal,
      onProgress: (done, total, last, wait) => setRun({ done, total, last: last.title || last.slug, wait }),
    });
    await reload().catch(() => {});
    setResult(out);
    const c = out.filter((o) => o.result === "created").length, u = out.filter((o) => o.result === "updated").length;
    toast(c || u ? `Import finished: ${plural(c, "article")} created${u ? `, ${u} updated` : ""}` : "Import finished, nothing was created");
  };

  const sum = result && {
    created: result.filter((o) => o.result === "created"), updated: result.filter((o) => o.result === "updated"),
    skipped: result.filter((o) => o.result === "skipped"), failed: result.filter((o) => o.result === "failed"),
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-labelledby="imp-title" className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[20px] border border-border bg-surface shadow-[0_24px_64px_rgba(0,0,0,.4)] sm:w-[min(760px,100%)] sm:rounded-[20px]">
        <div className="flex items-start gap-3 border-b border-border-soft px-5 pb-4 pt-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-12 bg-accent/10 text-accent"><Icon k="upload" size={20} /></span>
          <div className="min-w-0 flex-1">
            <h3 id="imp-title" className="font-jakarta text-[17px] font-semibold leading-tight">Import articles</h3>
            <p className="mt-0.5 truncate text-[13px] text-text-2">{file ? file.name : "Create articles from an Excel or CSV file."}</p>
          </div>
          <IconBtn aria-label="Close" onClick={close} disabled={running}><Icon k="x" /></IconBtn>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
          {/* 1 · choose a file */}
          {!book && (
            <>
              <button type="button" disabled={busy} onClick={() => input.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
                className={`flex flex-col items-center gap-2 rounded-16 border-2 border-dashed px-5 py-10 text-center transition-colors ${drag ? "border-accent bg-accent/[.05]" : "border-border hover:border-text-3 hover:bg-icon"} ${busy ? "cursor-wait opacity-70" : "cursor-pointer"}`}>
                <span className="flex size-12 items-center justify-center rounded-full bg-pill text-text-2"><Icon k="doc" size={22} /></span>
                <span className="font-medium text-text-1">{busy ? "Reading the file…" : "Choose a file or drop it here"}</span>
                <span className="text-xs text-text-3">.xlsx, .xls or .csv · up to {MAX_MB} MB</span>
              </button>
              <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
              <div className="rounded-12 bg-pill px-4 py-3 text-[13px] leading-relaxed text-text-2">
                <p>One article per row, with a header row. <b className="font-medium text-text-1">Title</b> is required; Slug, Category, Status, Date, Subtitle, Content, Meta Description, Cover Image, Tags… are optional and can be matched to your own column names in the next step.</p>
                <p className="mt-1.5">A file from <b className="font-medium text-text-1">Export CSV</b> imports as is. New articles are saved as <b className="font-medium text-text-1">Draft</b> unless the file has a Status column.</p>
              </div>
            </>
          )}

          {/* 2 · review */}
          {book && !run && (
            <>
              {book.sheets.length > 1 && (
                <section className="flex flex-col gap-2.5">
                  <Label>Sheet</Label>
                  <Select aria-label="Sheet" variant="outline" value={String(sheet)} onChange={(v) => selectSheet(book, +v)}>
                    {book.sheets.map((s, i) => <option key={i} value={String(i)}>{s.name} ({plural(Math.max(0, s.rows.length - 1), "row")})</option>)}
                  </Select>
                </section>
              )}

              <section className="flex flex-col gap-2.5">
                <Label right={!mapped.has("title") ? <span className="text-xs font-medium text-negative">Pick the Title column</span> : (
                  <button type="button" aria-expanded={cols} onClick={() => setCols(!cols)} className="flex cursor-pointer items-center gap-1 text-xs text-text-3 hover:text-text-1">
                    {mapped.size} of {headers.length} used · {cols ? "Hide" : "Edit"}<Icon k="chevD" size={14} className={cols ? "rotate-180" : ""} />
                  </button>
                )}>Columns</Label>
                {(cols || !mapped.has("title")) ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {headers.map((h, i) => (
                    <div key={i} className="flex min-w-0 items-center gap-2 rounded-10 border border-border-soft py-1.5 pl-3 pr-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-text-1" title={h}>{h}</span>
                      <Icon k="arrowR" size={14} className="text-text-3" />
                      <Select aria-label={`Field for column ${h}`} size="sm" align="right" className={`w-[160px] shrink-0 ${map[i] ? "" : "text-text-3"}`} value={map[i] || ""} onChange={(v) => setCol(i, v)}>
                        <option value="">Don&apos;t import</option>
                        {FIELDS.map((f) => <option key={f.k} value={f.k}>{f.label}</option>)}
                      </Select>
                    </div>
                  ))}
                </div> : (
                  <p className="text-xs leading-relaxed text-text-3">{headers.map((h, i) => map[i] && <span key={i} className="mr-1 mb-1 inline-block rounded-6 bg-pill px-1.5 py-0.5 text-text-2">{h} → {FIELDS.find((f) => f.k === map[i])!.label}</span>)}{headers.length > mapped.size && <span className="inline-block py-0.5">{plural(headers.length - mapped.size, "column")} not imported</span>}</p>
                )}
              </section>

              {existing > 0 && (
                <section className="flex flex-col gap-2.5">
                  <Label>{plural(existing, "slug")} already exist{existing === 1 ? "s" : ""}</Label>
                  <div role="radiogroup" className="grid grid-cols-2 gap-2">
                    {([["skip", "Skip them", "Keep the current articles as they are"], ["update", "Update them", "Replace their fields with the file's non-empty cells"]] as const).map(([v, t, d]) => (
                      <button key={v} type="button" role="radio" aria-checked={mode === v} onClick={() => setMode(v)}
                        className={`rounded-12 border px-3 py-2.5 text-left transition-colors ${mode === v ? "border-accent bg-accent/[.05]" : "border-border hover:bg-icon"}`}>
                        <span className="flex items-center gap-1.5 text-[13px] font-medium text-text-1"><span className={`grid size-4 place-items-center rounded-full border ${mode === v ? "border-accent" : "border-border"}`}>{mode === v && <i className="size-2 rounded-full bg-accent" />}</span>{t}</span>
                        <span className="mt-0.5 block text-xs text-text-3">{d}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section className="flex flex-col gap-2.5">
                <Label right={(n.invalid > 0 || n.warn > 0) && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-2"><input type="checkbox" className="accent-[var(--accent)]" checked={only} onChange={(e) => setOnly(e.target.checked)} />Only rows with issues</label>
                )}>{plural(rows.length, "row")} found</Label>
                <div className="flex flex-wrap gap-1.5">
                  {n.created > 0 && <Chip tone="pos"><Icon k="plus" size={13} />{n.created} new</Chip>}
                  {n.updated > 0 && <Chip tone="acc"><Icon k="pen" size={13} />{n.updated} to update</Chip>}
                  {n.skipped > 0 && <Chip tone="mute">{n.skipped} already exist{n.skipped === 1 ? "s" : ""}, skipped</Chip>}
                  {n.invalid > 0 && <Chip tone="neg"><Icon k="x" size={13} />{n.invalid} invalid</Chip>}
                  {n.warn > 0 && <Chip tone="warn"><Icon k="alert" size={13} />{n.warn} with warnings</Chip>}
                </div>
                {(sched > 0 || live > 0) && (
                  <p className="flex gap-2 rounded-10 bg-accent/[.06] px-3 py-2 text-xs leading-relaxed text-text-2"><Icon k="clock" size={15} className="mt-px text-accent" />
                    <span>{sched > 0 && <>{plural(sched, "Scheduled article")} will be published to Framer on {sched === 1 ? "its" : "their"} date (right away if it&apos;s past) when Framer publishing is on. </>}{live > 0 && <>{plural(live, "article")} will be marked Live here without being sent to Framer.</>}</span>
                  </p>
                )}
                <ul className="flex flex-col divide-y divide-border-soft overflow-hidden rounded-12 border border-border-soft">
                  {shown.slice(0, SHOWN).map((r) => {
                    const p = plan(r, mode), b = r.body, ex = b.sub || plain(b.html);
                    return (
                      <li key={r.line} className={`flex gap-3 px-3 py-2.5 ${p === "invalid" ? "bg-negative-bg/40" : p === "skipped" ? "opacity-60" : ""}`}>
                        <span className="w-7 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-text-3" title="Line in the file">{r.line}</span>
                        {b.img ? <img src={b.img} alt="" className="size-9 shrink-0 rounded-8 bg-pill object-cover" /> : <span className="grid size-9 shrink-0 place-items-center rounded-8 bg-pill font-jakarta text-sm font-semibold text-text-3">{(r.title || "?")[0]}</span>}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <p className={`truncate text-[13px] font-medium ${r.title ? "text-text-1" : "italic text-text-3"}`}>{r.title || "No title"}</p>
                              <p className="truncate text-[11px] text-text-3">{r.slug ? `/blog/${r.slug}` : "—"}{b.cat && ` · ${b.cat}`}{b.date && ` · ${fd(b.date)}`}{b.t.some(Boolean) && ` · ${b.t.filter(Boolean).join(", ")}`}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {p === "updated" && <span className="text-[11px] font-medium text-accent">Update</span>}
                              {p === "skipped" && <span className="text-[11px] text-text-3">Exists</span>}
                              {p !== "invalid" && (r.fields.status || !r.exists) && <StatusBadge s={r.fields.status || "Draft"} />}
                            </div>
                          </div>
                          {ex && <p className="mt-1 line-clamp-1 text-xs text-text-2">{ex}</p>}
                          {(b.meta || b.alt) && <p className="mt-0.5 truncate text-[11px] text-text-3">{b.meta && <>Meta: {b.meta}</>}{b.meta && b.alt && " · "}{b.alt && <>Alt: {b.alt}</>}</p>}
                          {r.errors.map((e) => <p key={e} className="mt-1 flex items-center gap-1 text-xs font-medium text-negative"><Icon k="x" size={13} />{e}</p>)}
                          {r.warnings.map((w) => <p key={w} className="mt-1 flex items-center gap-1 text-xs text-[#b07a10] dark:text-[#e5ad3a]"><Icon k="alert" size={13} />{w}</p>)}
                        </div>
                      </li>
                    );
                  })}
                  {!shown.length && <li className="p-6 text-center text-xs text-text-3">{rows.length ? "No issues." : "No rows under the header."}</li>}
                  {shown.length > SHOWN && <li className="p-3 text-center text-xs text-text-3">…and {shown.length - SHOWN} more</li>}
                </ul>
              </section>
            </>
          )}

          {/* 3 · progress */}
          {running && run && (
            <section className="flex flex-col items-center gap-4 py-8 text-center" aria-live="polite">
              <p className="font-jakarta text-[28px] font-semibold tabular-nums">{run.done}<span className="text-text-3"> / {run.total}</span></p>
              <div className="h-2 w-full max-w-[420px] overflow-hidden rounded-full bg-pill"><i className="block h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${run.total ? (run.done / run.total) * 100 : 0}%` }} /></div>
              <p className="max-w-full truncate text-[13px] text-text-2">{run.wait || (run.last ? `Saved “${run.last}”` : "Starting…")}</p>
              <p className="text-xs text-text-3">Articles are sent one at a time. Keep this window open.</p>
            </section>
          )}

          {/* 4 · summary */}
          {sum && (
            <section className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([["Created", sum.created.length, "text-positive"], ["Updated", sum.updated.length, "text-accent"], ["Skipped", sum.skipped.length, "text-text-2"], ["Failed", sum.failed.length, "text-negative"]] as const).map(([l, v, c]) => (
                  <div key={l} className="rounded-12 border border-border-soft px-3 py-2.5"><p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">{l}</p><p className={`font-jakarta text-[22px] font-semibold tabular-nums ${v ? c : "text-text-3"}`}>{v}</p></div>
                ))}
              </div>
              {[...sum.failed, ...sum.skipped].length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <Label>Not imported</Label>
                  <ul className="flex flex-col divide-y divide-border-soft overflow-hidden rounded-12 border border-border-soft">
                    {[...sum.failed, ...sum.skipped].map((o) => (
                      <li key={o.line} className="flex gap-3 px-3 py-2">
                        <span className="w-7 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-text-3">{o.line}</span>
                        <div className="min-w-0 flex-1"><p className="truncate text-[13px] text-text-1">{o.title || o.slug || "No title"}</p><p className={`text-xs ${o.result === "failed" ? "text-negative" : "text-text-3"}`}>{o.result === "failed" ? "Failed: " : ""}{o.reason}</p></div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>

        {book && (
          <div className="flex items-center justify-end gap-2 border-t border-border-soft px-5 py-4 max-[520px]:grid max-[520px]:grid-cols-2">
            {!run && <><Button variant="ghost" className="mr-auto max-[520px]:order-last max-[520px]:col-span-2" onClick={reset}>Choose another file</Button><PillBtn onClick={close}>Cancel</PillBtn><Cta onClick={start} disabled={!sending}>{sending ? `Import ${plural(sending, "article")}` : "Nothing to import"}</Cta></>}
            {running && <PillBtn className="max-[520px]:col-span-2" onClick={() => abort.current?.abort()}>Stop</PillBtn>}
            {result && <><Button variant="ghost" className="mr-auto max-[520px]:order-last max-[520px]:col-span-2" onClick={reset}>Import another file</Button><Cta className="max-[520px]:col-span-2" onClick={onClose}>Done</Cta></>}
          </div>
        )}
      </div>
    </div>
  );
}
