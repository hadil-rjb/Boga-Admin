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

export function bakeExport({ look, hlg, strength, tweaks }) {
  const size = look.size;
  const out = new Float32Array(size * size * size * 3);
  const d = size - 1;
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const node = [r / d, g / d, b / d];
    const x = hlg ? sampleCube(hlg, node) : node;
    const l = sampleCube(look, x);
    const m = [0, 1, 2].map((c) => l[c] * strength + x[c] * (1 - strength));
    const t = tweak(m, tweaks);
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
