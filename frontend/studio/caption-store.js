import { withDefaults, DEFAULT_STYLE } from './captions.js';

export const CAPTIONS_DEFAULT = { on: true, lines: [], style: null, preset: null, source: null, lang: null, voSig: null };

export function kindOf(d) {
  if (d && d.footage) return 'video';
  if (d && d.motion) return 'reel';
  return 'still';
}

export function capsOf(d) {
  if (!d.captions) d.captions = { ...CAPTIONS_DEFAULT, lines: [] };
  return d.captions;
}

function pristine(c) {
  return !c || (!(c.lines && c.lines.length) && !c.style && !c.source);
}

/** Width / height of a design's canvas from its ratio ('9:16' or '1920x1080'); a reel is 9:16 when unknown */
function aspectOf(d) {
  const m = String((d && d.ratio) || '').match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/);
  const w = m ? +m[1] : 9, h = m ? +m[2] : 16;
  return w > 0 && h > 0 ? w / h : 9 / 16;
}
/**
 * The look reels had before the caption engine (the old engine.js AU.drawCaption), for saved reels whose captions were on:
 * the brand body font (`font`; no font key follows a brand font, so 'sans-bold' with `family` set to it, null when unknown),
 * 700, white, no stroke or shadow, a rgba(0,0,0,.62) box with 0.55 em side padding and a 0.4 em radius, two lines, no highlight.
 * The old size was 4.6 % of the width; `size` is a share of the height, so it follows the canvas ratio.
 */
export function classicStyle(d, font = null) {
  const a = aspectOf(d), size = Math.round(0.046 * a * 10000) / 10000;
  return {
    ...DEFAULT_STYLE, font: 'sans-bold', family: font || null, size, weight: 700, case: 'none', color: '#FFFFFF',
    stroke: null, shadow: null,
    box: { color: 'rgba(0,0,0,.62)', pad: Math.round(size * 0.275 * 100000) / 100000, radius: 0.4 },
    highlight: { ...DEFAULT_STYLE.highlight, mode: 'none' },
    y: a < 1 ? 0.72 : 0.82, maxWords: 10, maxChars: 48, lines: 2, anim: 'none',
  };
}

/**
 * Moves legacy caption fields onto `d.captions`. `opts.font`: the brand body font, for the classic style a saved reel
 * with captions on keeps (see classicStyle).
 */
export function migrateCaptions(d, opts = {}) {
  let changed = false;
  const fc = d.footage && d.footage.captions;
  if (fc) {
    if (pristine(d.captions)) {
      const lines = fc.lines || [];
      d.captions = { ...CAPTIONS_DEFAULT, ...(d.captions || {}), lines, style: fc.style || null, preset: null, source: lines.length ? 'speech' : null, lang: fc.lang || null };
      if (fc.styleFrom) d.captions.styleFrom = fc.styleFrom;
    }
    delete d.footage.captions;
    changed = true;
  }
  if (d.motion && d.audio && typeof d.audio.captions === 'boolean') {
    if (pristine(d.captions)) {
      d.captions = { ...CAPTIONS_DEFAULT, lines: [], ...(d.captions || {}), on: d.audio.captions, source: 'voiceover' };
      // captions that were on keep their old look; new reels keep today's default
      if (d.audio.captions === true && d.captions.style == null) {
        d.captions.style = classicStyle(d, opts.font); d.captions.preset = null; d.captions.styleFrom = 'classic';
      }
    }
    delete d.audio.captions;
    changed = true;
  }
  return changed;
}

export function styleOf(d) {
  return withDefaults(capsOf(d).style || DEFAULT_STYLE);
}
