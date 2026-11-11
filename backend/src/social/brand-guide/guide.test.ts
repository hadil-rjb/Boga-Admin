import { describe, expect, it } from 'vitest';
import { tidyDesign } from './guide';

describe('tidyDesign', () => {
  it('trims and cuts what the guide says about design, and tolerates a missing object', () => {
    const d = tidyDesign({ layout: '  12 columns ', imagery: 'x'.repeat(900), logoUse: '', typography: 'Headlines in caps', rules: [{ text: ' Never stretch the logo ', kind: 'dont' }, { text: '  ', kind: 'do' }, ...Array.from({ length: 20 }, (_, i) => ({ text: 'R' + i, kind: 'do' as const }))] });
    expect(d.layout).toBe('12 columns');
    expect(d.imagery).toHaveLength(400);
    expect(d.rules[0]).toEqual({ text: 'Never stretch the logo', kind: 'dont' });
    expect(d.rules).toHaveLength(12);
    expect(tidyDesign(undefined)).toEqual({ layout: '', imagery: '', logoUse: '', typography: '', rules: [] });
  });
});
