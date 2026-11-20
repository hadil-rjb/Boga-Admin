import { firstLine, readRange, sleep } from "./video-file";
import { ApiError, request } from "../http";
import { Env, expiresIn, Linked, OAuthProvider, PublishInput, TokenSet } from "./types";

/** Upload chunk: a multiple of 256 KB, as the resumable protocol requires */
const CHUNK = 32 * 256 * 1024 * 4; // 32 MB

/** YouTube refuses "<" and ">" in titles and descriptions */
const clean = (s: string) => s.replace(/[<>]/g, "");
/** Titles: 1–100 characters; descriptions: up to 5000 bytes */
const bytesMax = (s: string, max: number) => { let out = ""; for (const ch of s) { if (Buffer.byteLength(out + ch) > max) break; out += ch; } return out; };

/**
 * YouTube: Google sign-in (OAuth 2.0 + PKCE) + YouTube Data API v3. Uploads the post's MP4 to the account's channel
 * with a resumable upload. Vertical videos up to 3 minutes show up as Shorts. Image posts can't go to YouTube.
 * Uses the workspace's Google OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, shared with Search Console).
 */
export function youtube(env: Env): OAuthProvider {
  const api = () => (env("YOUTUBE_API_URL") || "https://www.googleapis.com").replace(/\/$/, "");
  const authUrl = () => env("GOOGLE_OAUTH_URL") || "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenUrl = () => env("GOOGLE_TOKEN_URL") || "https://oauth2.googleapis.com/token";
  const app = () => ({ client_id: env("GOOGLE_CLIENT_ID")!, client_secret: env("GOOGLE_CLIENT_SECRET")! });
  const tokens = (t: any, prev?: TokenSet): TokenSet => ({ accessToken: t.access_token, refreshToken: t.refresh_token || prev?.refreshToken, expiresAt: expiresIn(t.expires_in) });

  return {
    net: "yt",
    name: "YouTube",
    kind: "oauth",
    pkce: true,
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    setup: [
      "In Google Cloud Console, enable “YouTube Data API v3” for the project of GOOGLE_CLIENT_ID.",
      "In APIs & Services → Credentials, open the OAuth client (Web application) and add the callback URL below as an authorized redirect URI.",
      "On the OAuth consent screen, add the scope youtube.upload, and add your Google account as a test user while the app is in testing.",
      "Until Google verifies the app, uploaded videos stay private.",
    ],

    authorizeUrl: ({ state, redirectUri, challenge }) =>
      `${authUrl()}?${new URLSearchParams({
        client_id: env("GOOGLE_CLIENT_ID")!, redirect_uri: redirectUri, response_type: "code", state,
        scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
        access_type: "offline", prompt: "consent", include_granted_scopes: "true",
        ...(challenge ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
      })}`,

    async exchange({ code, redirectUri, verifier }) {
      const t = tokens(await request(tokenUrl(), { method: "POST", form: { ...app(), code, grant_type: "authorization_code", redirect_uri: redirectUri, ...(verifier ? { code_verifier: verifier } : {}) } }));
      const r = await request(`${api()}/youtube/v3/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${t.accessToken}` } });
      const ch = r.items?.[0];
      if (!ch) throw new ApiError("This Google account has no YouTube channel. Create one on youtube.com, then connect again.");
      const s = ch.snippet || {}, handle = s.customUrl ? (s.customUrl.startsWith("@") ? s.customUrl : "@" + s.customUrl) : undefined;
      return {
        tokens: t,
        account: { id: ch.id, name: s.title || "YouTube channel", handle, avatar: s.thumbnails?.default?.url, url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${ch.id}` },
        extra: { channelId: ch.id },
      };
    },

    async refresh(link: Linked) {
      const t = link.tokens;
      if (!t.refreshToken || (t.expiresAt && t.expiresAt - Date.now() > 5 * 60_000)) return null;
      return tokens(await request(tokenUrl(), { method: "POST", form: { ...app(), grant_type: "refresh_token", refresh_token: t.refreshToken } }), t);
    },

    async publish(link: Linked, input: PublishInput) {
      const v = input.video;
      if (!v) throw new ApiError("YouTube only publishes videos. Make this post a video (an animated design or a clip), or untick YouTube.");
      const auth = { Authorization: `Bearer ${link.tokens.accessToken}` };
      const text = clean(input.text.trim());
      const title = firstLine(text, 100).trim() || "New video";
      const short = v.height > v.width && v.durationMs > 0 && v.durationMs <= 180_000;

      // 1. start a resumable session with the video's details
      const start = await fetch(`${api()}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(v.size), "X-Upload-Content-Type": "video/mp4" },
        body: JSON.stringify({
          snippet: { title, description: bytesMax(text, 5000), categoryId: "22" },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false, embeddable: true },
        }),
        signal: AbortSignal.timeout(60_000),
      }).catch(() => { throw new ApiError("Could not reach YouTube"); });
      const session = start.headers.get("location");
      if (!start.ok || !session) throw new ApiError(await failure(start, "YouTube refused the upload"));

      // 2. send the file in chunks; 308 = keep going, 200/201 = done (the video resource)
      let video: any;
      for (let from = 0; from < v.size; ) {
        const to = Math.min(from + CHUNK, v.size) - 1, body = await readRange(v.path, from, to);
        let res: Response | undefined;
        for (let attempt = 0; ; attempt++) {
          res = await fetch(session, {
            method: "PUT", headers: { ...auth, "Content-Type": "video/mp4", "Content-Range": `bytes ${from}-${to}/${v.size}` },
            body: new Uint8Array(body), signal: AbortSignal.timeout(5 * 60_000),
          }).catch(() => undefined);
          if (res && res.status < 500) break;
          if (attempt >= 3) throw new ApiError("The YouTube upload kept failing. Try again later.");
          await sleep(Number(env("YOUTUBE_RETRY_MS") || 2000) * (attempt + 1));
        }
        if (res!.status === 308) {
          const range = /bytes=0-(\d+)/.exec(res!.headers.get("range") || "");
          from = range ? Number(range[1]) + 1 : to + 1;
          continue;
        }
        if (!res!.ok) throw new ApiError(await failure(res!, "YouTube upload failed"));
        video = await res!.json();
        break;
      }
      if (!video?.id) throw new ApiError("YouTube did not return the video id");

      const id = String(video.id);
      const privacy = video.status?.privacyStatus;
      return {
        id,
        url: short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
        warning: privacy && privacy !== "public" ? "Uploaded as private: Google hasn't verified this app yet (YouTube locks unverified uploads to private)" : undefined,
      };
    },
  };
}

/** Readable error out of a Google API response */
async function failure(res: Response, fallback: string) {
  const body: any = await res.json().catch(() => null);
  const e = body?.error, reason = e?.errors?.[0]?.reason;
  if (reason === "quotaExceeded") return "YouTube's daily upload quota for this app is used up. Try again tomorrow.";
  if (reason === "uploadLimitExceeded") return "This YouTube channel reached its upload limit for today.";
  if (res.status === 401) return "The YouTube connection expired. Reconnect YouTube in Settings.";
  return e?.message ? `${fallback}: ${e.message}` : `${fallback} (${res.status})`;
}
