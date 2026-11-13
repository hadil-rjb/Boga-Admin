/**
 * Figma REST nodes → studio layers.
 *
 * The studio canvas takes the frame's own size, at scale 1: every layer keeps the position and size it has in
 * Figma (only frames over MAX_SIDE px are scaled down). Sizes of the standard ratios (1080×1080, 1080×1350,
 * 1080×1920) use their usual names; anything else is a custom canvas named "<w>x<h>".
 * Positions come from each node's absolute box, so children of groups (and groups imported on their own) land
 * exactly where they are in Figma, whatever coordinate space their transforms use.
 * The layer tree is kept like in Figma's Layers panel: frames, components and instances become studio frames (fill,
 * corners, strokes, effects, clip content, auto layout, constraints) and groups become groups, each child naming its
 * container in `pid`. A mask stays a layer (`mask`), masking the layers above it in its container by its shape and alpha.
 * Text, rectangles and ellipses become editable layers (fills, gradients, blend modes, every stroke with its alignment
 * and dashes, per-corner radius, every drop and inner shadow, blurs, rotation, opacity, italic, underline).
 * Vectors, stars, polygons, lines and boolean operations (and groups drawn only with them: logos, icons) become path
 * layers drawn from Figma's geometry when the studio can paint them the same.
 * Anything the studio can't express (rotated frames, image fills on vectors) is rendered by Figma and
 * placed as an image; frames that hold text are never flattened (what can't be drawn is simplified, with a note).
 *
 * Fills that need pixels are emitted as placeholders and resolved by the caller:
 *   {{raster:<nodeId>}}  rendered node      {{image:<imageRef>}}  image fill
 *
 * Image fills keep Figma's image adjustments (exposure, contrast, saturation, temperature, tint, highlights,
 * shadows) as `adj` (-100…100, applied by the studio) and the colors and gradients above the image as `ovs`
 * (Figma's fill list, top first, each with its own opacity). Flipped layers stay editable (`fx` / `fy` flags).
 */

export type Ratio = "1:1" | "4:5" | "9:16";
export const RATIOS: Record<Ratio, [number, number]> = { "1:1": [1080, 1080], "4:5": [1080, 1350], "9:16": [1080, 1920] };
/** Largest canvas side the studio accepts (bigger frames are scaled down to it) */
export const MAX_SIDE = 4000;

/** Canvas for a frame: its own size (scale 1), named after the standard ratio when it is one. */
export function canvasOf(fw: number, fh: number) {
  const k = Math.min(1, MAX_SIDE / Math.max(fw, fh, 1));
  const W = Math.max(1, Math.round(fw * k)), H = Math.max(1, Math.round(fh * k));
  const std = (Object.keys(RATIOS) as Ratio[]).find((r) => RATIOS[r][0] === W && RATIOS[r][1] === H);
  return { W, H, k, key: std || `${W}x${H}` };
}

/** Figma blend mode → CSS mix-blend-mode (PASS_THROUGH and NORMAL are the default) */
const BLEND: Record<string, string> = {
  MULTIPLY: "multiply", DARKEN: "darken", LINEAR_BURN: "multiply", COLOR_BURN: "color-burn", LIGHTEN: "lighten", SCREEN: "screen",
  LINEAR_DODGE: "plus-lighter", COLOR_DODGE: "color-dodge", OVERLAY: "overlay", SOFT_LIGHT: "soft-light", HARD_LIGHT: "hard-light",
  DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};

/** Families the studio loads (app/layout.tsx); anything else is swapped */
export const STUDIO_FONTS = ["Poppins", "Cairo", "Inter", "Plus Jakarta Sans", "Montserrat", "DM Sans", "Space Grotesk", "Playfair Display", "Tajawal", "Georgia"];

type M = [[number, number, number], [number, number, number]];
const I: M = [[1, 0, 0], [0, 1, 0]];
const mul = (a: M, b: M): M => [
  [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
  [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]],
];
const apply = (m: M, x: number, y: number) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export const nearestRatio = (w: number, h: number): Ratio => {
  const a = h / w;
  return (Object.keys(RATIOS) as Ratio[]).reduce((best, r) => (Math.abs(Math.log(a / (RATIOS[r][1] / RATIOS[r][0]))) < Math.abs(Math.log(a / (RATIOS[best][1] / RATIOS[best][0]))) ? r : best), "4:5");
};

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
export function rgba(c: { r: number; g: number; b: number; a?: number }, opacity = 1) {
  const a = (c.a ?? 1) * opacity;
  if (a >= 0.999) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase();
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${r3(a)})`;
}

const visiblePaints = (p?: any[]) => (p || []).filter((x) => x && x.visible !== false && (x.opacity ?? 1) > 0);

/** One Figma paint → one CSS background layer */
function paintCss(p: any, w: number, h: number): string | null {
  const op = p.opacity ?? 1;
  const stops = () => (p.gradientStops || []).map((s: any) => `${rgba(s.color, op)} ${r1(s.position * 100)}%`).join(", ");
  switch (p.type) {
    case "SOLID": return rgba(p.color, op);
    case "GRADIENT_LINEAR": {
      const [a, b] = p.gradientHandlePositions || [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }];
      const deg = (Math.atan2((b.y - a.y) * h, (b.x - a.x) * w) * 180) / Math.PI + 90;
      return `linear-gradient(${r1(deg)}deg, ${stops()})`;
    }
    case "GRADIENT_RADIAL":
    case "GRADIENT_DIAMOND": {
      // Figma's handles: the center, then the ends of the two radii; the gradient ends there (not at the box's corners),
      // as % of the box so it follows when the layer is resized
      const [c, e1, e2] = p.gradientHandlePositions || [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }];
      const rx = e1 ? Math.hypot((e1.x - c.x) * w, (e1.y - c.y) * h) : w / 2, ry = e2 ? Math.hypot((e2.x - c.x) * w, (e2.y - c.y) * h) : h / 2;
      return `radial-gradient(${r1((rx / Math.max(w, 1e-6)) * 100)}% ${r1((ry / Math.max(h, 1e-6)) * 100)}% at ${r1(c.x * 100)}% ${r1(c.y * 100)}%, ${stops()})`;
    }
    case "GRADIENT_ANGULAR": {
      const [c, e] = p.gradientHandlePositions || [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }];
      const deg = (Math.atan2((e.y - c.y) * h, (e.x - c.x) * w) * 180) / Math.PI + 90;
      return `conic-gradient(from ${r1(deg)}deg at ${r1(c.x * 100)}% ${r1(c.y * 100)}%, ${stops()})`;
    }
    case "IMAGE": {
      if (!p.imageRef) return null;
      const t = p.imageTransform as number[][] | undefined; // cropped / stretched image: node space → image space
      if (t && Math.abs(t[0][1]) < 1e-4 && Math.abs(t[1][0]) < 1e-4 && t[0][0] > 0 && t[1][1] > 0) {
        return `url({{image:${p.imageRef}}}) ${r1((-t[0][2] / t[0][0]) * w)}px ${r1((-t[1][2] / t[1][1]) * h)}px/${r1(w / t[0][0])}px ${r1(h / t[1][1])}px no-repeat`;
      }
      const size = p.scaleMode === "FIT" ? "center/contain no-repeat" : p.scaleMode === "TILE" ? "0 0/auto repeat" : p.scaleMode === "STRETCH" ? "center/100% 100% no-repeat" : "center/cover no-repeat";
      return `url({{image:${p.imageRef}}}) ${size}`;
    }
    default: return null;
  }
}

/** All visible fills → one CSS `background` value (Figma lists bottom→top, CSS top→bottom) */
export function fillsCss(fills: any[] | undefined, w: number, h: number): string | null {
  const layers = visiblePaints(fills).map((p) => paintCss(p, w, h)).filter(Boolean) as string[];
  if (!layers.length) return null;
  if (layers.length === 1) return layers[0];
  const css = layers.reverse();
  // a plain color can only be the bottom layer in CSS: wrap the others as flat gradients
  return css.map((c, i) => (i < css.length - 1 && !/gradient|url\(/.test(c) ? `linear-gradient(${c}, ${c})` : c)).join(", ");
}

/** Figma's image adjustments → studio `adj` (-100…100); only the ones that are set */
const FX_KEYS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
export function imageFx(p: any): Record<string, number> | undefined {
  const f = p?.filters || {}, out: Record<string, number> = {};
  FX_KEYS.forEach((k) => { const v = Math.round((+f[k] || 0) * 100); if (v) out[k] = Math.max(-100, Math.min(100, v)); });
  return Object.keys(out).length ? out : undefined;
}

/** A fill above an image, as the studio's fill list item: { k: "solid" | "grad", v, o } */
export type Overlay = { k: "solid" | "grad"; v: string; o: number };

/**
 * Fills of a node with one image: the image (and what's under it) as `fill`, its adjustments as `adj`, and the colors
 * and gradients painted above it as `ovs` (editable, top first). Anything else above the image stays in `fill`.
 */
export function imageFills(fills: any[] | undefined, w: number, h: number): { fill: string | null; adj?: Record<string, number>; ovs?: Overlay[] } {
  const paints = visiblePaints(fills), imgs = paints.filter((p) => p.type === "IMAGE");
  if (imgs.length !== 1) return { fill: fillsCss(fills, w, h) };
  const i = paints.indexOf(imgs[0]), above = paints.slice(i + 1), adj = imageFx(imgs[0]);
  if (above.length && above.every((p) => p.type === "SOLID" || /^GRADIENT_/.test(p.type))) {
    const ovs = above.map((p): Overlay => p.type === "SOLID"
      ? { k: "solid", v: rgba({ ...p.color, a: 1 }), o: r3((p.color.a ?? 1) * (p.opacity ?? 1)) }
      : { k: "grad", v: paintCss({ ...p, opacity: 1 }, w, h)!, o: r3(p.opacity ?? 1) }).reverse();
    return { fill: fillsCss(paints.slice(0, i + 1), w, h), adj, ovs };
  }
  return { fill: fillsCss(paints, w, h), adj };
}

export interface ConvertOut {
  bg: string;
  layers: any[];
  rasters: { id: string; w: number; h: number }[];
  images: { ref: string; w: number; h: number }[];
  warnings: string[];
  /** "1:1" | "4:5" | "9:16", or "<w>x<h>" for a custom canvas */
  ratio: string;
  width: number;
  height: number;
  scale: number;
}

const RASTER_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "REGULAR_POLYGON", "POLYGON"]);
const CONTAINERS = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);
const hasEffects = (n: any) => (n.effects || []).some((e: any) => e.visible !== false);
/** Visible text somewhere inside: such frames stay editable layers instead of one picture */
const hasText = (n: any): boolean => n.visible !== false && (n.type === "TEXT" ? !!String(n.characters || "").trim() : (n.children || []).some(hasText));
/** Clip box of a container, in Figma's absolute coordinates; r: its corner radius */
type Clip = { x: number; y: number; w: number; h: number; r: number };
const cut = (a: Clip | undefined, b: Clip): Clip => {
  if (!a) return b;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y), r: Math.max(a.r, b.r) };
};
/** A group or instance drawn only with vectors (a logo, an icon): path layers when every vector converts, else one image */
const vectorOnly = (n: any): boolean => {
  const kids = (n.children || []).filter((c: any) => c.visible !== false);
  return kids.length > 0 && kids.every((c: any) => RASTER_TYPES.has(c.type) || ((c.type === "GROUP" || c.type === "BOOLEAN_OPERATION" || CONTAINERS.has(c.type)) && !visiblePaints(c.fills).length && vectorOnly(c)));
};

/**
 * Figma geometry (`fillGeometry` / `strokeGeometry` paths: absolute M, L, Q, C, Z in the node's own space) → segments,
 * or null for path data that uses anything else.
 */
type Seg = { c: string; p: number[] };
const ARGS: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
function figPath(d: string): Seg[] | null {
  const toks = String(d || "").match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|[a-z]/gi) || [], out: Seg[] = [];
  for (let i = 0; i < toks.length;) {
    let c = toks[i++];
    const n = ARGS[c];
    if (n == null) return null;
    do { // repeated arguments repeat the command (after M: lines)
      const p = toks.slice(i, i + n).map(Number);
      if (p.length < n || p.some((x) => !Number.isFinite(x))) return null;
      out.push({ c, p }); i += n;
      if (c === "M") c = "L";
    } while (n && i < toks.length && !/^[a-z]$/i.test(toks[i]));
  }
  return out;
}
const fmt = (n: number) => { const r = Math.round(n * 1000) / 1000; return Object.is(r, -0) ? "0" : String(r); };
const toD = (segs: Seg[], dx = 0, dy = 0) => segs.map((s) => s.c + s.p.map((v, i) => fmt(v + (i % 2 ? dy : dx))).join(" ")).join("");
/** Box of the points (control points included: a little loose on curves, only used for flat nodes) */
function hull(segs: Seg[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  segs.forEach((s) => { for (let i = 0; i < s.p.length; i += 2) { x0 = Math.min(x0, s.p[i]); x1 = Math.max(x1, s.p[i]); y0 = Math.min(y0, s.p[i + 1]); y1 = Math.max(y1, s.p[i + 1]); } });
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** A geometry list → one path and its fill rule, or null when it is empty, unreadable or mixes fill rules */
function geometry(list: any[] | undefined): { segs: Seg[]; fr: string } | null {
  if (!list?.length) return null;
  const rules = new Set(list.map((g) => g.windingRule || "NONZERO"));
  if (rules.size > 1) return null;
  const segs: Seg[] = [];
  for (const g of list) { const s = figPath(g.path); if (!s) return null; segs.push(...s); }
  return segs.length ? { segs, fr: rules.has("EVENODD") ? "evenodd" : "nonzero" } : null;
}
const CAPS: Record<string, string> = { NONE: "butt", ROUND: "round", SQUARE: "square" };
const JOINS: Record<string, string> = { MITER: "miter", BEVEL: "bevel", ROUND: "round" };
/** Shapes whose outline is always closed: their fill geometry is the line a centered stroke follows */
const CLOSED = new Set(["STAR", "REGULAR_POLYGON", "POLYGON", "BOOLEAN_OPERATION"]);

export function convertFrame(frame: any, uid: () => string, fontFor: (family: string, size: number) => string = defaultFont): ConvertOut {
  // groups have no box of their own: their size is the bounding box of their content
  // a frame turned on the Figma canvas (a 1920×1080 frame turned a quarter to show 1080×1920) is imported as it shows:
  // the canvas is its box on screen, and its content keeps the frame's turn (rootM), so it stands the way it is seen
  const t0 = frame.type !== "GROUP" && frame.relativeTransform, rootRot = t0 ? (Math.atan2(t0[1][0], t0[0][0]) * 180) / Math.PI : 0;
  const turned = Math.abs(rootRot) > 0.05, rootM: M = turned ? [[t0[0][0], t0[0][1], 0], [t0[1][0], t0[1][1], 0]] : I;
  const bb0 = frame.absoluteBoundingBox, useBox = (frame.type === "GROUP" || turned) && bb0;
  const fw = useBox ? bb0.width : frame.size?.x ?? bb0.width, fh = useBox ? bb0.height : frame.size?.y ?? bb0.height;
  const { W, H, k, key: ratio } = canvasOf(fw, fh), offX = 0, offY = 0;
  const fbb = frame.absoluteBoundingBox || { x: 0, y: 0, width: fw, height: fh };
  const warn = new Set<string>(), layers: any[] = [], rasters: ConvertOut["rasters"] = [], images: ConvertOut["images"] = [];

  if (k < 1) warn.add(`The frame is ${Math.round(fw)}×${Math.round(fh)}: scaled down to ${W}×${H} (the studio canvas stops at ${MAX_SIDE}px)`);

  const isGroup = frame.type === "GROUP"; // a group imported on its own: transparent, like Figma exports it
  const fF = imageFills(frame.fills, W, H);
  const paints = visiblePaints(frame.fills), solid = paints.find((p) => p.type === "SOLID");
  const firstStop = paints.find((p) => p.gradientStops?.length)?.gradientStops[0]?.color;
  const bg = solid ? rgba(solid.color, solid.opacity ?? 1) : firstStop ? rgba(firstStop) : "#FFFFFF";
  // the frame's own fill: in a turned frame, a box of the frame's size turned the same way (gradients and pictures turn with it)
  const sw0 = turned ? (frame.size?.x ?? fw) * k : W, sh0 = turned ? (frame.size?.y ?? fh) * k : H;
  const fF0 = turned ? imageFills(frame.fills, sw0, sh0) : fF;
  if (turned && Math.abs(Math.abs(rootRot) - 90) > 0.05 && Math.abs(Math.abs(rootRot) - 180) > 0.05) warn.add("The frame is turned: its background is cut to its box on the canvas");
  layers.push({ id: uid(), type: "rect", name: "Background", x: r1(W / 2 - sw0 / 2), y: r1(H / 2 - sh0 / 2), w: r1(sw0), h: r1(sh0), rot: r1(rootRot), op: 1, fill: fF0.fill || (isGroup ? "transparent" : "#FFFFFF"), r: 0, locked: true, ...(fF0.adj ? { adj: fF0.adj } : {}), ...(fF0.ovs ? { ovs: fF0.ovs } : {}) });
  visiblePaints(frame.fills).filter((p) => p.type === "IMAGE").forEach((p) => images.push({ ref: p.imageRef, w: W, h: H }));

  /** Axis-aligned box of a node on the studio canvas (for rasterized nodes and groups) */
  const boxOf = (n: any, render = true) => {
    const b = (render && n.absoluteRenderBounds) || n.absoluteBoundingBox;
    return b ? { x: r1((b.x - fbb.x) * k + offX), y: r1((b.y - fbb.y) * k + offY), w: r1(b.width * k), h: r1(b.height * k) } : null;
  };

  /**
   * Effects as studio fields: the first drop shadow in shx/shy/shb/shs/shc/sha, the other drop and inner shadows in `fxs`,
   * one layer blur (bl) and one background blur (bbl). `ok` is false when the studio can't draw one of them on this kind of
   * layer: text and vectors have no inner shadow, no shadow spread and no background blur; several blurs of one kind.
   */
  const effectsOf = (n: any, kind: "box" | "text" | "path") => {
    let fx = (n.effects || []).filter((e: any) => e.visible !== false);
    const out: Record<string, any> = {};
    // grain (Figma's noise and texture effects): left out on a frosted-glass layer, whose blur only the studio can draw
    // (rendered by Figma, the layer would lose what's behind it); anything else with grain is rendered by Figma
    const grain = (e: any) => e.type === "NOISE" || e.type === "TEXTURE";
    if (fx.some(grain) && kind === "box" && fx.some((e: any) => e.type === "BACKGROUND_BLUR")) { fx = fx.filter((e: any) => !grain(e)); warn.add("Noise and texture effects were left out"); }
    const blurs = fx.filter((e: any) => e.type === "LAYER_BLUR"), bgs = fx.filter((e: any) => e.type === "BACKGROUND_BLUR");
    const shadows = fx.filter((e: any) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW");
    let ok = blurs.length <= 1 && bgs.length <= (kind === "box" ? 1 : 0) && shadows.length + blurs.length + bgs.length === fx.length;
    // Figma lists effects bottom first; the studio's lists are top first
    const list = [...shadows].reverse().flatMap((e: any) => {
      const inner = e.type === "INNER_SHADOW";
      if (inner && kind !== "box") { ok = false; return []; }
      if (e.spread && kind !== "box") ok = false;
      const c = e.color || { r: 0, g: 0, b: 0, a: 0.25 };
      return [{ k: inner ? "inner" : "drop", x: r1((e.offset?.x || 0) * k), y: r1((e.offset?.y || 0) * k), b: r1(Math.max(0, e.radius || 0) * k), s: kind === "box" ? r1((e.spread || 0) * k) : 0, c: rgba({ ...c, a: 1 }), o: r3(c.a ?? 1) }];
    });
    const d = list.findIndex((e) => e.k === "drop");
    if (d >= 0) {
      const e = list.splice(d, 1)[0];
      Object.assign(out, { shx: e.x, shy: e.y, shb: e.b, shc: e.c, sha: e.o, ...(e.s ? { shs: e.s } : {}) });
    }
    if (list.length) out.fxs = list.map(({ s, ...e }) => (s ? { ...e, s } : e));
    if (blurs[0]) out.bl = r1(((blurs[0].radius || 0) * k) / 2);
    if (bgs[0] && kind === "box") out.bbl = r1(((bgs[0].radius || 0) * k) / 2); // frosted glass: blurs what is behind the layer
    return { ok, props: out };
  };

  /**
   * Strokes of a box or a text as studio fields: the top one in stroke/sw/sa/sd, the others in `sts` ({ c, w, a, d }).
   * Gradient strokes use their first color. `ok` is false when the sides have different weights (a bottom border, say).
   */
  const strokesOf = (n: any, kind: "box" | "text") => {
    const ps = (n.strokeWeight ?? 1) > 0 ? visiblePaints(n.strokes) : [];
    if (!ps.length) return { ok: true, props: {} as Record<string, any> };
    let w = n.strokeWeight ?? 1;
    const iw = n.individualStrokeWeights;
    if (iw) { const v = [iw.top, iw.right, iw.bottom, iw.left].map((x) => +x || 0); if (new Set(v).size > 1) return { ok: false, props: {} }; w = v[0]; }
    if (w <= 0) return { ok: true, props: {} };
    const a = ({ INSIDE: "inside", OUTSIDE: "outside", CENTER: "center" } as Record<string, string>)[n.strokeAlign] || (kind === "text" ? "outside" : "inside");
    const dd = n.strokeDashes as number[] | undefined;
    const d = dd?.length && dd.some((x) => x > 0) ? (dd[0] <= 0.01 || (n.strokeCap === "ROUND" && dd[0] <= w * 0.6) ? "dot" : "dash") : null;
    const list = [...ps].reverse().flatMap((p) => {
      if (p.type === "SOLID") return [rgba(p.color, p.opacity ?? 1)];
      const s0 = p.gradientStops?.[0]?.color;
      if (s0) { warn.add("Gradient strokes use their first color"); return [rgba(s0, p.opacity ?? 1)]; }
      warn.add("Image strokes were left out"); return [];
    });
    if (!list.length) return { ok: true, props: {} };
    if (kind === "text" && list.length > 1) warn.add("Text with several strokes keeps the top one");
    const sw = r1(w * k), home = kind === "text" ? "outside" : "inside";
    const props: Record<string, any> = { stroke: list[0], sw, ...(a !== home ? { sa: a } : {}), ...(d ? { sd: d } : {}) };
    if (kind === "box" && list.length > 1) props.sts = list.slice(1).map((c) => ({ c, w: sw, a, ...(d ? { d } : {}) }));
    return { ok: true, props };
  };

  /** Corner radius: `r` (the largest), plus `rs` [top-left, top-right, bottom-right, bottom-left] when the corners differ */
  const radiusOf = (n: any) => {
    const radii = n.rectangleCornerRadii as number[] | undefined;
    if (radii && radii.length === 4 && new Set(radii).size > 1) return { r: r1(Math.max(...radii) * k), rs: radii.map((x) => r1(x * k)) };
    const r = (radii ? radii[0] : n.cornerRadius || 0) * k;
    return r ? { r: r1(r) } : { r: 0 };
  };

  /**
   * Blend mode of a layer. Figma also sets blend modes on fills: when every visible fill and stroke uses the same one
   * (and the layer itself doesn't), it is the layer's blend in the studio, which looks the same.
   */
  const blendOf = (n: any): Record<string, string> => {
    const paints = [...visiblePaints(n.fills), ...visiblePaints(n.strokes)], pb = paints.length && paints.every((p) => p.blendMode && p.blendMode === paints[0].blendMode) ? paints[0].blendMode : null;
    const mode = BLEND[n.blendMode] ? n.blendMode : pb && BLEND[pb] ? pb : null, b = mode && BLEND[mode];
    if (!BLEND[n.blendMode] && paints.some((p) => BLEND[p.blendMode]) && !b) warn.add("Fills with different blend modes use Normal");
    if (mode === "LINEAR_BURN") warn.add("“Linear burn” is approximated with Multiply");
    return b ? { blend: b } : {};
  };
  const nameOf = (n: any, def: string) => String(n.name || def).slice(0, 60);

  /** A node rendered by Figma, placed as an image (the frames around it clip it in the studio, like in Figma) */
  const raster = (n: any, pid?: string) => {
    const b = boxOf(n);
    if (!b || b.w < 0.5 || b.h < 0.5) return;
    rasters.push({ id: n.id, w: b.w, h: b.h });
    layers.push({ id: uid(), type: "image", name: nameOf(n, "Image"), ...b, rot: 0, op: 1, ...blendOf(n), fill: `url({{raster:${n.id}}}) center/100% 100% no-repeat`, r: 0, ...(pid ? { pid } : {}) });
  };

  /**
   * Rotated box of a node: studio layers rotate around their center. The center comes from the absolute bounding
   * box (exact for any parent: frames, groups, nested groups; a rotated node's box has the same center), the
   * rotation from the transform; the transform alone is the fallback when Figma sends no box.
   */
  const placed = (n: any, m: M) => {
    const b = n.absoluteBoundingBox;
    const w = n.size?.x ?? b?.width ?? 0, h = n.size?.y ?? b?.height ?? 0;
    const [cx, cy] = b ? [b.x + b.width / 2 - fbb.x, b.y + b.height / 2 - fbb.y] : apply(m, w / 2, h / 2);
    // a mirrored transform is a rotation then a horizontal flip: m = R(θ)·diag(-1, 1)
    const flip = mirrored(m), rot = ((flip ? Math.atan2(-m[1][0], -m[0][0]) : Math.atan2(m[1][0], m[0][0])) * 180) / Math.PI;
    return { x: r1(cx * k + offX - (w * k) / 2), y: r1(cy * k + offY - (h * k) / 2), w: r1(w * k), h: r1(h * k), rot: r1(Math.abs(rot) < 0.05 ? 0 : rot), ...(flip ? { fx: true } : {}) };
  };
  const relOf = (n: any): M => (n.relativeTransform as M) || [[1, 0, n.absoluteBoundingBox ? n.absoluteBoundingBox.x - fbb.x : 0], [0, 1, n.absoluteBoundingBox ? n.absoluteBoundingBox.y - fbb.y : 0]];
  const mirrored = (m: M) => m[0][0] * m[1][1] - m[0][1] * m[1][0] < 0;

  const overflows = (n: any) => {
    const b = n.absoluteBoundingBox;
    return b && (n.children || []).some((c: any) => {
      const a = c.visible !== false && c.absoluteBoundingBox;
      return a && (a.x < b.x - 1 || a.y < b.y - 1 || a.x + a.width > b.x + b.width + 1 || a.y + a.height > b.y + b.height + 1);
    });
  };

  /**
   * Opacity of a picture fill (Figma: Image 60 %): with the picture as the only fill and no stroke, it is the layer's
   * opacity in the studio, which looks the same; otherwise the picture shows opaque, with a note.
   */
  const imgOp = (n: any, strokeProps: Record<string, any>) => {
    const ps = visiblePaints(n.fills), img = ps.find((p) => p.type === "IMAGE"), o = img?.opacity ?? 1;
    if (o >= 0.999) return 1;
    if (ps.length === 1 && !strokeProps.stroke) return o;
    warn.add("Pictures with a fill opacity under other fills or a stroke show opaque");
    return 1;
  };
  /** A rectangle or an ellipse (null when the studio can't draw its effects or strokes: the caller renders it) */
  const shape = (n: any, m: M, type: "rect" | "ellipse"): any | null | undefined => {
    const E = effectsOf(n, "box"), S = strokesOf(n, "box");
    if (!E.ok || !S.ok) return null;
    const g = placed(n, m), F = imageFills(n.fills, g.w, g.h);
    if (!F.fill && !S.props.stroke && !Object.keys(E.props).length) return undefined; // draws nothing
    const isImage = visiblePaints(n.fills).some((p) => p.type === "IMAGE");
    const circle = type === "ellipse" && Math.abs(g.w - g.h) < 1;
    if (isImage && type === "ellipse" && !circle && (S.props.stroke || F.adj)) return null;
    visiblePaints(n.fills).filter((p) => p.type === "IMAGE").forEach((p) => images.push({ ref: p.imageRef, w: g.w, h: g.h }));
    // a picture in a circle: an image layer rounded into the circle (it keeps the image tools)
    const t = isImage && (type === "rect" || circle) ? "image" : type, rad = type === "ellipse" ? (circle && t === "image" ? { r: r1(g.w / 2) } : {}) : radiusOf(n);
    return {
      id: uid(), type: t, name: nameOf(n, type === "ellipse" ? "Ellipse" : "Rectangle"), ...g, op: r3((n.opacity ?? 1) * imgOp(n, S.props)), ...blendOf(n),
      fill: F.fill || "transparent", r: 0, ...rad, ...(F.adj ? { adj: F.adj } : {}), ...(F.ovs ? { ovs: F.ovs } : {}), ...S.props, ...E.props,
    };
  };

  /**
   * A vector, star, polygon, line or boolean shape → path layers drawn from Figma's geometry, or null when the studio can't
   * draw it the same way (image or angular fills, several fills, per-region fills, effects other than drop shadows and one blur).
   * The layer box is the node's own box (rotated and flipped like it), so the geometry keeps Figma's coordinates.
   * Strokes must be centered. Solid ones on closed shapes and lines stay real strokes; the others (open vectors, dashed,
   * gradient, arrow caps) use Figma's stroke outline, filled, as a second layer above the fill.
   */
  const vectorLayers = (n: any, m: M, op: number): any[] | null => {
    // a background blur on a vector without fill frosts nothing in Figma: left out
    const noFill = !visiblePaints(n.fills).length || n.type === "LINE";
    const E = effectsOf(noFill ? { ...n, effects: (n.effects || []).filter((e: any) => e.type !== "BACKGROUND_BLUR") } : n, "path");
    if (!E.ok) return null;
    const fills = visiblePaints(n.fills), strokes = (n.strokeWeight ?? 1) > 0 ? visiblePaints(n.strokes) : [];
    if (fills.length > 1 || strokes.length > 1) return null;
    const b = n.absoluteBoundingBox, w0 = n.size?.x ?? b?.width ?? 0, h0 = n.size?.y ?? b?.height ?? 0;
    const css = (p: any) => (p.type === "SOLID" || p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL" ? paintCss(p, w0 * k, h0 * k) : null);
    const fill = fills[0] && n.type !== "LINE" ? css(fills[0]) : null, stroke = strokes[0] ? css(strokes[0]) : null;
    if ((fills[0] && n.type !== "LINE" && !fill) || (strokes[0] && !stroke)) return null;
    if (!fill && !stroke) return [];
    // regions of one vector painted differently
    if (fill && (n.fillGeometry || []).some((g: any) => g.overrideID != null && n.fillOverrideTable?.[g.overrideID]?.fills)) return null;

    // inside / outside strokes: Figma's stroke outline is twice as wide, meant to be clipped by the fill
    const sp = strokes[0], cap = CAPS[n.strokeCap || "NONE"], join = JOINS[n.strokeJoin || "MITER"];
    // an inside stroke: Figma's outline, masked by the shape (outside strokes are rendered by Figma)
    const insideMask = sp && n.strokeAlign === "INSIDE" && n.type !== "LINE" ? geometry(n.fillGeometry) : null;
    if (sp && (n.strokeAlign || "CENTER") !== "CENTER" && !insideMask) return null;
    const plain = !!sp && !insideMask && sp.type === "SOLID" && !n.strokeDashes?.length && !n.individualStrokeWeights && !!cap && !!join;
    const realStroke = plain && (n.type === "LINE" || CLOSED.has(n.type)) ? { stroke, sw: r1((n.strokeWeight ?? 1) * k), cap, join } : null;
    type Part = { segs: Seg[]; fr: string; fill: string; extra?: Record<string, any>; name: string };
    const parts: Part[] = [], name = nameOf(n, "Vector");
    if (n.type === "LINE") {
      if (!realStroke) { const g = geometry(n.strokeGeometry); if (!g) return null; parts.push({ ...g, fill: stroke!, name }); }
      else {
        // Figma doesn't always center a line's stroke on it, and keeps round / square caps inside its length:
        // the line the stroke follows is the middle of the stroke's outline, shortened by the caps
        const o = geometry(n.strokeGeometry), hb = o && hull(o.segs), sw = n.strokeWeight ?? 1, inset = cap === "butt" ? 0 : sw / 2;
        const [x0, x1, y] = hb && Math.abs(hb.h - sw) < 0.5 ? [hb.x + inset, hb.x + hb.w - inset, hb.y + hb.h / 2] : [0, w0, 0];
        parts.push({ segs: [{ c: "M", p: [x0, y] }, { c: "L", p: [x1, y] }], fr: "nonzero", fill: "none", extra: realStroke, name });
      }
    } else {
      const fg = fill || realStroke ? geometry(n.fillGeometry) : null;
      if (fill && !fg) return null;
      if (fg && (fill || realStroke)) parts.push({ ...fg, fill: fill || "none", ...(realStroke ? { extra: realStroke } : {}), name });
      if (stroke && !(realStroke && fg)) {
        const g = geometry(n.strokeGeometry); if (!g) return null;
        parts.push({ ...g, fill: stroke, name: parts.length ? `${name} stroke`.slice(0, 60) : name });
      }
    }
    if (insideMask) parts.unshift({ ...insideMask, fill: "#FFFFFF", name: `${name} shape`.slice(0, 60), extra: { mask: true, mt: "vec" } });
    // fill and stroke as two layers only look the same when nothing is shared between them
    if (parts.filter((p) => !p.extra?.mask).length > 1 && (op < 0.999 || Object.keys(E.props).length || Object.keys(blendOf(n)).length)) return null;

    // the box: the node's own, except along a flat side (a line, a flat vector): there it spans the drawing
    let bx = 0, by = 0, bw = w0, bh = h0;
    if (w0 < 1 || h0 < 1) {
      const all = hull(parts.flatMap((p) => p.segs)), pad = realStroke ? (n.strokeWeight ?? 1) / 2 : 0;
      if (!all) return null;
      if (w0 < 1) { bx = all.x - pad; bw = Math.max(1, all.w + pad * 2); }
      if (h0 < 1) { by = all.y - pad; bh = Math.max(1, all.h + pad * 2); }
    }
    // the layer turns around its own center: move it by how far that center sits from the node's, along the node's axes
    const g = placed(n, m), dx = bx + bw / 2 - w0 / 2, dy = by + bh / 2 - h0 / 2;
    const cx = g.x + g.w / 2 + (m[0][0] * dx + m[0][1] * dy) * k, cy = g.y + g.h / 2 + (m[1][0] * dx + m[1][1] * dy) * k;
    const { x: _x, y: _y, w: _w, h: _h, ...turn } = g;
    const out: any[] = parts.map((p) => ({
      id: uid(), type: "path", name: p.name, ...turn, x: r1(cx - (bw * k) / 2), y: r1(cy - (bh * k) / 2), w: r1(bw * k), h: r1(bh * k),
      op: r3(op), ...blendOf(n), d: toD(p.segs, -bx, -by), vw: r3(bw), vh: r3(bh), fill: p.fill, ...(p.fr === "evenodd" ? { fr: "evenodd" } : {}),
      ...(p.extra || {}), ...(p.extra?.mask ? {} : E.props),
    }));
    if (!insideMask) return out;
    const grp = groupLayer(n); grp.op = 1; // a mask works in its own container: the shape and its stroke in a group
    return [grp, ...out.map((l) => ({ ...l, op: l.mask ? 1 : l.op, pid: grp.id }))];
  };

  /**
   * Layers of a group or frame drawn only with vectors (a logo, an icon), or null when one of them can't be a path layer
   * (or the group itself has effects, a blend mode, a mask or clipped overflow): the whole group is then rendered by Figma.
   */
  const vectorGroup = (n: any, m: M, op: number, top = false): any[] | null => {
    if (n.visible === false) return [];
    if (n.isMask) return null;
    const o = top ? op : op * (n.opacity ?? 1), mm = mul(m, relOf(n));
    if (o <= 0.001) return [];
    if (RASTER_TYPES.has(n.type)) return vectorLayers(n, mm, o); // vectors draw their own effects (or say they can't)
    if (hasEffects(n) || visiblePaints(n.fills).length || visiblePaints(n.strokes).length) return null;
    if (!top && BLEND[n.blendMode]) return null;
    // a see-through group fades as a whole in Figma: its parts can't fade one by one where they overlap
    if (!top && (n.opacity ?? 1) < 0.999 && (n.children || []).filter((c: any) => c.visible !== false).length > 1) return null;
    if (CONTAINERS.has(n.type) && n.clipsContent !== false && overflows(n)) return null;
    const out: any[] = [];
    for (const c of n.children || []) {
      const ls = vectorGroup(c, mm, o); // Figma's REST transforms are relative to the parent, groups included
      if (!ls) return null;
      out.push(...ls);
    }
    return out;
  };

  const text = (n: any, m: M, pid?: string, inFlow = false) => {
    const s = n.style || {}, g = placed(n, m);
    let chars = String(n.characters ?? "");
    if (s.textCase === "UPPER") chars = chars.toUpperCase();
    else if (s.textCase === "LOWER") chars = chars.toLowerCase();
    else if (s.textCase === "TITLE") chars = chars.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    const fill = visiblePaints(n.fills)[0];
    if (fill && fill.type !== "SOLID") warn.add("Gradient text uses its first color");
    const color = fill ? rgba(fill.type === "SOLID" ? fill.color : fill.gradientStops?.[0]?.color ?? { r: 0, g: 0, b: 0 }, fill.opacity ?? 1) : "#000000";
    const E = effectsOf(n, "text");
    if (!E.ok) warn.add("Some text effects (inner shadows, shadow spread, background blurs) were left out");
    const S = strokesOf(n, "text");
    if (s.textDecoration === "STRIKETHROUGH") warn.add("Strikethrough text is shown without its line");
    const size = (s.fontSize || 16) * k;
    const family = String(s.fontFamily || "Inter");
    const font = fontFor(family, size);
    if (font !== family) warn.add(`Font “${family}” isn't available, swapped to ${font}`);
    else if (!STUDIO_FONTS.includes(family)) warn.add(`Font “${family}” is loaded from Google Fonts (a fallback font shows if it isn't there)`);
    const lh = s.lineHeightPx && s.fontSize ? s.lineHeightPx / s.fontSize : 1.2;
    const align = ({ CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" } as Record<string, string>)[s.textAlignHorizontal] || "left";
    // auto-width text gets a little slack (font metrics differ), growing from the side it is aligned to;
    // not in an auto layout, where its width places the layers after it
    const slack = n.textAutoResize === "WIDTH_AND_HEIGHT" && !inFlow ? g.w * 0.04 + 2 : 0;
    const va = ({ CENTER: "middle", BOTTOM: "bottom" } as Record<string, string>)[s.textAlignVertical];
    const rtl = /[֐-ࣿﭐ-﷿ﹰ-﻿]/.test(chars);
    layers.push({
      id: uid(), type: "text", name: nameOf(n, chars.replace(/\s+/g, " ").slice(0, 20) || "Text"), ...g,
      x: r1(g.x - (align === "center" ? slack / 2 : align === "right" ? slack : 0)), w: r1(g.w + slack),
      op: r3(n.opacity ?? 1), ...blendOf(n), ...(va ? { va } : {}),
      text: chars, size: r1(size), weight: s.fontWeight || 400, font, color, align, lh: r3(lh), ls: r1((s.letterSpacing || 0) * k),
      ...(s.italic ? { it: true } : {}), ...(s.textDecoration === "UNDERLINE" ? { ul: true } : {}),
      ...(rtl ? { dir: "rtl" } : {}), ...S.props, ...E.props, ...(pid ? { pid } : {}),
    });
    // mixed styles (Figma: characterStyleOverrides + styleOverrideTable) → runs over the text: [{ s, e, ...style }]
    const ov: number[] = n.characterStyleOverrides || [], table = n.styleOverrideTable || {}, runs: any[] = [];
    let text2 = chars;
    for (let i = 0; i < ov.length;) {
      const id = ov[i] || 0; let j = i; while (j + 1 < ov.length && (ov[j + 1] || 0) === id) j++;
      const st = id && table[id];
      if (st) {
        const r: any = { s: i, e: j + 1 };
        if (st.fontWeight && st.fontWeight !== (s.fontWeight || 400)) r.weight = st.fontWeight;
        const rsize = st.fontSize ? st.fontSize * k : size;
        if (st.fontSize && Math.abs(rsize - size) > 0.05) r.size = r1(rsize);
        if (st.fontFamily && st.fontFamily !== family) { const f2 = fontFor(st.fontFamily, rsize); r.font = f2; if (f2 !== st.fontFamily) warn.add(`Font “${st.fontFamily}” isn't available, swapped to ${f2}`); }
        if (st.italic != null && !!st.italic !== !!s.italic) r.it = !!st.italic;
        if (st.textDecoration && (st.textDecoration === "UNDERLINE") !== (s.textDecoration === "UNDERLINE")) r.ul = st.textDecoration === "UNDERLINE";
        if (st.letterSpacing != null && st.letterSpacing !== s.letterSpacing) r.ls = r1(st.letterSpacing * k);
        if (st.lineHeightPx && (st.fontSize || s.fontSize)) { const l2 = r3(st.lineHeightPx / (st.fontSize || s.fontSize)); if (Math.abs(l2 - lh) > 0.005) r.lh = l2; }
        const f0 = visiblePaints(st.fills)[0];
        if (f0 && f0.type === "SOLID") { const c2 = rgba(f0.color, f0.opacity ?? 1); if (c2 !== color) r.color = c2; }
        if (st.textCase === "UPPER") text2 = text2.slice(0, i) + text2.slice(i, j + 1).toUpperCase() + text2.slice(j + 1);
        else if (st.textCase === "LOWER") text2 = text2.slice(0, i) + text2.slice(i, j + 1).toLowerCase() + text2.slice(j + 1);
        if (Object.keys(r).length > 2) runs.push(r);
      }
      i = j + 1;
    }
    if (runs.length || text2 !== chars) { const L = layers[layers.length - 1]; L.text = text2; if (runs.length) { L.runs = runs; L.rt = text2; } }
  };

  /* ---------- containers: frames, groups, auto layout, masks ---------- */
  /** Parent of the layers being placed: its layer (undefined for the page), and the auto layout they flow in */
  /** lh: the auto layout runs along the frame's own x axis (in Figma); turned: the frame is turned on the page */
  type Par = { id?: string; frame?: boolean; al?: any; mask?: boolean; lh?: boolean; turned?: boolean };
  const groupLayer = (n: any, pid?: string, name?: string) => {
    const b = boxOf(n, false) || { x: 0, y: 0, w: 1, h: 1 };
    return { id: uid(), type: "group", name: name || nameOf(n, "Group"), ...b, rot: 0, op: r3(n.opacity ?? 1), ...(pid ? { pid } : {}) };
  };
  /** Figma's auto layout → the studio's (frame.al); wrapping and grid layouts stay as placed */
  /** Where a node's own x and y axes point on the page (unit steps), when it is turned by quarters or flipped; else null */
  const axesOf = (m: M) => {
    const q = (v: number) => (Math.abs(v) < 1e-3 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-3 ? Math.sign(v) : NaN);
    const dx = [q(m[0][0]), q(m[1][0])], dy = [q(m[0][1]), q(m[1][1])];
    return [...dx, ...dy].some(Number.isNaN) ? null : { dx, dy };
  };
  type Axes = { dx: number[]; dy: number[] };
  /** A direction on the page → the side it points to: 0 top, 1 right, 2 bottom, 3 left */
  const sideOf = (d: number[]) => (d[0] > 0 ? 1 : d[0] < 0 ? 3 : d[1] > 0 ? 2 : 0);
  const neg = (d: number[]) => [-d[0], -d[1]];
  /** An auto layout in a frame's own axes → the same layout on the page (direction, order, padding, alignment, hugging) */
  const turnAL = (al: any, A: Axes) => {
    const p = [0, 0, 0, 0], lp = al.p || [0, 0, 0, 0];
    p[sideOf(neg(A.dy))] = lp[0]; p[sideOf(A.dx)] = lp[1]; p[sideOf(A.dy)] = lp[2]; p[sideOf(neg(A.dx))] = lp[3];
    const main = al.d === "h" ? A.dx : A.dy, cross = al.d === "h" ? A.dy : A.dx, back = main[0] + main[1] < 0;
    const flip = (v: string) => (v === "start" ? "end" : v === "end" ? "start" : v);
    const m = back ? flip(al.m || "start") : al.m || "start", c = cross[0] + cross[1] < 0 ? flip(al.c || "start") : al.c || "start";
    const hugW = A.dx[0] ? al.hw : al.hh, hugH = A.dx[1] ? al.hw : al.hh;
    return { d: main[0] ? "h" : "v", g: al.g, p, m, ...(c !== "start" ? { c } : {}), ...(hugW ? { hw: true } : {}), ...(hugH ? { hh: true } : {}), ...(back ? { rv: true } : {}) };
  };
  /** Corners [top-left, top-right, bottom-right, bottom-left] of a turned frame, as they show */
  const turnCorners = (rs: number[], A: Axes) => {
    const out = [0, 0, 0, 0];
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([cx, cy], i) => {
      const x = A.dx[0] * cx + A.dy[0] * cy, y = A.dx[1] * cx + A.dy[1] * cy;
      out[y < 0 ? (x < 0 ? 0 : 1) : x > 0 ? 2 : 3] = rs[i];
    });
    return out;
  };
  /** Shadow offsets of a turned frame, as they show */
  const turnShadows = (props: Record<string, any>, A: Axes) => {
    const t = (x: number, y: number) => [r1(A.dx[0] * x + A.dy[0] * y), r1(A.dx[1] * x + A.dy[1] * y)];
    if (props.shx != null || props.shy != null) [props.shx, props.shy] = t(props.shx || 0, props.shy || 0);
    (props.fxs || []).forEach((e: any) => { [e.x, e.y] = t(e.x || 0, e.y || 0); });
  };
  /** A gradient of a turned frame (handles in the frame's own w×h) → handles in its box on the page (W×H) */
  const turnPaint = (p: any, A: Axes, w: number, h: number, W: number, H: number) => {
    if (!p?.gradientHandlePositions) return p;
    const hp = p.gradientHandlePositions.map((q: any) => {
      const X = (q.x - 0.5) * w, Y = (q.y - 0.5) * h;
      return { x: (A.dx[0] * X + A.dy[0] * Y) / W + 0.5, y: (A.dx[1] * X + A.dy[1] * Y) / H + 0.5 };
    });
    return { ...p, gradientHandlePositions: hp };
  };
  const alOf = (n: any) => {
    if (n.layoutMode !== "HORIZONTAL" && n.layoutMode !== "VERTICAL") return null;
    if (n.layoutWrap === "WRAP") { warn.add("Wrapping auto layouts keep their positions (no auto layout in the studio)"); return null; }
    const Hz = n.layoutMode === "HORIZONTAL";
    const MA: Record<string, string> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "between" }, CA: Record<string, string> = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "end" };
    const hugW = n.layoutSizingHorizontal ? n.layoutSizingHorizontal === "HUG" : (Hz ? n.primaryAxisSizingMode : n.counterAxisSizingMode) === "AUTO";
    const hugH = n.layoutSizingVertical ? n.layoutSizingVertical === "HUG" : (Hz ? n.counterAxisSizingMode : n.primaryAxisSizingMode) === "AUTO";
    const c = CA[n.counterAxisAlignItems || "MIN"] || "start";
    return {
      d: Hz ? "h" : "v", g: r1((n.itemSpacing || 0) * k), p: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((v) => r1((v || 0) * k)),
      m: MA[n.primaryAxisAlignItems || "MIN"] || "start", ...(c !== "start" ? { c } : {}), ...(hugW ? { hw: true } : {}), ...(hugH ? { hh: true } : {}),
    };
  };
  const CT: Record<string, string> = { RIGHT: "end", BOTTOM: "end", CENTER: "center", LEFT_RIGHT: "both", TOP_BOTTOM: "both", SCALE: "scale" };
  /** How a node sits in its frame: auto layout (fills, stretches, absolute) and constraints */
  const childProps = (n: any, par: Par): Record<string, any> => {
    const o: Record<string, any> = {};
    if (!par.frame) return o;
    if (par.al) {
      if (n.layoutPositioning === "ABSOLUTE") o.ab = true;
      else {
        const Hz = par.lh ?? par.al.d !== "v"; // the child's sizing is in its frame's own axes
        if (n.layoutGrow === 1 || (Hz ? n.layoutSizingHorizontal : n.layoutSizingVertical) === "FILL") o.gr = true;
        if (n.layoutAlign === "STRETCH" || (Hz ? n.layoutSizingVertical : n.layoutSizingHorizontal) === "FILL") o.stc = true;
      }
    }
    if (!par.mask && !par.turned && (!par.al || o.ab) && n.constraints) {
      const ct: Record<string, string> = {}, h = CT[n.constraints.horizontal], v = CT[n.constraints.vertical];
      if (h) ct.h = h; if (v) ct.v = v;
      if (Object.keys(ct).length) o.ct = ct;
    }
    return o;
  };

  /**
   * The children of a container, in paint order. A mask stays a layer of its own (`mask`: it draws nothing and masks
   * the layers above it in the same container, by its shape and its alpha, like Figma; `mt`: "lum" for a luminance
   * mask, "vec" for an outline mask, where only the shape counts).
   */
  const kidsWalk = (n: any, kids: any[], m: M, par: Par, clip?: Clip) => {
    let cclip = clip;
    for (const c of kids) {
      if (!c.isMask) { walk(c, m, par, cclip); continue; }
      if (c.visible === false) continue;
      // the mask's alpha is its fill (an outline mask: its shape, painted opaque); strokes and effects don't mask
      const outline = c.maskType === "VECTOR" || !visiblePaints(c.fills).length;
      const node = { ...c, isMask: false, effects: [], strokes: [], ...(outline ? { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }] } : {}) };
      const from = layers.length;
      walk(node, m, par, undefined);
      let own = layers.slice(from).filter((l) => l.pid === par.id);
      if (own.length !== 1 || own[0].type === "group") { layers.length = from; raster(c, par.id); own = layers.slice(from); } // a mask drawn with several shapes: its picture
      if (own[0]) Object.assign(own[0], { mask: true, ...(c.maskType === "LUMINANCE" ? { mt: "lum" } : outline ? { mt: "vec" } : {}) });
      const b = c.absoluteBoundingBox;
      if (b) cclip = cut(clip, { x: b.x, y: b.y, w: b.width, h: b.height, r: 0 }); // what the mask hides entirely is left out
    }
  };

  /** Where a node stands against the clip of the frames around it: inside (or partly), or entirely hidden */
  const hiddenBy = (n: any, clip?: Clip) => {
    const a = n.absoluteRenderBounds || n.absoluteBoundingBox;
    if (!clip || !a) return false;
    // a line has no height: it counts as 1px thick
    const w = Math.max(1, a.width), h = Math.max(1, a.height), x = a.x - (w - a.width) / 2, y = a.y - (h - a.height) / 2;
    const c = cut(clip, { x, y, w, h, r: 0 });
    return c.w < 0.5 || c.h < 0.5;
  };

  /**
   * One Figma node → studio layers, inside the container `par`. m: transform of the node's parent (Figma's REST
   * transforms are relative to the parent, groups included); clip: box of the clipping frames around the node, to leave out what they hide entirely.
   */
  const walk = (n: any, m: M, par: Par, clip?: Clip) => {
    if (!n || n.visible === false || (n.opacity ?? 1) <= 0.001 || hiddenBy(n, clip)) return;
    const from = layers.length, pid = par.id;
    emit(n, m, par, clip);
    // the node's own layer (the first one placed in `par`) takes its place in the frame: auto layout, constraints
    const own = layers.slice(from).filter((l) => l.pid === pid);
    if (own.length === 1) Object.assign(own[0], childProps(n, par));
  };

  const emit = (n: any, m: M, par: Par, clip?: Clip) => {
    const mm = mul(m, relOf(n)), kids: any[] = n.children || [], from = layers.length;
    const isCont = n.type === "GROUP" || CONTAINERS.has(n.type);

    // a blended group or frame: its layers take its blend mode (the studio's groups don't paint), with a note
    const gb = isCont && kids.length && BLEND[n.blendMode];
    if (gb) {
      emitContent(n, m, mm, par, clip, kids, isCont);
      const own = layers[from];
      layers.slice(from).forEach((l) => { if (l.type !== "group" && !l.mask && !l.blend && true) l.blend = gb; });
      warn.add(`The blend mode of “${nameOf(n, "Group")}” is applied to each of its layers`);
      return;
    }
    emitContent(n, m, mm, par, clip, kids, isCont);
  };

  const emitContent = (n: any, m: M, mm: M, par: Par, clip: Clip | undefined, kids: any[], isCont: boolean) => {
    const pid = par.id, from = layers.length;
    const R = () => { layers.length = from; raster(n, pid); };
    if (isCont && vectorOnly(n) && !kids.some((c) => c.isMask) && !visiblePaints(n.fills).length && !visiblePaints(n.strokes).length) { // logo / icon
      const ls = vectorGroup(n, m, 1, true);
      if (!ls) return R();
      if (!ls.length) return;
      if (ls.length === 1 && ls[0].type !== "group") { layers.push({ ...ls[0], name: nameOf(n, ls[0].name), op: r3((ls[0].op ?? 1) * (n.opacity ?? 1)), ...(pid ? { pid } : {}) }); return; }
      layers.push(groupLayer(n, pid)); // the group carries its opacity
      const g = layers[layers.length - 1];
      layers.push(...ls.map((l) => ({ ...l, pid: l.pid || g.id })));
      return;
    }
    if (n.type === "GROUP") {
      const g = groupLayer(n, pid);
      layers.push(g);
      // the children's transforms are relative to the group (a turned group turns its content)
      kidsWalk(n, kids, mm, { id: g.id }, clip);
      return;
    }
    if (n.type === "TEXT") return text(n, mm, pid, !!par.al && n.layoutPositioning !== "ABSOLUTE");
    if (RASTER_TYPES.has(n.type)) {
      const ls = vectorLayers(n, mm, n.opacity ?? 1);
      if (!ls) return R();
      if (ls.length === 1) layers.push({ ...ls[0], ...(pid ? { pid } : {}) });
      else if (ls[0].type === "group") layers.push({ ...ls[0], ...(pid ? { pid } : {}) }, ...ls.slice(1));
      else if (ls.length > 1) { const g = groupLayer(n, pid); g.op = 1; layers.push(g, ...ls.map((l) => ({ ...l, pid: l.pid || g.id }))); } // fill + stroke outline
      return;
    }
    if (mirrored(mm) && !["RECTANGLE", "ELLIPSE"].includes(n.type)) return R();
    if (n.type === "ELLIPSE" || n.type === "RECTANGLE") {
      if (n.type === "ELLIPSE" && n.arcData && (n.arcData.endingAngle - n.arcData.startingAngle < 6.28 || n.arcData.innerRadius > 0)) return R();
      const L = shape(n, mm, n.type === "ELLIPSE" ? "ellipse" : "rect");
      if (L === null) return R();
      if (L) layers.push({ ...L, ...(pid ? { pid } : {}) });
      return;
    }
    if (CONTAINERS.has(n.type)) {
      const name = nameOf(n, "Frame"), txt = hasText(n), g = placed(n, mm);
      // the studio's frames stand upright: a frame turned a quarter (or flipped) is rebuilt the way it shows, its auto
      // layout, padding, corners, gradients and shadows turned with it; a frame turned otherwise is rendered by Figma
      const A = g.rot || g.fx ? axesOf(mm) : null;
      if ((g.rot || g.fx) && !A) { if (txt) warn.add(`“${name}” is rotated: it was imported as a picture`); return R(); }
      const E = effectsOf(n, "box"), S = strokesOf(n, "box");
      if ((!E.ok || !S.ok || (E.props.bl && kids.length)) && !txt) return R();
      if (!E.ok) warn.add(`“${name}”: some effects were simplified so its texts stay editable`);
      if (!S.ok) warn.add(`“${name}”: borders on some sides only were left out so its texts stay editable`);
      if (E.props.bl && kids.length) { delete E.props.bl; warn.add(`“${name}”: the layer blur was left out so its texts stay editable`); }
      const box = A ? { ...boxOf(n, false)!, rot: 0 } : g, lw = g.w, lh = g.h;
      const fills0 = A ? (n.fills || []).map((p: any) => turnPaint(p, A, lw, lh, box.w, box.h)) : n.fills;
      if (A && visiblePaints(n.fills).some((p) => p.type === "IMAGE")) warn.add(`“${name}” is turned: its picture fill shows unturned`);
      const F = imageFills(fills0, box.w, box.h);
      visiblePaints(n.fills).filter((p) => p.type === "IMAGE").forEach((p) => images.push({ ref: p.imageRef, w: box.w, h: box.h }));
      const al0 = alOf(n), al = al0 && A ? turnAL(al0, A) : al0, clips = n.clipsContent !== false, rad = radiusOf(n);
      if (A && rad.rs) rad.rs = turnCorners(rad.rs, A);
      if (A) turnShadows(E.props, A);
      const L = {
        id: uid(), type: "frame", name, ...box, op: r3(n.opacity ?? 1), fill: F.fill || "transparent", ...rad,
        ...(F.adj ? { adj: F.adj } : {}), ...(F.ovs ? { ovs: F.ovs } : {}), ...S.props, ...E.props,
        ...(clips ? {} : { noclip: true }), ...(al ? { al } : {}), ...(pid ? { pid } : {}),
      };
      layers.push(L);
      const b = n.absoluteBoundingBox, inner = clips && b ? cut(clip, { x: b.x, y: b.y, w: b.width, h: b.height, r: 0 }) : clip;
      const me: Par = { id: L.id, frame: true, al, ...(al0 ? { lh: al0.d === "h" } : {}), ...(A ? { turned: true } : {}) };
      kidsWalk(n, kids, mm, me, inner);
      return;
    }
    warn.add(`Unsupported layers (${String(n.type).toLowerCase()}) were skipped`);
  };

  // the page is the frame: its content is placed on the canvas (the frame's auto layout stays as Figma placed it)
  const root: Par = {}, rootClip = frame.clipsContent !== false && fbb ? { x: fbb.x, y: fbb.y, w: fbb.width, h: fbb.height, r: 0 } : undefined;
  const kids0 = frame.children || [];
  kidsWalk(frame, kids0, rootM, root, rootClip);
  if (hasEffects(frame)) warn.add("Shadows and blurs of the frame itself were left out");
  return { bg, layers, rasters, images, warnings: [...warn], ratio, width: W, height: H, scale: k };
}

/** Missing families: serif → Playfair Display, display sizes → Plus Jakarta Sans, the rest → Inter */
export function defaultFont(family: string, size: number) {
  if (STUDIO_FONTS.includes(family)) return family;
  if (/serif|garamond|times|georgia|playfair|merriweather|lora/i.test(family) && !/sans/i.test(family)) return "Playfair Display";
  if (/arab|naskh|kufi|tajawal|cairo/i.test(family)) return "Cairo";
  return size >= 28 ? "Plus Jakarta Sans" : "Inter";
}

/** Figma link → file key and optional node id ("12-34" in URLs, "12:34" in the API) */
export function parseFigmaUrl(input: string): { fileKey: string; nodeId?: string } | null {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return /^[A-Za-z0-9]{10,}$/.test(input.trim()) ? { fileKey: input.trim() } : null; }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const i = parts.findIndex((p) => ["file", "design", "proto"].includes(p));
  if (i < 0 || !parts[i + 1]) return null;
  const b = parts.indexOf("branch");
  const fileKey = b > i && parts[b + 1] ? parts[b + 1] : parts[i + 1];
  const node = u.searchParams.get("node-id");
  return { fileKey, nodeId: node ? decodeURIComponent(node).replace(/-/g, ":") : undefined };
}
