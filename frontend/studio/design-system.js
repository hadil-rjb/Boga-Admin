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
