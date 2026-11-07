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

export function migrateCaptions(d) {
  let changed = false;
  const fc = d.footage && d.footage.captions;
  if (fc) {
    if (!d.captions) {
      d.captions = { ...CAPTIONS_DEFAULT, lines: fc.lines || [], style: fc.style || null, preset: null, source: 'speech', lang: fc.lang || null };
    }
    delete d.footage.captions;
    changed = true;
  }
  if (d.motion && d.audio && typeof d.audio.captions === 'boolean') {
    if (!d.captions) d.captions = { ...CAPTIONS_DEFAULT, lines: [], on: d.audio.captions, source: 'voiceover' };
    delete d.audio.captions;
    changed = true;
  }
  return changed;
}

export function styleOf(d) {
  return withDefaults(capsOf(d).style || DEFAULT_STYLE);
}
