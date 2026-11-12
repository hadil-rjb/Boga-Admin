import { describe, it, expect } from 'vitest';
import { chatTitle, archiveChat, restoreChat, dropChat, addRefs, refsNote, refsStripHTML, historyHTML, HISTORY_MAX, REFS_MAX } from './agent-history.js';

const h = { ic: (n) => `[${n}]`, esc: (s) => String(s).replace(/</g, '&lt;'), when: () => 'today' };
const chat = (t) => [{ r: 'u', t }, { r: 'a', t: 'Done.', done: true }];

describe('chatTitle', () => {
  it('is the first request, cut at a word', () => {
    expect(chatTitle(chat('Make the headline bigger'))).toBe('Make the headline bigger');
    const long = chatTitle(chat('word '.repeat(30)));
    expect(long.length).toBeLessThanOrEqual(61); expect(long.endsWith('…')).toBe(true);
  });
  it('names a chat of pictures only, or an empty one', () => {
    expect(chatTitle([{ r: 'u', t: '', refs: ['x'] }])).toBe('Inspiration pictures');
    expect(chatTitle([])).toBe('Untitled chat');
  });
});

describe('archiveChat / restoreChat / dropChat', () => {
  it('New chat keeps the current one, newest first', () => {
    const d = { chat: chat('one') };
    expect(archiveChat(d, 1)).toBe(true); expect(d.chat).toEqual([]);
    d.chat = chat('two'); archiveChat(d, 2);
    expect(d.chats.map((c) => c.title)).toEqual(['two', 'one']);
  });
  it('an empty chat is not kept', () => {
    const d = { chat: [] }; expect(archiveChat(d)).toBe(false); expect(d.chats).toBeUndefined();
  });
  it('a running answer is closed when kept', () => {
    const d = { chat: [{ r: 'u', t: 'go' }, { r: 'a', done: false, t: '' }] }; archiveChat(d);
    expect(d.chats[0].chat[1].done).toBe(true);
  });
  it('keeps at most HISTORY_MAX chats', () => {
    const d = {}; for (let i = 0; i < HISTORY_MAX + 5; i++) { d.chat = chat('c' + i); archiveChat(d, i); }
    expect(d.chats).toHaveLength(HISTORY_MAX); expect(d.chats[0].title).toBe('c' + (HISTORY_MAX + 4));
  });
  it('opening a past chat swaps it with the current one', () => {
    const d = { chat: chat('old') }; archiveChat(d, 1); const id = d.chats[0].id;
    d.chat = chat('new');
    expect(restoreChat(d, id, 2)).toBe(true);
    expect(d.chat[0].t).toBe('old'); expect(d.chats.map((c) => c.title)).toEqual(['new']);
    expect(restoreChat(d, 'nope')).toBe(false);
  });
  it('deletes one chat', () => {
    const d = { chat: chat('a') }; archiveChat(d, 1); const id = d.chats[0].id;
    expect(dropChat(d, id)).toBe(true); expect(d.chats).toEqual([]); expect(dropChat(d, id)).toBe(false);
  });
});

describe('inspiration pictures', () => {
  it('keeps at most REFS_MAX and says how many were left out', () => {
    const r = addRefs([1, 2], [3, 4, 5, 6]);
    expect(r.list).toHaveLength(REFS_MAX); expect(r.dropped).toBe(2);
  });
  it('tells the model to use them as a style reference', () => {
    expect(refsNote(0)).toBe(''); expect(refsNote(1)).toContain('an inspiration picture'); expect(refsNote(3)).toContain('3 inspiration pictures');
  });
  it('draws the waiting pictures with a remove button', () => {
    expect(refsStripHTML(h, [], 'x')).toBe('');
    const s = refsStripHTML(h, [{ thumb: 'data:a' }, { thumb: 'data:b' }], 'agRefDrop');
    expect(s.match(/<img/g)).toHaveLength(2); expect(s).toContain('data-act="agRefDrop" data-i="1"');
  });
});

describe('historyHTML', () => {
  it('lists past chats, escaped, with open and delete', () => {
    const d = { chat: [], chats: [{ id: 'c1', at: 1, title: 'A <b>', chat: chat('A <b>') }] };
    const s = historyHTML(h, d);
    expect(s).toContain('data-act="agHistOpen" data-id="c1"'); expect(s).toContain('data-act="agHistDrop"'); expect(s).toContain('A &lt;b>');
  });
  it('shows the current chat and an empty state', () => {
    const s = historyHTML(h, { chat: chat('now') });
    expect(s).toContain('Current chat'); expect(s).toContain('No past chats yet');
  });
});
