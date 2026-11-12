import { describe, it, expect } from 'vitest';
import { inspectorRoute, SOON, takesOver, handsBack, modeOf, railFor, isFoot, subsOf, itemOf, panelFor, propTabs, switchState, keysOn, isDocTab, docToggle, DOC_TABS, kindTag, exportLabel, clock } from './video-studio.js';
import { stillSource } from './still-source.js';
import { kindOf } from './caption-store.js';
import { installReelSource, captionBlocks } from './reel-source.js';



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


describe('panels without content yet', () => {
  it('say what they will do in one sentence, never "Coming soon"', () => {
    for (const k of ['scenes', 'styles', 'script', 'audio', 'captions']) {
      expect(SOON[k]).toMatch(/^[A-Z].*\.$/);
      expect(SOON[k].split(/\.\s/)).toHaveLength(1);
      expect(SOON[k]).not.toMatch(/coming soon/i);
    }
    expect(SOON.styles).toMatch(/^Caption style presets/);
  });
});

describe('takesOver', () => {
  it('every design opens in the shell: videos, reels and stills', () => {
    expect(takesOver({ footage: { src: 'a' } })).toBe(true);
    expect(takesOver({ motion: {} })).toBe(true);
    expect(takesOver({ pages: [] })).toBe(true);
    expect(takesOver(null)).toBe(false);
  });
});

describe('handsBack', () => {
  it('no source: the editor draws everything', () => {
    expect(handsBack(null, 'nativeRail')).toBe(true);
    expect(handsBack(undefined, 'nativePages')).toBe(true);
  });
  it('a still hands only its bottom area back to the editor', () => {
    const S = stillSource();
    expect(handsBack(S, 'nativeRail')).toBe(false);
    expect(handsBack(S, 'nativePages')).toBe(true);
  });
  it('a source without the flag lets the shell draw (reels and videos as before)', () => {
    expect(handsBack({ player: {} }, 'nativeRail')).toBe(false);
    expect(handsBack({ player: {} }, 'nativePages')).toBe(false);
  });
});

describe('rail icons', () => {
  it('every item of a rail has its own icon (Brand keeps the palette)', () => {
    for (const [k, m] of [['still', 'design'], ['reel', 'animate'], ['video', 'animate']]) {
      const icons = railFor(k, m).map((r) => r[2]);
      expect(new Set(icons).size).toBe(icons.length);
    }
    expect(Object.fromEntries(railFor('still', 'design').map(([k, , i]) => [k, i])).brand).toBe('palette');
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
    for (const k of ['animation', 'scenes', 'audio', 'templates', 'elements', 'text', 'uploads', 'figma', 'brand', 'data', 'comps', 'agent']) expect(src.nativePanel(k)).toBe(true);
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


describe('modeOf', () => {
  it('a still is always Design, a video always Animate', () => {
    expect(modeOf('still')).toBe('design'); expect(modeOf('still', 'animate')).toBe('design');
    expect(modeOf('video')).toBe('animate'); expect(modeOf('video', 'design')).toBe('animate');
  });
  it('a reel opens in Animate and follows the user', () => {
    expect(modeOf('reel')).toBe('animate'); expect(modeOf('reel', 'design')).toBe('design'); expect(modeOf('reel', 'animate')).toBe('animate');
  });
});
describe('railFor', () => {
  const keys = (k, m) => railFor(k, m).map((r) => r[0]), labels = (k, m) => railFor(k, m).map((r) => r[1]);
  it('Design: the nine design tools, Agent last', () => {
    expect(labels('still', 'design')).toEqual(['Templates', 'Elements', 'Text', 'Uploads', 'Figma', 'Brand', 'Live data', 'Components', 'Agent']);
    expect(keys('reel', 'design')).toEqual(keys('still', 'design'));
    expect(isFoot('agent')).toBe(true); expect(isFoot('templates')).toBe(false);
  });
  it('Animate on a reel: Animation, Audio, Scenes, Captions, then the Agent pinned at the bottom', () => {
    expect(labels('reel', 'animate')).toEqual(['Animation', 'Audio', 'Scenes', 'Captions', 'Agent']);
    expect(keys('reel', 'animate')).toEqual(['animation', 'audio', 'scenes', 'captions', 'agent']);
    expect(isFoot('agent')).toBe(true);
  });
  it('gives a video the Agent, pinned at the bottom', () => { expect(keys('video', 'animate')).toEqual(['scenes', 'audio', 'captions', 'agent']); expect(panelFor('video', 'animate', 'agent')).toEqual({ mode: 'animate', tab: 'agent' }); });
  it('an uploaded video: Scenes, Audio, Captions, whatever mode is asked', () => {
    expect(labels('video', 'animate')).toEqual(['Scenes', 'Audio', 'Captions', 'Agent']);
    expect(labels('video', 'design')).toEqual(['Scenes', 'Audio', 'Captions', 'Agent']);
  });
  it('no design tool in Animate and no video tool in Design', () => {
    const d = new Set(keys('reel', 'design')), a = keys('reel', 'animate');
    expect(a.filter((k) => d.has(k))).toEqual(['agent']); // the agent works in both modes
  });
  it('returns fresh copies', () => { railFor('still', 'design')[0][1] = 'x'; expect(railFor('still', 'design')[0][1]).toBe('Templates'); });
});
describe('subsOf and itemOf', () => {
  it('only Captions has sub-tabs: Lines, Styles, Script', () => {
    expect(subsOf('captions')).toEqual([['captions', 'Lines'], ['styles', 'Styles'], ['script', 'Script']]);
    ['templates', 'elements', 'uploads', 'audio', 'scenes', 'animation', 'agent'].forEach((k) => expect(subsOf(k)).toEqual([]));
  });
  it('Styles and Script light Captions', () => {
    expect(itemOf('styles')).toBe('captions'); expect(itemOf('script')).toBe('captions'); expect(itemOf('audio')).toBe('audio');
  });
});
describe('panelFor', () => {
  it('a still never leaves Design: video keys open Templates, media opens Uploads', () => {
    ['scenes', 'audio', 'captions', 'animation', 'motion', 'look', 'nope', undefined].forEach((k) => expect(panelFor('still', 'design', k)).toEqual({ mode: 'design', tab: 'templates' }));
    expect(panelFor('still', 'design', 'media')).toEqual({ mode: 'design', tab: 'uploads' });
    expect(panelFor('still', 'design', 'figma')).toEqual({ mode: 'design', tab: 'figma' });
  });
  it('a video keeps its three items; media, look and design keys open Scenes', () => {
    ['media', 'look', 'motion', 'templates', 'brand', 'animation', undefined].forEach((k) => expect(panelFor('video', 'animate', k)).toEqual({ mode: 'animate', tab: 'scenes' }));
    ['audio', 'captions', 'styles', 'script'].forEach((k) => expect(panelFor('video', 'animate', k)).toEqual({ mode: 'animate', tab: k }));
  });
  it('a reel: a key of the other mode switches mode', () => {
    expect(panelFor('reel', 'animate', 'text')).toEqual({ mode: 'design', tab: 'text' });
    expect(panelFor('reel', 'design', 'audio')).toEqual({ mode: 'animate', tab: 'audio' });
    expect(panelFor('reel', 'design', 'styles')).toEqual({ mode: 'animate', tab: 'styles' });
  });
  it('keeps the agent in the mode the reel is in', () => {
    expect(panelFor('reel', 'animate', 'agent')).toEqual({ mode: 'animate', tab: 'agent' });
    expect(panelFor('reel', 'design', 'agent')).toEqual({ mode: 'design', tab: 'agent' });
    expect(panelFor('still', 'design', 'agent')).toEqual({ mode: 'design', tab: 'agent' });
  });
  it('a reel: old keys', () => {
    expect(panelFor('reel', 'design', 'motion')).toEqual({ mode: 'animate', tab: 'scenes' });
    expect(panelFor('reel', 'animate', 'look')).toEqual({ mode: 'animate', tab: 'scenes' });
    expect(panelFor('reel', 'animate', 'media')).toEqual({ mode: 'design', tab: 'uploads' });
  });
  it('a reel: an unknown key opens the first item of the current mode', () => {
    expect(panelFor('reel', 'animate', 'nope')).toEqual({ mode: 'animate', tab: 'animation' });
    expect(panelFor('reel', 'design', 'nope')).toEqual({ mode: 'design', tab: 'templates' });
  });
  it('every resolved tab is on the rail of the resolved mode', () => {
    const all = ['templates', 'elements', 'text', 'uploads', 'figma', 'brand', 'data', 'comps', 'agent', 'animation', 'audio', 'scenes', 'captions', 'styles', 'script', 'media', 'motion', 'look'];
    for (const kind of ['still', 'reel', 'video']) for (const mode of ['design', 'animate']) for (const k of all) {
      const r = panelFor(kind, modeOf(kind, mode), k);
      expect(railFor(kind, r.mode).map((x) => x[0])).toContain(itemOf(r.tab));
    }
  });
});
describe('inspector tabs', () => {
  it('Design mode: Design, Layers; Animate mode: Animate, Layers', () => {
    expect(propTabs('design', 'design').map((t) => t[1])).toEqual(['Design', 'Layers']);
    expect(propTabs('animate', 'animate').map((t) => t[1])).toEqual(['Animate', 'Layers']);
  });
  it('light one tab; a tab the mode lacks lights the first', () => {
    expect(propTabs('design', 'animate').filter((t) => t[2]).map((t) => t[0])).toEqual(['design']);
    expect(propTabs('animate', 'design').filter((t) => t[2]).map((t) => t[0])).toEqual(['animate']);
    expect(propTabs('animate', 'layers').filter((t) => t[2]).map((t) => t[0])).toEqual(['layers']);
  });
});
describe('the mode switch', () => {
  it('a video has none', () => { expect(switchState('video', 'animate', true)).toBe(null); });
  it('a still can be animated only by someone who can edit', () => {
    expect(switchState('still', 'design', true)).toEqual({ mode: 'design', canAnimate: true });
    expect(switchState('still', 'design', false)).toEqual({ mode: 'design', canAnimate: false });
  });
  it('a reel switches for everyone', () => { expect(switchState('reel', 'animate', false)).toEqual({ mode: 'animate', canAnimate: true }); });
  it('transport keys only in Animate', () => { expect(keysOn('animate')).toBe(true); expect(keysOn('design')).toBe(false); });
});

describe('inspectorRoute on a still', () => {
  it('always the editor properties, whatever panel is open', () => {
    expect(inspectorRoute(null, 'still', 'captions')).toBe('scene');
    expect(inspectorRoute({ kind: 'video' }, 'still')).toBe('scene');
  });
});

describe('document tabs', () => {
  it('History and Comments are document tabs, opened and closed from the top bar', () => {
    expect(isDocTab('history')).toBe(true);
    expect(isDocTab('comments')).toBe(true);
    expect(isDocTab('design')).toBe(false);
    expect(isDocTab('toString')).toBe(false);
    expect(Object.values(DOC_TABS)).toEqual(['History', 'Comments']);
    expect(docToggle('design', 'history')).toBe('history');
    expect(docToggle('history', 'history')).toBe('design');
    expect(docToggle('comments', 'history')).toBe('history');
  });
});

describe('kind tag and Export label', () => {
  it('a still says Post, or Carousel with its page count', () => {
    expect(kindTag('still', { pages: 1 })).toBe('Post');
    expect(kindTag('still')).toBe('Post');
    expect(kindTag('still', { pages: 3 })).toBe('Carousel · 3 pages');
  });
  it('a reel or a video says Video with its length once known', () => {
    expect(kindTag('reel', { ms: 11500 })).toBe('Video · 0:11.5');
    expect(kindTag('video', { ms: 163000 })).toBe('Video · 2:43');
    expect(kindTag('video', { ms: 0 })).toBe('Video');
    expect(kindTag('reel')).toBe('Video');
  });
  it('clock matches the transport (m:ss.t), without a trailing .0', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(59400)).toBe('0:59.4');
    expect(clock(11549)).toBe('0:11.5');
    expect(clock(600000)).toBe('10:00');
    expect(clock(-5)).toBe('0:00');
    expect(clock(undefined)).toBe('0:00');
  });
  it('Export says what comes out', () => {
    expect(exportLabel('still')).toBe('Export');
    expect(exportLabel('reel')).toBe('Export video');
    expect(exportLabel('video')).toBe('Export video');
  });
});
