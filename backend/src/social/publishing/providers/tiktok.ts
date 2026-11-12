import { ApiError, request } from "../http";
import { Env, expiresIn, Linked, OAuthProvider, PublishInput, TokenSet } from "./types";

/**
 * TikTok: Login Kit + Content Posting API (photo posts, direct post). TikTok downloads the images from
 * PUBLIC_API_URL, whose domain must be verified in the TikTok developer portal. Until the app passes
 * TikTok's audit, posts can only be published as private ("Only me").
 */
export function tiktok(env: Env): OAuthProvider {
  const api = () => (env("TIKTOK_API_URL") || "https://open.tiktokapis.com").replace(/\/$/, "");
  const authBase = () => env("TIKTOK_OAUTH_URL") || "https://www.tiktok.com/v2/auth/authorize/";
  const app = () => ({ client_key: env("TIKTOK_CLIENT_KEY")!, client_secret: env("TIKTOK_CLIENT_SECRET")! });
  /** TikTok answers 200 with error.code != "ok" for some failures */
  const ok = (r: any) => {
    if (r?.error?.code && r.error.code !== "ok") throw new ApiError(r.error.message || r.error.code);
    return r;
  };
  const tokens = (t: any): TokenSet => ({ accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresIn(t.expires_in), openId: t.open_id });

  return {
    net: "tt",
    name: "TikTok",
    kind: "oauth",
    env: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    setup: [
      "Create an app at developers.tiktok.com with Login Kit and Content Posting API (Direct Post enabled).",
      "Add the callback URL below as a redirect URI, and verify the domain of PUBLIC_API_URL for “pull from URL”.",
      "Copy the Client Key and Client Secret into TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET.",
      "Until TikTok audits the app, posts are published as private (Only me).",
    ],

    authorizeUrl: ({ state, redirectUri }) =>
      `${authBase()}?${new URLSearchParams({ client_key: env("TIKTOK_CLIENT_KEY")!, response_type: "code", scope: "user.info.basic,video.publish", redirect_uri: redirectUri, state })}`,

    async exchange({ code, redirectUri }) {
      const t = tokens(ok(await request(`${api()}/v2/oauth/token/`, { method: "POST", form: { ...app(), code, grant_type: "authorization_code", redirect_uri: redirectUri } })));
      const u = ok(await request(`${api()}/v2/user/info/?fields=open_id,avatar_url,display_name`, { headers: { Authorization: `Bearer ${t.accessToken}` } })).data.user;
      return { tokens: t, account: { id: u.open_id, name: u.display_name, avatar: u.avatar_url }, extra: {} };
    },

    async refresh(link: Linked) {
      const t = link.tokens;
      if (!t.refreshToken || (t.expiresAt && t.expiresAt - Date.now() > 10 * 60_000)) return null;
      return tokens(ok(await request(`${api()}/v2/oauth/token/`, { method: "POST", form: { ...app(), grant_type: "refresh_token", refresh_token: t.refreshToken } })));
    },

    async publish(link: Linked, input: PublishInput) {
      const h = { Authorization: `Bearer ${link.tokens.accessToken}` };
      if (!input.video && !input.images.length) throw new ApiError("TikTok photo posts need at least one image");
      const info = ok(await request(`${api()}/v2/post/publish/creator_info/query/`, { method: "POST", headers: h, json: {} })).data;
      const options: string[] = info.privacy_level_options || [];
      const privacy = options.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : options[0] || "SELF_ONLY";
      const [title, ...rest] = input.text.trim().split("\n");
      const warn = privacy === "SELF_ONLY" ? "Posted as private (Only me): TikTok hasn't audited this app yet" : undefined;
      if (input.video) {
        // a video: TikTok downloads it from its public URL (the PUBLIC_API_URL domain must be verified in the app)
        const vi = ok(await request(`${api()}/v2/post/publish/video/init/`, {
          method: "POST", headers: h,
          json: {
            post_info: { title: [...input.text.trim()].slice(0, 2200).join(""), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false, video_cover_timestamp_ms: 1000 },
            source_info: { source: "PULL_FROM_URL", video_url: input.video.url },
          },
        }));
        const pid = vi.data.publish_id;
        for (let i = 0; i < 100; i++) {
          const s = ok(await request(`${api()}/v2/post/publish/status/fetch/`, { method: "POST", headers: h, json: { publish_id: pid } })).data;
          if (s.status === "PUBLISH_COMPLETE") {
            const postId = (s.publicaly_available_post_id || s.publicly_available_post_id || [])[0];
            return { id: String(postId || pid), url: postId ? `https://www.tiktok.com/@${info.creator_username || ""}/video/${postId}` : undefined, warning: warn };
          }
          if (s.status === "FAILED") throw new ApiError(`TikTok rejected the video: ${s.fail_reason || "unknown reason"}`);
          await new Promise((r) => setTimeout(r, Number(env("TIKTOK_POLL_MS") || 3000)));
        }
        return { id: pid, warning: "TikTok is still processing the video; it will appear shortly" };
      }
      const init = ok(await request(`${api()}/v2/post/publish/content/init/`, {
        method: "POST",
        headers: h,
        json: {
          post_info: { title: [...title].slice(0, 90).join(""), description: [...(rest.join("\n").trim() || input.text)].slice(0, 4000).join(""), privacy_level: privacy, disable_comment: false, auto_add_music: true },
          source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: input.images.slice(0, 35).map((i) => i.url) },
          post_mode: "DIRECT_POST",
          media_type: "PHOTO",
        },
      }));
      const publishId = init.data.publish_id;
      for (let i = 0; i < 20; i++) {
        const s = ok(await request(`${api()}/v2/post/publish/status/fetch/`, { method: "POST", headers: h, json: { publish_id: publishId } })).data;
        if (s.status === "PUBLISH_COMPLETE") {
          const postId = (s.publicaly_available_post_id || s.publicly_available_post_id || [])[0];
          return { id: String(postId || publishId), url: postId ? `https://www.tiktok.com/@${info.creator_username || ""}/photo/${postId}` : undefined, warning: warn };
        }
        if (s.status === "FAILED") throw new ApiError(`TikTok rejected the post: ${s.fail_reason || "unknown reason"}`);
        await new Promise((r) => setTimeout(r, Number(env("TIKTOK_POLL_MS") || 3000)));
      }
      return { id: publishId, warning: "TikTok is still processing the post; it will appear shortly" };
    },
  };
}
