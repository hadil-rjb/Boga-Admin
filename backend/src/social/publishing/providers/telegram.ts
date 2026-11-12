import { readVideo } from "./video-file";
import { ApiError, request } from "../http";
import { blob, Env, Linked, PublishInput, TokenProvider } from "./types";

/** Telegram: a bot posts to a channel or group. No OAuth: bot token from @BotFather + the chat. */
export function telegram(env: Env): TokenProvider {
  const base = () => (env("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/$/, "");
  const call = (token: string, method: string, init: Parameters<typeof request>[1] = {}) =>
    request(`${base()}/bot${token}/${method}`, { method: "POST", ...init }).then((r) => {
      if (r.ok === false) throw new ApiError(r.description || "Telegram error");
      return r.result;
    });

  return {
    net: "tg",
    name: "Telegram",
    kind: "token",
    env: [],
    setup: [
      "In Telegram, open @BotFather, send /newbot and copy the bot token.",
      "Add the bot to your channel (or group) as an administrator allowed to post.",
      "Paste the token and the channel's @username (or its numeric chat id) here.",
    ],

    async connect({ botToken, chat }) {
      const token = String(botToken || "").trim(), target = String(chat || "").trim();
      if (!/^\d+:[\w-]{20,}$/.test(token)) throw new ApiError("That doesn't look like a bot token (123456:ABC…)");
      if (!target) throw new ApiError("Enter the channel @username or chat id");
      const me = await call(token, "getMe").catch(() => { throw new ApiError("Telegram rejected this bot token"); });
      const chatId = /^-?\d+$/.test(target) ? target : "@" + target.replace(/^@|^https?:\/\/t\.me\//g, "");
      const info = await call(token, "getChat", { json: { chat_id: chatId } }).catch(() => {
        throw new ApiError("The bot can't see that chat. Add it to the channel as an administrator first.");
      });
      const member = await call(token, "getChatMember", { json: { chat_id: info.id, user_id: me.id } }).catch(() => null);
      if (info.type === "channel" && !["administrator", "creator"].includes(member?.status)) {
        throw new ApiError("The bot must be an administrator of the channel to post.");
      }
      return {
        tokens: { accessToken: token },
        account: { id: String(info.id), name: info.title || info.username || String(info.id), handle: info.username ? "@" + info.username : undefined, url: info.username ? `https://t.me/${info.username}` : undefined },
        extra: { chatId: String(info.id), username: info.username || "", bot: me.username },
      };
    },

    async publish(link: Linked, input: PublishInput) {
      const token = link.tokens.accessToken, chat = link.extra.chatId, imgs = input.images.slice(0, 10);
      const text = input.text.trim(), long = text.length > 1024; // photo captions are limited to 1024 characters
      let first: any;
      if (input.video) {
        const v = input.video, f = new FormData();
        f.append("chat_id", chat);
        f.append("video", blob(await readVideo(v), "video/mp4"), "video.mp4");
        f.append("supports_streaming", "true");
        if (v.width) f.append("width", String(v.width));
        if (v.height) f.append("height", String(v.height));
        if (v.durationMs) f.append("duration", String(Math.round(v.durationMs / 1000)));
        if (text && !long) f.append("caption", text);
        first = await call(token, "sendVideo", { body: f, timeoutMs: 5 * 60_000 });
      } else if (imgs.length === 1) {
        const f = new FormData();
        f.append("chat_id", chat);
        f.append("photo", blob(imgs[0].buffer, imgs[0].mime), "slide-1.jpg");
        if (text && !long) f.append("caption", text);
        first = await call(token, "sendPhoto", { body: f, timeoutMs: 60_000 });
      } else if (imgs.length > 1) {
        const f = new FormData();
        f.append("chat_id", chat);
        f.append("media", JSON.stringify(imgs.map((_, i) => ({ type: "photo", media: `attach://p${i}`, ...(i === 0 && text && !long ? { caption: text } : {}) }))));
        imgs.forEach((im, i) => f.append(`p${i}`, blob(im.buffer, im.mime), `slide-${i + 1}.jpg`));
        first = (await call(token, "sendMediaGroup", { body: f, timeoutMs: 90_000 }))[0];
      }
      if (text && (long || (!imgs.length && !input.video))) first = (await call(token, "sendMessage", { json: { chat_id: chat, text: text.slice(0, 4096) } })) || first;
      const id = String(first?.message_id ?? "");
      return { id, url: link.extra.username && id ? `https://t.me/${link.extra.username}/${id}` : undefined };
    },
  };
}
