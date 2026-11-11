/* ============================================================
   Brand design system: the shape of a system, and choosing the references it is learned from.
   - Templates first, newest first, then designs that were approved or published, newest first. Drafts are never used.
   - At most MAX_SOURCES references per analysis, and the first page of each only.
   - sourceSig tells when the references changed, so a saved system can be marked out of date.
   - tidySystem applies every limit to what the model returns or the user edits; a value that fails is dropped, never guessed.
   Pure: no DOM, no imports from engine.js.
   ============================================================ */

export const MAX_SOURCES = 12;
export const MAX_INSPIRATION = 8;
export const MAX_INSPIRATION_PATTERNS = 3;

const byNewest = (a, b) => (b.at || 0) - (a.at || 0);

/** A short hash of a text (32-bit FNV-1a, base 36); undefined hashes the empty string. */
export function hashText(s) {
  s = typeof s === 'string' ? s : '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** A short hash of a page's background and layers: changes when its content changes. */
export function sourceRev(page) {
  return hashText(JSON.stringify([page && page.bg, page && page.layers]) || '');
}

/** The references to learn from: { kind, id, name, ratio, at, live, rev }. `at` orders them; `rev` follows their content. */
export function pickSources(brand, designs, posts) {
  const templates = ((brand && brand.templates) || []).slice().sort(byNewest).map((t) => ({
    kind: 'template', id: t.id, name: t.name, ratio: t.ratio, at: t.at || 0, live: !!t.live, rev: sourceRev(t),
  }));
  const published = new Set((posts || []).filter((p) => p.status === 'Published').map((p) => p.d));
  const picked = (designs || [])
    .filter((d) => d.status === 'Approved' || published.has(d.id))
    .sort(byNewest)
    .map((d) => ({
      kind: 'design', id: d.id, name: d.name, ratio: d.ratio, at: d.at || 0, live: !!(d.pages && d.pages[0] && d.pages[0].live),
      rev: sourceRev(d.pages && d.pages[0] ? d.pages[0] : d),
    }));
  return templates.concat(picked).slice(0, MAX_SOURCES);
}

/** A string that changes when a reference's content is edited, or a reference is added or removed; not when it is only saved again. */
export function sourceSig(sources) {
  return (sources || []).map((s) => s.id + ':' + (s.rev || '')).join('|');
}

// ---- Inspiration pictures and the brand guide ----

/** The brand guide's written design rules, tidied; null when it says nothing about design. */
export function tidyGuideDesign(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rules = (Array.isArray(raw.rules) ? raw.rules : []).map((r) => {
    r = r && typeof r === 'object' ? r : {};
    const text = typeof r.text === 'string' ? r.text.trim().slice(0, 160) : '';
    return text ? { text, kind: r.kind === 'dont' ? 'dont' : 'do' } : null;
  }).filter(Boolean).slice(0, 12);
  const t = (v) => (typeof v === 'string' ? v.trim().slice(0, 400) : '');
  const out = {
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '',
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
    layout: t(raw.layout), imagery: t(raw.imagery), logoUse: t(raw.logoUse), typography: t(raw.typography),
    rules,
  };
  return out.layout || out.imagery || out.logoUse || out.typography || rules.length ? out : null;
}

/** The guide as the server reads it: tidied, without the date; undefined when there is no usable guide. */
export function guideForRequest(guideDesign) {
  const g = tidyGuideDesign(guideDesign);
  if (!g) return undefined;
  const { at, ...rest } = g;
  return rest;
}

/** Every source a design system is learned from: { own, inspiration, guide }. */
export function gatherSources(brand, designs, posts) {
  const inspiration = ((brand && Array.isArray(brand.inspiration)) ? brand.inspiration : [])
    .filter((p) => p && typeof p.src === 'string').slice(0, MAX_INSPIRATION).map((p) => {
      const sized = typeof p.w === 'number' && typeof p.h === 'number';
      return {
        kind: 'inspiration', id: p.id, name: p.name, ratio: sized ? p.w + 'x' + p.h : '',
        w: typeof p.w === 'number' ? p.w : 0, h: typeof p.h === 'number' ? p.h : 0, at: p.at || 0, rev: hashText(p.src),
      };
    });
  const g = guideForRequest(brand && brand.guideDesign);
  return {
    own: pickSources(brand, designs, posts),
    inspiration,
    guide: g ? { name: g.name, rev: hashText(JSON.stringify(g)) } : null,
  };
}

export function hasSources(g) {
  return !!(g && ((g.own && g.own.length) || (g.inspiration && g.inspiration.length) || g.guide));
}

/** The signature of everything gathered; with no pictures and no guide it is exactly the signature of the own references. */
export function gatheredSig(g) {
  return [
    sourceSig(g.own),
    g.inspiration && g.inspiration.length ? 'i=' + sourceSig(g.inspiration) : '',
    g.guide ? 'g=' + g.guide.rev : '',
  ].filter(Boolean).join('#');
}

export const LIMITS = { type: 5, roles: 8, pairs: 6, gradients: 3, patterns: 8, slots: 10, rules: 16 };
export const TYPE_ROLES = ['headline', 'subhead', 'body', 'label', 'caption'];
export const COLOR_ROLES = ['background', 'surface', 'text', 'accent', 'muted'];
export const SLOT_ROLES = ['headline', 'subhead', 'body', 'label', 'logo', 'image', 'cta', 'shape'];

const AGENT_MAX_CHARS = 6000;
const BOOKKEEPING = ['v', 'at', 'model', 'sig', 'sources', 'guide'];

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

function tidyPattern(p, i, sourceIds, inspirationIds) {
  p = obj(p);
  const slots = arr(p.slots).map(tidySlot).filter(Boolean).slice(0, LIMITS.slots);
  if (!slots.length) return null;
  const sourceId = str(p.sourceId, 80);
  const origin = p.origin === 'inspiration' ? 'inspiration' : 'brand';
  if (origin === 'inspiration' && inspirationIds && !inspirationIds.includes(sourceId)) return null;
  return {
    id: str(p.id, 40) || 'p' + (i + 1),
    name: str(p.name, 60),
    when: str(p.when, 200),
    ratio: str(p.ratio, 12),
    sourceId: origin === 'inspiration' || !sourceIds || sourceIds.includes(sourceId) ? sourceId : '',
    origin,
    slots,
  };
}

function tidyRule(r) {
  r = obj(r);
  const text = str(r.text, 160);
  if (!text) return null;
  return { text, kind: r.kind === 'do' ? 'do' : 'dont', by: oneOf(r.by, ['ai', 'user', 'guide'], 'ai') };
}

/** The patterns with only the first MAX_INSPIRATION_PATTERNS drawn from inspiration pictures kept. */
function cappedInspiration(patterns) {
  let n = 0;
  return patterns.filter((p) => p.origin !== 'inspiration' || ++n <= MAX_INSPIRATION_PATTERNS);
}

/** The content fields of a design system with every limit applied; null when raw is not an object. */
export function tidySystem(raw, sourceIds, inspirationIds) {
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
      patterns: cappedInspiration(arr(layout.patterns).map((p, i) => tidyPattern(p, i, sourceIds, inspirationIds)).filter(Boolean)).slice(0, LIMITS.patterns),
    },
    shapes: {
      radius: num(shapes.radius, 0, 300), stroke: num(shapes.stroke, 0, 40),
      shadow: oneOf(shapes.shadow, ['none', 'soft', 'hard'], 'none'), motifs: str(shapes.motifs, 200),
    },
    imagery: str(raw.imagery, 200),
    rules: arr(raw.rules).map(tidyRule).filter(Boolean).slice(0, LIMITS.rules),
  };
  for (const k of BOOKKEEPING) if (k !== 'guide' && raw[k] !== undefined) out[k] = raw[k];
  if (raw.guide && typeof raw.guide === 'object' && !Array.isArray(raw.guide)) out.guide = { name: str(raw.guide.name, 120) };
  return out;
}

/** A copy of the rules where those matching a guide rule are marked by: 'guide'; with no guide, no rule stays marked that way. */
export function markGuideRules(rules, guideDesign) {
  const g = tidyGuideDesign(guideDesign);
  const key = (t) => String(t || '').trim().toLowerCase();
  const fromGuide = new Set(g ? g.rules.map((r) => key(r.text)) : []);
  return arr(rules).map((r) => {
    if (!g) return r && r.by === 'guide' ? { ...r, by: 'ai' } : { ...r };
    if (r && r.by !== 'user' && fromGuide.has(key(r.text))) return { ...r, by: 'guide' };
    return { ...r };
  });
}

/** The old rules the user wrote, then the new guide rules, then the other new rules, one per lower-cased text, at most LIMITS.rules. */
export function mergeRules(oldRules, newRules) {
  const seen = new Set();
  const fresh = arr(newRules);
  const ordered = arr(oldRules).filter((r) => r && r.by === 'user')
    .concat(fresh.filter((r) => r && r.by === 'guide'), fresh.filter((r) => !r || r.by !== 'guide'));
  return ordered.filter((r) => {
    const key = String((r && r.text) || '').trim().toLowerCase();
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

/** What a brand adds to the agent's context: its system and the references the system was learned from, or nothing at all. */
export function agentExtras(system) {
  const designSystem = forAgent(system);
  if (!designSystem) return {};
  const references = arr(system.sources).map((s) => obj(s)).map(({ id, kind, name, ratio }) => ({ id, kind, name, ratio }));
  return { designSystem, references };
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
    ...arr(sys && sys.colors && sys.colors.pairs).flatMap((p) => (p ? [p.bg, p.text, p.accent] : [])),
  ].map(rgbOf).filter(Boolean).map(labOf);
  // A layer is the logo when it is named "logo", named after one of the brand's logos (the agent names it after the kit logo,
  // and a saved design keeps its pictures as media URLs, so the fill no longer holds the kit's data URL), or shows a brand logo image.
  const logoSrcs = arr(brand && brand.logos).map((l) => l && l.src).filter((s) => typeof s === 'string' && s);
  const logoNames = new Set(arr(brand && brand.logos).map((l) => String((l && l.name) || '').trim().toLowerCase()).filter(Boolean));
  const isLogo = (l) => /logo/i.test(l.name || '') || logoNames.has(String(l.name || '').trim().toLowerCase())
    || (typeof l.fill === 'string' && logoSrcs.some((s) => l.fill.includes(s)));

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
    if (!rgb || !palette.length) return false;
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
    if (allowedFonts.size && typeof l.font === 'string' && l.font && !allowedFonts.has(l.font.toLowerCase())) {
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

  if (corner && corner !== 'none' && !live.some(isLogo)) {
    issues.push({ layerId: '', rule: 'logo', detail: `The slide has no logo; the brand places it in the ${corner} corner.` });
  }
  return issues;
}

export function lintText(issues, nameOf) {
  if (!arr(issues).length) return 'No issues.';
  return issues.map((i) => `- ${(i.layerId && nameOf(i.layerId)) || 'Slide'}: ${i.detail}`).join('\n');
}

// ---- Pattern wireframes (Brand kit) ----

const round2 = (n) => Math.round(n * 100) / 100;

/** Height of a 100-wide canvas for a ratio such as '4:5' or '1920x1080'; 125 (4:5) when it cannot be read. */
function wireHeight(ratio) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(ratio || ''));
  const w = m ? Number(m[1]) : 0;
  const h = m ? Number(m[2]) : 0;
  return w > 0 && h > 0 ? round2((100 * h) / w) : 125;
}

/** A pattern drawn as an inline SVG wireframe: the canvas as a path, then one rect per slot, on a 100-wide canvas. */
export function patternWire(pattern, { esc }) {
  const H = wireHeight(pattern && pattern.ratio);
  const rects = arr(pattern && pattern.slots).map((s) => {
    s = obj(s);
    const role = oneOf(s.role, SLOT_ROLES, 'shape');
    const x = round2(num(s.x, 0, 1) * 100);
    const y = round2(num(s.y, 0, 1) * H);
    const w = round2(num(s.w, 0, 1) * 100);
    const h = round2(num(s.h, 0, 1) * H);
    return `<rect class="ds-slot ds-${role}" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"><title>${esc(role)}</title></rect>`;
  }).join('');
  return `<svg class="ds-wire" viewBox="0 0 100 ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">`
    + `<path class="ds-canvas" d="M0 0H100V${H}H0Z"></path>${rects}</svg>`;
}
