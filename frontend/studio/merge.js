/* ============================================================
   Three-way merge of a design saved in two places at once (two tabs, two people).
   `base` is the version both started from (the last one this tab synced), `mine` this tab's, `theirs` the one the
   API kept. A part only one side changed takes that side's change; a part both changed the same way is kept; a part
   both changed differently is a real conflict, and the caller keeps "… (conflicted copy)" as before.
   Objects merge key by key; arrays (pages, layers, caption lines) and values are taken whole.
   Pure, no imports: used by engine.js (persist.onConflict) and unit-tested.
   ============================================================ */

/** Keys that only say when or where the design was last touched: when both changed, this tab's wins */
const STAMPS = new Set(['upd', 'at']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const key = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v === undefined ? null : v;
  const out = {};
  for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
  return out;
}
const same = (a, b) => (a === b) || key(a) === key(b);

/**
 * { ok: true, value, theirs } where value is the merged design and theirs is true when it took something from
 * `theirs`; { ok: false, path } at the first part both sides changed differently. No `base`: nothing can be told.
 */
export function merge3(base, mine, theirs) {
  if (base === undefined || base === null) return { ok: false, path: '' };
  let took = false;
  const walk = (b, m, t, path) => {
    if (same(m, t)) return { ok: true, v: m };
    if (same(b, m)) { took = true; return { ok: true, v: t }; }
    if (same(b, t)) return { ok: true, v: m };
    if (isObj(m) && isObj(t)) {
      const out = {}, bo = isObj(b) ? b : {};
      for (const k of new Set([...Object.keys(m), ...Object.keys(t)])) {
        if (STAMPS.has(k) && !same(m[k], t[k])) { if (m[k] !== undefined) out[k] = m[k]; continue; }
        const r = walk(bo[k], m[k], t[k], path ? `${path}.${k}` : k);
        if (!r.ok) return r;
        if (r.v !== undefined) out[k] = r.v;
      }
      return { ok: true, v: out };
    }
    return { ok: false, path };
  };
  const r = walk(base, mine, theirs, '');
  return r.ok ? { ok: true, value: r.v, theirs: took } : { ok: false, path: r.path };
}
