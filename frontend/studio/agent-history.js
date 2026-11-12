/* ============================================================
   Agent panel: past chats and inspiration pictures.
   - New chat keeps the current one in the design's history (d.chats, newest first) instead of wiping it.
   - History lists them; opening one swaps it with the current chat, which goes to the history in turn.
   - Inspiration pictures: up to REFS_MAX per message, sent to the model with the words, shown small in the chat.
   Pure: data and markup, given the page's helpers ({ ic, esc, when }). engine.js wires it into the panel.
   ============================================================ */

export const HISTORY_MAX = 20;
export const REFS_MAX = 4;

/** A chat's title: its first request, cut at a word */
export function chatTitle(chat) {
  const u = (chat || []).find((m) => m && m.r === 'u' && String(m.t || '').trim());
  const t = u ? String(u.t).replace(/\s+/g, ' ').trim() : '';
  if (!t) return (chat || []).some((m) => m && m.r === 'u' && m.refs && m.refs.length) ? 'Inspiration pictures' : 'Untitled chat';
  return t.length > 60 ? t.slice(0, 60).replace(/\s+\S*$/, '') + '…' : t;
}

/** Moves the current chat to the history; nothing happens to an empty chat. Returns whether it moved */
export function archiveChat(d, now = Date.now()) {
  const ch = (d && d.chat) || [];
  if (!ch.some((m) => m && m.r === 'u')) { if (d) d.chat = []; return false; }
  ch.forEach((m) => { if (m.r === 'a' && !m.done) { m.done = true; m.t = m.t || 'Stopped.'; } });
  const id = 'c' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  d.chats = [{ id, at: now, title: chatTitle(ch), chat: ch }, ...(d.chats || [])].slice(0, HISTORY_MAX);
  d.chat = [];
  return true;
}

/** Opens a past chat: the current one goes to the history. Returns whether it was found */
export function restoreChat(d, id, now = Date.now()) {
  const list = (d && d.chats) || [], i = list.findIndex((c) => c.id === id);
  if (i < 0) return false;
  const [c] = list.splice(i, 1);
  archiveChat(d, now);
  d.chat = c.chat || [];
  return true;
}

export function dropChat(d, id) {
  const n = ((d && d.chats) || []).length;
  if (n) d.chats = d.chats.filter((c) => c.id !== id);
  return n !== ((d && d.chats) || []).length;
}

/** Adds pictures to the ones waiting to be sent, up to REFS_MAX */
export function addRefs(list, more) {
  const all = [...(list || []), ...(more || [])];
  return { list: all.slice(0, REFS_MAX), dropped: Math.max(0, all.length - REFS_MAX) };
}

/** What the model is told about the pictures (not shown in the chat) */
export function refsNote(n) {
  if (!n) return '';
  return `The user attached ${n === 1 ? 'an inspiration picture' : `${n} inspiration pictures`}, shown before the message. Use ${n === 1 ? 'it' : 'them'} as a style reference (layout, colours, type, mood) and apply that style with the brand kit; do not copy ${n === 1 ? 'its' : 'their'} text, logos or people.`;
}

/** The pictures waiting above the text box; act: the remove action */
export function refsStripHTML({ ic, esc }, refs, act) {
  if (!refs || !refs.length) return '';
  return `<div class="ag-refs" aria-label="Inspiration pictures">${refs.map((r, i) => `<span class="ag-ref"><img src="${esc(r.thumb)}" alt="Inspiration ${i + 1}"><button data-act="${esc(act)}" data-i="${i}" title="Remove this picture" aria-label="Remove picture ${i + 1}">${ic('x', 11)}</button></span>`).join('')}</div>`;
}

/** The history list, in place of the thread */
export function historyHTML({ ic, esc, when }, d) {
  const list = (d && d.chats) || [], cur = (d && d.chat) || [];
  const now = cur.some((m) => m && m.r === 'u')
    ? `<div class="ag-hi on"><span class="ag-hi-t"><b>${esc(chatTitle(cur))}</b><small>Current chat · ${cur.filter((m) => m.r === 'u').length} message${cur.filter((m) => m.r === 'u').length === 1 ? '' : 's'}</small></span><button class="ag-mini" data-act="agHist">Back</button></div>` : '';
  const rows = list.map((c) => {
    const n = (c.chat || []).filter((m) => m.r === 'u').length;
    return `<div class="ag-hi"><button class="ag-hi-t" data-act="agHistOpen" data-id="${esc(c.id)}" title="Open this chat"><b>${esc(c.title || chatTitle(c.chat))}</b><small>${esc(when(c.at))} · ${n} message${n === 1 ? '' : 's'}</small></button><button class="ag-hi-x" data-act="agHistDrop" data-id="${esc(c.id)}" title="Delete this chat" aria-label="Delete this chat">${ic('trash', 14)}</button></div>`;
  }).join('');
  const empty = list.length ? '' : `<div class="ag-hi-empty">${ic('history', 22)}<p>No past chats yet. When you start a new chat, this one is kept here.</p></div>`;
  return `<div class="ag-hist"><div class="ag-lbl">Chats on this design</div>${now}${rows}${empty}</div>`;
}
