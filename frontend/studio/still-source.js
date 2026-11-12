/* ============================================================
   Still source: still posts and carousels in the Video Studio shell (video-studio.js), so one shell opens every design
   (Unified Studio plan, Task 2). A still has no player and no tracks, so the shell draws no transport or timeline for it.
   The shell draws a still's unified rail and sub-tabs; the editor keeps drawing every panel (nativePanel), the slide strip
   until the Pages dock lands (nativePages) and the Design / Layers properties (nativeInspector).
   installStillSource touches no DOM.
   ============================================================ */

/** The `still` source (a fresh object) */
export function stillSource() {
  return {
    mount() {},
    unmount() {},
    player: null,
    tracks: () => [],
    nativePages: true,
    nativePanel: () => true,
    nativeInspector: true,
  };
}

export function installStillSource({ VS }) {
  const source = stillSource();
  VS.register('still', source);
  return source;
}
