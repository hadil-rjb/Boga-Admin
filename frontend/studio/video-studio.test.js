import { describe, it, expect } from 'vitest';
import { railFor, inspectorRoute, railTab, SOON, takesOver } from './video-studio.js';

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
  it('only videos open in the shell for now', () => {
    expect(takesOver({ footage: { src: 'a' } })).toBe(true);
    expect(takesOver({ motion: {} })).toBe(false);
    expect(takesOver({ pages: [] })).toBe(false);
    expect(takesOver(null)).toBe(false);
  });
});
