// Subtitle grouping, editing and drawing shared by the studio preview and the
// headless export render. Pure ESM, no imports; the only DOM use is the passed ctx2d.
// Backend gets a byte-identical copy (sync-shared).

export const DEFAULT_STYLE = {
  font: 'sans-bold', size: 0.045, weight: 800, case: 'none', color: '#FFFFFF', stroke: null,
  shadow: { color: 'rgba(0,0,0,.55)', blur: 0.006, y: 0.002 }, box: null,
  highlight: { mode: 'box', color: '#E8B54A', text: '#1A1A1A', radius: 0.18 },
  y: 0.65, maxWords: 3, maxChars: 22, lines: 1, anim: 'none',
};

// Optional style fields and their defaults; a style without them renders exactly as before.
// ls: letter/word spacing (em of the font size added to every word gap), lh: line height (wrapped rows),
// x: horizontal anchor (0..1 of the width), align: how the block sits on x, boxOpacity: box alpha multiplier,
// anim/animSpeed: animation kind and speed (0.5-2), offset: caption delay (ms), minDur/gap: line duration floor and gap (ms).
const STYLE_DEFAULTS = {
  ls: 0, lh: 1.15, x: 0.5, align: 'center', boxOpacity: 1, anim: 'none', animSpeed: 1, offset: 0, minDur: 600, gap: 0,
};
export function withDefaults(style) {
  const out = { ...STYLE_DEFAULTS };
  for (const k of Object.keys(style || {})) if (style[k] !== undefined) out[k] = style[k];
  return out;
}

export const FONT_STACKS = {
  'sans-bold': '"Cairo", "Noto Sans Arabic", "Inter", sans-serif',
  sans: '"Noto Sans Arabic", "Cairo", "Inter", sans-serif',
  serif: '"Amiri", "Noto Naskh Arabic", Georgia, serif',
  display: '"Lalezar", "Cairo", "Noto Sans Arabic", sans-serif',
};

// The web fonts the stacks above name (the studio editor and the export page load this stylesheet).
export const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cairo:wght@400;600;700;800;900&family=Lalezar&family=Noto+Naskh+Arabic:wght@400;700&family=Noto+Sans+Arabic:wght@400;600;700;800&display=swap';

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
  let lines = [];
  let cur = [];
  for (const w of words) {
    if (breaksBefore(cur, w, style)) { lines.push(mkLine(cur)); cur = []; }
    cur.push(w);
  }
  if (cur.length) lines.push(mkLine(cur));
  // minDur/gap apply only when the style passed to group() sets them (withDefaults output would enable minDur 600).
  const minDur = Number(style.minDur) > 0 ? Number(style.minDur) : 0;
  const gap = Number(style.gap) > 0 ? Number(style.gap) : 0;
  if (minDur) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      while (l.end - l.start < minDur && i + 1 < lines.length) {
        const n = lines[i + 1];
        const ext = () => ({ ...l, end: Math.max(l.end, Math.min(n.start, l.start + minDur)) });
        if (END_PUNCT.test(l.words[l.words.length - 1].t)) { l = ext(); break; }
        const all = [...l.words, ...n.words];
        const chars = all.reduce((c, x) => c + x.t.length + 1, 0) - 1;
        if (all.length > style.maxWords || chars > style.maxChars) { l = ext(); break; }
        l = mkLine(all); i++;
      }
      out.push(l);
    }
    lines = out;
  }
  if (gap) {
    lines = lines.map((l, i) => {
      const nx = lines[i + 1];
      if (!nx || nx.start - l.end >= gap) return l;
      return { ...l, end: Math.max(l.start + 1, nx.start - gap) };
    });
  }
  return lines;
}

// Token-level LCS: returns [oldIdx, newIdx] pairs of kept tokens, in order.
export function lcsPairs(a, b) {
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
// The canvas font of a style at px (the export page loads it before drawing).
export const fontOf = (style, px) => {
  const stack = FONT_STACKS[style.font] || FONT_STACKS['sans-bold'];
  return `${style.weight} ${px}px ${style.family ? `${style.family}, ${stack}` : stack}`;
};

const ANIM_MS = 133;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Ramp duration (ms) of a style: ANIM_MS / animSpeed, speed clamped to 0.5-2.
const animDur = (style) => ANIM_MS / Math.min(2, Math.max(0.5, Number(style.animSpeed) || 1));
// Deterministic per-word animation state from time alone.
// dy is a fraction of the font px (positive = down); visible:false words are not drawn;
// highlight:true marks a word as active (karaoke fills every word whose start has passed).
export function animAt(style, line, wordIndex, ms) {
  const st = withDefaults(style);
  const dur = animDur(st);
  const w = line.words[wordIndex];
  let alpha = 1, scale = 1, dy = 0, visible = true, highlight = false;
  switch (st.anim) {
    case 'fade': alpha = clamp01((ms - line.start) / dur); break;
    case 'pop': {
      const d = ms - w.s;
      if (d >= 0 && d < dur) scale = 1 + 0.12 * (1 - Math.abs((2 * d) / dur - 1));
      break;
    }
    case 'karaoke': highlight = w.s <= ms; break;
    case 'word': visible = w.s <= ms; break;
    case 'typewriter': visible = w.s <= ms; alpha = clamp01((ms - w.s) / dur); break;
    case 'bounce': {
      // on the baseline until spoken, then a hop up (0.25 em at the top) and back down over 2 ramps
      const p = clamp01((ms - w.s) / (2 * dur));
      dy = p > 0 && p < 1 ? -0.25 * Math.sin(Math.PI * p) : 0;
      break;
    }
    case 'slide': {
      const p = clamp01((ms - line.start) / dur);
      alpha = p; dy = 0.6 * (1 - p);
      break;
    }
    default:
  }
  return { alpha, scale, dy, visible, highlight };
}

// Every ms in [0, durMs) at which draw() output changes: 0, each line's start and end, each word's start and end, and,
// when the style animates, 4 steps across the ramp (133 ms / animSpeed) after each word start for pop, fade, typewriter
// and bounce (bounce also steps through its second half, 8 steps over 2 ramps), and for fade and slide the same 4
// steps after the line's start (their ramps start there). Every time is shifted by style.offset (draw runs at ms - offset).
// Lines without words are skipped (lineAt never shows them). Sorted, deduplicated, integers.
export function changeTimes(lines, style, durMs) {
  const st = withDefaults(style);
  const set = new Set([0]);
  const add = (t) => { const v = Math.round(t + st.offset); if (v >= 0 && v < durMs) set.add(v); };
  const dur = animDur(st);
  const wordRamp = { fade: 4, pop: 4, typewriter: 4, bounce: 8 }[st.anim] || 0;
  const lineRamp = st.anim === 'fade' || st.anim === 'slide';
  for (const l of lines || []) {
    if (!l || !l.words || !l.words.length) continue;
    add(l.start); add(l.end);
    // fade and slide ramp from the line's start, which can come before its first word
    if (lineRamp) for (let k = 1; k <= 4; k++) add(l.start + (k * dur) / 4);
    for (const w of l.words) {
      add(w.s); add(w.e);
      for (let k = 1; k <= wordRamp; k++) add(w.s + (k * dur) / 4);
    }
  }
  return [...set].sort((a, b) => a - b);
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
  style = withDefaults(style);
  const px = style.size * h;
  ctx.font = fontOf(style, px);
  const widths = line.words.map((x) => ctx.measureText(shown(x.t, style)).width);
  const gap = ctx.measureText(' ').width + style.ls * px;
  const rowW = (a, b) => widths.slice(a, b).reduce((x, y) => x + y, 0) + gap * Math.max(0, b - a - 1);
  const total = rowW(0, widths.length);
  const rtl = isRtl(line.words.map((x) => x.t).join(' '));
  const wrap = style.lines === 2 && widths.length > 1 && total > 0.86 * w;
  const rows = wrap ? splitRows(widths, gap) : [[0, widths.length]];
  const lh = wrap ? px * (style.lh === 1.15 ? 1.25 : (1.25 * style.lh) / 1.15) : px;
  const top = style.y * h - (lh * rows.length) / 2;
  const bw = Math.max(...rows.map(([a, b]) => rowW(a, b)));
  const ax = style.x * w;
  const bx = style.align === 'left' ? ax : style.align === 'right' ? ax - bw : ax - bw / 2;
  const words = [];
  rows.forEach(([a, b], r) => {
    const idx = []; for (let i = a; i < b; i++) idx.push(i);
    if (rtl) idx.reverse();
    const rw = rowW(a, b);
    let x = style.align === 'left' ? bx : style.align === 'right' ? bx + bw - rw : ax - rw / 2;
    const y = top + r * lh + (lh - px) / 2;
    for (const i of idx) { words[i] = { i, x, y, w: widths[i], h: px }; x += widths[i] + gap; }
  });
  return { x: bx, y: top, w: bw, h: lh * rows.length, words };
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
  style = withDefaults(style);
  ms -= style.offset;
  const line = lineAt(lines, ms);
  if (!line) return;
  const L = layout(ctx, line, style, w, h);
  const act = activeWord(line, ms);
  const hl = style.highlight;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // typewriter fades per word below; every other animation fades the whole line (and its box) together
  ctx.globalAlpha = style.anim === 'typewriter' ? 1 : animAt(style, line, 0, ms).alpha;
  const boxDy = style.anim === 'slide' ? animAt(style, line, 0, ms).dy * style.size * h : 0;
  if (style.box) {
    const pad = (style.box.pad || 0.012) * h;
    ctx.fillStyle = style.box.color;
    roundRect(ctx, L.x - pad * 2, L.y - pad + boxDy, L.w + pad * 4, L.h + pad * 2, (style.box.radius || 0.18) * L.h);
    if (style.boxOpacity !== 1) {
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * style.boxOpacity; ctx.fill(); ctx.globalAlpha = a;
    } else ctx.fill();
  }
  if (style.shadow) {
    ctx.shadowColor = style.shadow.color; ctx.shadowBlur = style.shadow.blur * h; ctx.shadowOffsetY = style.shadow.y * h;
  }
  for (const b0 of L.words) {
    const a = animAt(style, line, b0.i, ms);
    if (!a.visible) continue;
    const b = a.dy ? { ...b0, y: b0.y + a.dy * b0.h } : b0;
    const on = (style.anim === 'karaoke' ? a.highlight : b.i === act) && hl;
    if (style.anim === 'typewriter') ctx.globalAlpha = a.alpha;
    if (on && hl.mode === 'box') {
      const pad = b.h * 0.12;
      ctx.fillStyle = hl.color;
      roundRect(ctx, b.x - pad, b.y, b.w + pad * 2, b.h, hl.radius * b.h);
      ctx.fill();
    }
    const fill = on && hl.mode === 'box' ? hl.text : on && hl.mode === 'color' ? hl.color : style.color;
    const k = (on && hl.mode === 'scale' ? 1.12 : 1) * a.scale;
    drawWord(ctx, shown(line.words[b.i].t, style), b, style, fill, k, h);
  }
  ctx.restore();
}
