import { describe, it, expect } from 'vitest';
import { railFor, inspectorRoute, railTab, SOON, takesOver } from './video-studio.js';
import { kindOf } from './caption-store.js';
import { installReelSource, captionBlocks } from './reel-source.js';

const keys = (kind) => railFor(kind).map((r) => r[0]);

describe('railFor', () => {
  it('video: media, captions, styles, script, audio, look, agent in that order', () => {
    expect(keys('video')).toEqual(['media', 'captions', 'styles', 'script', 'audio', 'look', 'agent']);
  });
  it('every item is [key, label, icon] with a label and an icon', () => {
    for (const kind of ['video', 'reel']) for (const r of railFor(kind)) {
      expect(r).toHaveLength(3);
      expect(typeof r[1]).toBe('string'); expect(r[1].length).toBeGreaterThan(0);
      expect(typeof r[2]).toBe('string'); expect(r[2].length).toBeGreaterThan(0);
    }
  });
  it('reel: starts with templates, motion, then captions; no look or media', () => {
    const k = keys('reel');
    expect(k.slice(0, 3)).toEqual(['templates', 'motion', 'captions']);
    expect(k).toEqual(['templates', 'motion', 'captions', 'styles', 'script', 'audio', 'elements', 'text', 'uploads', 'brand', 'figma', 'data', 'comps', 'agent']);
    expect(k).not.toContain('look');
    expect(k).not.toContain('media');
  });
  it('reel keeps the existing RAIL keys and icons so their panels still work', () => {
    const r = Object.fromEntries(railFor('reel').map(([k, , i]) => [k, i]));
    expect(r).toMatchObject({ templates: 'layout', motion: 'film37', audio: 'music38', elements: 'shapes', text: 'type', uploads: 'upload', figma: 'figma', brand: 'palette', data: 'chart', comps: 'comp33', agent: 'studio' });
  });
  it('returns a fresh list (callers may not corrupt it) and an empty one for stills', () => {
    railFor('video').pop();
    expect(keys('video')).toHaveLength(7);
    expect(railFor('still')).toEqual([]);
  });
});

describe('inspectorRoute', () => {
  it('a caption goes to the caption tabs host', () => {
    expect(inspectorRoute({ kind: 'caption', id: 'l1' }, 'video')).toBe('caption');
    expect(inspectorRoute({ kind: 'caption', id: 'l1' }, 'reel')).toBe('caption');
  });
  it('the video track goes to the source inspector', () => {
    expect(inspectorRoute({ kind: 'video' }, 'video')).toBe('source');
  });
  it('a scene goes to the scene properties', () => {
    expect(inspectorRoute({ kind: 'scene', i: 2 }, 'reel')).toBe('scene');
  });
  it('nothing selected: the source inspector for a video, the scene properties for a reel', () => {
    expect(inspectorRoute(null, 'video')).toBe('source');
    expect(inspectorRoute(undefined, 'reel')).toBe('scene');
    expect(inspectorRoute({ kind: 'nope' }, 'video')).toBe('source');
  });
  it('nothing selected while Captions or Styles is open: the caption tabs', () => {
    expect(inspectorRoute(null, 'video', 'captions')).toBe('caption');
    expect(inspectorRoute(null, 'reel', 'styles')).toBe('caption');
    expect(inspectorRoute(null, 'video', 'look')).toBe('source');
    expect(inspectorRoute({ kind: 'video' }, 'video', 'captions')).toBe('source');
  });
});

describe('railTab', () => {
  it('keeps a tab the rail has, else captions', () => {
    expect(railTab('video', 'look')).toBe('look');
    expect(railTab('video', 'templates')).toBe('captions');
    expect(railTab('video', undefined)).toBe('captions');
    expect(railTab('reel', 'motion')).toBe('motion');
  });
});

describe('panels without content yet', () => {
  it('say what they will do in one sentence, never "Coming soon"', () => {
    for (const k of ['media', 'styles', 'script', 'audio', 'look', 'captions']) {
      expect(SOON[k]).toMatch(/^[A-Z].*\.$/);
      expect(SOON[k].split(/\.\s/)).toHaveLength(1);
      expect(SOON[k]).not.toMatch(/coming soon/i);
    }
    expect(SOON.styles).toMatch(/^Caption style presets/);
  });
});

describe('takesOver', () => {
  it('videos and reels open in the shell, stills keep the editor', () => {
    expect(takesOver({ footage: { src: 'a' } })).toBe(true);
    expect(takesOver({ motion: {} })).toBe(true);
    expect(takesOver({ pages: [] })).toBe(false);
    expect(takesOver(null)).toBe(false);
  });
});

describe('the styles rail item', () => {
  it('has its own icon (Brand keeps the palette)', () => {
    for (const kind of ['video', 'reel']) {
      const r = Object.fromEntries(railFor(kind).map(([k, , i]) => [k, i]));
      expect(r.styles).not.toBe('palette');
    }
  });
});

/* ---------- the reel source ---------- */
const scene = (dur, vo) => ({ id: 'p' + dur, layers: [], scene: { k: 'body', dur, tr: 'cut', trd: 400, ...(vo ? { vo } : {}) } });
const reel = (extra = {}) => ({ motion: { fmt: 'reel', fps: 30 }, ratio: '9:16', pages: [scene(3000), scene(2000)], ...extra });
/** A fake shell and motion editor: the source registers on VS, the motion closure gives the scene and audio html */
function fakeReel(d, layers = []) {
  const reg = {};
  const VS = { register: (k, s) => { reg[k] = s; }, reset() {}, refresh() {}, tick() {}, select() {} };
  const M = {
    player: { toggle() {}, play() {}, pause() {}, seek() {}, time: () => 0, duration: () => 5000, playing: () => false },
    scenesHTML: () => '<i>scenes</i>', clipsHTML: () => ({ music: '<i>music</i>', voice: '<i>voice</i>' }),
    layers: () => layers, loop: () => false, fit() {},
  };
  const src = installReelSource({ ED: { d }, ACT: {}, VS, M, ic: (n) => `<${n}>`, esc: (x) => String(x), canEdit: () => true, mutate: (f) => f(), save() {} });
  return { reg, src };
}

describe('reel source', () => {
  it('a motion design with 2 scenes is a reel, and its tracks are scenes, captions, voice, music in that order', () => {
    const d = reel();
    expect(kindOf(d)).toBe('reel');
    const { reg, src } = fakeReel(d);
    expect(reg.reel).toBe(src);
    expect(src.tracks().map((t) => t.id)).toEqual(['scenes', 'captions', 'voice', 'music']);
  });
  it('draws the scenes and the audio clips from the motion editor', () => {
    const { src } = fakeReel(reel());
    const html = Object.fromEntries(src.tracks().filter((t) => t.html).map((t) => [t.id, t.html(40)]));
    expect(html).toMatchObject({ scenes: '<i>scenes</i>', voice: '<i>voice</i>', music: '<i>music</i>' });
  });
  it('the player is the motion editor\'s', () => {
    const { src } = fakeReel(reel());
    for (const k of ['toggle', 'play', 'pause', 'seek', 'time', 'duration', 'playing']) expect(typeof src.player[k]).toBe('function');
  });
  it('layer lanes come below the scenes behind a Layers row, collapsed by default', () => {
    const ly = [{ id: 'a', name: 'Title', type: 'text', html: () => '<i>a</i>' }];
    const { src } = fakeReel(reel(), ly);
    const ids = src.tracks().map((t) => t.id);
    expect(ids).toEqual(['scenes', 'captions', 'voice', 'music', 'layers']);
    const L = src.tracks()[4];
    expect(L.toggle).toBe('fold'); expect(L.open).toBe(false);
  });
  it('captions, styles and script are the shell\'s; the reel\'s own panels stay the editor\'s', () => {
    const { src } = fakeReel(reel());
    for (const k of ['captions', 'styles', 'script']) expect(src.nativePanel(k)).toBe(false);
    for (const k of ['templates', 'motion', 'audio', 'elements', 'text', 'uploads', 'figma', 'brand', 'data', 'comps', 'agent']) expect(src.nativePanel(k)).toBe(true);
  });
  it('the captions track holds draggable blocks (the voice-over lines), voice and music mute the preview', () => {
    const d = reel(); d.pages[0].scene.vo = { text: 'Hello there', src: 'a.mp3', dur: 1000 };
    const ts = fakeReel(d).src.tracks();
    expect(ts[1].blocks.map((b) => b.text)).toEqual(['Hello there']);
    expect(ts[1].blocks[0].start).toBe(150);
    expect(ts[2].toggle).toBe('mute'); expect(ts[3].toggle).toBe('mute');
  });
  it('voice and music mutes are session state: the track shows muted, the design is untouched', () => {
    const d = reel(), { src } = fakeReel(d);
    src.onToggle('music');
    expect(src.tracks()[3].hidden).toBe(true); expect(src.tracks()[2].hidden).toBe(false);
    expect(d.audio).toBeUndefined();
  });
  it('the captions track follows the audio captions switch', () => {
    expect(fakeReel(reel()).src.tracks()[1].hidden).toBe(true);
    expect(fakeReel(reel({ audio: { captions: true } })).src.tracks()[1].hidden).toBe(false);
  });
});

describe('captionBlocks', () => {
  it('one block per scene with a voice-over line: the clip (plus its tail) inside its scene, or the whole scene without a clip', () => {
    const d = reel(); d.pages[0].scene.vo = { text: 'Hello there', src: 'a.mp3', dur: 1000 }; d.pages[1].scene.vo = { text: ' Bye ' };
    expect(captionBlocks(d)).toEqual([{ i: 0, start: 150, end: 1550, text: 'Hello there' }, { i: 1, start: 3000, end: 5000, text: 'Bye' }]);
  });
  it('no line, no block', () => {
    expect(captionBlocks(reel())).toEqual([]);
  });
});
