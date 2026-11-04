import { describe, expect, it } from 'vitest';
import { parseRange } from './footage.range';

describe('parseRange', () => {
  it('parses start-end, start- and suffix ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=10-500', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });
  it('flags unsatisfiable and ignores absent or malformed headers', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=50-10', 100)).toBe('unsatisfiable');
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('items=1-2', 100)).toBeNull();
  });
});
