import { facebook, instagram } from "./meta";
import { linkedin } from "./linkedin";
import { telegram } from "./telegram";
import { tiktok } from "./tiktok";
import { x } from "./x";
import { youtube } from "./youtube";
import { Env, Net, Provider } from "./types";

export * from "./types";

/** Networks in the order the studio shows them */
export const NETS: Net[] = ["ig", "li", "x", "fb", "tt", "tg", "yt"];

export const providers = (env: Env): Record<Net, Provider> => ({
  ig: instagram(env),
  li: linkedin(env),
  x: x(env),
  fb: facebook(env),
  tt: tiktok(env),
  tg: telegram(env),
  yt: youtube(env),
});
