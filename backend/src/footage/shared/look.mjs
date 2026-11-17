// Grade math shared by the studio preview and the backend export LUT baker.
// Pure ESM, no imports, no DOM. Backend gets a byte-identical copy (sync-shared).

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function parseCube(text) {
  let size = 0;
  const vals = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    if (/^[A-Za-z_]/.test(parts[0])) {
      if (parts[0] === 'LUT_3D_SIZE') size = parseInt(parts[1], 10);
      continue;
    }
    if (parts.length >= 3) vals.push(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
  }
  if (!(size >= 2)) throw new Error('cube: missing or invalid LUT_3D_SIZE');
  if (vals.length !== size * size * size * 3) throw new Error('cube: expected ' + size ** 3 + ' entries, got ' + vals.length / 3);
  return { size, data: Float32Array.from(vals) };
}

export function writeCube(lut, title = 'look') {
  const out = ['TITLE "' + String(title).replace(/"/g, "'") + '"', 'LUT_3D_SIZE ' + lut.size];
  for (let i = 0; i < lut.data.length; i += 3) {
    out.push(lut.data[i].toPrecision(9) + ' ' + lut.data[i + 1].toPrecision(9) + ' ' + lut.data[i + 2].toPrecision(9));
  }
  return out.join('\n') + '\n';
}

export function identityCube(size = 33) {
  const data = new Float32Array(size * size * size * 3);
  const d = size - 1;
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    data[i++] = r / d; data[i++] = g / d; data[i++] = b / d;
  }
  return { size, data };
}

export function sampleCube(lut, [r, g, b]) {
  const n = lut.size, d = n - 1, data = lut.data;
  const fx = clamp01(r) * d, fy = clamp01(g) * d, fz = clamp01(b) * d;
  const x0 = Math.min(Math.floor(fx), d - 1), y0 = Math.min(Math.floor(fy), d - 1), z0 = Math.min(Math.floor(fz), d - 1);
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const at = (x, y, z) => data[((z * n + y) * n + x) * 3 + c];
    const c00 = at(x0, y0, z0) * (1 - tx) + at(x0 + 1, y0, z0) * tx;
    const c10 = at(x0, y0 + 1, z0) * (1 - tx) + at(x0 + 1, y0 + 1, z0) * tx;
    const c01 = at(x0, y0, z0 + 1) * (1 - tx) + at(x0 + 1, y0, z0 + 1) * tx;
    const c11 = at(x0, y0 + 1, z0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1, z0 + 1) * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    out[c] = c0 * (1 - tz) + c1 * tz;
  }
  return out;
}

const decode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// Each of exposure, temp, sat is -1..1.
export function tweak([r, g, b], { exposure = 0, temp = 0, sat = 0 } = {}) {
  const k = Math.pow(2, exposure * 2);
  let c = [r, g, b].map((v) => clamp01(encode(Math.max(0, decode(clamp01(v)) * k))));
  c = [clamp01(c[0] + temp * 0.06), c[1], clamp01(c[2] - temp * 0.06)];
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const s = 1 + sat;
  return c.map((v) => clamp01(y + (v - y) * s));
}

/* ---- Look filters: one-click styles on top of the grade (preview: GLSL_FILTER, export: baked into the LUT) ---- */
// Each filter is a few numbers: saturation, contrast around mid-grey, a tint added to the shadows and one to the
// highlights, a fade (lifted blacks) and mono (black & white). `amount` 0..1 mixes it with the graded image.
// `light` is the light balance a filter starts with (shadows, highlights: see applyTone); choosing it sets the sliders.
export const FILTERS = {
  none: { label: 'None', light: [0, 0] },
  natural: { label: 'Natural', sat: 1.05, con: 1.0, sh: [0, 0, 0], hi: [0, 0, 0], fade: 0, mono: 0, light: [0.4, 0.45] },
  portrait: { label: 'Portrait', sat: 1.03, con: 0.96, sh: [0.012, 0.004, -0.006], hi: [0.016, 0.008, -0.01], fade: 0.015, mono: 0, light: [0.55, 0.5] },
  cinematic: { label: 'Cinematic', sat: 0.9, con: 1.1, sh: [-0.025, 0.01, 0.04], hi: [0.04, 0.012, -0.035], fade: 0.02, mono: 0, light: [0.3, 0.4] },
  warm: { label: 'Warm', sat: 1.06, con: 1.02, sh: [0.025, 0.008, -0.02], hi: [0.04, 0.02, -0.035], fade: 0, mono: 0, light: [0.3, 0.3] },
  bw: { label: 'B&W', sat: 1, con: 1.12, sh: [0, 0, 0], hi: [0, 0, 0], fade: 0.01, mono: 1, light: [0.3, 0.35] },
  vintage: { label: 'Vintage', sat: 0.72, con: 0.9, sh: [0.03, 0.025, 0.0], hi: [0.04, 0.025, -0.05], fade: 0.08, mono: 0, light: [0.2, 0.4] },
};
/**
 * `d.footage.look.fx` with its defaults: { filter, amount 0..1 (0.8), shadows 0..1 (0: brightens the dark parts, a
 * backlit face), highlights 0..1 (0: tones down the bright parts, a window behind), grain 0..1 (0), vignette 0..1 (0) }
 */
export function fxOf(fx) {
  const u = (v, d) => { const n = v == null ? d : +v; return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d; };
  const f = fx && Object.prototype.hasOwnProperty.call(FILTERS, fx.filter) ? fx.filter : 'none';
  return { filter: f, amount: u(fx && fx.amount, 0.8), shadows: u(fx && fx.shadows, 0), highlights: u(fx && fx.highlights, 0), grain: u(fx && fx.grain, 0), vignette: u(fx && fx.vignette, 0) };
}
/**
 * Light balance on one colour (mirrored by GLSL_FILTER lookTone): the luminance goes through a curve that lifts the
 * shadows and mid-tones (+ 3.4 × shadows × y(1−y)³, strongest at a quarter: a face in the shade, fading out before the
 * highlights) and pulls down only the brightest part (− 0.15 × highlights × y × smoothstep(0.7, 1, y): a window, a lamp;
 * skin below 0.7 is not touched; white ends at 0.85).
 * Both keep the curve monotonic; the colour is scaled with it, so hues stay.
 */
export function applyTone([r, g, b], shadows = 0, highlights = 0) {
  if (!(shadows > 0) && !(highlights > 0)) return [r, g, b];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (y <= 0) return [r, g, b];
  const t = clamp01((y - 0.7) / 0.3), knee = t * t * (3 - 2 * t);
  const y2 = clamp01(y + 3.4 * shadows * y * (1 - y) * (1 - y) * (1 - y) - 0.15 * highlights * y * knee), k = y2 / y;
  return [r * k, g * k, b * k].map(clamp01);
}
/** The filter's numbers for the shader and the baker (amount 0 for none) */
export function filterParams(fx) {
  const x = fxOf(fx), F = FILTERS[x.filter];
  if (x.filter === 'none') return { amount: 0, sat: 1, con: 1, sh: [0, 0, 0], hi: [0, 0, 0], fade: 0, mono: 0 };
  return { amount: x.amount, sat: F.sat, con: F.con, sh: F.sh, hi: F.hi, fade: F.fade, mono: F.mono };
}
/** One colour through the filter (mirrored by GLSL_FILTER) */
export function applyFilter([r, g, b], P) {
  if (!P || !(P.amount > 0)) return [r, g, b];
  const y0 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let c = [r, g, b].map((v) => y0 + (v - y0) * (1 - P.mono));
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  c = c.map((v) => y + (v - y) * P.sat).map((v) => (v - 0.5) * P.con + 0.5);
  const t = clamp01(y), w = t * t * (3 - 2 * t); // highlights weight
  c = c.map((v, i) => v + P.sh[i] * (1 - w) + P.hi[i] * w).map((v) => P.fade + clamp01(v) * (1 - P.fade));
  return [r, g, b].map((v, i) => clamp01(v + (c[i] - v) * P.amount));
}

export function bakeExport({ look, hlg, strength, tweaks, fx = null }) {
  const P = filterParams(fx), X = fxOf(fx);
  const size = look.size;
  const out = new Float32Array(size * size * size * 3);
  const d = size - 1;
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const node = [r / d, g / d, b / d];
    const x = hlg ? sampleCube(hlg, node) : node;
    const l = sampleCube(look, x);
    const m = [0, 1, 2].map((c) => l[c] * strength + x[c] * (1 - strength));
    const t = applyFilter(applyTone(tweak(m, tweaks), X.shadows, X.highlights), P);
    out[i++] = t[0]; out[i++] = t[1]; out[i++] = t[2];
  }
  return { size, data: out };
}

// Must mirror tweak() above exactly (used by the preview shader).
export const GLSL_TWEAK = `
vec3 lookTweak(vec3 c, float exposure, float temp, float sat) {
  c = clamp(c, 0.0, 1.0);
  vec3 lin = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  lin = max(lin * pow(2.0, exposure * 2.0), 0.0);
  c = clamp(mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), lin)), 0.0, 1.0);
  c = clamp(c + vec3(temp * 0.06, 0.0, -temp * 0.06), 0.0, 1.0);
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return clamp(vec3(y) + (c - vec3(y)) * (1.0 + sat), 0.0, 1.0);
}
`;

// Must mirror applyFilter() above exactly (used by the preview shader).
export const GLSL_FILTER = `
uniform float u_famt, u_fsat, u_fcon, u_ffade, u_fmono, u_tsh, u_thi; uniform vec3 u_fsh, u_fhi;
vec3 lookTone(vec3 c) {
  if (u_tsh <= 0.0 && u_thi <= 0.0) return c;
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (y <= 0.0) return c;
  float t = clamp((y - 0.7) / 0.3, 0.0, 1.0), knee = t * t * (3.0 - 2.0 * t);
  float y2 = clamp(y + 3.4 * u_tsh * y * (1.0 - y) * (1.0 - y) * (1.0 - y) - 0.15 * u_thi * y * knee, 0.0, 1.0);
  return clamp(c * (y2 / y), 0.0, 1.0);
}
vec3 lookFilter(vec3 c0) {
  if (u_famt <= 0.0) return c0;
  vec3 L = vec3(0.2126, 0.7152, 0.0722);
  vec3 c = mix(c0, vec3(dot(c0, L)), u_fmono);
  float y = dot(c, L);
  c = (vec3(y) + (c - vec3(y)) * u_fsat - 0.5) * u_fcon + 0.5;
  float t = clamp(y, 0.0, 1.0), w = t * t * (3.0 - 2.0 * t);
  c = u_ffade + clamp(c + u_fsh * (1.0 - w) + u_fhi * w, 0.0, 1.0) * (1.0 - u_ffade);
  return clamp(c0 + (c - c0) * u_famt, 0.0, 1.0);
}
// Vignette (darkens the corners, 0..1) and film grain (luma noise per frame, 0..1): the export draws the same
float vignetteAt(vec2 uv, float amt) {
  float d = length(uv - 0.5) * 1.4142;
  float t = clamp((d - 0.35) / 0.6, 0.0, 1.0);
  return 1.0 - amt * 0.6 * t * t * (3.0 - 2.0 * t);
}
float grainAt(vec2 px, float seed) { return fract(sin(dot(px + seed, vec2(12.9898, 78.233))) * 43758.5453) - 0.5; }
`;
