import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatRef, postProblem, telegram } from './providers/telegram';

const TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxyz012345';
const ok = (result: any) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const fail = (status: number, description: string) => new Response(JSON.stringify({ ok: false, error_code: status, description }), { status });
const ME = { id: 42, is_bot: true, first_name: 'Boga', username: 'boga_bot' };

function fake(routes: Record<string, (body: any) => Response>) {
  const calls: { method: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: any, init: any = {}) => {
    const method = String(u).split('/').pop()!, body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, body });
    return (routes[method] || (() => fail(400, 'Bad Request: unexpected')))(body);
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
const tg = () => telegram(() => undefined);

describe('chatRef', () => {
  it.each([
    ['@mychannel', '@mychannel'], ['mychannel', '@mychannel'], ['https://t.me/mychannel', '@mychannel'],
    ['t.me/mychannel/12', '@mychannel'], ['-1001234567890', '-1001234567890'],
  ])('%s → %s', (input, out) => expect(chatRef(input)).toBe(out));
  it('refuses private invite links and junk', () => {
    expect(() => chatRef('https://t.me/+AbCdEf')).toThrow(/invite links/);
    expect(() => chatRef('t.me/joinchat/AbCdEf')).toThrow(/invite links/);
    expect(() => chatRef('a b')).toThrow(/username/);
  });
});

describe('postProblem', () => {
  it('channel: needs an admin that may post', () => {
    expect(postProblem('channel', { status: 'administrator', can_post_messages: true })).toBeNull();
    expect(postProblem('channel', { status: 'creator' })).toBeNull();
    expect(postProblem('channel', { status: 'administrator', can_post_messages: false })).toMatch(/Post messages/);
    expect(postProblem('channel', { status: 'member' })).toMatch(/administrator/);
    expect(postProblem('channel', null)).toMatch(/isn't a member/);
  });
  it('group: any member that is not muted; never a private chat', () => {
    expect(postProblem('supergroup', { status: 'member' })).toBeNull();
    expect(postProblem('group', { status: 'left' })).toMatch(/isn't a member/);
    expect(postProblem('supergroup', { status: 'restricted', can_send_messages: false })).toMatch(/muted/);
    expect(postProblem('private', { status: 'member' })).toMatch(/person/);
  });
});

describe('Telegram connect wizard', () => {
  it('step 1: a malformed token never reaches Telegram', async () => {
    const calls = fake({});
    await expect(tg().check!({ botToken: 'nope' })).rejects.toThrow(/doesn't look like a bot token/);
    expect(calls).toHaveLength(0);
  });

  it('step 1: a revoked token says so; a network error is not blamed on the token', async () => {
    fake({ getMe: () => fail(401, 'Unauthorized') });
    await expect(tg().check!({ botToken: TOKEN })).rejects.toThrow(/rejected this bot token/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(tg().check!({ botToken: TOKEN })).rejects.toThrow(/Could not reach/);
  });

  it('step 2: returns the bot, its add-to-channel link and the chats it was just added to', async () => {
    fake({
      getMe: () => ok(ME),
      getUpdates: () => ok([
        { my_chat_member: { chat: { id: -1001, title: 'News', type: 'channel', username: 'news' }, new_chat_member: { user: { id: 42 }, status: 'administrator', can_post_messages: true } } },
        { my_chat_member: { chat: { id: -1002, title: 'Old', type: 'channel' }, new_chat_member: { user: { id: 42 }, status: 'left' } } },
        { message: { chat: { id: 7, type: 'private' } } },
      ]),
    });
    const r: any = await tg().check!({ botToken: TOKEN });
    expect(r.bot).toMatchObject({ username: 'boga_bot', addToChannel: 'https://t.me/boga_bot?startchannel&admin=post_messages+edit_messages+delete_messages' });
    expect(r.chats).toEqual([{ id: '-1001', title: 'News', type: 'channel', username: 'news', status: 'administrator', canPost: true }]);
  });

  it('step 2: a webhook on the bot (getUpdates 409) gives an empty list, not an error', async () => {
    fake({ getMe: () => ok(ME), getUpdates: () => fail(409, 'Conflict: can\'t use getUpdates method while webhook is active') });
    expect(await tg().check!({ botToken: TOKEN })).toMatchObject({ chats: [] });
  });

  it('step 3: reports an admin without "Post messages", and connect refuses it', async () => {
    fake({
      getMe: () => ok(ME),
      getChat: () => ok({ id: -1001, title: 'News', type: 'channel', username: 'news' }),
      getChatMember: () => ok({ status: 'administrator', can_post_messages: false }),
    });
    const r: any = await tg().check!({ botToken: TOKEN, chat: 'https://t.me/news' });
    expect(r.chat).toMatchObject({ id: '-1001', canPost: false });
    expect(r.problem).toMatch(/Post messages/);
    await expect(tg().connect({ botToken: TOKEN, chat: '@news' })).rejects.toThrow(/Post messages/);
  });

  it('connects a private channel and links its posts with t.me/c', async () => {
    const calls = fake({
      getMe: () => ok(ME),
      getChat: () => ok({ id: -1009876, title: 'Team', type: 'channel' }),
      getChatMember: () => ok({ status: 'administrator', can_post_messages: true }),
      sendMessage: () => ok({ message_id: 5 }),
    });
    const l = await tg().connect({ botToken: TOKEN, chat: '-1009876' });
    expect(l).toMatchObject({ tokens: { accessToken: TOKEN }, account: { id: '-1009876', name: 'Team' }, extra: { chatId: '-1009876', username: '', bot: 'boga_bot', type: 'channel' } });
    expect(calls.find((c) => c.method === 'getChatMember')!.body).toEqual({ chat_id: -1009876, user_id: 42 });
    const r = await tg().publish(l, { text: 'Hi', images: [], story: false });
    expect(r.url).toBe('https://t.me/c/9876/5');
  });
});
