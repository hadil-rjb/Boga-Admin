import { readRange, sleep } from "./video-file";
import { ApiError, request } from "../http";
import { Env, expiresIn, Linked, OAuthProvider, PublishInput } from "./types";

/**
 * LinkedIn "little text" commentary: reserved characters must be escaped, and hashtags written as
 * {hashtag|\#|tag} so they stay clickable.
 */
export function littleText(s: string) {
  const parts = s.split(/(#[\p{L}\p{N}_]+)/u);
  return parts
    .map((p, i) => (i % 2 ? `{hashtag|\\#|${p.slice(1)}}` : p.replace(/[\\|{}@\[\]()<>#*_~]/g, (c) => "\\" + c)))
    .join("");
}

/** API version header (YYYYMM). LinkedIn keeps about a year of monthly versions; default: two months ago. */
const version = (env: Env) => {
  if (env("LINKEDIN_VERSION")) return env("LINKEDIN_VERSION")!;
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** LinkedIn: Sign In with LinkedIn (OpenID) + Share on LinkedIn, posts to the member's feed. */
export function linkedin(env: Env): OAuthProvider {
  const api = () => (env("LINKEDIN_API_URL") || "https://api.linkedin.com").replace(/\/$/, "");
  const oauth = () => (env("LINKEDIN_OAUTH_URL") || "https://www.linkedin.com/oauth/v2").replace(/\/$/, "");
  const rest = (token: string) => ({ Authorization: `Bearer ${token}`, "LinkedIn-Version": version(env), "X-Restli-Protocol-Version": "2.0.0" });

  return {
    net: "li",
    name: "LinkedIn",
    kind: "oauth",
    env: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    setup: [
      "Create an app at linkedin.com/developers and add the products “Sign In with LinkedIn using OpenID Connect” and “Share on LinkedIn”.",
      "In Auth, add the callback URL below as an authorized redirect URL.",
      "Copy the Client ID and Client Secret into LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET.",
    ],

    authorizeUrl: ({ state, redirectUri }) =>
      `${oauth()}/authorization?${new URLSearchParams({ response_type: "code", client_id: env("LINKEDIN_CLIENT_ID")!, redirect_uri: redirectUri, state, scope: "openid profile w_member_social" })}`,

    async exchange({ code, redirectUri }) {
      const t = await request(`${oauth()}/accessToken`, {
        method: "POST",
        form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: env("LINKEDIN_CLIENT_ID")!, client_secret: env("LINKEDIN_CLIENT_SECRET")! },
      });
      const me = await request(`${api()}/v2/userinfo`, { headers: { Authorization: `Bearer ${t.access_token}` } });
      return {
        tokens: { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresIn(t.expires_in) },
        account: { id: me.sub, name: me.name || [me.given_name, me.family_name].filter(Boolean).join(" "), avatar: me.picture },
        extra: { author: `urn:li:person:${me.sub}` },
      };
    },

    async refresh(link: Linked) {
      const t = link.tokens;
      if (!t.refreshToken || (t.expiresAt && t.expiresAt - Date.now() > 24 * 3600_000)) return null;
      const r = await request(`${oauth()}/accessToken`, {
        method: "POST",
        form: { grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: env("LINKEDIN_CLIENT_ID")!, client_secret: env("LINKEDIN_CLIENT_SECRET")! },
      });
      return { accessToken: r.access_token, refreshToken: r.refresh_token || t.refreshToken, expiresAt: expiresIn(r.expires_in) };
    },

    async publish(link: Linked, input: PublishInput) {
      if (link.tokens.expiresAt && link.tokens.expiresAt < Date.now()) throw new ApiError("The LinkedIn connection expired. Reconnect LinkedIn in Settings.");
      const h = rest(link.tokens.accessToken), author = link.extra.author;
      if (input.video) return postVideo(api(), input, h, author);
      const imageUrns: string[] = [];
      for (const im of input.images.slice(0, 20)) {
        const init = await request(`${api()}/rest/images?action=initializeUpload`, { method: "POST", headers: h, json: { initializeUploadRequest: { owner: author } } });
        const up = await fetch(init.value.uploadUrl, { method: "PUT", headers: { Authorization: h.Authorization, "Content-Type": im.mime }, body: new Uint8Array(im.buffer) });
        if (!up.ok) throw new ApiError(`LinkedIn image upload failed (${up.status})`);
        imageUrns.push(init.value.image);
      }
      const content = imageUrns.length === 1 ? { media: { id: imageUrns[0] } } : imageUrns.length > 1 ? { multiImage: { images: imageUrns.map((id) => ({ id })) } } : undefined;
      const r = await request(`${api()}/rest/posts`, {
        method: "POST",
        headers: h,
        json: {
          author,
          commentary: littleText(input.text),
          visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          ...(content ? { content } : {}),
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        },
      });
      const urn = (r as any).__headers?.get("x-restli-id") || r.id;
      if (!urn) throw new ApiError("LinkedIn did not return the post id");
      let warning: string | undefined;
      if (input.firstComment?.trim()) {
        await request(`${api()}/rest/socialActions/${encodeURIComponent(urn)}/comments`, {
          method: "POST", headers: h, json: { actor: author, object: urn, message: { text: input.firstComment.trim() } },
        }).catch((e) => { warning = `Posted, but the first comment failed: ${e.message}`; });
      }
      return { id: urn, url: `https://www.linkedin.com/feed/update/${urn}`, warning };
    },
  };
}

/**
 * A LinkedIn video post: initializeUpload (the file's size) → PUT each part to its upload URL (keeping the ETags) →
 * finalizeUpload → wait until the video is AVAILABLE → the post, with the video as its media.
 */
async function postVideo(base: string, input: PublishInput, h: Record<string, string>, author: string) {
  const api = () => base;
  const v = input.video!;
  const init = await request(`${api()}/rest/videos?action=initializeUpload`, {
    method: "POST", headers: h, json: { initializeUploadRequest: { owner: author, fileSizeBytes: v.size, uploadCaptions: false, uploadThumbnail: false } },
  });
  const { video, uploadToken = "", uploadInstructions = [] } = init.value || {};
  if (!video || !uploadInstructions.length) throw new ApiError("LinkedIn did not accept the video");
  const etags: string[] = [];
  for (const part of uploadInstructions as { uploadUrl: string; firstByte: number; lastByte: number }[]) {
    const body = await readRange(v.path, part.firstByte, part.lastByte);
    const up = await fetch(part.uploadUrl, { method: "PUT", headers: { Authorization: h.Authorization, "Content-Type": "application/octet-stream" }, body: new Uint8Array(body), signal: AbortSignal.timeout(5 * 60_000) });
    if (!up.ok) throw new ApiError(`LinkedIn video upload failed (${up.status})`);
    etags.push(String(up.headers.get("etag") || "").replace(/"/g, ""));
  }
  await request(`${api()}/rest/videos?action=finalizeUpload`, { method: "POST", headers: h, json: { finalizeUploadRequest: { video, uploadToken, uploadedPartIds: etags } } });
  for (let i = 0; ; i++) {
    const s = await request(`${api()}/rest/videos/${encodeURIComponent(video)}`, { headers: h });
    if (s.status === "AVAILABLE") break;
    if (s.status === "PROCESSING_FAILED") throw new ApiError("LinkedIn could not process the video");
    if (i >= 100) throw new ApiError("LinkedIn is still processing the video. Try again in a few minutes.");
    await sleep(Number(process.env.LINKEDIN_POLL_MS || 3000));
  }
  const r = await request(`${api()}/rest/posts`, {
    method: "POST", headers: h,
    json: {
      author, commentary: littleText(input.text), visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: video } }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
    },
  });
  const urn = (r as any).__headers?.get("x-restli-id") || r.id;
  if (!urn) throw new ApiError("LinkedIn did not return the post id");
  let warning: string | undefined;
  if (input.firstComment?.trim()) {
    await request(`${api()}/rest/socialActions/${encodeURIComponent(urn)}/comments`, {
      method: "POST", headers: h, json: { actor: author, object: urn, message: { text: input.firstComment.trim() } },
    }).catch((e) => { warning = `Posted, but the first comment failed: ${e.message}`; });
  }
  return { id: urn, url: `https://www.linkedin.com/feed/update/${urn}`, warning };
}
