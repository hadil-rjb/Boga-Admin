import { describe, expect, it } from 'vitest';
import { keepDesignSystem } from './keep';

describe('keepDesignSystem', () => {
  const stored = { summary: 'Dark and bold.', v: 1 };
  it('keeps the stored system when the incoming kit has no designSystem key', () => {
    expect(keepDesignSystem({ name: 'B' }, stored)).toEqual({ name: 'B', designSystem: stored });
  });
  it('lets an incoming system win, including null', () => {
    const fresh = { summary: 'New.' };
    expect(keepDesignSystem({ name: 'B', designSystem: fresh }, stored)).toEqual({ name: 'B', designSystem: fresh });
    expect(keepDesignSystem({ name: 'B', designSystem: null }, stored)).toEqual({ name: 'B', designSystem: null });
  });
  it('adds nothing when no system is stored', () => {
    const kit = { name: 'B' };
    expect(keepDesignSystem(kit, undefined)).toBe(kit);
    expect(keepDesignSystem(kit, undefined)).not.toHaveProperty('designSystem');
  });
});
