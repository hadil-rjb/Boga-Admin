"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import Icon, { IconKey } from "./Icon";
import { Avatar } from "./split";

const NAV: { label: string; icon: IconKey; href: string }[] = [
  { label: "Dashboard", icon: "grid", href: "/" },
  { label: "Articles", icon: "doc", href: "/articles" },
  { label: "Calendar", icon: "cal", href: "/calendar" },
  { label: "Search Console", icon: "search", href: "/search" },
  { label: "Settings", icon: "settings", href: "/settings" },
];
const BOT: { label: string; icon: IconKey; href: string }[] = [
  { label: "Overview", icon: "grid", href: "/bot/overview" },
  { label: "Conversations", icon: "chat", href: "/bot/conversations" },
  { label: "Knowledge base", icon: "book", href: "/bot/knowledge" },
  { label: "Leads", icon: "users", href: "/bot/leads" },
  { label: "Settings", icon: "settings", href: "/bot/settings" },
];
const WORKSPACES: { name: string; sub: string; icon: IconKey; href: string; soon?: boolean }[] = [
  { name: "Blog Admin", sub: "Content & Articles", icon: "doc", href: "/" },
  { name: "Chatbot Admin", sub: "AI & Conversations", icon: "chat", href: "/bot/overview" },
  { name: "Social Media Admin", sub: "Social & Publishing", icon: "globe", href: "/social-media" },
];

export default function Sidebar({ open, onClose, user }: { open: boolean; onClose: () => void; user: { name: string; email: string; avatar?: string; role?: string } }) {
  const router = useRouter();
  const [wsOpen, setWsOpen] = useState(false);
  const [accOpen, setAccOpen] = useState(false);
  const pathname = usePathname();
  const inBot = pathname.startsWith("/bot");
  const ws = inBot ? "Chatbot Admin" : "Blog Admin";
  const active = inBot ? "/bot/" + (pathname.split("/")[2] || "overview") : "/" + (pathname.split("/")[1] || "");
  const initial = (user.name || "?").charAt(0).toUpperCase();
  const logout = () => { localStorage.removeItem("uxb.token"); router.replace("/login"); };

  return (
    <>
      {open && <div className="fixed inset-0 z-20 bg-black/40 lg:hidden" onClick={onClose} />}
      <aside className={`fixed left-0 top-0 z-30 flex h-screen w-[272px] flex-col border-r border-border bg-surface transition-transform duration-[250ms] ease-in-out max-lg:-translate-x-full ${open ? "max-lg:translate-x-0 max-lg:shadow-[20px_0_40px_rgba(0,0,0,.25)]" : ""}`}>
        <div className="relative border-b border-border-soft p-4">
          <div className="flex items-center gap-3">
            <div className="size-9 shrink-0 overflow-hidden rounded-10"><Image src="/logo.png" alt="Boğa Logo" width={36} height={36} className="size-full object-cover" /></div>
            <button onClick={() => setWsOpen(!wsOpen)} className="flex flex-1 cursor-pointer items-center justify-between gap-2 text-left">
              <div><p className="text-sm font-semibold text-text-1">Boğa</p><p className="text-xs text-text-2">{ws}</p></div>
              <Icon k="chevD" size={16} className={`text-text-2 transition-transform ${wsOpen ? "rotate-180" : ""}`} />
            </button>
          </div>
          {wsOpen && (
            <div className="absolute inset-x-3 top-full z-40 mt-2 overflow-hidden rounded-12 border border-border bg-surface p-1.5 shadow-[0_12px_32px_rgba(15,23,42,.16),0_2px_8px_rgba(15,23,42,.08)]">
              <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-text-3">Switch workspace</div>
              {WORKSPACES.map((w) => (
                <button key={w.name} onClick={() => { setWsOpen(false); router.push(w.href); onClose(); }} className={`group flex w-full cursor-pointer items-center gap-2 rounded-8 p-1.5 text-left outline-none transition-colors hover:bg-pill focus-visible:bg-pill focus-visible:ring-1 focus-visible:ring-accent/40 ${ws === w.name ? "bg-accent/[.07]" : ""}`}>
                  <div className={`flex size-8 shrink-0 items-center justify-center rounded-8 ${ws === w.name ? "bg-accent text-white" : "bg-pill text-text-1 group-hover:bg-surface"}`}><Icon k={w.icon} size={16} /></div>
                  <div className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium leading-4">{w.name}</span><small className="block truncate text-[10px] leading-4 text-text-2">{w.sub}</small></div>
                  {w.soon ? <span className="shrink-0 rounded-full bg-accent/[.08] px-1.5 py-0.5 text-[9px] font-semibold leading-3 text-accent">Soon</span> : ws === w.name ? <Icon k="check" size={14} className="shrink-0 text-accent" /> : null}
                </button>
              ))}
            </div>
          )}
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {(inBot ? BOT : NAV.filter((n) => user.role !== "link" || n.href === "/articles" || n.href === "/calendar")).map((n) => (
            <Link key={n.label} href={n.href} onClick={onClose} className={`flex items-center gap-2 rounded-8 px-3 py-2 text-sm font-medium tracking-[-0.02em] ${n.href === active ? "bg-pill text-text-1" : "text-text-2 hover:bg-pill"}`}>
              <Icon k={n.icon} />{n.label}
            </Link>
          ))}
        </nav>

        <div className={`relative border-t border-border-soft p-3 ${user.role === "link" ? "hidden" : ""}`}>
          {accOpen && (
            <div className="absolute inset-x-3 bottom-full z-40 mb-2 rounded-12 border border-border bg-surface p-2 shadow-xs">
              <div className="flex items-center gap-2.5 p-2">
                <Avatar name={user.name} src={user.avatar} size={36} />
                <div><p className="text-sm font-medium">{user.name}</p><p className="text-xs text-text-2">{user.email}</p></div>
              </div>
              <div className="my-1 h-px bg-border-soft" />
              <Link href="/profile" onClick={() => { setAccOpen(false); onClose(); }} className="flex w-full cursor-pointer items-center gap-2 rounded-8 p-2 text-sm text-text-1 hover:bg-pill"><Icon k="user" size={18} />Profile</Link>
              <div className="my-1 h-px bg-border-soft" />
              <button onClick={logout} className="flex w-full cursor-pointer items-center gap-2 rounded-8 p-2 text-sm text-negative hover:bg-pill"><Icon k="logout" size={18} />Sign out</button>
            </div>
          )}
          <button onClick={() => setAccOpen(!accOpen)} className="flex w-full cursor-pointer items-center gap-2.5 rounded-10 p-2 text-left hover:bg-pill">
            <Avatar name={user.name} src={user.avatar} size={36} />
            <div className="flex-1"><p className="text-sm font-medium">{user.name}</p><p className="truncate text-xs text-text-2">{user.email}</p></div>
            <Icon k="chevD" size={16} className="text-text-2" />
          </button>
        </div>
      </aside>
    </>
  );
}
