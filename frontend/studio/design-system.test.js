import { describe, it, expect } from 'vitest';
import { pickSources, sourceSig, MAX_SOURCES } from './design-system.js';

const tpl = (id, at) => ({ id, name: 'T ' + id, ratio: '4:5', bg: '#000', layers: [], at });
const des = (id, status, at) => ({ id, name: 'D ' + id, ratio: '1:1', status, at, pages: [{ bg: '#fff', layers: [] }] });

describe('pickSources', () => {
  it('takes templates first, newest first, then approved or published designs, never drafts', () => {
    const brand = { templates: [tpl('t1', 1), tpl('t2', 5)] };
    const designs = [des('d1', 'Draft', 9), des('d2', 'Approved', 3), des('d3', 'Scheduled', 8), des('d4', 'Draft', 7)];
    const posts = [{ d: 'd4', status: 'Published' }, { d: 'd3', status: 'Scheduled' }];
    expect(pickSources(brand, designs, posts).map((s) => s.id)).toEqual(['t2', 't1', 'd4', 'd2']);
  });
  it('caps at 12 and returns [] for a brand with nothing to learn from', () => {
    const brand = { templates: Array.from({ length: 20 }, (_, i) => tpl('t' + i, i)) };
    expect(pickSources(brand, [], [])).toHaveLength(MAX_SOURCES);
    expect(pickSources({ templates: [] }, [des('d1', 'Draft', 1)], [])).toEqual([]);
    expect(pickSources({}, undefined, undefined)).toEqual([]);
  });
  it('flags live pages and carries kind, name and ratio', () => {
    const s = pickSources({ templates: [{ ...tpl('t1', 1), live: { kind: 'calendar' } }] }, [], [])[0];
    expect(s).toMatchObject({ kind: 'template', id: 't1', name: 'T t1', ratio: '4:5', live: true });
  });
});
describe('sourceSig', () => {
  it('changes when a source is edited, added or removed', () => {
    const a = [{ id: 't1', at: 1 }, { id: 'd2', at: 3 }];
    expect(sourceSig(a)).toBe('t1:1|d2:3');
    expect(sourceSig([{ id: 't1', at: 2 }, { id: 'd2', at: 3 }])).not.toBe(sourceSig(a));
    expect(sourceSig([])).toBe('');
  });
});
