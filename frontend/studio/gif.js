/* ============================================================
   Animated GIF encoder for the Studio's video export (animated designs). Pure, no DOM, unit-tested.
   - buildPalette: up to 256 colours for the whole GIF from sample frames (exact colours when there are few, else median cut);
   - gifWriter: frames are added one at a time (RGBA in, indexed + LZW out), so a long GIF never holds every frame in memory;
   - encodeGif: the same for frames already in memory.
   A GIF has no sound and one palette here (no per-frame palette, no dithering): flat brand designs keep their colours,
   photos and gradients band a little.
   ============================================================ */

export const GIF_FPS = [10, 12, 15];
/** Short-side sizes offered, in px */
export const GIF_SIZES = [360, 540, 720];
/** Above this length a GIF gets heavy: the dialog warns */
export const GIF_LONG_MS = 15000;

/** The GIF's pixel size for a design of W × H at a short side of `short` px: never scaled up, even numbers; s is the scale */
export function gifSize(W, H, short) {
  const s = Math.min(1, short / Math.min(W, H));
  return { w: Math.max(2, Math.round((W * s) / 2) * 2), h: Math.max(2, Math.round((H * s) / 2) * 2), s };
}
/** A rough file size in bytes (a flat design measured at about 0.035 byte per pixel; 0.05 leaves room for photos) */
export const gifEstimate = (w, h, fps, ms) => Math.round(w * h * Math.max(1, Math.round((ms / 1000) * fps)) * 0.05);

/* ---------- palette ---------- */
const MAX = 256, SAMPLES = 120000;
/** Up to 256 [r, g, b] colours for RGBA frames (at least 2: a GIF colour table cannot be smaller) */
export function buildPalette(frames) {
  let total = 0; for (const f of frames) total += f.length >> 2;
  const step = Math.max(1, Math.floor(total / SAMPLES));
  const exact = new Map(); // 24-bit colour -> count, while there are few
  const hist = new Map(); // 15-bit bin -> [count, r sum, g sum, b sum]
  let n = 0;
  for (const f of frames) {
    for (let p = (n % step) * 4; p < f.length; p += step * 4, n++) {
      const r = f[p], g = f[p + 1], b = f[p + 2];
      if (exact.size <= MAX) { const k = (r << 16) | (g << 8) | b; exact.set(k, (exact.get(k) || 0) + 1); }
      const hk = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3), h = hist.get(hk);
      if (h) { h[0]++; h[1] += r; h[2] += g; h[3] += b; } else hist.set(hk, [1, r, g, b]);
    }
  }
  let pal;
  if (exact.size <= MAX) pal = [...exact.keys()].map((k) => [k >> 16, (k >> 8) & 255, k & 255]);
  else pal = medianCut([...hist.values()].map(([c, r, g, b]) => ({ c, r: r / c, g: g / c, b: b / c })));
  while (pal.length < 2) pal.push([0, 0, 0]);
  return pal;
}
function medianCut(bins) {
  const box = (items) => {
    let lo = [255, 255, 255], hi = [0, 0, 0], c = 0;
    for (const it of items) { const v = [it.r, it.g, it.b]; for (let i = 0; i < 3; i++) { if (v[i] < lo[i]) lo[i] = v[i]; if (v[i] > hi[i]) hi[i] = v[i]; } c += it.c; }
    const range = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], ax = range.indexOf(Math.max(...range));
    return { items, c, ax, span: range[ax] };
  };
  const boxes = [box(bins)];
  while (boxes.length < MAX) {
    // the box that most needs a cut: the widest one that can still be split, weighted by how many pixels it holds
    let bi = -1, best = 0;
    boxes.forEach((b, i) => { const score = b.span * Math.sqrt(b.c); if (b.items.length > 1 && score > best) { best = score; bi = i; } });
    if (bi < 0) break;
    const b = boxes[bi], key = ['r', 'g', 'b'][b.ax], items = b.items.slice().sort((x, y) => x[key] - y[key]);
    let acc = 0, cut = 1;
    for (let i = 0; i < items.length - 1; i++) { acc += items[i].c; if (acc >= b.c / 2) { cut = i + 1; break; } cut = i + 1; }
    boxes.splice(bi, 1, box(items.slice(0, cut)), box(items.slice(cut)));
  }
  return boxes.map((b) => { let r = 0, g = 0, bl = 0; for (const it of b.items) { r += it.r * it.c; g += it.g * it.c; bl += it.b * it.c; } return [Math.round(r / b.c), Math.round(g / b.c), Math.round(bl / b.c)]; });
}
/** (r, g, b) -> index of the closest palette colour, remembered per 18-bit colour */
export function nearestIndexer(pal) {
  const cache = new Int16Array(1 << 18).fill(-1), n = pal.length;
  return (r, g, b) => {
    const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2); let i = cache[k];
    if (i >= 0) return i;
    let best = Infinity;
    for (let j = 0; j < n; j++) { const p = pal[j], dr = p[0] - r, dg = p[1] - g, db = p[2] - b, d = dr * dr * 2 + dg * dg * 4 + db * db * 3; if (d < best) { best = d; i = j; } }
    cache[k] = i; return i;
  };
}

/* ---------- LZW ---------- */
/** GIF LZW of indexed pixels with a minimum code size: the packed bytes (not yet cut into sub-blocks) */
export function lzw(px, minSize) {
  const clear = 1 << minSize, eoi = clear + 1, out = [];
  let size = minSize + 1, next = eoi + 1, cur = 0, bits = 0, dict = new Map();
  const emit = (code) => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
  emit(clear);
  if (px.length) {
    let prefix = px[0];
    for (let i = 1; i < px.length; i++) {
      const k = px[i], key = (prefix << 8) | k, hit = dict.get(key);
      if (hit !== undefined) { prefix = hit; continue; }
      emit(prefix);
      if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
      else { emit(clear); dict = new Map(); size = minSize + 1; next = eoi + 1; }
      prefix = k;
    }
    emit(prefix);
  }
  emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}

/* ---------- writer ---------- */
const u16 = (v) => [v & 255, (v >> 8) & 255];
/**
 * A GIF written frame by frame: add(rgba) for each frame (RGBA bytes, width × height), then done() -> Uint8Array.
 * The palette is fixed for the whole file (buildPalette). It loops forever.
 */
export function gifWriter({ width, height, fps, palette }) {
  const bitsN = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length)))), tableN = 1 << bitsN, minSize = Math.max(2, bitsN);
  const parts = [], delay = Math.max(2, Math.round(100 / fps)), index = nearestIndexer(palette), px = new Uint8Array(width * height);
  const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(width), ...u16(height), 0x80 | 0x70 | (bitsN - 1), 0, 0];
  for (let i = 0; i < tableN; i++) { const c = palette[i] || [0, 0, 0]; head.push(c[0], c[1], c[2]); }
  head.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // loop forever
  parts.push(Uint8Array.from(head));
  return {
    add(rgba) {
      for (let i = 0, p = 0; i < px.length; i++, p += 4) px[i] = index(rgba[p], rgba[p + 1], rgba[p + 2]);
      const data = lzw(px, minSize), blocks = new Uint8Array(data.length + Math.ceil(data.length / 255) + 1);
      let o = 0; for (let p = 0; p < data.length; p += 255) { const n = Math.min(255, data.length - p); blocks[o++] = n; blocks.set(data.subarray(p, p + n), o); o += n; }
      blocks[o] = 0;
      parts.push(Uint8Array.from([0x21, 0xf9, 4, 0, ...u16(delay), 0, 0, 0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0, minSize]), blocks);
    },
    done() {
      parts.push(Uint8Array.of(0x3b));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },
  };
}
/** Frames already in memory -> the GIF's bytes; null when `signal.stop` is set. onStep(0..1) after each frame */
export function encodeGif(frames, { width, height, fps, onStep, signal } = {}) {
  if (signal && signal.stop) return null;
  const w = gifWriter({ width, height, fps, palette: buildPalette(frames) });
  for (let i = 0; i < frames.length; i++) { if (signal && signal.stop) return null; w.add(frames[i]); if (onStep) onStep((i + 1) / frames.length); }
  return w.done();
}
