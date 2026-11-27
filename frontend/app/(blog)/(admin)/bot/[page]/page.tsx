"use client";
import { Suspense, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useData } from "@/lib/data";
import { BotSettings as S, useBot } from "@/lib/chatbot";
import { ErrorCard, NotConnected, PageSkeleton } from "@/components/chatbot/shared";
import { pageCls } from "@/components/table";
import Overview from "@/components/chatbot/Overview";
import Conversations from "@/components/chatbot/Conversations";
import Knowledge from "@/components/chatbot/Knowledge";
import Leads from "@/components/chatbot/Leads";
import BotSettings from "@/components/chatbot/BotSettings";

const PAGES = { overview: Overview, conversations: Conversations, knowledge: Knowledge, leads: Leads } as const;

export default function BotPage() {
  const { page } = useParams<{ page: string }>();
  const router = useRouter();
  const { user } = useData();
  const s = useBot<S>("/chatbot/settings");
  const known = page === "settings" || page in PAGES;
  useEffect(() => { if (!known) router.replace("/bot/overview"); }, [known, router]);

  if (!known) return null;
  if (s.error && !s.data) return <div className={pageCls}><ErrorCard error={s.error} onRetry={s.reload} /></div>;
  if (!s.data) return <PageSkeleton />;
  if (page === "settings") return <BotSettings s={s.data} onChange={s.set} />;
  if (!s.data.connected) return <NotConnected own={user.role === "admin"} />;
  const P = PAGES[page as keyof typeof PAGES];
  return <Suspense fallback={<PageSkeleton />}><P /></Suspense>;
}
