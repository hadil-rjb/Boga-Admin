"use client";
import { Suspense, useEffect, useState } from "react";
import ShareDialog from "@/components/ShareDialog";
import HistoryDrawer from "@/components/HistoryDrawer";
import { Pa } from "@/components/split";
import NotificationBell from "@/components/NotificationBell";
import { api } from "@/lib/api";
import OAuthResult from "@/components/OAuthResult";
import Sidebar from "@/components/Sidebar";
import { ArticleDrawerProvider } from "@/components/ArticleDrawerHost";
import Icon from "@/components/Icon";
import { IconBtn, btn } from "@/components/ui";
import { DataProvider, useData } from "@/lib/data";
import { FeedbackProvider } from "@/components/feedback";
import { toggleTheme } from "@/lib/theme";
import { usePathname, useRouter } from "next/navigation";
import { useArticleDrawer } from "@/components/ArticleDrawerHost";

const BT: Record<string, [string, string]> = {
  overview: ["Chatbot Overview", "How your website assistant is doing with visitors."],
  conversations: ["Conversations", "Read what visitors asked and how the assistant answered."],
  knowledge: ["Knowledge base", "What the assistant knows, and the questions it couldn't answer."],
  leads: ["Leads", "Visitors who asked to be contacted through the assistant."],
  settings: ["Chatbot Settings", "Customize the website widget and get its install code."],
};
const T: Record<string, [string, string]> = {
  "/articles": ["Articles", "Write, optimize and publish your blog content."],
  "/calendar": ["Editorial Calendar", "Plan what goes live and when. Drag an article to another day to reschedule it."],
  "/search": ["Search Console", "How your blog articles perform on Google."],
  "/settings": ["Settings", "Integrations and data."],
  "/profile": ["Profile", "Manage your account and notification preferences."],
};

function Shell({ children }: { children: React.ReactNode }) {
  const { user } = useData();
  const { openNewArticle } = useArticleDrawer();
  const router = useRouter();
  const link = user.role === "link";
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState(false), [hist, setHist] = useState(false);
  const [viewers, setViewers] = useState<{ id: string; name: string; you?: boolean }[]>([]);
  // Présence en direct : ping toutes les 25 s (viewerId par onglet)
  useEffect(() => {
    let vid = "anon";
    try { vid = sessionStorage.getItem("uxb.v") || Math.random().toString(36).slice(2, 12); sessionStorage.setItem("uxb.v", vid); } catch {}
    const ping = () => api("/share/ping", { method: "POST", body: { viewerId: vid } }).then((r) => setViewers(r.viewers)).catch(() => {});
    ping(); const t = setInterval(ping, 25000);
    const vis = () => !document.hidden && ping(); document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, []);
  const pn = usePathname();
  const path = "/" + (pn.split("/")[1] || "");
  const inBot = path === "/bot";
  const workspacePage = pn.split("/")[2];
  const [h, sub] = inBot
    ? BT[workspacePage] || ["Chatbot Admin", "Chatbot Admin workspace."]
    : T[path] || [`Welcome back, ${user.name.split(" ")[0]}`, "Here’s how your content and SEO performance are doing."];
  const can = user.role === "admin" || user.role === "editor";
  const others = viewers.filter((v) => !v.you);
  useEffect(() => { if (link && !/^\/(articles|calendar)/.test(location.pathname)) router.replace("/articles"); }, [link, router, path]);
  return (
    <div className="flex min-h-screen max-w-[100vw]">
      <Sidebar open={open} onClose={() => setOpen(false)} user={user} />
      <div className="w-full max-w-full flex-1 lg:ml-[272px]">
        {/* under lg (sidebar hidden): menu and actions on one row, the title below on its own full row */}
        <div className="flex flex-wrap items-center gap-3 px-8 py-5 max-[1024px]:px-5 max-sm:gap-2 max-sm:px-4 max-sm:py-4">
          <IconBtn title="Menu" onClick={() => setOpen(true)} className="lg:hidden"><Icon k="menu" /></IconBtn>
          <div className="min-w-0 flex-1 max-lg:order-last max-lg:basis-full">
            <p className="font-jakarta text-xl font-semibold max-sm:text-lg">{h}</p>
            <p className="text-sm text-text-2">{sub}</p>
          </div>
          <div className="flex -space-x-2 max-lg:ml-auto max-sm:hidden">{others.slice(0, 4).map((v) => <span key={v.id} title={`${v.name} · online now`}><Pa name={v.name} id={v.id} online size={32} /></span>)}{others.length > 4 && <span className="flex size-8 items-center justify-center rounded-full bg-pill text-xs">+{others.length - 4}</span>}</div>
          {!link && <IconBtn title="Version history" onClick={() => setHist(true)} className="max-sm:ml-auto"><Icon k="history" /></IconBtn>}
          {!link && <button onClick={() => setShare(true)} className={btn("secondary")}><Icon k="users" /><span className="max-sm:hidden">Share</span></button>}
          <IconBtn title="Toggle theme" onClick={toggleTheme}><Icon k="sun" className="hidden dark:block" /><Icon k="moon" className="dark:hidden" /></IconBtn>
          {!link && <NotificationBell />}
          {can && !inBot && <button onClick={() => openNewArticle()} className={btn("primary")} aria-label="New Article"><Icon k="plus" /><span className="max-sm:hidden">New Article</span></button>}
        </div>
        <Suspense><OAuthResult /></Suspense>
        {share && <ShareDialog onClose={() => setShare(false)} />}
        {hist && <HistoryDrawer onClose={() => setHist(false)} />}
        {children}
      </div>
    </div>
  );
}
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <DataProvider><FeedbackProvider><ArticleDrawerProvider><Shell>{children}</Shell></ArticleDrawerProvider></FeedbackProvider></DataProvider>;
}
