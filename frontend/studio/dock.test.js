import { describe, it, expect } from 'vitest';
import { dockState, visibleTracks, durLabel } from './dock.js';

describe('dockState', () => {
  it('Design shows pages, Animate shows the timeline', () => {
    expect(dockState('design')).toBe('pages'); expect(dockState('animate')).toBe('timeline'); expect(dockState()).toBe('pages');
  });
});

describe('visibleTracks', () => {
  const t = (id, empty, add) => ({ id, ...(empty ? { empty: true } : {}), ...(add ? { add } : {}) });
  it('keeps tracks with content in order and offers the empty ones', () => {
    const { keep, adds } = visibleTracks([t('scenes'), t('captions', true, { label: 'Captions', act: 'edTab', k: 'captions' }),
      t('voice'), t('music', true, { label: 'Music', act: 'au38Open' })]);
    expect(keep.map((x) => x.id)).toEqual(['scenes', 'voice']);
    expect(adds).toEqual([{ id: 'captions', label: 'Captions', act: 'edTab', k: 'captions' }, { id: 'music', label: 'Music', act: 'au38Open' }]);
  });
  it('an empty track without an add just leaves', () => {
    const { keep, adds } = visibleTracks([t('a'), t('b', true)]);
    expect(keep.map((x) => x.id)).toEqual(['a']);
    expect(adds).toEqual([]);
  });
  it('tracks without the flag stay (sources that never mark them work as before)', () => {
    const tracks = [{ id: 'video' }, { id: 'captions', blocks: [] }];
    expect(visibleTracks(tracks).keep).toEqual(tracks);
  });
  it('copes with nothing', () => {
    expect(visibleTracks(undefined)).toEqual({ keep: [], adds: [] });
    expect(visibleTracks([null])).toEqual({ keep: [], adds: [] });
  });
});

describe('durLabel', () => {
  it('seconds, with one decimal only when needed', () => {
    expect(durLabel(5000)).toBe('5 s');
    expect(durLabel(2500)).toBe('2.5 s');
    expect(durLabel(8540)).toBe('8.5 s');
    expect(durLabel(12000)).toBe('12 s');
  });
  it('nothing without a length', () => {
    expect(durLabel(0)).toBe('');
    expect(durLabel(undefined)).toBe('');
    expect(durLabel(-3)).toBe('');
  });
});
