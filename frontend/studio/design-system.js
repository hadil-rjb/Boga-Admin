/* ============================================================
   Brand design system, Task 1: choosing the references a brand's system is learned from.
   - Templates first, newest first, then designs that were approved or published, newest first. Drafts are never used.
   - At most MAX_SOURCES references per analysis, and the first page of each only.
   - sourceSig tells when the references changed, so a saved system can be marked out of date.
   Pure: no DOM, no imports from engine.js.
   ============================================================ */

export const MAX_SOURCES = 12;

const byNewest = (a, b) => (b.at || 0) - (a.at || 0);

/** The references to learn from: { kind, id, name, ratio, at, live }. */
export function pickSources(brand, designs, posts) {
  const templates = ((brand && brand.templates) || []).slice().sort(byNewest).map((t) => ({
    kind: 'template', id: t.id, name: t.name, ratio: t.ratio, at: t.at || 0, live: !!t.live,
  }));
  const published = new Set((posts || []).filter((p) => p.status === 'Published').map((p) => p.d));
  const picked = (designs || [])
    .filter((d) => d.status === 'Approved' || published.has(d.id))
    .sort(byNewest)
    .map((d) => ({
      kind: 'design', id: d.id, name: d.name, ratio: d.ratio, at: d.at || 0, live: !!(d.pages && d.pages[0] && d.pages[0].live),
    }));
  return templates.concat(picked).slice(0, MAX_SOURCES);
}

/** A string that changes when a reference is edited, added or removed. */
export function sourceSig(sources) {
  return sources.map((s) => s.id + ':' + (s.at || 0)).join('|');
}
