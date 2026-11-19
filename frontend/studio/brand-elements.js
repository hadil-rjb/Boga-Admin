/* Brand backgrounds: the layers behind the content of the brand's templates, reusable on any design.
   A template's background is the run of its bottom layers (with everything grouped in them) before the first
   content: a text, a group holding text, the logo, or a subject picture (a plain image that does not cover the
   canvas: a gold render, a phone). Its glows, rings, light streaks and textures come with their blend modes,
   masks and opacity, so a new design looks like the brand instead of an approximation drawn with shapes.
   Pure: no DOM, no state. engine.js gives it the templates and applies the result. */

/** Most backgrounds offered (the agent's context stays small) */
export const MAX_BACKGROUNDS = 30;

const kids = (layers, id) => layers.filter((l) => l.pid === id);
function subtree(layers, l) {
  const out = [l];
  for (const k of kids(layers, l.id)) out.push(...subtree(layers, k));
  return out;
}
const isLogo = (l) => /logo/i.test(String(l.name || ''));
/** A small mark drawn with vector paths only (a logo, calligraphy, an icon): content, not background */
const isMark = (tree, w, h) => tree.length > 0 && tree.every((x) => x.type === 'path' || x.type === 'group' || x.type === 'frame') && tree.some((x) => x.type === 'path') && (tree[0].w || 0) * (tree[0].h || 0) < w * h * 0.15;
const cover = (l, w, h) => (l.w || 0) * (l.h || 0) >= w * h * 0.85 && l.x <= w * 0.05 && l.y <= h * 0.05 && l.x + l.w >= w * 0.95 && l.y + l.h >= h * 0.95;

/**
 * The background layers of one page (bottom first), or [] when it has none worth reusing.
 * size: [w, h] of the page's canvas.
 */
export function backgroundOf(layers, [w, h]) {
  const L = Array.isArray(layers) ? layers : [], ids = new Set(L.map((l) => l.id));
  const top = L.filter((l) => !l.pid || !ids.has(l.pid));
  const out = [];
  for (const l of top) {
    const tree = subtree(L, l);
    if (tree.some((x) => x.type === 'text') || isLogo(l) || l.hidden || isMark(tree, w, h)) break;
    // a subject picture: a plain image (no blend, fully opaque) that does not fill the canvas
    if (l.type === 'image' && !l.blend && (l.op == null || l.op >= 0.95) && !cover(l, w, h)) break;
    out.push(...tree);
  }
  // a lone flat rectangle is only a colour: the page background says that already
  const rich = out.filter((l) => !(l.type === 'rect' && !l.blend && !/gradient|url\(/.test(String(l.fill || ''))));
  return rich.length ? out : [];
}

/** A plain photo filling the canvas: its colours are the picture's, not the page colour's */
const photoBehind = (layers, [w, h]) => layers.some((l) => l.type === 'image' && !l.blend && (l.op == null || l.op >= 0.95) && cover(l, w, h));

/** A short signature: the same background reused by several templates is offered once */
const sigOf = (bg, layers) => [bg, ...layers.map((l) => [l.type, Math.round(l.x), Math.round(l.y), Math.round(l.w), Math.round(l.h), l.blend || '', l.op ?? 1, String(l.fill || l.src || '').slice(0, 60)].join(','))].join('|');

/** Light or dark, from a #rrggbb colour (gradients and images count as dark) */
export function themeOf(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return 'dark';
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, mx = Math.max(r, g, b), sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
  if (lum > 0.6) return 'light';
  if (b > r * 1.4 && b > g * 1.2) return 'blue';
  return sat > 0.5 && mx > 120 ? 'accent' : 'dark'; // a strong colour (the brand's orange) is neither light nor dark
}

/**
 * The brand's reusable backgrounds: one per template first (in the templates' order), then their versions, without repeats.
 * dims(ratio) → [w, h]. Each: { id: 'bg-<template>[__<version>]', name, from, category, ratio, bg, theme, layers }.
 */
export function extractBackgrounds(templates, dims, max = MAX_BACKGROUNDS) {
  const out = [], seen = new Set();
  const add = (t, v) => {
    const src = v || t, ratio = (v && v.ratio) || t.ratio, size = dims(ratio);
    if (!size) return;
    const layers = backgroundOf(src.layers, size);
    if (!layers.length) return;
    const sig = sigOf(src.bg, layers);
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({
      id: 'bg-' + t.id + (v ? '__' + v.id : ''), name: v ? `${t.name} · ${v.name}` : t.name, from: t.id,
      ...(t.category ? { category: t.category } : {}), ratio, bg: src.bg || '#000000', theme: photoBehind(layers, size) ? 'photo' : themeOf(src.bg), layers,
    });
  };
  // every template first (the most kinds of background), then their versions (other colours and sizes)
  const list = (templates || []).filter((t) => t && t.id);
  for (const t of list) { if (out.length >= max) break; add(t, null); }
  for (const t of list) for (const v of t.versions || []) { if (out.length >= max) break; if (v && v.id) add(t, v); }
  return out.slice(0, max);
}

/**
 * Background layers moved from a [w, h] canvas to another: one uniform scale that covers the new canvas
 * (circles stay round, textures keep their grain), centred. Returns new objects; ids are kept.
 */
export function coverLayers(layers, [ow, oh], [nw, nh]) {
  const s = Math.max(nw / ow, nh / oh), dx = (nw - ow * s) / 2, dy = (nh - oh * s) / 2;
  const r2 = (n) => Math.round(n * 10) / 10;
  return (layers || []).map((l) => ({
    ...l, x: r2(l.x * s + dx), y: r2(l.y * s + dy), w: r2(l.w * s), h: r2(l.h * s),
    ...(typeof l.r === 'number' ? { r: r2(l.r * s) } : {}), ...(typeof l.sw === 'number' ? { sw: r2(l.sw * s) } : {}),
  }));
}

/* ---------- Theme versions learned from the brand's own templates ---------- */
const COLOR_RE = /#[0-9a-f]{8}\b|#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi;
/** One spelling per colour: "#FFF" → "#ffffff", "rgba(0, 0, 0, .5)" → "rgba(0,0,0,.5)" */
export function normColor(c) {
  const s = String(c || '').trim().toLowerCase().replace(/\s+/g, '');
  const m = /^#([0-9a-f]{3})$/.exec(s);
  return m ? '#' + m[1].split('').map((x) => x + x).join('') : s;
}
/** A version's theme as the version maker says it: light, or dark (the brand's blue counts as dark) */
export const kindOf = (theme) => (theme === 'light' ? 'light' : 'dark');
const colorsIn = (v) => (typeof v === 'string' && !/url\(/.test(v) ? (v.match(COLOR_RE) || []).map(normColor) : []);
/** The colours of a layer, in a fixed order: [prop, colours[]] */
const colorSlots = (l) => [
  ['color', colorsIn(l.color)], ['fill', colorsIn(l.fill)], ['stroke', colorsIn(l.stroke)],
  ...(l.runs || []).map((r, i) => ['run' + i, colorsIn(r.color)]),
];

/**
 * What each colour becomes when a layout changes theme, learned from the templates that have versions in both
 * themes (the same layout, its layers matched by type and name): { 'dark>light': Map, 'light>dark': Map } of
 * colour → the colour the brand used most often in its place.
 */
export function learnThemeMap(templates) {
  const votes = { 'dark>light': new Map(), 'light>dark': new Map() };
  const vote = (dir, a, b) => { if (a === b) return; const m = votes[dir]; if (!m.has(a)) m.set(a, new Map()); const n = m.get(a); n.set(b, (n.get(b) || 0) + 1); };
  const keyed = (layers) => { const seen = new Map(), out = new Map(); (layers || []).forEach((l) => { if (l.mask) return; const k = l.type + '|' + String(l.name || '').trim().toLowerCase(); const i = seen.get(k) || 0; seen.set(k, i + 1); out.set(k + '#' + i, l); }); return out; };
  for (const t of templates || []) {
    const members = [t, ...(t.versions || [])].filter((x) => x && Array.isArray(x.layers) && themeOf(x.bg) !== 'accent').map((x) => ({ kind: kindOf(themeOf(x.bg)), bg: normColor(x.bg), layers: keyed(x.layers) }));
    for (const a of members) for (const b of members) {
      if (a === b || a.kind === b.kind) continue;
      const dir = a.kind + '>' + b.kind;
      if (/^#/.test(a.bg) && /^#/.test(b.bg)) vote(dir, a.bg, b.bg);
      for (const [k, la] of a.layers) {
        const lb = b.layers.get(k); if (!lb) continue;
        const sa = colorSlots(la), sb = new Map(colorSlots(lb));
        for (const [prop, ca] of sa) { const cb = sb.get(prop) || []; if (ca.length && ca.length === cb.length) ca.forEach((c, i) => vote(dir, c, cb[i])); }
      }
    }
  }
  const out = {};
  for (const dir of Object.keys(votes)) {
    out[dir] = new Map([...votes[dir]].map(([from, tos]) => [from, [...tos].sort((x, y) => y[1] - x[1])[0][0]]));
  }
  return out;
}

/**
 * The brand background a theme version should use: of that theme, from the same template family first (the
 * version of the size asked for), then the same category, then any. kind: 'light' | 'dark'.
 */
export function pickThemeBackground(bgs, kind, { from = '', category = '', ratio = '' } = {}) {
  const ok = (bgs || []).filter((b) => ['light', 'dark', 'blue'].includes(b.theme) && kindOf(b.theme) === kind); // never a photo or an accent colour
  const rank = (b) => [b.from === from && from ? 0 : 1, category && b.category === category ? 0 : 1, b.ratio === ratio ? 0 : 1, kind === 'dark' && b.theme !== 'dark' ? 1 : 0];
  return ok.slice().sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; })[0] || null;
}

/** Replaces the colours of a string with the learned ones; colours it never saw go through `fallback` */
export const mapColors = (v, map, fallback = (c) => c) => (typeof v === 'string' ? v.replace(COLOR_RE, (m) => (map && map.has(normColor(m)) ? map.get(normColor(m)) : fallback(m))) : v);
