"use client";
import { useEffect, useState } from "react";
import Icon from "../Icon";
import Select from "../Select";
import { Button, Cta, PillBtn } from "../ui";
import { Acts, Field, FieldGrid, PanelHead, Split, inpCls, taCls } from "../split";
import { useFeedback } from "../feedback";
import { api } from "@/lib/api";
import { useData } from "@/lib/data";
import { since } from "@/lib/seo";
import { BotSettings as S, hostOf, WIDGET_DEFAULTS, WIDGET_ICONS, WidgetConfig, downloadExport, embedCode, widgetOf } from "@/lib/chatbot";
import WidgetPreview from "./WidgetPreview";

const Badge = ({ on, a = "Connected", b = "Not connected" }: { on: boolean; a?: string; b?: string }) => <span className={`shrink-0 rounded-6 px-[7px] py-1 text-[10px] font-medium ${on ? "bg-positive-bg text-positive" : "bg-pill text-text-2"}`}>{on ? a : b}</span>;
const Hint = ({ children, bad }: { children: React.ReactNode; bad?: boolean }) => <p className={`text-xs ${bad ? "text-negative" : "text-text-3"}`}>{children}</p>;
const Sub = ({ children }: { children: React.ReactNode }) => <h3 className="-mb-2 border-t border-border-soft pt-5 text-[11px] font-medium uppercase tracking-[0.06em] text-text-3">{children}</h3>;
const SWATCHES = ["#fd0e35", "#ff3b3b", "#2563eb", "#7c3aed", "#059669", "#0f172a"];

// ───────── Connection : le site suffit ─────────
const STEPS = ["Opening your website", "Finding the chat widget", "Checking the assistant"];
function Connection({ s, onChange, go }: { s: S; onChange: (s: S) => void; go: (k: string) => void }) {
  const { user, gsc } = useData();
  const { toast, ask } = useFeedback();
  const own = user.role === "admin";
  const [site, setSite] = useState(hostOf(s.website || gsc.domain || "")), [busy, setBusy] = useState(false), [step, setStep] = useState(0), [err, setErr] = useState(""), [edit, setEdit] = useState(!s.connected);
  // étapes affichées pendant la recherche (la vraie recherche se fait côté serveur)
  useEffect(() => { if (!busy) return; setStep(0); const t = setInterval(() => setStep((x) => Math.min(x + 1, STEPS.length - 1)), 1400); return () => clearInterval(t); }, [busy]);
  const connect = async () => {
    if (!site.trim()) return setErr("Enter your website, e.g. uxboga.com");
    setBusy(true); setErr("");
    try { const r = await api<S>("/chatbot/connect", { method: "POST", body: { website: site.trim() } }); onChange(r); setSite(hostOf(r.website)); setEdit(false); toast(`Connected to ${hostOf(r.website)}`); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const disc = async () => {
    if (!(await ask({ t: "Disconnect the chatbot?", p: "The widget on your site keeps working. This admin just stops showing its data until you connect again.", ok: "Disconnect", danger: true }))) return;
    try { onChange(await api<S>("/chatbot/settings", { method: "DELETE" })); setEdit(true); toast("Chatbot disconnected"); } catch (e: any) { toast(e.message); }
  };
  const notOnSite = /isn't on|couldn't open/.test(err);

  return <>
    <PanelHead title="Website" desc="Enter your website. The admin finds the assistant installed on it and connects by itself: no server address or key to copy." right={<Badge on={s.connected} />} />

    {s.connected && !edit ? (
      <div className="flex flex-wrap items-center gap-3 rounded-12 border border-border p-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-10 bg-positive-bg text-positive"><Icon k="globe" size={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{s.website ? hostOf(s.website) : "Your website"}</p>
          <p className="truncate text-xs text-text-2">{s.source === "site" ? "Assistant found on your website" : "Assistant set on the server"} · {hostOf(s.apiUrl)}</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-text-3"><Icon k="checkCircle" size={14} className="text-positive" />{s.connectedAt ? `Connected ${since(s.connectedAt)}` : "Connected automatically"}</span>
      </div>
    ) : (
      <Field label="Website address" hint="The site where your chat bubble is published.">
        <div className={`flex items-center rounded-10 border bg-pill focus-within:border-accent ${err ? "border-negative/50" : "border-transparent"}`}>
          <span className="select-none pl-3 text-sm text-text-3">https://</span>
          <input className="min-w-0 flex-1 bg-transparent px-1 py-[9px] text-sm text-text-1 outline-0 max-[700px]:min-h-10" value={site} onChange={(e) => { setSite(e.target.value.replace(/^https?:\/\//, "")); setErr(""); }} placeholder="uxboga.com" disabled={!own || busy} inputMode="url" autoComplete="url" autoFocus={!s.connected} onKeyDown={(e) => e.key === "Enter" && connect()} aria-invalid={!!err} />
          {site && !busy && <button type="button" onClick={() => setSite("")} aria-label="Clear" className="mr-1.5 flex size-7 cursor-pointer items-center justify-center rounded-8 text-text-3 hover:bg-icon hover:text-text-1"><Icon k="x" size={15} /></button>}
        </div>
      </Field>
    )}

    {busy && (
      <ol className="flex flex-col gap-2 rounded-12 bg-icon p-4" aria-live="polite">
        {STEPS.map((t, i) => (
          <li key={t} className={`flex items-center gap-2.5 text-[13px] ${i <= step ? "text-text-1" : "text-text-3"}`}>
            {i < step ? <Icon k="checkCircle" size={16} className="text-positive" /> : i === step ? <span className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" /> : <span className="size-4 rounded-full border-2 border-border" />}
            {i === 0 ? `Opening ${hostOf(site)}` : t}
          </li>
        ))}
      </ol>
    )}

    {err && (
      <div role="alert" className="flex flex-col gap-2.5 rounded-12 bg-negative-bg px-4 py-3 text-[13px] text-negative">
        <p className="flex items-start gap-2"><Icon k="alert" size={16} className="mt-px shrink-0" />{err}</p>
        {notOnSite && <button onClick={() => go("install")} className="inline-flex w-fit cursor-pointer items-center gap-1.5 pl-6 font-medium underline-offset-2 hover:underline">Get the widget code<Icon k="arrowR" size={14} /></button>}
      </div>
    )}

    {!s.keyConfigured && (
      <div className="flex gap-3 rounded-12 border border-border p-4 text-[13px] text-text-2">
        <Icon k="lock" size={18} className="mt-0.5 shrink-0 text-text-3" />
        <div><b className="text-text-1">One-time server setup</b><p className="mt-1">The admin API needs the chatbot&apos;s admin key in its environment: add <code className="rounded-6 bg-pill px-1.5 py-0.5 text-[12px]">CHATBOT_ADMIN_KEY</code> with the same value as <code className="rounded-6 bg-pill px-1.5 py-0.5 text-[12px]">ADMIN_API_KEY</code> on the chatbot server, then restart. Nobody has to type it here.</p></div>
      </div>
    )}

    {own ? (
      s.connected && !edit
        ? <Acts><PillBtn onClick={disc}>Disconnect</PillBtn><PillBtn onClick={() => { setEdit(true); setErr(""); }}>Change website</PillBtn></Acts>
        : <Acts one={!s.connected}>{s.connected && <PillBtn onClick={() => { setEdit(false); setErr(""); setSite(hostOf(s.website)); }} disabled={busy}>Cancel</PillBtn>}<Cta onClick={connect} disabled={busy || !s.keyConfigured}>{busy ? "Connecting…" : "Connect"}</Cta></Acts>
    ) : <Hint>Only the workspace owner can change the connection.</Hint>}
  </>;
}

// ───────── Widget (apparence + aperçu en direct) ─────────
function Widget({ s, onChange }: { s: S; onChange: (s: S) => void }) {
  const { user } = useData();
  const { toast, ask } = useFeedback();
  const own = user.role === "admin";
  const saved = widgetOf(s);
  const [w, setW] = useState<WidgetConfig>(saved), [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(w) !== JSON.stringify(saved);
  const set = <K extends keyof WidgetConfig>(k: K, v: WidgetConfig[K]) => setW((x) => ({ ...x, [k]: v }));
  // avertit avant de quitter la page avec des changements non enregistrés
  useEffect(() => { if (!dirty) return; const f = (e: BeforeUnloadEvent) => e.preventDefault(); addEventListener("beforeunload", f); return () => removeEventListener("beforeunload", f); }, [dirty]);
  const save = async () => {
    setBusy(true);
    try { onChange(await api<S>("/chatbot/widget", { method: "PUT", body: { ...w, suggestedQuestions: w.suggestedQuestions.map((q) => q.trim()).filter(Boolean), quickActions: w.quickActions.filter((a) => a.label.trim() && a.prompt.trim()) } })); toast("Widget saved. Update the code on your site to publish it."); }
    catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  const reset = async () => { if (await ask({ t: "Reset the widget to defaults?", p: "Your title, messages, quick actions and colors go back to the original UX Boğa setup. Nothing is saved until you click Save.", ok: "Reset" })) setW(WIDGET_DEFAULTS); };
  const qa = (i: number, k: "label" | "prompt" | "icon", v: string) => set("quickActions", w.quickActions.map((a, j) => (j === i ? { ...a, [k]: v } : a)));

  return <>
    <PanelHead title="Website widget" desc="How the chat bubble looks and greets visitors. Try it in the live preview: it talks to your real chatbot." right={<Badge on={!dirty} a="Saved" b="Unsaved changes" />} />
    {s.connected ? <WidgetPreview apiUrl={s.apiUrl} config={w} /> : <Hint bad>Connect your website first (Website tab) to see the live preview.</Hint>}
    {s.connected && <Hint>Messages you send in the preview are real conversations: they show up in Conversations.</Hint>}

    <Sub>Header</Sub>
    <FieldGrid>
      <Field label="Title"><input className={inpCls} value={w.title} maxLength={40} onChange={(e) => set("title", e.target.value)} disabled={!own} /></Field>
      <Field label="Subtitle"><input className={inpCls} value={w.subtitle} maxLength={60} onChange={(e) => set("subtitle", e.target.value)} disabled={!own} /></Field>
      <Field full label="Welcome message" hint={`${w.welcomeMessage.length}/600 · first message visitors see when they open the chat`}><textarea className={`${taCls} min-h-[110px]`} value={w.welcomeMessage} maxLength={600} onChange={(e) => set("welcomeMessage", e.target.value)} disabled={!own} /></Field>
    </FieldGrid>

    <Sub>Look</Sub>
    <FieldGrid>
      <Field label="Theme"><Select className="w-full" value={w.theme} disabled={!own} onChange={(v) => set("theme", v as WidgetConfig["theme"])}><option value="auto">Match visitor (auto)</option><option value="light">Light</option><option value="dark">Dark</option></Select></Field>
      <Field label="Position"><Select className="w-full" value={w.position} disabled={!own} onChange={(v) => set("position", v as WidgetConfig["position"])}><option value="right">Bottom right</option><option value="left">Bottom left</option></Select></Field>
      <Field full label="Accent color">
        <div className="flex flex-wrap items-center gap-2">
          {SWATCHES.map((c) => <button key={c} type="button" disabled={!own} onClick={() => set("accentColor", c)} aria-label={`Use ${c}`} className={`size-8 cursor-pointer rounded-full border-2 transition ${w.accentColor.toLowerCase() === c ? "border-text-1 scale-110" : "border-transparent"}`} style={{ background: c }} />)}
          <label className="relative flex size-8 cursor-pointer items-center justify-center rounded-full border border-dashed border-border text-text-2 hover:bg-icon" title="Custom color"><Icon k="palette" size={15} /><input type="color" value={w.accentColor} disabled={!own} onChange={(e) => set("accentColor", e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" /></label>
          <input className={`${inpCls} !w-[110px] font-mono`} value={w.accentColor} maxLength={7} onChange={(e) => set("accentColor", e.target.value)} disabled={!own} aria-label="Accent color hex" />
        </div>
      </Field>
    </FieldGrid>

    <Sub>Quick actions</Sub>
    <Hint>Buttons shown under the welcome message. A click sends the prompt as if the visitor typed it.</Hint>
    <div className="flex flex-col gap-2">
      {w.quickActions.map((a, i) => (
        <div key={i} className="grid grid-cols-[120px_minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2 max-[640px]:grid-cols-[minmax(0,1fr)_auto] max-[640px]:rounded-12 max-[640px]:bg-icon max-[640px]:p-2">
          <Select className="w-full max-[640px]:col-span-1" value={a.icon || "services"} disabled={!own} onChange={(v) => qa(i, "icon", v)}>{WIDGET_ICONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <input className={`${inpCls} max-[640px]:order-3 max-[640px]:col-span-2`} value={a.label} maxLength={40} placeholder="Button label" onChange={(e) => qa(i, "label", e.target.value)} disabled={!own} aria-label={`Quick action ${i + 1} label`} />
          <input className={`${inpCls} max-[640px]:order-4 max-[640px]:col-span-2`} value={a.prompt} maxLength={200} placeholder="Message sent to the assistant" onChange={(e) => qa(i, "prompt", e.target.value)} disabled={!own} aria-label={`Quick action ${i + 1} prompt`} />
          <Button size="icon" variant="ghost" title="Remove" aria-label={`Remove quick action ${i + 1}`} disabled={!own} onClick={() => set("quickActions", w.quickActions.filter((_, j) => j !== i))} className="max-[640px]:order-2"><Icon k="trash" /></Button>
        </div>
      ))}
      {own && w.quickActions.length < 4 && <Button variant="ghost" className="self-start" onClick={() => set("quickActions", [...w.quickActions, { label: "", prompt: "", icon: "services" }])}><Icon k="plus" />Add quick action</Button>}
    </div>

    <Sub>Suggested questions</Sub>
    <Hint>Shown as chips to help visitors start. Keep them short.</Hint>
    <div className="flex flex-col gap-2">
      {w.suggestedQuestions.map((q, i) => (
        <div key={i} className="flex gap-2">
          <input className={inpCls} value={q} maxLength={120} placeholder="e.g. How long does a project take?" onChange={(e) => set("suggestedQuestions", w.suggestedQuestions.map((x, j) => (j === i ? e.target.value : x)))} disabled={!own} aria-label={`Suggested question ${i + 1}`} />
          <Button size="icon" variant="ghost" title="Remove" aria-label={`Remove question ${i + 1}`} disabled={!own} onClick={() => set("suggestedQuestions", w.suggestedQuestions.filter((_, j) => j !== i))}><Icon k="trash" /></Button>
        </div>
      ))}
      {own && w.suggestedQuestions.length < 4 && <Button variant="ghost" className="self-start" onClick={() => set("suggestedQuestions", [...w.suggestedQuestions, ""])}><Icon k="plus" />Add question</Button>}
    </div>

    {own ? (
      <div className={`z-10 -mx-2 flex flex-wrap items-center gap-2 rounded-12 border p-2 ${dirty ? "sticky bottom-3 border-border bg-surface/95 shadow-[0_8px_24px_rgba(0,0,0,.12)] backdrop-blur" : "border-transparent"}`}>
        <span className="mr-auto pl-2 text-[13px] text-text-2">{dirty ? "You have unsaved changes" : "All changes saved"}</span>
        <PillBtn onClick={reset}>Reset</PillBtn>
        {dirty && <PillBtn onClick={() => setW(saved)}>Discard</PillBtn>}
        <Cta onClick={save} disabled={!dirty || busy}>{busy ? "Saving…" : "Save widget"}</Cta>
      </div>
    ) : <Hint>Only the workspace owner can change the widget.</Hint>}
  </>;
}

// ───────── Installation ─────────
function Install({ s }: { s: S }) {
  const { toast } = useFeedback();
  const code = embedCode(s.apiUrl, widgetOf(s));
  return <>
    <PanelHead title="Install on your website" desc="Add the widget to every page of your Framer site. It runs in an isolated container, so it never clashes with your site's styles." />
    <ol className="flex flex-col gap-3">
      {["In Framer, open Site Settings → General → Custom Code.", "Paste the code below in “End of <body> tag”.", "Publish your site. The chat bubble appears on every page."].map((t, i) => (
        <li key={i} className="flex items-start gap-3 text-[13px] text-text-2"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-pill text-[11px] font-semibold text-text-1">{i + 1}</span><span className="pt-0.5">{t}</span></li>
      ))}
    </ol>
    <div className="relative overflow-hidden rounded-12 border border-border bg-icon">
      <pre className="max-h-[360px] overflow-auto p-4 pr-24 font-mono text-[12px] leading-relaxed text-text-1">{code}</pre>
      <button onClick={() => navigator.clipboard.writeText(code).then(() => toast("Embed code copied"))} className="absolute right-2.5 top-2.5 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-10 border border-border bg-surface px-3 text-[13px] font-medium shadow-xs hover:bg-pill"><Icon k="copy" size={15} />Copy</button>
    </div>
    {!s.connected && <Hint bad>Connect your website first (Website tab) so the code points to your assistant.</Hint>}
    <Hint>The code includes your saved widget settings. After changing the widget, copy it again and republish.</Hint>
  </>;
}

// ───────── Données ─────────
function Data({ s }: { s: S }) {
  const { toast } = useFeedback();
  const [busy, setBusy] = useState("");
  const exp = async (n: "conversations.csv" | "report.pdf") => { setBusy(n); try { await downloadExport(n); toast("Download started"); } catch (e: any) { toast(e.message); } setBusy(""); };
  return <>
    <PanelHead title="Data & export" desc="Conversations and leads are stored on your chatbot server. Download them any time." />
    <div className="grid grid-cols-2 gap-2.5 max-[560px]:grid-cols-1">
      {([["conversations.csv", "download", "Conversations (CSV)", "Every question and answer, with sources and timing."], ["report.pdf", "chart", "Analytics report (PDF)", "A shareable summary of the assistant's performance."]] as const).map(([n, i, t, d]) => (
        <button key={n} disabled={!s.connected || !!busy} onClick={() => exp(n)} className="flex cursor-pointer flex-col gap-2 rounded-12 border border-border p-4 text-left hover:bg-icon disabled:cursor-not-allowed disabled:opacity-50">
          <span className="flex size-9 items-center justify-center rounded-10 bg-pill"><Icon k={i} size={18} /></span>
          <b className="text-sm font-medium">{busy === n ? "Preparing…" : t}</b>
          <span className="text-xs text-text-2">{d}</span>
        </button>
      ))}
    </div>
    {!s.connected && <Hint bad>Connect your website (Website tab) to export the assistant&apos;s data.</Hint>}
  </>;
}

export default function BotSettings({ s, onChange }: { s: S; onChange: (s: S) => void }) {
  const [sec, setSec] = useState("connection");
  useEffect(() => { const k = new URLSearchParams(location.search).get("s"); if (k) setSec(k); }, []);
  const pick = (k: string) => { setSec(k); history.replaceState(null, "", `?s=${k}`); };
  return (
    <Split items={[["connection", "Website", "globe"], ["widget", "Widget", "chat"], ["install", "Install on website", "upload"], ["data", "Data & export", "database"]]} cur={sec} onSelect={pick}>
      {sec === "connection" && <Connection s={s} onChange={onChange} go={pick} />}
      {sec === "widget" && <Widget s={s} onChange={onChange} />}
      {sec === "install" && <Install s={s} />}
      {sec === "data" && <Data s={s} />}
    </Split>
  );
}
