/* ============================================================
   The bottom dock (Unified Studio plan, Task 4): one place under the canvas with two states.
   - Pages: the page strip (the editor's filmstrip), in Design mode. An animated design's pages show their length.
   - Timeline: the shell's transport and track timeline, in Animate mode (an uploaded video always).
   Tracks with nothing on them (no caption lines, no music, no voice-over) leave the timeline; one "+ Track" row offers them.
   Pure helpers, unit-tested; the shell (video-studio.js) draws.
   ============================================================ */

/** The dock's state for an editing mode ('design' | 'animate', video-studio.js): pages in Design, the timeline in Animate */
export const dockState = (mode) => (mode === 'animate' ? 'timeline' : 'pages');

/**
 * The tracks to draw and the ones to offer: a track marked `empty` leaves the timeline, and its `add` ({ label, act, k? })
 * goes to the "+ Track" row. Order is kept. Returns { keep, adds }.
 */
export function visibleTracks(tracks) {
  const keep = [], adds = [];
  for (const t of tracks || []) {
    if (!t) continue;
    if (t.empty) { if (t.add) adds.push({ id: t.id, ...t.add }); } else keep.push(t);
  }
  return { keep, adds };
}

/** A page's length on the strip: "5 s", "2.5 s"; '' without a scene length */
export function durLabel(ms) {
  const n = +ms;
  if (!(n > 0)) return '';
  const s = Math.round(n / 100) / 10;
  return `${s % 1 ? s.toFixed(1) : s} s`;
}
