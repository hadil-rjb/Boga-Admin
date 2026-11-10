/**
 * A studio tab that loaded before an analysis sends its brand kit without `designSystem`.
 * Replacing the stored brand with that kit would erase the system, so a kit with no
 * `designSystem` key keeps the stored one. A kit that carries the key (even null) wins.
 */
export function keepDesignSystem<K extends Record<string, any>>(kit: K, stored: unknown): K {
  if (kit.designSystem !== undefined || stored === undefined || stored === null) return kit;
  return { ...kit, designSystem: stored };
}
