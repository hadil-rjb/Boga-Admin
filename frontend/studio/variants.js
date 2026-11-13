/*
   Versions of a design: the same pages in another size, theme or language (the editor's "Versions" dialog, engine v36).
   Pure functions on page objects ({ bg, layers, live? }) so they can be tested without the studio:
   - resizePage: full-bleed layers cover the new canvas, the rest is scaled as one block and centred;
   - swapTheme: neutral colours swap between light and dark (brand colours, photos and accents stay), a photo or
     coloured background gets a veil of the other theme;
   - swapLanguage: translated texts, reading direction, alignment and the brand's Arabic font; live data follows.
*/

/** Sizes a version can take (the key is the studio's ratio key; "WxH" keys are custom canvases) */
export const SIZES = [
  { key: '1:1', name: 'Square', w: 1080, h: 1080 },
  { key: '4:5', name: 'Portrait', w: 1080, h: 1350 },
  { key: '9:16', name: 'Story', w: 1080, h: 1920 },
  { key: '1920x1080', name: 'Landscape', w: 1920, h: 1080 },
];

/* ---------- colours ---------- */
const COLOR_RE = /#[0-9a-f]{8}\b|#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi;
/** "#RGB", "#RRGGBB", "#RRGGBBAA", "rgb()" or "rgba()" → { r, g, b, a } (0-255, alpha 0-1), else null */
export function parseColor(c) {
  const s = String(c || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) { const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]; return { r: +m[1], g: +m[2], b: +m[3], a }; }
  return null;
}
/** Relative luminance (0 black … 1 white) of a colour, or null when it isn't one */
export function lumOf(c) {
  const p = typeof c === 'string' ? parseColor(c) : c; if (!p) return null;
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(p.r) + 0.7152 * ch(p.g) + 0.0722 * ch(p.b);
}
/** Saturation (HSL, 0 grey … 1 vivid) */
const satOf = (p) => { const mx = Math.max(p.r, p.g, p.b) / 255, mn = Math.min(p.r, p.g, p.b) / 255, l = (mx + mn) / 2; return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); };
/** A hex colour at an alpha, written like the studio writes colours */
const withAlpha = (hex, a) => {
  const p = parseColor(hex); if (!p) return hex;
  return a >= 0.999 ? '#' + [p.r, p.g, p.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase() : `rgba(${p.r},${p.g},${p.b},${Math.round(a * 1000) / 1000})`;
};
/**
 * One colour in the other theme. Text, strokes and vectors (logos, icons) swap between light and dark when they are
 * neutral; fills swap when they are a neutral surface (a dark card on a dark design), and a see-through light veil
 * (a glass card) becomes a see-through dark one. Brand colours (saturated) and mid greys stay.
 */
export function swapColor(c, to, pal, role) {
  const p = parseColor(c); if (!p) return c;
  const L = lumOf(p), S = satOf(p), neutral = S < 0.3;
  if (!neutral) return c;
  if (role === 'ink') {
    if (to === 'light' && L > 0.55) return withAlpha(pal.dark, p.a);
    if (to === 'dark' && L < 0.3) return withAlpha(pal.light, p.a);
    return c;
  }
  if (p.a < 0.5) { // a veil: keeps its strength, takes the other side
    if (to === 'light' && L > 0.6) return withAlpha(pal.dark, Math.min(0.5, p.a * 0.6));
    if (to === 'dark' && L < 0.4) return withAlpha(pal.light, p.a);
    return c;
  }
  if (to === 'light' && L < 0.25) return withAlpha(pal.light, p.a);
  if (to === 'dark' && L > 0.75) return withAlpha(pal.dark, p.a);
  return c;
}
/** Every colour in a CSS value (a colour, a gradient, a background list) through swapColor; pictures stay */
const swapAll = (v, to, pal, role) => (typeof v === 'string' ? v.replace(COLOR_RE, (m) => swapColor(m, to, pal, role)) : v);

/* ---------- reading a design ---------- */
const AR_RE = /[؀-ۿ]/;
const texts = (pages) => pages.flatMap((pg) => (pg.layers || []).filter((l) => l.type === 'text' && !l.hidden && String(l.text || '').trim()));
/** "ar" when most of the design's words are Arabic, else "en" */
export function langOf(pages) {
  let ar = 0, lat = 0;
  texts(pages).forEach((l) => { const t = String(l.text); ar += (t.match(/[؀-ۿ]/g) || []).length; lat += (t.match(/[A-Za-z]/g) || []).length; });
  return ar > lat ? 'ar' : 'en';
}
/** "dark" when most of the text is light (it sits on something dark), else "light"; with no text, the background decides */
export function themeOf(pages) {
  let light = 0, dark = 0;
  texts(pages).forEach((l) => { const L = lumOf(l.color), n = String(l.text).length * (l.size || 16); if (L == null) return; if (L > 0.5) light += n; else dark += n; });
  if (light || dark) return light > dark ? 'dark' : 'light';
  const pg = pages[0] || {}, bgL = lumOf((String(pg.bg || '').match(COLOR_RE) || [])[0]);
  return bgL != null && bgL < 0.4 ? 'dark' : 'light';
}

/* ---------- size ---------- */
/** Axis-aligned box of a layer (rotation included) */
function box(l) {
  const t = ((l.rot || 0) * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t)), w = l.w * c + l.h * s, h = l.w * s + l.h * c;
  return { x: l.x + l.w / 2 - w / 2, y: l.y + l.h / 2 - h / 2, w, h };
}
/** A layer that fills the canvas: the locked background, or a layer whose box covers (almost) all of it */
const fillsCanvas = (l, W, H) => { if (l.name === 'Background' && l.locked) return true; const b = box(l); return b.x <= W * 0.02 && b.y <= H * 0.02 && b.x + b.w >= W * 0.98 && b.y + b.h >= H * 0.98; };
/**
 * Backdrop rather than content: fills the canvas, or is mostly outside it (a glow, a texture or a light ray bleeding off
 * the edges), or takes most of it. Content (cards, texts, logos, pictures) sits mostly inside the canvas.
 */
const isBackdrop = (l, W, H) => {
  if (fillsCanvas(l, W, H)) return true;
  const b = box(l), iw = Math.max(0, Math.min(W, b.x + b.w) - Math.max(0, b.x)), ih = Math.max(0, Math.min(H, b.y + b.h) - Math.max(0, b.y));
  const inside = (iw * ih) / Math.max(1, b.w * b.h);
  return inside < 0.75 || b.w * b.h > W * H * 0.75;
};
const r1 = (n) => Math.round(n * 10) / 10;
/** Sizes inside a layer (type, corners, strokes, effects, auto layout) scaled by k */
function scaleInside(l, k) {
  ['size', 'ls', 'r', 'sw', 'shx', 'shy', 'shb', 'shs', 'bl', 'bbl', 'fs0', 'fh0'].forEach((p) => { if (typeof l[p] === 'number' && l[p]) l[p] = r1(l[p] * k); });
  if (Array.isArray(l.rs)) l.rs = l.rs.map((v) => r1(v * k));
  (l.fxs || []).forEach((e) => ['x', 'y', 'b', 's'].forEach((p) => { if (e[p]) e[p] = r1(e[p] * k); }));
  (l.sts || []).forEach((e) => { if (e.w) e.w = r1(e.w * k); });
  (l.runs || []).forEach((r) => ['size', 'ls'].forEach((p) => { if (r[p]) r[p] = r1(r[p] * k); }));
  if (l.al) { l.al.g = r1((l.al.g || 0) * k); if (l.al.p) l.al.p = l.al.p.map((v) => r1(v * k)); }
}
/** Moves a layer by a transform around its centre: centre (cx, cy) → (ox + (cx - ax) * k, oy + (cy - ay) * k) */
function place(l, k, ax, ay, ox, oy) {
  const cx = l.x + l.w / 2, cy = l.y + l.h / 2, w = l.w * k, h = l.h * k;
  l.x = r1(ox + (cx - ax) * k - w / 2); l.y = r1(oy + (cy - ay) * k - h / 2); l.w = r1(w); l.h = r1(h);
  if (l._w != null) { l._x = l.x; l._y = l.y; l._w = l.w; l._h = l.h; } // containers: already where they go (syncTree mustn't move the content again)
  scaleInside(l, k);
}
/**
 * The page in another size. The backdrop (backgrounds, full-bleed photos, glows and textures bleeding off the edges)
 * covers the new canvas, centred; the content is scaled as one block, so the composition keeps its proportions, and centred,
 * fitted with a margin (a story's content fits a square, a square's content grows a little in a story, at most 15%).
 * A container's content follows it.
 */
export function resizePage(pg, [W, H], [nw, nh]) {
  if (W === nw && H === nh) return pg;
  const L = pg.layers || [], byId = new Map(L.map((l) => [l.id, l]));
  const top = (l) => { let t = l; for (let n = 0; t.pid && byId.get(t.pid) && n < 64; n++) t = byId.get(t.pid); return t; };
  const tops = L.filter((l) => !l.pid || !byId.get(l.pid)), bg = new Set(tops.filter((l) => isBackdrop(l, W, H)).map((l) => l.id));
  const content = tops.filter((l) => !bg.has(l.id) && !l.hidden);
  const cover = Math.max(nw / W, nh / H);
  let k = cover, ax = W / 2, ay = H / 2;
  if (content.length) {
    const bs = content.map(box), x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
    const x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
    // the block's margins in the original, kept in proportion in the new canvas
    const mx = Math.max(0, Math.min(x0, W - x1)) / W, my = Math.max(0, Math.min(y0, H - y1)) / H, m = Math.max(0.04, Math.min(mx, my, 0.12));
    k = Math.min((nw * (1 - 2 * m)) / Math.max(1, x1 - x0), (nh * (1 - 2 * m)) / Math.max(1, y1 - y0), Math.min(nw / W, nh / H) * 1.15);
    ax = (x0 + x1) / 2; ay = (y0 + y1) / 2;
  }
  L.forEach((l) => {
    const t = top(l);
    if (bg.has(t.id)) {
      if (l === t && l.name === 'Background' && l.locked) { Object.assign(l, { x: 0, y: 0, w: nw, h: nh }); return; }
      place(l, cover, W / 2, H / 2, nw / 2, nh / 2);
    } else place(l, k, ax, ay, nw / 2, nh / 2);
  });
  return pg;
}

/* ---------- theme ---------- */
/**
 * The page in the other theme. pal: { dark, light } (the brand's darkest and lightest colours). Neutral colours swap
 * (see swapColor); pictures stay. When the background is a picture or a coloured gradient, a veil of the new theme
 * goes over the layers that fill the canvas, under the content (it can be faded or deleted like any layer).
 */
export function swapTheme(pg, to, W, H, pal) {
  const L = pg.layers || [];
  if (typeof pg.bg === 'string') pg.bg = swapAll(pg.bg, to, pal, 'fill');
  L.forEach((l) => {
    if (l.mask) return; // a mask's colours only shape what's above it
    if (l.type === 'text') {
      l.color = swapAll(l.color, to, pal, 'ink');
      (l.runs || []).forEach((r) => { if (r.color) r.color = swapAll(r.color, to, pal, 'ink'); });
    } else if (typeof l.fill === 'string' && !/url\(/.test(l.fill)) l.fill = swapAll(l.fill, to, pal, l.type === 'path' ? 'ink' : 'fill');
    if (l.stroke) l.stroke = swapAll(l.stroke, to, pal, 'ink');
    (l.sts || []).forEach((s) => { if (s.c) s.c = swapAll(s.c, to, pal, 'ink'); });
    (l.ovs || []).forEach((o) => { if (o.v) o.v = swapAll(o.v, to, pal, 'fill'); });
  });
  // a picture or a colourful gradient behind everything keeps its colours: a veil of the new theme goes over it
  const byId = new Map(L.map((l) => [l.id, l])), tops = L.filter((l) => !l.pid || !byId.get(l.pid));
  const full = tops.filter((l) => fillsCanvas(l, W, H)), last = full[full.length - 1];
  const colourful = (v) => /url\(/.test(String(v || '')) || (String(v || '').match(COLOR_RE) || []).some((c) => { const p = parseColor(c); return p && satOf(p) >= 0.3; });
  if (last && full.some((l) => l.type === 'image' || colourful(l.fill)) && !L.some((l) => l.name === 'Theme veil')) {
    // after the last full-canvas layer and everything inside it
    let at = L.indexOf(last) + 1; const inLast = (l) => { for (let p = l.pid && byId.get(l.pid), n = 0; p && n < 64; p = p.pid && byId.get(p.pid), n++) if (p === last) return true; return false; };
    while (at < L.length && inLast(L[at])) at++;
    L.splice(at, 0, { id: 'veil-' + Math.random().toString(36).slice(2, 9), type: 'rect', name: 'Theme veil', x: 0, y: 0, w: W, h: H, rot: 0, op: to === 'light' ? 0.84 : 0.72, fill: to === 'light' ? pal.light : pal.dark, r: 0 });
  }
  return pg;
}

/* ---------- language ---------- */
const AR_FONTS = /cairo|tajawal|almarai|amiri|kufi|naskh|arabic|readex|rubik|noto sans ar|harmattan|lateef|el messiri|changa|mada|baloo bhaijaan|reem|lalezar|vazir/i;
/**
 * The design's fixed texts that aren't in the `to` language yet, to translate: [{ id: "<page>:<layer>", text }].
 * Live texts (their words come from the feed) and texts with no words (numbers, symbols) stay out.
 */
export function textsToTranslate(pages, to) {
  const out = [];
  pages.forEach((pg, i) => (pg.layers || []).forEach((l) => {
    if (l.type !== 'text' || l.feed) return;
    const t = String(l.text || '').trim(); if (!t || !/[A-Za-z؀-ۿ]/.test(t)) return;
    if (to === 'ar' ? AR_RE.test(t) : !AR_RE.test(t)) return; // already in that language
    out.push({ id: `${i}:${l.id}`.slice(0, 80), text: t.slice(0, 600) });
  }));
  return out;
}
const mirror = (a) => ({ left: 'right', right: 'left' }[a] || a);
/**
 * The page in another language: translated texts (tr: Map "<page>:<layer>" → text), right to left for Arabic with
 * the brand's Arabic font where the font has no Arabic letters, alignment mirrored; live data shows that language.
 * fonts: the brand's { heading, body, arabic }.
 */
export function swapLanguage(pg, i, to, tr, fonts = {}) {
  const rtl = to === 'ar';
  (pg.layers || []).forEach((l) => {
    if (l.type !== 'text') return;
    const t = tr.get(`${i}:${l.id}`.slice(0, 80));
    if (t != null) { l.text = t; delete l.runs; delete l.rt; } // styled ranges belonged to the old words
    if (rtl && !AR_FONTS.test(String(l.font || ''))) l.font = fonts.arabic || 'Cairo';
    if (!rtl && /arabic|kufi|naskh/i.test(String(l.font || ''))) l.font = (l.size || 16) >= 28 ? fonts.heading || 'Plus Jakarta Sans' : fonts.body || 'Inter';
    if ((l.dir === 'rtl') !== rtl) { l.dir = rtl ? 'rtl' : 'ltr'; l.align = mirror(l.align); if (l.fa0) l.fa0 = mirror(l.fa0); }
    if (l.fd0) l.fd0 = rtl ? 'rtl' : 'ltr';
  });
  // live data in the new language; the headline picked stays (translated stories keep their ids: the same story shows)
  if (pg.live && pg.live.kind) { pg.live.lang = to; pg.live.events = null; pg.live.at = 0; }
  return pg;
}

/* ---------- name ---------- */
const WORDS = { lang: { en: 'English', ar: 'Arabic' }, theme: { light: 'Light', dark: 'Dark' } };
const KNOWN = new Set([...Object.values(WORDS.lang), ...Object.values(WORDS.theme), ...SIZES.map((z) => z.name)]);
/** "News · Story" + { lang: "ar", size: "1:1" } → "News · Arabic · Square" (the old version words are replaced) */
export function versionName(name, o) {
  const parts = String(name || 'Untitled').split(' · '), base = [];
  parts.forEach((p, i) => { if (i === 0 || !KNOWN.has(p.trim())) base.push(p); });
  const add = [o.lang && WORDS.lang[o.lang], o.size && (SIZES.find((z) => z.key === o.size) || { name: String(o.size).replace('x', '×') }).name, o.theme && WORDS.theme[o.theme]].filter(Boolean);
  return [...base, ...add].join(' · ').slice(0, 120);
}
