import { describe, it, expect } from 'vitest';
import { stillSource, installStillSource } from './still-source.js';
import { inspectorRoute } from './video-studio.js';

describe('stillSource', () => {
  it('has no player and no tracks, so the shell draws no transport or timeline', () => {
    const S = stillSource();
    expect(S.player).toBeNull();
    expect(S.tracks()).toEqual([]);
  });
  it('lets the shell draw the rail; hands every panel, the bottom area and the properties back to the editor', () => {
    const S = stillSource();
    expect(S.nativeRail).toBeUndefined();
    expect(S.nativePages).toBe(true);
    expect(S.nativeInspector).toBe(true);
    for (const k of ['templates', 'elements', 'text', 'uploads', 'figma', 'brand', 'data', 'comps', 'motion', 'agent']) expect(S.nativePanel(k)).toBe(true);
    expect(S.inspector).toBeUndefined();
  });
  it('nothing selected on a still routes the inspector to the editor properties', () => {
    expect(inspectorRoute(null, 'still', 'templates')).toBe('scene');
  });
  it('mount and unmount are safe without a stage', () => {
    const S = stillSource();
    expect(() => { S.mount(null); S.unmount(); }).not.toThrow();
  });
  it('returns a fresh object each time', () => {
    expect(stillSource()).not.toBe(stillSource());
  });
});

describe('installStillSource', () => {
  it('registers the still source and touches no DOM', () => {
    const reg = [];
    const S = installStillSource({ VS: { register: (k, s) => reg.push([k, s]) } });
    expect(reg).toHaveLength(1);
    expect(reg[0][0]).toBe('still');
    expect(reg[0][1]).toBe(S);
  });
});
