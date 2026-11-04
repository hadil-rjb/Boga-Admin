// Subtitle grouping, editing and drawing shared by the studio preview and the
// headless export render. Pure ESM, no imports; the only DOM use is the passed ctx2d.
// Backend gets a byte-identical copy (sync-shared).

export const DEFAULT_STYLE = {
  font: 'sans-bold', size: 0.045, weight: 800, case: 'none', color: '#FFFFFF', stroke: null,
  shadow: { color: 'rgba(0,0,0,.55)', blur: 0.006, y: 0.002 }, box: null,
  highlight: { mode: 'box', color: '#E8B54A', text: '#1A1A1A', radius: 0.18 },
  y: 0.65, maxWords: 3, maxChars: 22, lines: 1, anim: 'none',
};

export const FONT_STACKS = {
  'sans-bold': '"Cairo", "Noto Sans Arabic", "Inter", sans-serif',
  sans: '"Noto Sans Arabic", "Cairo", "Inter", sans-serif',
  serif: '"Amiri", "Noto Naskh Arabic", Georgia, serif',
  display: '"Lalezar", "Cairo", "Noto Sans Arabic", sans-serif',
};

const PAUSE_MS = 350;
const END_PUNCT = /[.!?؟…,،;:؛]$/;
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const STRONG_LTR = /[A-Za-zÀ-ɏ]/;

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const mkLine = (words, start = 0, end = 0) => ({
  id: rid(), start: words.length ? words[0].s : start, end: words.length ? words[words.length - 1].e : end, words,
});

function breaksBefore(cur, w, style) {
  if (!cur.length) return false;
  const prev = cur[cur.length - 1];
  const chars = cur.reduce((n, x) => n + x.t.length + 1, 0) + w.t.length;
  return cur.length >= style.maxWords || chars > style.maxChars
    || w.s - prev.e >= PAUSE_MS || END_PUNCT.test(prev.t);
}

export function group(words, style) {
  const lines = [];
  let cur = [];
  for (const w of words) {
    if (breaksBefore(cur, w, style)) { lines.push(mkLine(cur)); cur = []; }
    cur.push(w);
  }
  if (cur.length) lines.push(mkLine(cur));
  return lines;
}

// Token-level LCS: returns [oldIdx, newIdx] pairs of kept tokens, in order.
function lcsPairs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { pairs.push([i++, j++]); } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pairs;
}

function fillRun(tokens, from, to, s, e, out) {
  const step = (e - s) / (to - from);
  for (let k = from; k < to; k++) {
    out.push({ t: tokens[k], s: Math.round(s + step * (k - from)), e: Math.round(s + step * (k - from + 1)) });
  }
}

export function retext(line, text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ...line, words: [] };
  const old = line.words;
  const pairs = lcsPairs(old.map((w) => w.t), tokens);
  const out = [];
  let ni = 0;
  let gapStart = line.start;
  for (const [oi, nj] of [...pairs, [-1, tokens.length]]) {
    const gapEnd = oi < 0 ? line.end : old[oi].s;
    if (nj > ni) fillRun(tokens, ni, nj, gapStart, gapEnd, out);
    if (oi >= 0) { out.push(old[oi]); gapStart = old[oi].e; }
    ni = nj + 1;
  }
  return { ...line, start: out[0].s, end: out[out.length - 1].e, words: out };
}

export function split(line, atMs) {
  const k = line.words.findIndex((w) => w.s >= atMs);
  const at = k < 0 ? line.words.length : k;
  return [mkLine(line.words.slice(0, at), line.start, atMs), mkLine(line.words.slice(at), atMs, line.end)];
}

export function merge(a, b) {
  return mkLine([...a.words, ...b.words], a.start, b.end);
}

// Scales a line (and its word times) linearly into [start, end]; a zero-length line only shifts.
export function retime(line, start, end) {
  const os = line.start, span = line.end - line.start, k = span > 0 ? (end - start) / span : 1;
  const map = (t) => Math.round(start + (t - os) * k);
  return { ...line, start, end, words: line.words.map((w) => ({ ...w, s: map(w.s), e: map(w.e) })) };
}

const NEW_LINE_MS = 1500, MIN_NEW_MS = 200;
// Inserts a 1500 ms line at atMs (or after the line it falls in), shortened to end before the next line.
// With less than 200 ms of room the same array comes back.
export function addLine(lines, atMs, text = '') {
  const prev = lines.filter((l) => l.start <= atMs).pop();
  const start = Math.max(0, Math.round(prev ? Math.max(atMs, prev.end) : atMs));
  const next = lines.find((l) => l.start >= start && l !== prev);
  const end = Math.round(Math.min(start + NEW_LINE_MS, next ? next.start : Infinity));
  if (end - start < MIN_NEW_MS) return lines;
  const line = retext(mkLine([], start, end), text);
  const at = next ? lines.indexOf(next) : lines.length;
  return [...lines.slice(0, at), line, ...lines.slice(at)];
}

export function lineAt(lines, ms) {
  return lines.find((l) => l.words.length && ms >= l.start && ms < l.end) || null;
}

export function activeWord(line, ms) {
  return line.words.findIndex((w) => ms >= w.s && ms < w.e);
}

const shown = (t, style) => (style.case === 'upper' ? t.toUpperCase() : style.case === 'lower' ? t.toLowerCase() : t);
const isRtl = (text) => {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return true;
    if (STRONG_LTR.test(ch)) return false;
  }
  return false;
};
const fontOf = (style, px) => {
  const stack = FONT_STACKS[style.font] || FONT_STACKS['sans-bold'];
  return `${style.weight} ${px}px ${style.family ? `${style.family}, ${stack}` : stack}`;
};

const ANIM_MS = 133;
// Deterministic per-word animation state from time alone.
export function animAt(style, line, wordIndex, ms) {
  let alpha = 1;
  let scale = 1;
  if (style.anim === 'fade') alpha = Math.min(1, Math.max(0, (ms - line.start) / ANIM_MS));
  if (style.anim === 'pop') {
    const d = ms - line.words[wordIndex].s;
    if (d >= 0 && d < ANIM_MS) scale = 1 + 0.12 * (1 - Math.abs((2 * d) / ANIM_MS - 1));
  }
  return { alpha, scale };
}

// Balanced 2-row split by measured width, preserving reading order.
function splitRows(widths, gap) {
  let best = 1;
  let bestMax = Infinity;
  for (let k = 1; k < widths.length; k++) {
    const sum = (a, b) => widths.slice(a, b).reduce((x, y) => x + y, 0) + gap * (b - a - 1);
    const m = Math.max(sum(0, k), sum(k, widths.length));
    if (m < bestMax) { bestMax = m; best = k; }
  }
  return [[0, best], [best, widths.length]];
}

export function layout(ctx, line, style, w, h) {
  const px = style.size * h;
  ctx.font = fontOf(style, px);
  const widths = line.words.map((x) => ctx.measureText(shown(x.t, style)).width);
  const gap = ctx.measureText(' ').width;
  const rowW = (a, b) => widths.slice(a, b).reduce((x, y) => x + y, 0) + gap * Math.max(0, b - a - 1);
  const total = rowW(0, widths.length);
  const rtl = isRtl(line.words.map((x) => x.t).join(' '));
  const wrap = style.lines === 2 && widths.length > 1 && total > 0.86 * w;
  const rows = wrap ? splitRows(widths, gap) : [[0, widths.length]];
  const lh = wrap ? px * 1.25 : px;
  const top = style.y * h - (lh * rows.length) / 2;
  const words = [];
  rows.forEach(([a, b], r) => {
    const idx = []; for (let i = a; i < b; i++) idx.push(i);
    if (rtl) idx.reverse();
    let x = w / 2 - rowW(a, b) / 2;
    const y = top + r * lh + (lh - px) / 2;
    for (const i of idx) { words[i] = { i, x, y, w: widths[i], h: px }; x += widths[i] + gap; }
  });
  const bw = Math.max(...rows.map(([a, b]) => rowW(a, b)));
  return { x: w / 2 - bw / 2, y: top, w: bw, h: lh * rows.length, words };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawWord(ctx, text, b, style, fill, scale, h) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.font = fontOf(style, b.h);
  if (style.stroke) {
    ctx.lineWidth = style.stroke.width * h; ctx.strokeStyle = style.stroke.color; ctx.lineJoin = 'round';
    ctx.strokeText(text, -b.w / 2, 0);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, -b.w / 2, 0);
  ctx.restore();
}

export function draw(ctx, lines, style, ms, w, h) {
  const line = lineAt(lines, ms);
  if (!line) return;
  const L = layout(ctx, line, style, w, h);
  const act = activeWord(line, ms);
  const hl = style.highlight;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = animAt(style, line, 0, ms).alpha;
  if (style.box) {
    const pad = (style.box.pad || 0.012) * h;
    ctx.fillStyle = style.box.color;
    roundRect(ctx, L.x - pad * 2, L.y - pad, L.w + pad * 4, L.h + pad * 2, (style.box.radius || 0.18) * L.h);
    ctx.fill();
  }
  if (style.shadow) {
    ctx.shadowColor = style.shadow.color; ctx.shadowBlur = style.shadow.blur * h; ctx.shadowOffsetY = style.shadow.y * h;
  }
  for (const b of L.words) {
    const on = b.i === act && hl;
    if (on && hl.mode === 'box') {
      const pad = b.h * 0.12;
      ctx.fillStyle = hl.color;
      roundRect(ctx, b.x - pad, b.y, b.w + pad * 2, b.h, hl.radius * b.h);
      ctx.fill();
    }
    const fill = on && hl.mode === 'box' ? hl.text : on && hl.mode === 'color' ? hl.color : style.color;
    const k = (on && hl.mode === 'scale' ? 1.12 : 1) * animAt(style, line, b.i, ms).scale;
    drawWord(ctx, shown(line.words[b.i].t, style), b, style, fill, k, h);
  }
  ctx.restore();
}
