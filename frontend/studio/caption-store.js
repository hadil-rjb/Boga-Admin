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

export function migrateCaptions(d) {
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
    }
    delete d.audio.captions;
    changed = true;
  }
  return changed;
}

export function styleOf(d) {
  return withDefaults(capsOf(d).style || DEFAULT_STYLE);
}
