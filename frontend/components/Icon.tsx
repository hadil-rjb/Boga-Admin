import {
  ArrowRight, ArrowUpRight, CalendarPlus, Inbox, ShieldCheck, TrendingDown, TrendingUp, CalendarCheck, FileCheck, FileChartColumn, PenLine, Bell, BookOpen, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Clock, Copy, Database, Download,
  ExternalLink, Eye, FileText, Globe, History, Image as ImageIcon, LayoutDashboard, Link2, Lock, LogOut, Mail, Menu, MessageSquare, Monitor, Moon, Palette,
  Pencil, Plus, ListFilter, PanelRight, Grid2x2, Search, Settings, Smartphone, Sparkles, Sun, Tablet, Trash2, TriangleAlert, Upload, User, Users, X, type LucideIcon,
} from "lucide-react";

/** Jeu d'icônes SVG unique (Lucide) — toutes les icônes de l'app passent par ici */
const ICONS = {
  plus: Plus, x: X, search: Search, menu: Menu, grid: LayoutDashboard, doc: FileText, cal: CalendarDays, chevD: ChevronDown, chevL: ChevronLeft, chevR: ChevronRight,
  check: Check, checkCircle: CircleCheck, bell: Bell, sun: Sun, moon: Moon, logout: LogOut, user: User, users: Users, chat: MessageSquare, settings: Settings,
  sparkles: Sparkles, download: Download, upload: Upload, trash: Trash2, link: Link2, ext: ExternalLink, copy: Copy, pen: Pencil, history: History, globe: Globe,
  image: ImageIcon, alert: TriangleAlert, arrowR: ArrowRight, arrowUR: ArrowUpRight, desktop: Monitor, mobile: Smartphone, tablet: Tablet, lock: Lock, book: BookOpen,
  calCheck: CalendarCheck, fileCheck: FileCheck, chart: FileChartColumn, penLine: PenLine,
  calPlus: CalendarPlus, inbox: Inbox, shield: ShieldCheck, trendDown: TrendingDown, trendUp: TrendingUp,
  palette: Palette, database: Database, mail: Mail, clock: Clock, eye: Eye,
  filter: ListFilter, panelR: PanelRight, tbl: Grid2x2,
} satisfies Record<string, LucideIcon>;

export type IconKey = keyof typeof ICONS;
export default function Icon({ k, size = 20, className = "" }: { k: IconKey; size?: number; className?: string }) {
  const C = ICONS[k];
  return <C width={size} height={size} strokeWidth={1.7} aria-hidden className={`shrink-0 ${className}`} />;
}
