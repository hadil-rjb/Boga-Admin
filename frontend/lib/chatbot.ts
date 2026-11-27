"use client";
import { useCallback, useEffect, useState } from "react";
import { api, apiUrl, getToken } from "./api";

export type BotSource = { url: string; title: string; section: string; score: number };
export type BotMessage = { question: string; answer: string; sessionId: string; language: string; sources: BotSource[]; responseTimeMs: number; answered: boolean; topScore: number; timestamp: string };
export type BotAnalytics = {
  totalConversations: number; totalQuestions: number; answeredCount: number; unansweredCount: number; answerRate: number; averageResponseTimeMs: number;
  mostAskedQuestions: { question: string; count: number }[]; mostViewedTopics: { topic: string; count: number }[]; conversationsByDay: { date: string; count: number }[];
};
export type BotLead = { name: string; email: string; company: string; message: string; sessionId: string; createdAt: string };
export type BotKnowledge = { vectors: number; empty: boolean; ingestionRunning: boolean };
export type QuickAction = { label: string; prompt: string; icon?: string };
export type WidgetConfig = { title: string; subtitle: string; welcomeMessage: string; suggestedQuestions: string[]; quickActions: QuickAction[]; theme: "auto" | "light" | "dark"; position: "right" | "left"; accentColor: string };
export type BotSettings = { connected: boolean; apiUrl: string; hasKey: boolean; last4: string; connectedAt: string | null; widget: Partial<WidgetConfig> };

/** Icônes reconnues par le widget pour les actions rapides */
export const WIDGET_ICONS: [string, string][] = [["services", "Services"], ["portfolio", "Portfolio"], ["chart", "Chart"], ["phone", "Phone"], ["design", "Design"], ["growth", "Growth"], ["strategy", "Strategy"]];
export const WIDGET_DEFAULTS: WidgetConfig = {
  title: "UX Boğa Assistant",
  subtitle: "Fintech growth & product design",
  welcomeMessage: "Hi — welcome to UX Boğa. 👋\n\nI help visitors explore our design services, fintech portfolio and how we partner with product teams.\n\nWhat would you like to look at first?",
  suggestedQuestions: ["What services does UX Boğa offer?", "Show me your fintech projects", "How can UX Boğa help my startup?"],
  quickActions: [
    { label: "Explore Services", prompt: "What services does UX Boğa offer?", icon: "services" },
    { label: "View Portfolio", prompt: "Show me your fintech projects", icon: "portfolio" },
    { label: "Fintech Expertise", prompt: "Tell me about your fintech expertise", icon: "chart" },
    { label: "Book a Call", prompt: "I would like to book a call with the UX Boğa team", icon: "phone" },
  ],
  theme: "auto", position: "right", accentColor: "#fd0e35",
};
export const widgetOf = (s: BotSettings): WidgetConfig => ({ ...WIDGET_DEFAULTS, ...s.widget });
/** Code à coller dans Framer (config + script du serveur chatbot) */
export const embedCode = (apiUrl: string, w: WidgetConfig) => {
  const base = (apiUrl || "https://your-chatbot.onrender.com").replace(/\/+$/, "");
  const cfg = JSON.stringify({ apiUrl: base, ...w }, null, 2).replace(/</g, "\\u003c").replace(/\n/g, "\n  ");
  return `<script>\n  window.UXBogaChatConfig = ${cfg};\n</script>\n<script src="${base}/widget/uxboga-chat.js" defer></script>`;
};

/** Une session du widget = une conversation (questions dans l'ordre chronologique) */
export type Thread = { id: string; messages: BotMessage[]; first: string; last: string; language: string; unanswered: number; lead?: BotLead };

export function toThreads(items: BotMessage[], leads: BotLead[] = []): Thread[] {
  const by = new Map<string, BotMessage[]>();
  for (const m of items) { const k = m.sessionId || "unknown"; (by.get(k) ?? by.set(k, []).get(k)!).push(m); }
  const leadBy = new Map(leads.filter((l) => l.sessionId).map((l) => [l.sessionId, l]));
  return [...by.entries()].map(([id, ms]) => {
    const s = [...ms].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { id, messages: s, first: s[0].timestamp, last: s[s.length - 1].timestamp, language: s[0].language, unanswered: s.filter((m) => !m.answered).length, lead: leadBy.get(id) };
  }).sort((a, b) => b.last.localeCompare(a.last));
}

const norm = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "");
/** Questions sans réponse regroupées (même question posée plusieurs fois = un seul trou dans la base) */
export type Gap = { question: string; count: number; last: string; best: number; sessions: string[] };
export function toGaps(items: BotMessage[]): Gap[] {
  const m = new Map<string, Gap>();
  for (const c of items) {
    const k = norm(c.question); if (!k) continue;
    const g = m.get(k);
    if (g) { g.count++; if (c.timestamp > g.last) g.last = c.timestamp; g.best = Math.max(g.best, c.topScore); if (!g.sessions.includes(c.sessionId)) g.sessions.push(c.sessionId); }
    else m.set(k, { question: c.question.trim(), count: 1, last: c.timestamp, best: c.topScore, sessions: [c.sessionId] });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

/** Aperçu texte d'une réponse markdown (liste de conversations) */
export const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
export const fmtMs = (ms: number) => (!Number.isFinite(ms) || ms <= 0 ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
export const LANG: Record<string, string> = { en: "English", fr: "French", ar: "Arabic", tr: "Turkish", es: "Spanish", de: "German", it: "Italian" };
export const langName = (l: string) => LANG[l] || (l || "—").toUpperCase();
export const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname === "/" ? x.host : x.pathname; } catch { return u; } };
/** Score de pertinence RAG (0–1) → ton de la pastille */
export const scoreTone = (s: number) => (s >= 0.55 ? "bg-positive-bg text-positive" : s >= 0.35 ? "bg-[#d99a1e]/15 text-[#b7791f] dark:text-[#fbbf24]" : "bg-negative-bg text-negative");

/** Téléchargement authentifié (CSV / PDF) relayé par l'API */
export async function downloadExport(name: "conversations.csv" | "report.pdf") {
  const r = await fetch(apiUrl(`/chatbot/export/${name}`), { headers: { Authorization: "Bearer " + (getToken() || "") } });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || "Export failed"); }
  const cd = r.headers.get("content-disposition") || "", fn = /filename="([^"]+)"/.exec(cd)?.[1] || name;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await r.blob()); a.download = fn; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

type State<T> = { data: T | null; loading: boolean; error: string; reload: () => Promise<void>; set: (d: T) => void };
/** Charge une ressource du chatbot ; `null` tant que les réglages ne sont pas connus */
export function useBot<T>(path: string | null): State<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path), [error, setError] = useState("");
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true); setError("");
    try { setData(await api<T>(path)); } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, [path]);
  useEffect(() => { reload(); }, [reload]);
  return { data, loading, error, reload, set: setData };
}
