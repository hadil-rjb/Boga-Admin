// Caption style presets, grouped by category. Pure ESM; each style is a partial CaptionStyle
// (merged over the current style by applyPreset, then filled by withDefaults).
import { DEFAULT_STYLE, withDefaults } from './captions.js';

export const CATEGORIES = [
  { id: 'viral', name: 'Bold and viral' },
  { id: 'karaoke', name: 'Karaoke' },
  { id: 'clean', name: 'Clean' },
  { id: 'cinematic', name: 'Cinematic' },
  { id: 'boxed', name: 'Boxed' },
  { id: 'neon', name: 'Neon' },
  { id: 'arabic', name: 'Arabic' },
];

const stroke = (color, width) => ({ color, width });
const shadow = (color, blur = 0.008, y = 0.003) => ({ color, blur, y });
const hl = (mode, color, text = '#1A1A1A', radius = 0.18) => ({ mode, color, text, radius });
const box = (color, radius = 0.2, pad = 0.3) => ({ color, radius, pad });
const P = (id, name, cat, style) => ({ id, name, cat, style });

const SOFT = shadow('rgba(0,0,0,.55)', 0.006, 0.002);
const AR = { lh: 1.3, case: 'none' };

export const PRESETS = [
  // Bold and viral
  P('viral-impact', 'Impact', 'viral', { font: 'display', size: 0.06, weight: 900, case: 'upper', color: '#FFFFFF', stroke: stroke('#000000', 0.014), shadow: shadow('rgba(0,0,0,.7)'), anim: 'pop', maxWords: 2, highlight: hl('color', '#FFE600') }),
  P('viral-yellow', 'Yellow punch', 'viral', { font: 'sans-bold', size: 0.058, weight: 900, case: 'upper', color: '#FFE600', stroke: stroke('#000000', 0.014), shadow: shadow('rgba(0,0,0,.7)'), anim: 'bounce', maxWords: 2, highlight: hl('color', '#FFFFFF') }),
  P('viral-red', 'Red alert', 'viral', { font: 'display', size: 0.06, weight: 900, case: 'upper', color: '#FFFFFF', stroke: stroke('#E11D1D', 0.016), shadow: shadow('rgba(0,0,0,.65)'), anim: 'pop', maxWords: 2, highlight: hl('color', '#FFE600') }),
  P('viral-green', 'Green pop', 'viral', { font: 'sans-bold', size: 0.056, weight: 900, case: 'upper', color: '#B6FF3B', stroke: stroke('#0B2A00', 0.014), shadow: shadow('rgba(0,0,0,.65)'), anim: 'bounce', maxWords: 2, highlight: hl('color', '#FFFFFF') }),
  P('viral-stack', 'Big stack', 'viral', { font: 'display', size: 0.07, weight: 900, case: 'upper', color: '#FFFFFF', stroke: stroke('#000000', 0.016), shadow: shadow('rgba(0,0,0,.7)'), anim: 'pop', maxWords: 3, maxChars: 16, lines: 2, lh: 1.05, highlight: hl('scale', '#FFE600') }),
  // Karaoke
  P('karaoke-gold', 'Gold box', 'karaoke', { font: 'sans-bold', size: 0.05, weight: 800, color: '#FFFFFF', stroke: null, shadow: SOFT, anim: 'karaoke', maxWords: 4, highlight: hl('box', '#E8B54A', '#1A1A1A') }),
  P('karaoke-pink', 'Pink box', 'karaoke', { font: 'sans-bold', size: 0.05, weight: 800, color: '#FFFFFF', stroke: null, shadow: SOFT, anim: 'karaoke', maxWords: 4, highlight: hl('box', '#FF2E88', '#FFFFFF') }),
  P('karaoke-blue', 'Blue box', 'karaoke', { font: 'sans-bold', size: 0.05, weight: 800, color: '#FFFFFF', stroke: null, shadow: SOFT, anim: 'karaoke', maxWords: 4, highlight: hl('box', '#2F6BFF', '#FFFFFF') }),
  P('karaoke-yellow', 'Yellow text', 'karaoke', { font: 'sans-bold', size: 0.052, weight: 900, color: '#FFFFFF', stroke: stroke('#000000', 0.012), shadow: shadow('rgba(0,0,0,.6)'), anim: 'karaoke', maxWords: 4, highlight: hl('color', '#FFE600') }),
  P('karaoke-mint', 'Mint text', 'karaoke', { font: 'sans', size: 0.05, weight: 800, color: '#FFFFFF', stroke: null, shadow: SOFT, anim: 'karaoke', maxWords: 4, highlight: hl('color', '#3DF2B5') }),
  P('karaoke-scale', 'Scale up', 'karaoke', { font: 'sans-bold', size: 0.05, weight: 900, case: 'upper', color: '#FFFFFF', stroke: stroke('#000000', 0.012), shadow: shadow('rgba(0,0,0,.6)'), anim: 'karaoke', maxWords: 3, highlight: hl('scale', '#FFE600') }),
  // Clean
  P('clean-white', 'White', 'clean', { font: 'sans', size: 0.045, weight: 700, color: '#FFFFFF', stroke: null, shadow: SOFT, anim: 'fade' }),
  P('clean-bold', 'Bold white', 'clean', { font: 'sans-bold', size: 0.048, weight: 800, color: '#FFFFFF', stroke: null, shadow: shadow('rgba(0,0,0,.75)', 0.008, 0.003), anim: 'none' }),
  P('clean-dark', 'Dark text', 'clean', { font: 'sans', size: 0.045, weight: 700, color: '#111111', stroke: null, shadow: shadow('rgba(255,255,255,.5)', 0.006, 0.001), anim: 'fade', highlight: hl('none', '#111111') }),
  P('clean-two-line', 'Two lines', 'clean', { font: 'sans', size: 0.042, weight: 600, color: '#FFFFFF', stroke: null, shadow: SOFT, anim: 'fade', maxWords: 6, maxChars: 34, lines: 2, lh: 1.2 }),
  P('clean-slide', 'Slide in', 'clean', { font: 'sans', size: 0.045, weight: 700, color: '#FFFFFF', stroke: null, shadow: SOFT, anim: 'slide' }),
  // Cinematic
  P('cine-serif', 'Serif', 'cinematic', { font: 'serif', size: 0.04, weight: 400, color: '#F5F1E8', stroke: null, shadow: shadow('rgba(0,0,0,.6)', 0.008, 0.002), y: 0.86, anim: 'fade', maxWords: 6, maxChars: 34 }),
  P('cine-upper', 'Wide caps', 'cinematic', { font: 'serif', size: 0.034, weight: 400, case: 'upper', ls: 0.12, color: '#F5F1E8', stroke: null, shadow: shadow('rgba(0,0,0,.6)', 0.008, 0.002), y: 0.87, anim: 'fade', maxWords: 6, maxChars: 34 }),
  P('cine-gold', 'Gold serif', 'cinematic', { font: 'serif', size: 0.042, weight: 700, color: '#E8C77A', stroke: null, shadow: shadow('rgba(0,0,0,.7)', 0.01, 0.003), y: 0.85, anim: 'fade', maxWords: 5, maxChars: 30 }),
  P('cine-typewriter', 'Typewriter', 'cinematic', { font: 'serif', size: 0.038, weight: 400, color: '#F5F1E8', stroke: null, shadow: shadow('rgba(0,0,0,.6)', 0.008, 0.002), y: 0.86, anim: 'typewriter', maxWords: 6, maxChars: 34 }),
  // Boxed
  P('box-black', 'Black box', 'boxed', { font: 'sans-bold', size: 0.045, weight: 800, color: '#FFFFFF', stroke: null, shadow: null, box: box('#000000'), boxOpacity: 0.75, anim: 'none' }),
  P('box-white', 'White box', 'boxed', { font: 'sans-bold', size: 0.045, weight: 800, color: '#111111', stroke: null, shadow: null, box: box('#FFFFFF'), boxOpacity: 0.95, anim: 'pop', highlight: hl('none', '#111111') }),
  P('box-yellow', 'Yellow box', 'boxed', { font: 'sans-bold', size: 0.048, weight: 900, color: '#111111', stroke: null, shadow: null, box: box('#FFE600', 0.15), anim: 'pop', highlight: hl('none', '#111111') }),
  P('box-pill', 'Pill', 'boxed', { font: 'sans', size: 0.042, weight: 700, color: '#FFFFFF', stroke: null, shadow: null, box: box('#1F1F1F', 0.5, 0.4), boxOpacity: 0.85, anim: 'fade' }),
  // Neon
  P('neon-cyan', 'Cyan glow', 'neon', { font: 'sans-bold', size: 0.05, weight: 800, color: '#7DF9FF', stroke: stroke('#00E5FF', 0.003), shadow: shadow('#00E5FF', 0.035, 0), anim: 'fade', highlight: hl('color', '#FFFFFF') }),
  P('neon-pink', 'Pink glow', 'neon', { font: 'sans-bold', size: 0.05, weight: 800, color: '#FF8AD0', stroke: stroke('#FF2E88', 0.003), shadow: shadow('#FF2E88', 0.035, 0), anim: 'pop', highlight: hl('color', '#FFFFFF') }),
  P('neon-green', 'Green glow', 'neon', { font: 'display', size: 0.054, weight: 800, color: '#B6FF9E', stroke: stroke('#39FF14', 0.003), shadow: shadow('#39FF14', 0.035, 0), anim: 'bounce', highlight: hl('color', '#FFFFFF') }),
  P('neon-purple', 'Purple glow', 'neon', { font: 'sans-bold', size: 0.05, weight: 800, color: '#D9B8FF', stroke: stroke('#A855F7', 0.003), shadow: shadow('#A855F7', 0.035, 0), anim: 'fade', highlight: hl('color', '#FFFFFF') }),
  // Arabic
  P('ar-bold', 'Bold white', 'arabic', { ...AR, font: 'sans-bold', size: 0.05, weight: 800, color: '#FFFFFF', stroke: stroke('#000000', 0.010), shadow: SOFT, anim: 'pop', maxWords: 3 }),
  P('ar-clean', 'Clean', 'arabic', { ...AR, font: 'sans', size: 0.046, weight: 700, color: '#FFFFFF', stroke: null, shadow: SOFT, anim: 'fade', maxWords: 4 }),
  P('ar-karaoke', 'Karaoke gold', 'arabic', { ...AR, font: 'sans-bold', size: 0.05, weight: 800, color: '#FFFFFF', stroke: null, shadow: SOFT, anim: 'karaoke', maxWords: 4, highlight: hl('box', '#E8B54A', '#1A1A1A') }),
  P('ar-yellow', 'Yellow punch', 'arabic', { ...AR, font: 'sans-bold', size: 0.054, weight: 900, color: '#FFE600', stroke: stroke('#000000', 0.012), shadow: shadow('rgba(0,0,0,.65)'), anim: 'bounce', maxWords: 3 }),
  P('ar-box', 'Dark box', 'arabic', { ...AR, font: 'sans-bold', size: 0.046, weight: 800, color: '#FFFFFF', stroke: null, shadow: null, box: box('#000000'), boxOpacity: 0.75, anim: 'none', maxWords: 4 }),
];

export const presetById = (id) => PRESETS.find((p) => p.id === id) || null;

// Applies a preset over the neutral DEFAULT_STYLE so nothing leaks from the previously applied preset.
// Position and timing (y, x, maxWords, offset, minDur, gap) carry over from the current style unless the preset sets them.
const CARRIED = ['y', 'x', 'maxWords', 'offset', 'minDur', 'gap'];
export function applyPreset(style, id) {
  const p = presetById(id);
  if (!p) return withDefaults(style);
  const out = { ...DEFAULT_STYLE, ...p.style };
  for (const k of CARRIED) if (p.style[k] === undefined && style && style[k] !== undefined) out[k] = style[k];
  return withDefaults(out);
}

const w = (t, s, e) => ({ t, s, e });
// A short sample line for previews.
export function sampleLine(lang) {
  const words = lang === 'ar'
    ? [w('أهلا', 0, 500), w('بكم', 500, 1000), w('جميعا', 1000, 1500)]
    : [w('Make', 0, 500), w('it', 500, 1000), w('count', 1000, 1500)];
  return { id: 'sample', start: 0, end: 1500, words };
}
