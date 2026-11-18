/* ============================================================
   Creative Canvas — model helpers (no DOM)
   Geometry of the board's elements and their conversion into Studio design layers.
   Element kinds: text, sticky, image, shape (rect | ellipse | diamond | triangle), path (pen), connector.
   Positions are world units; a path's points are relative to its box; a connector joins two
   elements (a.id / b.id) or free points (a.x / a.y).
   ============================================================ */
import { uid, Tx, Rc, El, Im, BG } from './templates';

export const STICKY = ['#fef08a', '#fed7aa', '#fecaca', '#fbcfe8', '#ddd6fe', '#bfdbfe', '#a7f3d0', '#e5e7eb'];
export const INK = ['#1e1e1e', '#64748b', '#fd0e35', '#f97316', '#eab308', '#22a24c', '#2563eb', '#7c3aed', '#ffffff'];
export const FILLS = ['transparent', '#ffffff', '#f1f5f9', '#fee2e2', '#ffedd5', '#fef9c3', '#dcfce7', '#dbeafe', '#ede9fe', '#1e1e1e'];
export const DEFAULT_INK = '#1e1e1e';

export const hasText = (e) => e.k === 'text' || e.k === 'sticky' || (e.k === 'shape' && !!(e.text || '').trim());
export const clone = (v) => JSON.parse(JSON.stringify(v));

/** Box of an element in world units (a connector: the box of its two ends) */
export function boxOf(e, byId) {
  if (e.k === 'connector') {
    const [[ax, ay], [bx, by]] = connectorPts(e, byId);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }
  return { x: e.x, y: e.y, w: e.w, h: e.h };
}

export function unionBox(boxes) {
  if (!boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  boxes.forEach((b) => { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const intersects = (a, b) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/** Where the line from the center of box b towards (tx, ty) leaves the box (plus a small gap) */
export function edgePoint(b, tx, ty, gap = 6) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const s = Math.min(dx ? (b.w / 2 + gap) / Math.abs(dx) : Infinity, dy ? (b.h / 2 + gap) / Math.abs(dy) : Infinity);
  return s >= 1 ? [tx, ty] : [cx + dx * s, cy + dy * s];
}

/** The two drawn ends of a connector: attached ends start on the edge of their element */
export function connectorPts(c, byId) {
  const A = c.a && c.a.id && byId.get(c.a.id), B = c.b && c.b.id && byId.get(c.b.id);
  const ca = A ? [A.x + A.w / 2, A.y + A.h / 2] : [c.a.x, c.a.y];
  const cb = B ? [B.x + B.w / 2, B.y + B.h / 2] : [c.b.x, c.b.y];
  return [A ? edgePoint(A, cb[0], cb[1]) : ca, B ? edgePoint(B, ca[0], ca[1]) : cb];
}

/** Smooth SVG path through pen points [x0, y0, x1, y1, …] (quadratic curves through the midpoints) */
export function smoothD(pts, k = 1, ox = 0, oy = 0) {
  const P = (i) => [ox + pts[i] * k, oy + pts[i + 1] * k], r = (n) => Math.round(n * 10) / 10;
  if (pts.length < 4) { const [x, y] = P(0); return `M${r(x)} ${r(y)}l0.1 0`; }
  let [x, y] = P(0), d = `M${r(x)} ${r(y)}`;
  for (let i = 2; i < pts.length - 2; i += 2) {
    const [x1, y1] = P(i), [x2, y2] = P(i + 2);
    d += `Q${r(x1)} ${r(y1)} ${r((x1 + x2) / 2)} ${r((y1 + y2) / 2)}`;
  }
  [x, y] = P(pts.length - 2);
  return d + `L${r(x)} ${r(y)}`;
}

/** A pen stroke in world points → a path element whose box holds the whole stroke */
export function pathFrom(world, stroke, sw) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < world.length; i += 2) { x0 = Math.min(x0, world[i]); x1 = Math.max(x1, world[i]); y0 = Math.min(y0, world[i + 1]); y1 = Math.max(y1, world[i + 1]); }
  const m = sw / 2, x = x0 - m, y = y0 - m;
  const pts = world.map((v, i) => Math.round((v - (i % 2 ? y : x)) * 10) / 10);
  return { id: uid(), k: 'path', x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(x1 - x0 + sw)), h: Math.max(1, Math.round(y1 - y0 + sw)), pts, stroke, sw };
}

/** Shape outline as an SVG path in a w×h box */
export function shapeD(shape, w, h) {
  if (shape === 'diamond') return `M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`;
  if (shape === 'triangle') return `M${w / 2} 0L${w} ${h}L0 ${h}Z`;
  return null;
}

/** Elements with text, in reading order (rows top to bottom, then left to right) */
export function readingOrder(els) {
  const rows = [...els].sort((a, b) => a.y - b.y), out = [];
  let row = [], top = -Infinity, bottom = -Infinity;
  rows.forEach((e) => {
    if (row.length && e.y > bottom - Math.min(e.h, bottom - top) / 2) { out.push(...row.sort((a, b) => a.x - b.x)); row = []; bottom = -Infinity; }
    if (!row.length) top = e.y;
    row.push(e); bottom = Math.max(bottom, e.y + e.h);
  });
  return out.concat(row.sort((a, b) => a.x - b.x));
}

/** The text of the elements, in reading order, as a caption draft */
export const captionOf = (els) => readingOrder(els.filter(hasText)).map((e) => String(e.text || '').trim()).filter(Boolean).join('\n\n');

/**
 * Board elements → layers of a W×H design page, arranged as on the board (scaled to fit, centered).
 * look: { bg, ink, heading, body } — the page background, the default text color and the brand fonts.
 */
export function toLayers(els, W, H, look = {}) {
  const byId = new Map(els.map((e) => [e.id, e]));
  const items = els.filter((e) => e.k !== 'connector' || (byId.has(e.a && e.a.id) || !e.a.id) && (byId.has(e.b && e.b.id) || !e.b.id));
  const box = unionBox(items.map((e) => boxOf(e, byId)));
  const layers = [BG(W, H, look.bg || '#ffffff')];
  if (!box) return layers;
  const pad = Math.round(Math.min(W, H) * 0.08);
  const k = Math.min(4, (W - 2 * pad) / Math.max(1, box.w), (H - 2 * pad) / Math.max(1, box.h));
  const ox = (W - box.w * k) / 2 - box.x * k, oy = (H - box.h * k) / 2 - box.y * k;
  const X = (v) => Math.round(v * k + ox), Y = (v) => Math.round(v * k + oy), S = (v) => Math.max(1, Math.round(v * k));
  const ink = look.ink || DEFAULT_INK, font = look.body || 'Inter', head = look.heading || font;
  const txt = (e, x, y, w, h, o = {}) => ({ ...Tx(x, y, w, String(e.text || ''), { size: S(e.size || 24), color: e.color || ink, weight: e.weight || 500, align: e.align || 'left', font: (e.size || 24) >= 32 ? head : font, lh: 1.3, name: String(e.text || 'Text').slice(0, 20) }), h, ...o });
  [...items].sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((e) => {
    const x = X(e.x), y = Y(e.y), w = S(e.w), h = S(e.h);
    if (e.k === 'text') layers.push(txt(e, x, y, w, h));
    else if (e.k === 'sticky') {
      const p = S(16);
      layers.push(Rc(x, y, w, h, e.fill || STICKY[0], { name: 'Sticky note', r: S(6) }));
      layers.push(txt(e, x + p, y + p, Math.max(1, w - 2 * p), Math.max(1, h - 2 * p), { color: e.color || '#1f2937', size: S(e.size || 18) }));
    } else if (e.k === 'shape') {
      const fill = e.fill && e.fill !== 'transparent' ? e.fill : 'transparent', st = e.stroke ? { stroke: e.stroke, sw: S(e.sw || 2) } : {};
      const d = shapeD(e.shape, w, h);
      if (d) layers.push({ id: uid(), type: 'path', name: e.shape === 'diamond' ? 'Diamond' : 'Triangle', x, y, w, h, rot: 0, op: 1, d, vw: w, vh: h, fill: fill === 'transparent' ? 'none' : fill, ...st });
      else layers.push((e.shape === 'ellipse' ? El : Rc)(x, y, w, h, fill, { name: e.shape === 'ellipse' ? 'Circle' : 'Shape', ...(e.shape === 'ellipse' ? {} : { r: S(8) }), ...st }));
      if ((e.text || '').trim()) {
        const p = S(10), size = S(e.size || 18);
        layers.push(txt(e, x + p, Math.round(y + h / 2 - size * 0.65), Math.max(1, w - 2 * p), Math.round(size * 1.3), { align: 'center', size }));
      }
    } else if (e.k === 'image') layers.push(Im(x, y, w, h, `url(${e.src}) center/cover no-repeat`, { name: e.name || 'Image' }));
    else if (e.k === 'path') layers.push({ id: uid(), type: 'path', name: 'Drawing', x, y, w, h, rot: 0, op: 1, d: smoothD(e.pts, k), vw: w, vh: h, fill: 'none', stroke: e.stroke || ink, sw: S(e.sw || 4), cap: 'round', join: 'round' });
    else if (e.k === 'connector') {
      const [[ax, ay], [bx, by]] = connectorPts(e, byId), x0 = Math.min(X(ax), X(bx)), y0 = Math.min(Y(ay), Y(by));
      const w2 = Math.max(1, Math.abs(X(bx) - X(ax))), h2 = Math.max(1, Math.abs(Y(by) - Y(ay)));
      const p1 = [X(ax) - x0, Y(ay) - y0], p2 = [X(bx) - x0, Y(by) - y0];
      let d = `M${p1[0]} ${p1[1]}L${p2[0]} ${p2[1]}`;
      if (e.arrow !== false) {
        const a = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]), L = S(12), q = (t) => `${Math.round(p2[0] - L * Math.cos(a + t))} ${Math.round(p2[1] - L * Math.sin(a + t))}`;
        d += `M${q(0.45)}L${p2[0]} ${p2[1]}L${q(-0.45)}`;
      }
      layers.push({ id: uid(), type: 'path', name: 'Connector', x: x0, y: y0, w: w2, h: h2, rot: 0, op: 1, d, vw: w2, vh: h2, fill: 'none', stroke: e.stroke || '#64748b', sw: S(e.sw || 2), cap: 'round', join: 'round' });
    }
  });
  return layers;
}

/**
 * One slide per note (a carousel): each text element, in reading order, becomes a slide in the brand's look.
 * look: { bg, ink, accent, heading, body }
 */
export function notesToPages(els, W, H, look = {}) {
  const notes = readingOrder(els.filter(hasText)).filter((e) => String(e.text || '').trim()).slice(0, 20);
  const pad = Math.round(W * 0.1), n = notes.length;
  return notes.map((e, i) => {
    const text = String(e.text).trim(), size = Math.round(W * (text.length > 160 ? 0.042 : text.length > 70 ? 0.055 : 0.075));
    const lines = Math.max(1, Math.ceil((text.length * size * 0.52) / (W - 2 * pad)) + (text.match(/\n/g) || []).length);
    const th = Math.round(lines * size * 1.25);
    const layers = [
      BG(W, H, look.bg || '#0b1220'),
      Rc(pad, Math.round(H / 2 - th / 2 - size * 1.2), Math.round(W * 0.08), Math.max(6, Math.round(W * 0.008)), look.accent || '#fd0e35', { name: 'Accent' }),
      { ...Tx(pad, Math.round(H / 2 - th / 2), W - 2 * pad, text, { size, weight: 700, color: look.ink || '#f8fafc', font: look.heading || 'Poppins', lh: 1.25, name: text.slice(0, 20) }), h: th },
    ];
    if (n > 1) layers.push(Tx(pad, H - pad - Math.round(W * 0.03), W - 2 * pad, `${i + 1} / ${n}`, { size: Math.round(W * 0.026), weight: 500, color: look.ink || '#f8fafc', font: look.body || 'Inter', op: 0.6, name: 'Counter' }));
    return { id: uid(), bg: look.bg || '#0b1220', layers };
  });
}

/**
 * "Generate design": what the Studio Agent is asked for, from the selected board elements.
 * Notes become the post's content (in reading order); photos are placed on the page beforehand
 * (photoLayers) and the agent is told they are the post's own content, not inspiration.
 * extra: the user's own words from the dialog. slides: pages wanted (1 = a single post).
 */
export function generateRequest(els, { extra = '', slides = 1, label = '' } = {}) {
  const notes = readingOrder(els.filter(hasText)).map((e) => String(e.text || '').trim()).filter(Boolean);
  const photos = els.filter((e) => e.k === 'image').length;
  const ask = String(extra || '').trim();
  const lines = [];
  lines.push(ask || (slides > 1 ? `Design a ${slides}-slide carousel from my board.` : 'Design a social media post from my board.'));
  if (notes.length) lines.push('', 'My notes, in order:', ...notes.map((t) => '- ' + t.replace(/\s*\n\s*/g, ' ')));
  if (photos) lines.push('', `Use the ${photos === 1 ? 'photo' : `${photos} photos`} already on the page.`);
  const text = lines.join('\n');
  const note = [
    'This is a new design created from the user’s Creative Canvas board: the notes in the message are the content and ideas to work from (rewrite them into punchy post copy; do not paste them as sticky notes).',
    photos ? `The page already holds ${photos === 1 ? 'one photo' : `${photos} photos`} from the board, named “From the board”. They are the post’s own content, not inspiration: keep them visible (move, resize or crop them as the layout needs, never delete them).` : '',
    'Build it with the brand kit and its design system, if it has one, then check the result.',
    label ? `The user chose ${label}${slides > 1 ? `, ${slides} pages: design every page` : ''}. Keep this size.` : 'Choose the canvas size and the number of pages that fit the request best (resize_canvas, manage_slides) before adding layers.',
  ].filter(Boolean).join(' ');
  return { text, note, notes: notes.length, photos };
}

/** The selected photos as image layers of a W×H page, arranged as on the board (no background) */
export function photoLayers(els, W, H) {
  const pics = els.filter((e) => e.k === 'image').slice(0, 6);
  if (!pics.length) return [];
  return toLayers(pics, W, H).slice(1).map((l) => ({ ...l, name: 'From the board' }));
}
