import { readVideo } from "./video-file";
import { ApiError, request } from "../http";
import { blob, Env, Linked, PublishInput, TokenProvider } from "./types";

/** Admin rights the bot asks for when added from the wizard's "Add to channel" link */
const RIGHTS = "post_messages+edit_messages+delete_messages";

/** A chat the bot can post to, as the Connect wizard shows it */
export interface TgChat { id: string; title: string; type: string; username?: string; status?: string; canPost?: boolean }

/** "@name", "name", "t.me/name", "https://t.me/name/12" or a numeric id → what getChat takes */
export function chatRef(input: string): string {
  const s = String(input || "").trim();
  if (/^-?\d+$/.test(s)) return s;
  if (/(?:^|\/)(?:\+|joinchat\/)/.test(s.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i, "/"))) {
    throw new ApiError("Private invite links can't be used. Add the bot to the channel, then pick it from the list (or paste its numeric id).");
  }
  const name = s.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
  if (!/^[A-Za-z]\w{3,31}$/.test(name)) throw new ApiError("Enter the channel's @username, its t.me link or its numeric id");
  return "@" + name;
}

/** Can a bot with this chat-member record publish in a chat of this type? null = yes, else why not. */
export function postProblem(type: string, m: any): string | null {
  const status = m?.status;
  if (type === "private") return "That's a person, not a channel or group. Enter a channel or group.";
  if (!status || status === "left" || status === "kicked") return `The bot isn't a member of this ${type === "channel" ? "channel" : "group"} yet. Add it, then check again.`;
  if (type === "channel") {
    if (status === "creator") return null;
    if (status !== "administrator") return "The bot must be an administrator of the channel.";
    if (m.can_post_messages === false) return "The bot is an administrator but can't post. Turn on \"Post messages\" in its admin rights.";
    return null;
  }
  if (status === "restricted" && m.can_send_messages === false) return "The bot is muted in this group. Allow it to send messages.";
  return null;
}

/** Telegram: a bot posts to a channel or group. No OAuth: bot token from @BotFather + the chat. */
export function telegram(env: Env): TokenProvider {
  const base = () => (env("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/$/, "");
  const call = (token: string, method: string, init: Parameters<typeof request>[1] = {}) =>
    request(`${base()}/bot${token}/${method}`, { method: "POST", ...init }).then((r) => {
      if (r.ok === false) throw new ApiError(r.description || "Telegram error");
      return r.result;
    });

  /** Step 1: the token is well-formed and Telegram knows the bot */
  async function bot(botToken: string) {
    const token = String(botToken || "").trim();
    if (!/^\d+:[\w-]{30,}$/.test(token)) throw new ApiError("That doesn't look like a bot token. It looks like 123456789:AAE… and comes from @BotFather.");
    const me = await call(token, "getMe").catch((e: ApiError) => {
      // 401/404: Telegram doesn't know this token. Anything else (timeout, network) is said as is.
      throw e.status === 401 || e.status === 404 ? new ApiError("Telegram rejected this bot token. Copy it again from @BotFather (it may have been revoked).") : e;
    });
    return {
      token,
      me,
      info: {
        id: String(me.id), name: me.first_name as string, username: me.username as string,
        url: `https://t.me/${me.username}`,
        addToChannel: `https://t.me/${me.username}?startchannel&admin=${RIGHTS}`,
        addToGroup: `https://t.me/${me.username}?startgroup&admin=${RIGHTS}`,
      },
    };
  }

  /** Step 2: chats the bot was recently added to (from its pending updates), so nobody has to type an id */
  async function recentChats(token: string, botId: number): Promise<TgChat[]> {
    const ups: any[] = await call(token, "getUpdates", { json: { allowed_updates: ["my_chat_member", "channel_post", "message"], limit: 100 } }).catch(() => []); // 409 when a webhook is set: no list then
    const seen = new Map<string, TgChat>();
    for (const u of ups || []) {
      const m = u.my_chat_member, chat = m?.chat || u.channel_post?.chat || u.message?.chat;
      if (!chat || chat.type === "private") continue;
      const member = m && m.new_chat_member?.user?.id === botId ? m.new_chat_member : undefined;
      const prev = seen.get(String(chat.id));
      seen.set(String(chat.id), {
        id: String(chat.id), title: chat.title || chat.username || String(chat.id), type: chat.type, username: chat.username,
        status: member?.status ?? prev?.status, canPost: member ? !postProblem(chat.type, member) : prev?.canPost,
      });
    }
    return [...seen.values()].filter((c) => c.status !== "left" && c.status !== "kicked").reverse();
  }

  /** Step 3: the chat exists, the bot is in it and may post */
  async function inspect(token: string, botId: number, target: string) {
    const ref = chatRef(target);
    const info = await call(token, "getChat", { json: { chat_id: ref } }).catch((e: ApiError) => {
      if (e.status && e.status < 500) throw new ApiError(/^-?\d+$/.test(ref) ? "The bot can't see that chat. Add it to the channel as an administrator first." : `Telegram can't find ${ref}, or the bot isn't in it yet. Check the username, or add the bot first.`);
      throw e;
    });
    if (info.type === "private") throw new ApiError(postProblem("private", null)!);
    const member = await call(token, "getChatMember", { json: { chat_id: info.id, user_id: botId } }).catch(() => null);
    const chat: TgChat = { id: String(info.id), title: info.title || info.username || String(info.id), type: info.type, username: info.username, status: member?.status };
    const problem = postProblem(info.type, member);
    return { info, chat: { ...chat, canPost: !problem }, problem };
  }

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

    /** The Connect wizard checks each step before anything is saved: { bot, chats } or, with a chat, { bot, chat, problem } */
    async check({ botToken, chat }) {
      const b = await bot(botToken);
      if (!String(chat || "").trim()) return { bot: b.info, chats: await recentChats(b.token, b.me.id) };
      const { chat: c, problem } = await inspect(b.token, b.me.id, chat);
      return { bot: b.info, chat: c, problem };
    },

    async connect({ botToken, chat }) {
      const b = await bot(botToken);
      if (!String(chat || "").trim()) throw new ApiError("Enter the channel @username or chat id");
      const { info, problem } = await inspect(b.token, b.me.id, chat);
      if (problem) throw new ApiError(problem);
      return {
        tokens: { accessToken: b.token },
        account: { id: String(info.id), name: info.title || info.username || String(info.id), handle: info.username ? "@" + info.username : undefined, url: info.username ? `https://t.me/${info.username}` : undefined },
        extra: { chatId: String(info.id), username: info.username || "", bot: b.me.username, type: info.type },
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
      return { id, url: id ? postUrl(link.extra, id) : undefined };
    },
  };
}

/** Public channel: t.me/name/12. Private channel or supergroup (-100…): t.me/c/<id>/12 (members only). */
function postUrl(extra: Record<string, any>, id: string) {
  if (extra.username) return `https://t.me/${extra.username}/${id}`;
  const m = /^-100(\d+)$/.exec(String(extra.chatId || ""));
  return m ? `https://t.me/c/${m[1]}/${id}` : undefined;
}
