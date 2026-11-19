"use client";
import Select from "./Select";
import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { Cta, IconBtn, PillBtn, btn } from "./ui";
import { useFeedback } from "./feedback";
import ArticleFixDialog from "./ArticleFixDialog";
import SeoRecommendations from "./SeoRecommendations";
import ArticleReviewDialog from "./ArticleReviewDialog";
import CoverGen from "./CoverGen";
import LinkPopover from "./LinkPopover";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useData } from "@/lib/data";
import { checks, score, today } from "@/lib/seo";
import type { Article } from "@/lib/types";

const slugify = (s: string) => s.split("|")[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const plain = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const inp = "w-full rounded-10 border border-transparent bg-pill px-3 py-2.5 text-sm text-text-1 outline-0 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60";
const sel = `${inp} cursor-pointer`;
const tbBtn = btn("secondary", "sm", "min-w-8");

const Fr = ({ label, children, hint, hintBad }: { label: string; children: React.ReactNode; hint?: React.ReactNode; hintBad?: boolean }) => (
  <div className="grid grid-cols-1 gap-1 border-b border-border-soft py-4 min-[700px]:grid-cols-[140px_1fr] min-[700px]:gap-3">
    <label className="text-sm min-[700px]:pt-2.5">{label}</label>
    <div>{children}{hint && <p className={`mt-1.5 text-xs ${hintBad ? "text-negative" : "text-text-3"}`}>{hint}</p>}</div>
  </div>
);
const blank = (cat: string, d?: string, tm?: string): Article => ({ slug: "", img: "", alt: "", title: "", meta: "", sub: "", cat, t: ["", "", ""], html: "<p></p>", coverPrompt: "", date: d || "", time: tm || "09:00", status: d && d > today() ? "Scheduled" : "Draft", framerState: "", framerNote: "", framerSyncedAt: null });

export default function ArticleDrawer({ slug, date, time, onClose, refresh, focus }: { slug: string | null; date?: string; time?: string; onClose: () => void; refresh?: "refresh" | "snippet"; focus?: string }) {
  const { articles, user, gsc, reload } = useData();
  const { toast, ask } = useFeedback();
  const can = user.role === "admin" || user.role === "editor";
  const orig = slug ? articles.find((a) => a.slug === slug) : null;
  const cats = [...new Set(articles.map((a) => a.cat).filter(Boolean))].sort();
  const [E, setE] = useState<Article>(() => (orig ? JSON.parse(JSON.stringify(orig)) : blank(cats[0] || "", date, time)));
  const [autoSlug, setAutoSlug] = useState(!orig);
  const [src, setSrc] = useState(false);
  const [blk, setBlk] = useState("p");
  const [srcVal, setSrcVal] = useState("");
  const [imgErr, setImgErr] = useState(false);
  const [gen, setGen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // opened from a Search Console opportunity: go straight to the refresh, once the article is loaded
  const autoFix = useRef(!!refresh);
  useEffect(() => { if (autoFix.current && orig && can) { autoFix.current = false; setFixing(true); } }, [orig, can]);
  const [fr, setFr] = useState<{ enabled: boolean; ready: boolean; timezone?: string } | null>(null);
  const router = useRouter();
  const [lp, setLp] = useState<HTMLAnchorElement | null>(null);
  const lpRef = useRef<HTMLAnchorElement | null>(null);
  lpRef.current = lp;
  const ct = useRef<HTMLDivElement>(null);
  const rng = useRef<Range | null>(null);
  const fi = useRef<HTMLInputElement>(null);
  const set = (p: Partial<Article>) => setE((e) => ({ ...e, ...p }));

  useEffect(() => { if (ct.current) ct.current.innerHTML = E.html; /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (!orig) return; api("/framer/status").then(setFr).catch(() => setFr({ enabled: false, ready: false })); }, [orig]);
  useEffect(() => {
    const h = () => { const s = getSelection(); if (s && s.rangeCount && ct.current?.contains(s.anchorNode)) rng.current = s.getRangeAt(0).cloneRange(); };
    document.addEventListener("selectionchange", h); return () => document.removeEventListener("selectionchange", h);
  }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key !== "Escape") return; if (lpRef.current) setLp(null); else onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const cmd = (c: string, v?: string) => {
    const e = ct.current; if (!e || src) return;
    e.focus();
    if (rng.current) { const s = getSelection()!; s.removeAllRanges(); s.addRange(rng.current); }
    document.execCommand(c, false, c === "formatBlock" && v ? `<${v}>` : v);
    set({ html: e.innerHTML });
  };
  const link = async () => {
    if (!rng.current || rng.current.collapsed) return toast("Select the text to link first");
    const sv = rng.current;
    let u = await ask({ t: "Add link", p: "Leave empty to remove the link.", input: "https://", ok: "Apply" });
    if (u === null) return;
    rng.current = sv; u = String(u).trim();
    if (!u || u === "https://") return cmd("unlink");
    if (!/^(https?:|mailto:|tel:|\/|#)/.test(u)) u = "https://" + u;
    cmd("createLink", u);
    ct.current?.querySelectorAll("a").forEach((x) => { x.target = "_blank"; x.rel = "noopener"; });
    set({ html: ct.current!.innerHTML });
  };
  const toggleSrc = () => {
    if (!src) { setSrcVal(ct.current!.innerHTML); setSrc(true); }
    else { ct.current!.innerHTML = srcVal; set({ html: srcVal }); setSrc(false); }
  };
  const upload = (f?: File) => {
    if (!f || !f.type.startsWith("image/")) return toast("Please choose an image file");
    const r = new FileReader();
    r.onload = () => {
      const i = new Image();
      i.onload = () => { const k = Math.min(1, 1400 / i.width), c = document.createElement("canvas"); c.width = i.width * k; c.height = i.height * k; c.getContext("2d")!.drawImage(i, 0, 0, c.width, c.height); set({ img: c.toDataURL("image/webp", 0.85) }); setImgErr(false); };
      i.src = r.result as string;
    };
    r.readAsDataURL(f);
  };
  const genCover = async () => {
    if (!E.title) { toast("Add a title first"); return ""; }
    setGen(true);
    let out = "";
    try {
      const r = await api("/ai/cover-prompt", { method: "POST", body: { title: E.title, cat: E.cat || undefined, meta: E.meta || undefined, sub: E.sub || undefined, t: E.t.filter(Boolean), text: plain(E.html).slice(0, 1500) || undefined } });
      out = r.coverPrompt;
      set({ coverPrompt: r.coverPrompt, ...(r.alt && !E.alt ? { alt: r.alt } : {}) });
      toast(r.hasStyle ? "Cover prompt ready" : "Cover prompt ready — add a cover style in Settings → Cover images for a consistent look");
    } catch (e: any) { toast(e.message); }
    setGen(false);
    return out;
  };
  const pickCat = async (v: string) => {
    if (v !== "__new") return set({ cat: v });
    const n = await ask({ t: "New category", input: "", ph: "Category name", ok: "Create" });
    if (n && String(n).trim()) set({ cat: String(n).trim() });
  };
  const save = async () => {
    if (!can) return toast("You have view-only access");
    if (!E.title || !E.slug) return toast("Title and slug are required");
    if (articles.some((a) => a.slug === E.slug && a.slug !== orig?.slug)) return toast("This slug is already used");
    if (E.status === "Scheduled" && !E.date) return toast("Pick a date to schedule");
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(E.time || "") ? E.time : "09:00";
    const body = { slug: E.slug, img: E.img || "", alt: E.alt || "", title: E.title, meta: E.meta || "", sub: E.sub || "", cat: E.cat || "", t: E.t.map((x) => x.trim()), html: E.html || "", coverPrompt: E.coverPrompt || "", date: E.date || "", time, status: E.status };
    try {
      if (orig) await api("/articles/" + encodeURIComponent(orig.slug), { method: "PATCH", body }); else await api("/articles", { method: "POST", body });
      await reload(); toast("Article saved"); onClose();
    } catch (e: any) { toast(e.message); }
  };
  const del = async () => {
    if (!can || !orig) return;
    if (await ask({ t: "Delete article?", p: `"${E.title || E.slug}" will be permanently removed.`, ok: "Delete", danger: true })) {
      try { await api("/articles/" + encodeURIComponent(orig.slug), { method: "DELETE" }); await reload(); toast("Article deleted"); onClose(); } catch (e: any) { toast(e.message); }
    }
  };
  const framerNow = async () => {
    if (!orig) return toast("Save the article first");
    if (!(await ask({ t: "Publish to Framer now?", p: `The last saved version of “${E.title}” is added to your Framer CMS and the site is published. The article becomes Live.`, ok: "Publish" }))) return;
    toast("Publishing on Framer…");
    try { await api("/framer/publish/" + encodeURIComponent(orig.slug), { method: "POST" }); await reload(); toast("Published on Framer"); onClose(); } catch (e: any) { toast(e.message); await reload().catch(() => {}); }
  };
  const framerRetry = async () => { try { await api("/framer/retry/" + encodeURIComponent(orig!.slug), { method: "POST" }); toast("Will be retried within a minute"); } catch (e: any) { toast(e.message); } };

  const sc = score(E), base = /^sc-domain:/.test(gsc.site) ? "www." + gsc.domain : gsc.domain;
  const mb = "mt-1.5 text-xs";
  const live = "rounded-6 px-[7px] py-1 text-[10px] font-medium";
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-[min(640px,100%)] flex-col border-l border-border bg-surface shadow-[-20px_0_40px_rgba(0,0,0,.25)]">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 min-[700px]:px-5">
          <IconBtn onClick={onClose}><Icon k="x" /></IconBtn>
          <p className="flex-1 font-medium">{can ? (orig ? "Edit article" : "New article") : "View article"}</p>
          {can && orig && <PillBtn onClick={del}><Icon k="trash" size={18} /><span className="max-[640px]:hidden">Delete</span></PillBtn>}
          {can && <Cta onClick={save}>Save</Cta>}
        </div>
        <fieldset disabled={!can} className="min-w-0 flex-1 overflow-y-auto px-4 pb-10 min-[700px]:px-5">
          <div className="flex flex-wrap gap-1.5 border-b border-border-soft py-3.5">
            <span className={`rounded-6 px-2 py-1 text-[11px] font-semibold ${sc >= 80 ? "bg-positive-bg text-positive" : "bg-negative-bg text-negative"}`}>SEO {sc}/100</span>
            {checks(E).map(([l, ok]) => <span key={l} className={`rounded-6 px-2 py-1 text-[11px] ${ok ? "bg-positive-bg text-positive" : "bg-negative-bg text-negative"}`}>{ok ? "✓" : "✗"} {l}</span>)}
            {can && (
              <button type="button" onClick={() => (E.title.trim() ? setFixing(true) : toast("Add a title first"))}
                className="inline-flex cursor-pointer items-center gap-1 rounded-6 border border-accent/30 bg-accent/[.06] px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/[.12]">
                <Icon k="sparkles" size={13} />{sc < 100 ? "Fix with AI" : "Proofread with AI"}
              </button>
            )}
            {can && (
              <button type="button" onClick={() => (plain(src ? srcVal : E.html).length > 40 ? setReviewing(true) : toast("Write some content first"))}
                className="inline-flex cursor-pointer items-center gap-1 rounded-6 border border-border px-2 py-1 text-[11px] font-medium text-text-2 hover:bg-icon hover:text-text-1">
                <Icon k="shield" size={13} />Check accuracy
              </button>
            )}
          </div>

          <SeoRecommendations a={src ? { ...E, html: srcVal } : E} saved={!!orig} />

          <Fr label="Cover Image" hint="Uploads are stored in this browser. Host the image (e.g. in Framer) before importing the CSV into your CMS.">
            <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files[0]); }}
              className={`relative flex aspect-video max-w-full items-center justify-center overflow-hidden rounded-12 bg-pill min-[700px]:max-w-[420px] ${E.img ? "border border-solid border-border" : "border-[1.5px] border-dashed border-border"}`}>
              {E.img && !imgErr && <img src={E.img} alt="" onError={() => setImgErr(true)} onLoad={() => setImgErr(false)} className="size-full bg-bg object-contain" />}
              {E.img && imgErr && <div className="p-4 text-center text-xs text-negative">Image could not be loaded</div>}
              {!E.img && (
                <div onClick={() => fi.current?.click()} className="flex cursor-pointer flex-col items-center gap-1 p-7 text-center text-xs text-text-2">
                  <Icon k="upload" size={24} /><b className="text-sm font-medium text-text-1">Upload image</b><span>Drag & drop or click · PNG, JPG, WebP</span>
                </div>
              )}
            </div>
            {E.img && can && <div className="my-2.5 flex gap-2"><PillBtn onClick={() => fi.current?.click()}><Icon k="upload" />Replace</PillBtn><PillBtn onClick={() => set({ img: "" })}>Remove</PillBtn></div>}
            <input ref={fi} type="file" accept="image/*" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
            <input className={`${inp} mt-2`} placeholder="Or paste an image URL" value={E.img.startsWith("data:") ? "" : E.img} onChange={(e) => { set({ img: e.target.value }); setImgErr(false); }} />
            <div className="h-2" />
            <input className={inp} placeholder="Alt text — describe the image" value={E.alt} onChange={(e) => set({ alt: e.target.value })} />
          </Fr>

          <Fr label="Cover prompt (AI)" hint="Paste it into Midjourney, DALL·E, Ideogram, Firefly… It follows the visual style of your previous covers (Settings → Cover images).">
            <textarea rows={6} className={inp} placeholder="A ready-to-use prompt for your image generator…" value={E.coverPrompt} onChange={(e) => set({ coverPrompt: e.target.value })} />
            <div className="mt-2 flex flex-wrap gap-2">
              {can && <PillBtn onClick={genCover} disabled={gen}>{gen ? "Generating…" : E.coverPrompt ? "Regenerate" : "Generate with AI"}</PillBtn>}
              <PillBtn onClick={() => E.coverPrompt ? navigator.clipboard.writeText(E.coverPrompt).then(() => toast("Prompt copied"), () => toast("Could not copy")) : toast("Nothing to copy yet")}>Copy prompt</PillBtn>
            </div>
            {can && <CoverGen title={E.title} slug={E.slug} ensurePrompt={async () => E.coverPrompt.trim() || genCover()} onUse={(url) => { set({ img: url }); setImgErr(false); }} />}
          </Fr>

          <Fr label="Status"><Select className="w-full" value={E.status} onChange={(v) => set({ status: v })}>{["Draft", "Scheduled", "Live"].map((s) => <option key={s}>{s}</option>)}</Select></Fr>
          <Fr label="Publish date & time" hint={`Time zone: ${fr?.timezone || "server default"}`}>
            <div className="flex gap-2"><input type="date" className={`${inp} max-w-[220px]`} value={E.date} onChange={(e) => set({ date: e.target.value })} /><input type="time" className={`${inp} max-w-[140px]`} value={E.time || "09:00"} onChange={(e) => set({ time: e.target.value })} /></div>
          </Fr>

          {orig && (
            <Fr label="Framer">
              {E.framerState === "synced" ? <div><span className={`${live} bg-positive-bg text-positive`}>Published on Framer</span> <span className="text-[11px] text-text-3">{E.framerSyncedAt ? new Date(E.framerSyncedAt).toLocaleString("en") : ""}</span>{E.framerNote && <p className={`${mb} text-text-3`}>{E.framerNote}</p>}</div>
                : E.framerState === "error" ? <div><span className={`${live} bg-pill text-text-2`}>Failed</span><p className={`${mb} text-negative`}>{E.framerNote || "Unknown error"}</p></div>
                : fr?.enabled && E.status === "Scheduled" && E.date ? <div><span className={`${live} bg-accent/[.08] text-accent`}>Auto-publish</span> <span className="text-[11px] text-text-3">{E.date} at {E.time || "09:00"} ({fr.timezone})</span></div>
                : <span className="text-[11px] text-text-3">{fr?.enabled ? "Set the status to Scheduled with a date and time to auto-publish on Framer." : "Auto-publish is off — enable it in Settings → Framer."}</span>}
              {can && fr?.ready && <div className="mt-2 flex flex-wrap gap-2"><PillBtn onClick={framerNow}>Publish to Framer now</PillBtn>{E.framerState === "error" && <PillBtn onClick={framerRetry}>Retry</PillBtn>}</div>}
            </Fr>
          )}

          <Fr label="Title" hint={`${E.title.length}/60 characters`} hintBad={E.title.length > 60}>
            <input className={inp} value={E.title} onChange={(e) => set({ title: e.target.value, ...(autoSlug ? { slug: slugify(e.target.value) } : {}) })} />
          </Fr>
          <Fr label="Meta Description" hint={`${E.meta.length}/160 characters · ideal 120–160`} hintBad={!!E.meta.length && (E.meta.length < 120 || E.meta.length > 160)}>
            <textarea rows={3} className={inp} value={E.meta} onChange={(e) => set({ meta: e.target.value })} />
          </Fr>
          <Fr label="Subtitle"><input className={inp} value={E.sub} onChange={(e) => set({ sub: e.target.value })} /></Fr>
          <Fr label="Category">
            <Select className="w-full" value={E.cat} onChange={(v) => pickCat(v)}>
              {[...new Set([...cats, E.cat].filter(Boolean))].map((c) => <option key={c}>{c}</option>)}<option value="__new">+ New category…</option>
            </Select>
          </Fr>
          {[0, 1, 2].map((i) => <Fr key={i} label={"Tag " + (i + 1)}><input className={inp} value={E.t[i]} onChange={(e) => set({ t: E.t.map((x, j) => (j === i ? e.target.value : x)) })} /></Fr>)}
          <Fr label="Slug" hint={`${base}/blog/${E.slug}`}><input className={inp} value={E.slug} onChange={(e) => { setAutoSlug(false); set({ slug: e.target.value }); }} /></Fr>

          <Fr label="Content">
            {can && (
              <div className="mb-2 flex flex-wrap items-center gap-1">
                <Select className="w-[150px] max-[700px]:w-[132px]" aria-label="Text style" value={blk} onChange={(v) => { setBlk(v); cmd("formatBlock", v); }}>
                  <option value="p">Paragraph</option>{[1, 2, 3, 4, 5, 6].map((i) => <option key={i} value={"h" + i}>Heading {i}</option>)}
                </Select>
                <button className={tbBtn} onMouseDown={(e) => { e.preventDefault(); cmd("bold"); }}><b>B</b></button>
                <button className={tbBtn} onMouseDown={(e) => { e.preventDefault(); cmd("italic"); }}><i>I</i></button>
                <button className={tbBtn} onMouseDown={(e) => e.preventDefault()} onClick={link}>Link</button>
                <button className={tbBtn} onMouseDown={(e) => { e.preventDefault(); cmd("insertUnorderedList"); }}>• List</button>
                <button className={tbBtn} onMouseDown={(e) => { e.preventDefault(); cmd("insertOrderedList"); }}>1. List</button>
                <button className={tbBtn} onMouseDown={(e) => { e.preventDefault(); cmd("formatBlock", "blockquote"); }}>❝</button>
                <button className={tbBtn} onClick={toggleSrc}>&lt;/&gt;</button>
              </div>
            )}
            <div ref={ct} contentEditable={can && !src} suppressContentEditableWarning onInput={(e) => set({ html: e.currentTarget.innerHTML })} onClick={(e) => { const a = (e.target as HTMLElement).closest("a"); if (a) { e.preventDefault(); setLp(a as HTMLAnchorElement); } else setLp(null); }}
              className={`min-h-80 rounded-10 bg-pill p-3.5 text-[15px] leading-[1.65] outline-0 ${src ? "hidden" : ""} [&_a]:cursor-pointer [&_a]:text-accent [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-accent [&_blockquote]:pl-3.5 [&_blockquote]:text-text-2 [&_h1]:text-[28px] [&_h2]:text-[22px] [&_h3]:text-lg [&_h4]:text-base [&_h5]:text-sm [&_h6]:text-xs [&_h6]:uppercase [&_h6]:tracking-[.05em] [&_h1]:mb-2 [&_h2]:mb-2 [&_h3]:mb-2 [&_h4]:mb-2 [&_h1]:mt-[18px] [&_h2]:mt-[18px] [&_h3]:mt-[18px] [&_h4]:mt-[18px] [&_h1]:leading-[1.3] [&_h2]:leading-[1.3] [&_h3]:leading-[1.3] [&_img]:max-w-full [&_img]:rounded-8 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-[22px] [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-[22px]`} />
            {src && <textarea rows={16} className={inp} value={srcVal} onChange={(e) => setSrcVal(e.target.value)} />}
          </Fr>
        </fieldset>
      </aside>
      {fixing && <ArticleFixDialog article={src ? { ...E, html: srcVal } : E} saved={!!orig} mode={refresh} focus={focus} onClose={() => setFixing(false)} onApply={(p) => {
        set(p);
        if (p.slug) setAutoSlug(false);
        if (p.html !== undefined) { if (ct.current) ct.current.innerHTML = p.html; if (src) setSrcVal(p.html); }
        setFixing(false);
        toast(`${Object.keys(p).length} change${Object.keys(p).length === 1 ? "" : "s"} applied — review, then Save`);
      }} />}
      {reviewing && <ArticleReviewDialog article={src ? { ...E, html: srcVal } : E} onClose={() => setReviewing(false)} onApply={(html, n) => {
        set({ html });
        if (ct.current) ct.current.innerHTML = html;
        if (src) setSrcVal(html);
        setReviewing(false);
        toast(`${n} rewrite${n === 1 ? "" : "s"} applied — review, then Save`);
      }} />}
      {lp && <LinkPopover a={lp} articles={articles} base={base} can={can} toast={toast} onClose={() => setLp(null)} onChange={() => set({ html: ct.current!.innerHTML })}
        onView={async (slug) => { setLp(null); const t = articles.find((x) => x.slug === slug); if (!t) return; if (can && !(await ask({ t: `Open “${t.title}”?`, p: "Unsaved changes in the current article will be lost — save first if needed.", ok: "Open article" }))) return; router.push(`/articles?edit=${encodeURIComponent(slug)}`); }} />}
    </>
  );
}
