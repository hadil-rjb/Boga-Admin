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
import { BotSettings as S, WIDGET_DEFAULTS, WIDGET_ICONS, WidgetConfig, downloadExport, embedCode, widgetOf } from "@/lib/chatbot";
import WidgetPreview from "./WidgetPreview";

const Badge = ({ on, a = "Connected", b = "Not connected" }: { on: boolean; a?: string; b?: string }) => <span className={`shrink-0 rounded-6 px-[7px] py-1 text-[10px] font-medium ${on ? "bg-positive-bg text-positive" : "bg-pill text-text-2"}`}>{on ? a : b}</span>;
const Hint = ({ children, bad }: { children: React.ReactNode; bad?: boolean }) => <p className={`text-xs ${bad ? "text-negative" : "text-text-3"}`}>{children}</p>;
const Sub = ({ children }: { children: React.ReactNode }) => <h3 className="-mb-2 border-t border-border-soft pt-5 text-[11px] font-medium uppercase tracking-[0.06em] text-text-3">{children}</h3>;
const SWATCHES = ["#fd0e35", "#ff3b3b", "#2563eb", "#7c3aed", "#059669", "#0f172a"];

// ───────── Connection ─────────
function Connection({ s, onChange }: { s: S; onChange: (s: S) => void }) {
  const { user } = useData();
  const { toast, ask } = useFeedback();
  const own = user.role === "admin";
  const [url, setUrl] = useState(s.apiUrl), [key, setKey] = useState(""), [show, setShow] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const dirty = url.trim().replace(/\/+$/, "") !== s.apiUrl || !!key.trim();
  const save = async () => {
    if (!url.trim()) return setErr("Add the chatbot server URL.");
    setBusy(true); setErr("");
    try { const r = await api<S>("/chatbot/settings", { method: "PUT", body: { apiUrl: url.trim(), apiKey: key.trim() || undefined } }); onChange(r); setUrl(r.apiUrl); setKey(""); toast("Chatbot connected"); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const disc = async () => {
    if (!(await ask({ t: "Disconnect the chatbot?", p: "The widget on your site keeps working. This admin just stops showing its data until you reconnect.", ok: "Disconnect", danger: true }))) return;
    try { onChange(await api<S>("/chatbot/settings", { method: "DELETE" })); setUrl(""); toast("Chatbot disconnected"); } catch (e: any) { toast(e.message); }
  };
  return <>
    <PanelHead title="Chatbot server" desc="The admin reads conversations, leads and knowledge from your chatbot server. The admin key is stored encrypted and never shown again." right={<Badge on={s.connected} />} />
    <FieldGrid>
      <Field full label="Server URL" hint="The base URL of the chatbot API, without /api.">
        <input className={inpCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://uxboga-chatbot.onrender.com" disabled={!own} inputMode="url" autoComplete="off" />
      </Field>
      <Field full label="Admin key" hint={s.hasKey ? <>Saved key ends in <b className="font-medium text-text-2">…{s.last4}</b>. Leave empty to keep it.</> : "ADMIN_API_KEY from the chatbot server's .env."}>
        <div className="relative">
          <input className={`${inpCls} pr-10`} type={show ? "text" : "password"} value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.hasKey ? "••••••••••••" + s.last4 : "Paste the admin key"} disabled={!own} autoComplete="new-password" onKeyDown={(e) => e.key === "Enter" && dirty && save()} />
          <button type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide key" : "Show key"} className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-8 text-text-3 hover:bg-icon hover:text-text-1"><Icon k={show ? "lock" : "eye"} size={16} /></button>
        </div>
      </Field>
    </FieldGrid>
    {err && <p role="alert" className="flex items-start gap-2 rounded-10 bg-negative-bg px-3 py-2.5 text-[13px] text-negative"><Icon k="alert" size={16} className="mt-px" />{err}</p>}
    {s.connected && !err && <p className="flex items-center gap-1.5 text-xs text-text-3"><Icon k="checkCircle" size={14} className="text-positive" />Verified {since(s.connectedAt)}</p>}
    {own ? <Acts one={!s.connected}>{s.connected && <PillBtn onClick={disc}>Disconnect</PillBtn>}<Cta onClick={save} disabled={busy || (!dirty && s.connected)}>{busy ? "Testing connection…" : s.connected ? "Save & test" : "Connect chatbot"}</Cta></Acts> : <Hint>Only the workspace owner can change the connection.</Hint>}
    <div className="rounded-12 bg-icon p-4 text-[13px] text-text-2"><b className="text-text-1">Where to find them</b><ol className="mt-2 list-decimal space-y-1 pl-5"><li>Open your chatbot service (e.g. on Render) and copy its public URL.</li><li>In its environment variables, copy the value of <b>ADMIN_API_KEY</b>.</li><li>Paste both here and click Connect. The admin checks them before saving.</li></ol></div>
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
    {s.connected ? <WidgetPreview apiUrl={s.apiUrl} config={w} /> : <Hint bad>Connect the chatbot server first to see the live preview.</Hint>}
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
    {!s.connected && <Hint bad>Connect the chatbot server first so the code points to the right URL.</Hint>}
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
    {!s.connected && <Hint bad>Connect the chatbot server to export its data.</Hint>}
  </>;
}

export default function BotSettings({ s, onChange }: { s: S; onChange: (s: S) => void }) {
  const [sec, setSec] = useState("connection");
  useEffect(() => { const k = new URLSearchParams(location.search).get("s"); if (k) setSec(k); }, []);
  const pick = (k: string) => { setSec(k); history.replaceState(null, "", `?s=${k}`); };
  return (
    <Split items={[["connection", "Connection", "link"], ["widget", "Widget", "chat"], ["install", "Install on website", "globe"], ["data", "Data & export", "database"]]} cur={sec} onSelect={pick}>
      {sec === "connection" && <Connection s={s} onChange={onChange} />}
      {sec === "widget" && <Widget s={s} onChange={onChange} />}
      {sec === "install" && <Install s={s} />}
      {sec === "data" && <Data s={s} />}
    </Split>
  );
}
