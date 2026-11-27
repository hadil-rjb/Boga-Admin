"use client";
import { ReactNode } from "react";
import Icon, { IconKey } from "./Icon";
import { fieldCls } from "./table";

export const inpCls = fieldCls + " w-full";
export const taCls = `${fieldCls} w-full min-h-[120px] resize-y px-3.5 py-3`;

export function Split({ items, cur, onSelect, children }: { items: [string, string, IconKey][]; cur: string; onSelect: (k: string) => void; children: ReactNode }) {
  return (
    <div className="grid items-start gap-6 px-8 pb-8 max-[1024px]:px-5 max-[900px]:grid-cols-1 min-[901px]:grid-cols-[280px_minmax(0,1fr)] max-[700px]:px-4">
      <div className="flex rounded-[20px] border border-border bg-surface p-4 max-[900px]:static max-[900px]:overflow-x-auto max-[900px]:p-2 min-[901px]:sticky min-[901px]:top-[88px] min-[901px]:flex-col min-[901px]:gap-1">
        <div className="px-3 pb-2.5 pt-1 text-xs font-medium uppercase tracking-[0.08em] text-text-3 max-[900px]:hidden">Select menu</div>
        {items.map(([k, l, i]) => (
          <button key={k} onClick={() => onSelect(k)} className={`flex shrink-0 cursor-pointer items-center gap-3 whitespace-nowrap rounded-12 p-3 text-left text-sm font-medium min-[901px]:w-full ${k === cur ? "bg-pill text-text-1" : "text-text-2 hover:bg-icon"}`}>
            <Icon k={i} size={20} className={k === cur ? "text-accent" : ""} /><span>{l}</span>
          </button>
        ))}
      </div>
      <div className="flex w-full max-w-[780px] flex-col gap-[22px] rounded-[20px] border border-border bg-surface p-7 max-[900px]:p-5">{children}</div>
    </div>
  );
}
export const PanelHead = ({ title, desc, right }: { title: string; desc: string; right?: ReactNode }) => (
  <div className="flex items-start justify-between gap-3">
    <div><h2 className="m-0 font-jakarta text-xl font-semibold">{title}</h2><p className="mt-1 text-sm text-text-2">{desc}</p></div>{right}
  </div>
);
export const Field = ({ label, children, full, hint }: { label: ReactNode; children: ReactNode; full?: boolean; hint?: ReactNode }) => (
  <div className={full ? "col-span-full" : ""}>
    <label className="mb-1.5 block text-sm font-medium">{label}</label>{children}{hint && <p className="mt-1.5 text-xs text-text-3">{hint}</p>}
  </div>
);
export const FieldGrid = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-2 gap-3.5 max-[560px]:grid-cols-1">{children}</div>;
export const Switch = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
  <button aria-label={label} onClick={onClick} className={`relative h-[26px] w-11 shrink-0 cursor-pointer rounded-full transition ${on ? "bg-accent" : "bg-track"}`}>
    <span className={`absolute top-[3px] size-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-all ${on ? "left-[21px]" : "left-[3px]"}`} />
  </button>
);
export const Acts = ({ children, one }: { children: ReactNode; one?: boolean }) => <div className={`grid gap-3 ${one ? "grid-cols-1" : "grid-cols-2"} [&>button]:w-full`}>{children}</div>;
export const Avatar = ({ name, src, size = 40 }: { name: string; src?: string; size?: number }) => (
  <div className="flex shrink-0 items-center justify-center rounded-full bg-accent bg-cover bg-center font-semibold text-white" style={{ width: size, height: size, fontSize: size * 0.36, backgroundImage: src ? `url(${src})` : undefined }}>{src ? "" : (name || "?")[0].toUpperCase()}</div>
);

const COL = ["#fd0e35", "#2563eb", "#059669", "#d97706", "#7c3aed", "#0891b2", "#db2777"];
const hc = (s: string) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COL[h % COL.length]; };
/** Pastille d'avatar colorée (présence, membres, historique) */
export const Pa = ({ name, id, src, online, size = 32 }: { name: string; id?: string; src?: string; online?: boolean; size?: number }) => (
  <span title={name} className={`inline-flex shrink-0 items-center justify-center rounded-full bg-cover bg-center font-semibold text-white ${online ? "ring-2 ring-positive" : ""}`}
    style={{ width: size, height: size, fontSize: size * 0.4, background: src ? `url(${src}) center/cover` : hc(id || name) }}>{src ? "" : (name || "?")[0].toUpperCase()}</span>
);
