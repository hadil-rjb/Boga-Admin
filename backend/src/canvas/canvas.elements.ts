/**
 * Cleaning of Creative Canvas elements before they are stored. The client owns the shape of an element;
 * the server only keeps known kinds and fields, bounds the numbers and the text, and refuses inline images
 * (images are uploaded to /media/assets first and the element keeps the URL).
 */
export const KINDS = ["text", "sticky", "image", "shape", "path", "connector"] as const;
export type Kind = (typeof KINDS)[number];

export const MAX_ELEMENTS = 4000;
const MAX_TEXT = 5000;
const MAX_POINTS = 4000;
const COORD = 1e7;

const num = (v: unknown, lo = -COORD, hi = COORD, dflt = 0) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : dflt;
};
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const color = (v: unknown) => (typeof v === "string" && /^(#[0-9a-f]{3,8}|transparent|rgba?\([\d.,\s%]+\))$/i.test(v) ? v : undefined);
const id = (v: unknown) => (typeof v === "string" && /^[\w-]{1,40}$/.test(v) ? v : undefined);
const url = (v: unknown) => (typeof v === "string" && /^https?:\/\/[^\s"'<>]{1,2000}$/i.test(v) ? v : undefined);

/** Drops undefined fields, so the stored element only has what was set */
const compact = <T extends Record<string, unknown>>(o: T) => {
  Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]);
  return o;
};

export function cleanElement(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const k = e.k as Kind;
  const eid = id(e.id);
  if (!eid || !KINDS.includes(k)) return null;
  const base = {
    id: eid,
    k,
    x: num(e.x),
    y: num(e.y),
    w: num(e.w, 0, COORD, 0),
    h: num(e.h, 0, COORD, 0),
    rot: num(e.rot, -360, 360, 0) || undefined,
    z: num(e.z, -1e9, 1e9, 0),
    locked: e.locked === true || undefined,
    group: id(e.group),
  };
  switch (k) {
    case "text":
    case "sticky":
      return compact({
        ...base,
        text: str(e.text, MAX_TEXT) ?? "",
        fill: color(e.fill),
        color: color(e.color),
        size: num(e.size, 6, 400, k === "sticky" ? 18 : 24),
        // a text box the user resized keeps its width (wraps there); otherwise it grows with its text
        fixed: k === "text" && e.fixed === true ? true : undefined,
        weight: [400, 500, 600, 700, 800].includes(e.weight as number) ? e.weight : undefined,
        align: ["left", "center", "right"].includes(e.align as string) ? e.align : undefined,
      });
    case "image": {
      const src = url(e.src);
      if (!src) return null;
      return compact({ ...base, src, name: str(e.name, 200) });
    }
    case "shape":
      return compact({
        ...base,
        shape: ["rect", "ellipse", "diamond", "triangle"].includes(e.shape as string) ? e.shape : "rect",
        fill: color(e.fill),
        stroke: color(e.stroke),
        sw: num(e.sw, 0, 100, 2),
        text: str(e.text, MAX_TEXT),
        color: color(e.color),
        size: e.size === undefined ? undefined : num(e.size, 6, 400, 18),
      });
    case "path": {
      const pts = Array.isArray(e.pts) ? e.pts.slice(0, MAX_POINTS * 2).map((v) => num(v)) : [];
      if (pts.length < 2) return null;
      return compact({ ...base, pts, stroke: color(e.stroke), sw: num(e.sw, 0.5, 200, 4) });
    }
    case "connector": {
      const end = (v: unknown) => {
        if (!v || typeof v !== "object") return undefined;
        const p = v as Record<string, unknown>;
        return compact({ id: id(p.id), x: num(p.x), y: num(p.y) });
      };
      const a = end(e.a), b = end(e.b);
      if (!a || !b) return null;
      return compact({
        ...base,
        a,
        b,
        stroke: color(e.stroke),
        sw: num(e.sw, 0.5, 50, 2),
        arrow: e.arrow === false ? false : undefined,
        dash: e.dash === true || undefined,
        label: str(e.label, 200),
      });
    }
  }
  return null;
}

/** Cleans a whole board: unknown or invalid elements are dropped, ids stay unique */
export function cleanElements(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of raw.slice(0, MAX_ELEMENTS)) {
    const e = cleanElement(r);
    if (!e || seen.has(e.id as string)) continue;
    seen.add(e.id as string);
    out.push(e);
  }
  return out;
}

export function cleanViewport(v: unknown) {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { x: num(o.x), y: num(o.y), z: num(o.z, 0.05, 8, 1) };
}
