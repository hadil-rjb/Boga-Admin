/**
 * Video posts: what each network accepts, checked in the studio before scheduling (same rules) and by the publisher.
 * Sources: Instagram Reels (3 s – 15 min, ≤ 300 MB via URL), Facebook Page video, TikTok (≤ 10 min, ≤ 4 GB),
 * LinkedIn (3 s – 30 min, ≤ 5 GB), X (≤ 140 s for standard accounts, ≤ 512 MB), Telegram bots (≤ 50 MB upload).
 */
import type { Net } from "./providers/types";

export interface VideoMeta { size: number; durationMs: number; width: number; height: number }

export const VIDEO_LIMITS: Record<Net, { minMs: number; maxMs: number; maxBytes: number; name: string }> = {
  ig: { minMs: 3_000, maxMs: 15 * 60_000, maxBytes: 300 * 1024 ** 2, name: "Instagram" },
  fb: { minMs: 1_000, maxMs: 240 * 60_000, maxBytes: 4 * 1024 ** 3, name: "Facebook" },
  tt: { minMs: 3_000, maxMs: 10 * 60_000, maxBytes: 4 * 1024 ** 3, name: "TikTok" },
  li: { minMs: 3_000, maxMs: 30 * 60_000, maxBytes: 5 * 1024 ** 3, name: "LinkedIn" },
  x: { minMs: 500, maxMs: 140_000, maxBytes: 512 * 1024 ** 2, name: "X" },
  tg: { minMs: 0, maxMs: Infinity, maxBytes: 50 * 1024 ** 2, name: "Telegram" },
};

const secs = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
const mb = (b: number) => (b >= 1024 ** 3 ? `${Math.round(b / 1024 ** 3)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

/** Why `net` can't take this video (a sentence), or null when it can */
export function videoProblem(net: Net, v: VideoMeta): string | null {
  const L = VIDEO_LIMITS[net]; if (!L) return null;
  if (v.durationMs && v.durationMs < L.minMs) return `${L.name} needs a video of at least ${secs(L.minMs)}.`;
  if (v.durationMs && v.durationMs > L.maxMs) return `${L.name} takes videos up to ${secs(L.maxMs)}: this one is ${secs(v.durationMs)}.`;
  if (v.size && v.size > L.maxBytes) return `${L.name} takes videos up to ${mb(L.maxBytes)}: this one is ${mb(v.size)}.`;
  return null;
}

/** A design that publishes as a video: an imported clip (footage) or an animated design (motion) */
export const isVideoPost = (design: Record<string, any> | null | undefined) => !!(design?.footage || design?.motion);

/** A stored video's file name: 24 random hex characters and .mp4 (also its public URL) */
export const VIDEO_ID = /^[a-f0-9]{24}$/;
