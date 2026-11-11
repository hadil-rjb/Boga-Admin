/**
 * Fields of a social post that only the server writes: `publish` (state, per-network results) and
 * `media` (rendered slides). The studio syncs whole post objects, so these are always taken from the
 * stored document, never from the client — an open tab can't undo a publication or re-arm it.
 */
export type PublishState = "idle" | "pending" | "publishing" | "published" | "partial" | "failed";

/**
 * A video design (an imported clip, or an animated design) publishes its MP4, prepared by the studio when the post is
 * scheduled (media.video). Until that file is there the post can't go out: this message says what to do.
 */
export const VIDEO_NOT_READY = "The video for this post isn't ready yet. Open the post in the studio and schedule it again.";
export { isVideoPost as isVideoDesign } from "./post-video";
/** What the scheduler needs before it can publish a post: its slides, or its video */
export const mediaReady = (media: Record<string, any> | null | undefined) => !!(media?.ids?.length || media?.video?.id);

const DONE: PublishState[] = ["published", "partial", "publishing"];

/**
 * Approval in Notion: automation runs that need it carry `review` ({ state: pending | approved | rejected,
 * at, by, note }) and wait as "In Review". Approved runs become "Scheduled"; rejected ones "Rejected".
 * An approval that comes this long after the planned time is too late: the run is not published.
 */
export type ReviewState = "pending" | "approved" | "rejected";
export const REVIEW_GRACE_MS = 6 * 3600_000;

export function mergePost(existing: Record<string, any> | null | undefined, item: Record<string, any>) {
  const { publish: _p, media: _m, review: _r, ...rest } = item;
  const out: Record<string, any> = { ...rest };
  if (existing?.media) out.media = existing.media;
  // the review decision comes from Notion: the studio can't approve a run by sending it back as "Scheduled"
  if (existing?.review) {
    out.review = existing.review;
    if (!DONE.includes(existing.publish?.state)) out.status = existing.status;
  }
  let pub = existing?.publish;
  if (pub) {
    if (DONE.includes(pub.state)) {
      out.status = existing!.status; // once it went out, the server owns the status
    } else if (out.status === "Scheduled") {
      // (re)scheduled from the studio: arm it again if images are ready
      const moved = out.date !== existing!.date || out.time !== existing!.time || existing!.status !== "Scheduled";
      if (mediaReady(existing?.media) && (pub.state === "idle" || (pub.state === "failed" && moved))) pub = { ...pub, state: "pending", attempts: 0, nextTry: null };
    } else if (pub.state === "pending") {
      pub = { ...pub, state: "idle" }; // back to draft: disarm
    }
    out.publish = pub;
  }
  return out;
}

const NAMES: Record<string, string> = { ig: "instagram", li: "linkedin", x: "x", fb: "facebook", tt: "tiktok", tg: "telegram" };
const slug = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Same tracking parameters the studio previews */
export function withUtm(u: string, net: string, designName?: string) {
  try {
    const x = new URL(/^https?:\/\//.test(u) ? u : "https://" + u);
    x.searchParams.set("utm_source", NAMES[net] || net);
    x.searchParams.set("utm_medium", "social");
    x.searchParams.set("utm_campaign", slug(designName || "post"));
    return x.toString();
  } catch {
    return u;
  }
}

/** Caption for one network: its custom caption or the shared one, plus the link where links work. */
export function textFor(post: Record<string, any>, net: string, designName?: string) {
  const cap = String((post.caps && post.caps[net] !== undefined ? post.caps[net] : post.cap) || "").trim();
  if (!post.link || net === "ig" || net === "tt") return cap; // links aren't clickable there
  let link = post.utm ? withUtm(post.link, net, designName) : String(post.link);
  if (!/^https?:\/\//.test(link)) link = "https://" + link;
  return cap.includes(link) ? cap : `${cap}\n\n${link}`.trim();
}
