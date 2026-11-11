/** Contract every social network implements. */
export type Net = "ig" | "li" | "x" | "fb" | "tt" | "tg";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt?: number;
  [k: string]: unknown;
}

export interface Account {
  id: string;
  name: string;
  handle?: string;
  avatar?: string;
  url?: string;
}

/** What is stored for a connection (tokens are encrypted at rest). */
export interface Linked {
  tokens: TokenSet;
  account: Account;
  extra: Record<string, any>;
}

export interface PublishImage {
  buffer: Buffer;
  mime: string;
  /** Public URL of the same image (for networks that download it themselves) */
  url: string;
  width?: number;
  height?: number;
}

/** A post's video (an MP4, H.264 + AAC, faststart), prepared by the studio and stored on disk by PostVideoStore */
export interface PublishVideo {
  /** Public URL (Range requests): Instagram, Facebook and TikTok download it themselves */
  url: string;
  /** Local file, for networks that take an upload (LinkedIn, X, Telegram) */
  path: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  durationMs: number;
}

export interface PublishInput {
  text: string;
  firstComment?: string;
  /** Slides (an image post), or empty for a video post */
  images: PublishImage[];
  /** A video post: networks publish it as a video (Reel, TikTok video…) instead of images */
  video?: PublishVideo;
  /** 9:16 design: Instagram publishes it as a Story */
  story: boolean;
}

export interface PublishResult {
  id: string;
  url?: string;
  warning?: string;
}

export type Env = (key: string) => string | undefined;

interface Base {
  net: Net;
  name: string;
  /** env vars needed before this network can be connected */
  env: string[];
  /** setup notes shown in the Connect dialog */
  setup: string[];
  publish(link: Linked, input: PublishInput): Promise<PublishResult>;
  /** Refresh tokens if they are about to expire; returns new tokens or null if unchanged. */
  refresh?(link: Linked): Promise<TokenSet | null>;
}

export interface OAuthProvider extends Base {
  kind: "oauth";
  pkce?: boolean;
  authorizeUrl(p: { state: string; redirectUri: string; challenge?: string }): string;
  exchange(p: { code: string; redirectUri: string; verifier?: string }): Promise<Linked>;
}

export interface TokenProvider extends Base {
  kind: "token";
  connect(input: Record<string, string>): Promise<Linked>;
}

export type Provider = OAuthProvider | TokenProvider;

export const expiresIn = (seconds?: number) => (seconds ? Date.now() + seconds * 1000 : undefined);

/** Buffer → Blob for multipart uploads */
export const blob = (buf: Buffer, type: string) => new Blob([new Uint8Array(buf)], { type });
