/* ============================================================
   Brand design system: the shape of a system, and choosing the references it is learned from.
   - Templates first, newest first, then designs that were approved or published, newest first. Drafts are never used.
   - At most MAX_SOURCES references per analysis, and the first page of each only.
   - sourceSig tells when the references changed, so a saved system can be marked out of date.
   - tidySystem applies every limit to what the model returns or the user edits; a value that fails is dropped, never guessed.
   Pure: no DOM, no imports from engine.js.
   ============================================================ */

export const MAX_SOURCES = 12;

const byNewest = (a, b) => (b.at || 0) - (a.at || 0);

/** The references to learn from: { kind, id, name, ratio, at, live }. */
export function pickSources(brand, designs, posts) {
  const templates = ((brand && brand.templates) || []).slice().sort(byNewest).map((t) => ({
    kind: 'template', id: t.id, name: t.name, ratio: t.ratio, at: t.at || 0, live: !!t.live,
  }));
  const published = new Set((posts || []).filter((p) => p.status === 'Published').map((p) => p.d));
  const picked = (designs || [])
    .filter((d) => d.status === 'Approved' || published.has(d.id))
    .sort(byNewest)
    .map((d) => ({
      kind: 'design', id: d.id, name: d.name, ratio: d.ratio, at: d.at || 0, live: !!(d.pages && d.pages[0] && d.pages[0].live),
    }));
  return templates.concat(picked).slice(0, MAX_SOURCES);
}

/** A string that changes when a reference is edited, added or removed. */
export function sourceSig(sources) {
  return (sources || []).map((s) => s.id + ':' + (s.at || 0)).join('|');
}

export const LIMITS = { type: 5, roles: 8, pairs: 6, gradients: 3, patterns: 8, slots: 10, rules: 16 };
export const TYPE_ROLES = ['headline', 'subhead', 'body', 'label', 'caption'];
export const COLOR_ROLES = ['background', 'surface', 'text', 'accent', 'muted'];
export const SLOT_ROLES = ['headline', 'subhead', 'body', 'label', 'logo', 'image', 'cta', 'shape'];

const AGENT_MAX_CHARS = 6000;
const BOOKKEEPING = ['v', 'at', 'model', 'sig', 'sources'];

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/** A finite number clamped to lo..hi; anything else falls back to the lower bound or the given default. */
const num = (v, lo, hi, fallback) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback === undefined ? lo : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const hex = (v) => {
  if (typeof v !== 'string') return '';
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? '#' + m[1].toUpperCase() : '';
};

function tidyType(t) {
  t = obj(t);
  const role = oneOf(t.role, TYPE_ROLES, '');
  const font = str(t.font, 60);
  if (!role || !font) return null;
  let sizeMin = num(t.sizeMin, 8, 400);
  let sizeMax = num(t.sizeMax, 8, 400);
  if (sizeMin > sizeMax) [sizeMin, sizeMax] = [sizeMax, sizeMin];
  return {
    role, font, weight: num(t.weight, 100, 900), sizeMin, sizeMax, lh: num(t.lh, 0.8, 3),
    ls: num(t.ls, -20, 40, 0), upper: t.upper === true, align: oneOf(t.align, ['left', 'center', 'right'], 'left'),
  };
}

function tidyPair(p) {
  p = obj(p);
  const bg = hex(p.bg);
  const text = hex(p.text);
  if (!bg || !text) return null;
  const accent = hex(p.accent);
  return accent ? { bg, text, accent } : { bg, text };
}

const round4 = (n) => Math.round(n * 10000) / 10000;

function tidySlot(s) {
  s = obj(s);
  const role = oneOf(s.role, SLOT_ROLES, '');
  if (!role) return null;
  const x = num(s.x, 0, 1);
  const y = num(s.y, 0, 1);
  const w = Math.min(num(s.w, 0, 1), 1 - x);
  const h = Math.min(num(s.h, 0, 1), 1 - y);
  if (w < 0.01 || h < 0.01) return null;
  return { role, x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

function tidyPattern(p, i, sourceIds) {
  p = obj(p);
  const slots = arr(p.slots).map(tidySlot).filter(Boolean).slice(0, LIMITS.slots);
  if (!slots.length) return null;
  const sourceId = str(p.sourceId, 80);
  return {
    id: str(p.id, 40) || 'p' + (i + 1),
    name: str(p.name, 60),
    when: str(p.when, 200),
    ratio: str(p.ratio, 12),
    sourceId: !sourceIds || sourceIds.includes(sourceId) ? sourceId : '',
    slots,
  };
}

function tidyRule(r) {
  r = obj(r);
  const text = str(r.text, 160);
  if (!text) return null;
  return { text, kind: r.kind === 'do' ? 'do' : 'dont', by: r.by === 'user' ? 'user' : 'ai' };
}

/** The content fields of a design system with every limit applied; null when raw is not an object. */
export function tidySystem(raw, sourceIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const colors = obj(raw.colors);
  const layout = obj(raw.layout);
  const logo = obj(layout.logo);
  const shapes = obj(raw.shapes);
  const out = {
    summary: str(raw.summary, 600),
    type: arr(raw.type).map(tidyType).filter(Boolean).slice(0, LIMITS.type),
    colors: {
      roles: arr(colors.roles).map((c) => {
        c = obj(c);
        const h = hex(c.hex);
        const role = oneOf(c.role, COLOR_ROLES, '');
        return h && role ? { hex: h, role, usage: str(c.usage, 200) } : null;
      }).filter(Boolean).slice(0, LIMITS.roles),
      pairs: arr(colors.pairs).map(tidyPair).filter(Boolean).slice(0, LIMITS.pairs),
      gradients: arr(colors.gradients).map((g) => str(g, 200))
        .filter((g) => g.startsWith('linear-gradient(') || g.startsWith('radial-gradient(')).slice(0, LIMITS.gradients),
    },
    layout: {
      margin: num(layout.margin, 0, 300), gap: num(layout.gap, 0, 200),
      align: oneOf(layout.align, ['left', 'center', 'mixed'], 'left'),
      logo: { corner: oneOf(logo.corner, ['tl', 'tr', 'bl', 'br', 'none'], 'none'), width: num(logo.width, 0, 600) },
      patterns: arr(layout.patterns).map((p, i) => tidyPattern(p, i, sourceIds)).filter(Boolean).slice(0, LIMITS.patterns),
    },
    shapes: {
      radius: num(shapes.radius, 0, 300), stroke: num(shapes.stroke, 0, 40),
      shadow: oneOf(shapes.shadow, ['none', 'soft', 'hard'], 'none'), motifs: str(shapes.motifs, 200),
    },
    imagery: str(raw.imagery, 200),
    rules: arr(raw.rules).map(tidyRule).filter(Boolean).slice(0, LIMITS.rules),
  };
  for (const k of BOOKKEEPING) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

/** The old rules the user wrote, then the new rules, one per lower-cased text, at most LIMITS.rules. */
export function mergeRules(oldRules, newRules) {
  const seen = new Set();
  return arr(oldRules).filter((r) => r && r.by === 'user').concat(arr(newRules)).filter((r) => {
    const key = String((r && r.text) || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, LIMITS.rules);
}

/** The system as the agent reads it: no bookkeeping, and under about 6,000 characters. */
export function forAgent(system) {
  if (!system) return null;
  const out = { ...system };
  for (const k of BOOKKEEPING) delete out[k];
  if (out.layout && Array.isArray(out.layout.patterns)) {
    out.layout = { ...out.layout, patterns: out.layout.patterns.slice() };
    while (JSON.stringify(out).length >= AGENT_MAX_CHARS && out.layout.patterns.length) out.layout.patterns.pop();
  }
  return out;
}

// ---- The design check ----
// Sizes and distances in a system are for a 1080 px wide canvas; the check scales them by canvas.w / 1080.

const DELTA_E_MAX = 12;
const CONTRAST_NORMAL = 4.5;
const CONTRAST_LARGE = 3;
const LARGE_TEXT_PX = 28;

function plainHex(v) {
  if (typeof v !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return '#' + h.toUpperCase();
}

function rgbOf(hexStr) {
  const h = plainHex(hexStr);
  if (!h) return null;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

const linear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

function labOf(rgb) {
  const [r, g, b] = rgb.map(linear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const luminance = (rgb) => {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const inBox = (l, x, y) => x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h;

export function lintSlide(page, canvas, brand, system) {
  const issues = [];
  const k = (canvas && canvas.w > 0 ? canvas.w : 1080) / 1080;
  const W = canvas && canvas.w > 0 ? canvas.w : 1080;
  const H = canvas && canvas.h > 0 ? canvas.h : 1080;
  const layers = arr(page && page.layers);
  const sys = system && typeof system === 'object' ? system : null;
  const fonts = obj(brand && brand.fonts);

  const allowedFonts = new Set(
    [fonts.heading, fonts.body, fonts.arabic, ...arr(sys && sys.type).map((t) => t.font)]
      .filter((f) => typeof f === 'string' && f).map((f) => f.toLowerCase()),
  );
  const palette = [
    ...arr(brand && brand.colors).map((c) => c && c.hex),
    ...arr(sys && sys.colors && sys.colors.roles).map((r) => r && r.hex),
  ].map(rgbOf).filter(Boolean).map(labOf);

  const types = arr(sys && sys.type);
  const sizeLo = types.length ? Math.min(...types.map((t) => t.sizeMin)) : 0;
  const sizeHi = types.length ? Math.max(...types.map((t) => t.sizeMax)) : 0;
  const margin = sys && sys.layout && sys.layout.margin > 0 ? sys.layout.margin : 0;
  const m = margin * k - 1;
  const corner = sys && sys.layout && sys.layout.logo && sys.layout.logo.corner;

  const live = layers.filter((l) => l && !l.hidden);
  const pageBg = rgbOf(page && page.bg);

  const offPalette = (value) => {
    const rgb = rgbOf(value);
    if (!rgb) return false;
    const hexVal = plainHex(value);
    if (hexVal === '#000000' || hexVal === '#FFFFFF') return false;
    const lab = labOf(rgb);
    return !palette.some((p) => deltaE(lab, p) <= DELTA_E_MAX);
  };

  layers.forEach((l, i) => {
    if (!l || l.hidden || l.locked || l.feed) return;
    const id = l.id;
    if (l.type !== 'text') {
      if (offPalette(l.fill)) issues.push({ layerId: id, rule: 'colour', detail: `Fill ${plainHex(l.fill)} is not in the brand palette.` });
      return;
    }
    if (typeof l.font === 'string' && l.font && !allowedFonts.has(l.font.toLowerCase())) {
      issues.push({ layerId: id, rule: 'font', detail: `Font ${l.font} is not one of the brand's fonts.` });
    }
    if (types.length && typeof l.size === 'number') {
      const lo = sizeLo * k, hi = sizeHi * k;
      if (l.size < lo) issues.push({ layerId: id, rule: 'size', detail: `Text is ${Math.round(l.size)} px; the brand's smallest is ${Math.round(lo)} px.` });
      else if (l.size > hi) issues.push({ layerId: id, rule: 'size', detail: `Text is ${Math.round(l.size)} px; the brand's largest is ${Math.round(hi)} px.` });
    }
    if (offPalette(l.color)) issues.push({ layerId: id, rule: 'colour', detail: `Text colour ${plainHex(l.color)} is not in the brand palette.` });
    if (margin > 0 && (l.x < m || l.y < m || l.x + l.w > W - m || l.y + l.h > H - m)) {
      issues.push({ layerId: id, rule: 'margin', detail: `Text is closer than the brand's ${Math.round(margin * k)} px margin to the edge.` });
    }
    const fg = rgbOf(l.color);
    if (fg) {
      const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
      let back = null;
      let known = true;
      for (let j = i - 1; j >= 0; j--) {
        const b = layers[j];
        if (!b || b.hidden || typeof b.fill !== 'string' || !b.fill.trim() || !inBox(b, cx, cy)) continue;
        back = rgbOf(b.fill);
        known = !!back;
        break;
      }
      if (back === null && known) back = pageBg;
      if (back) {
        const ratio = contrast(fg, back);
        const need = l.size / k >= LARGE_TEXT_PX ? CONTRAST_LARGE : CONTRAST_NORMAL;
        if (ratio < need) {
          issues.push({ layerId: id, rule: 'contrast', detail: `Text contrast is ${ratio.toFixed(1)} to 1; it needs at least ${need} to 1.` });
        }
      }
    }
  });

  if (corner && corner !== 'none' && !live.some((l) => /logo/i.test(l.name || ''))) {
    issues.push({ layerId: '', rule: 'logo', detail: `The slide has no logo; the brand places it in the ${corner} corner.` });
  }
  return issues;
}

export function lintText(issues, nameOf) {
  if (!arr(issues).length) return 'No issues.';
  return issues.map((i) => `- ${(i.layerId && nameOf(i.layerId)) || 'Slide'}: ${i.detail}`).join('\n');
}
