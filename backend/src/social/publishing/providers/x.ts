import { readRange, sleep } from "./video-file";
import { ApiError, request } from "../http";
import { blob, Env, expiresIn, Linked, OAuthProvider, PublishInput, PublishVideo, TokenSet } from "./types";

/** X (Twitter): OAuth 2.0 with PKCE, v2 media upload + POST /2/tweets. Up to 4 images. */
export function x(env: Env): OAuthProvider {
  const api = () => (env("X_API_URL") || "https://api.x.com").replace(/\/$/, "");
  const authBase = () => env("X_OAUTH_URL") || "https://x.com/i/oauth2/authorize";
  const id = () => env("X_CLIENT_ID")!;
  const basic = () => "Basic " + Buffer.from(`${id()}:${env("X_CLIENT_SECRET") || ""}`).toString("base64");

  const token = async (form: Record<string, string>): Promise<TokenSet> => {
    const t = await request(`${api()}/2/oauth2/token`, { method: "POST", headers: { Authorization: basic() }, form: { client_id: id(), ...form } });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresIn(t.expires_in) };
  };

  return {
    net: "x",
    name: "X",
    kind: "oauth",
    pkce: true,
    env: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
    setup: [
      "Create a project and app at developer.x.com and enable OAuth 2.0 (type: Web App).",
      "Permissions: Read and write. Add the callback URL below.",
      "Copy the OAuth 2.0 Client ID and Client Secret into X_CLIENT_ID and X_CLIENT_SECRET.",
    ],

    authorizeUrl: ({ state, redirectUri, challenge }) =>
      `${authBase()}?${new URLSearchParams({
        response_type: "code", client_id: id(), redirect_uri: redirectUri, state,
        scope: "tweet.read tweet.write users.read media.write offline.access",
        code_challenge: challenge!, code_challenge_method: "S256",
      })}`,

    async exchange({ code, redirectUri, verifier }) {
      const tokens = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier! });
      const me = (await request(`${api()}/2/users/me?user.fields=profile_image_url,username,name`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } })).data;
      return { tokens, account: { id: me.id, name: me.name, handle: "@" + me.username, avatar: me.profile_image_url, url: `https://x.com/${me.username}` }, extra: {} };
    },

    async refresh(link: Linked) {
      const t = link.tokens;
      if (!t.refreshToken || (t.expiresAt && t.expiresAt - Date.now() > 5 * 60_000)) return null;
      return token({ grant_type: "refresh_token", refresh_token: t.refreshToken });
    },

    async publish(link: Linked, input: PublishInput) {
      const auth = { Authorization: `Bearer ${link.tokens.accessToken}` };
      const mediaIds: string[] = [];
      if (input.video) mediaIds.push(await uploadVideo(api(), auth, input.video));
      for (const im of input.images.slice(0, 4)) {
        const f = new FormData();
        f.append("media", blob(im.buffer, im.mime), "slide.jpg");
        f.append("media_category", "tweet_image");
        const r = await request(`${api()}/2/media/upload`, { method: "POST", headers: auth, body: f, timeoutMs: 60_000 });
        const mid = r.data?.id ?? r.media_id_string;
        if (!mid) throw new ApiError("X did not accept the image");
        mediaIds.push(String(mid));
      }
      const r = await request(`${api()}/2/tweets`, { method: "POST", headers: auth, json: { text: input.text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) } });
      const tid = r.data?.id;
      const handle = String(link.account.handle || "").replace(/^@/, "");
      return { id: tid, url: `https://x.com/${handle || "i/web"}/status/${tid}`, warning: !input.video && input.images.length > 4 ? "X shows up to 4 images: the first 4 slides were posted" : undefined };
    },
  };
}

/** X's chunked upload: initialize (JSON) → append 4 MB segments → finalize → wait while X processes the video */
async function uploadVideo(base: string, auth: Record<string, string>, v: PublishVideo): Promise<string> {
  const api = () => base;
  const init = await request(`${api()}/2/media/upload/initialize`, { method: "POST", headers: auth, json: { media_type: "video/mp4", total_bytes: v.size, media_category: "tweet_video" } });
  const id = String(init.data?.id ?? "");
  if (!id) throw new ApiError("X did not accept the video");
  const SEG = 4 * 1024 * 1024;
  for (let i = 0, at = 0; at < v.size; i++, at += SEG) {
    const f = new FormData();
    f.append("media", blob(await readRange(v.path, at, Math.min(v.size, at + SEG) - 1), "video/mp4"), "video.mp4");
    f.append("segment_index", String(i));
    await request(`${api()}/2/media/upload/${id}/append`, { method: "POST", headers: auth, body: f, timeoutMs: 120_000 });
  }
  let info = (await request(`${api()}/2/media/upload/${id}/finalize`, { method: "POST", headers: auth })).data?.processing_info;
  for (let n = 0; info && info.state !== "succeeded"; n++) {
    if (info.state === "failed") throw new ApiError(`X could not process the video${info.error?.message ? `: ${info.error.message}` : ""}`);
    if (n >= 60) throw new ApiError("X is still processing the video. Try again in a few minutes.");
    await sleep(Number(process.env.X_POLL_MS || (info.check_after_secs || 3) * 1000));
    info = (await request(`${api()}/2/media/upload?${new URLSearchParams({ command: "STATUS", media_id: id })}`, { headers: auth })).data?.processing_info;
  }
  return id;
}
