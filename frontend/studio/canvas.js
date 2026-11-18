/* eslint-disable */
// @ts-nocheck
/* ============================================================
   Creative Canvas — an infinite board for ideas and drafts (#/canvas, #/canvas/<id>)
   Text, sticky notes, images, shapes, pen drawings and connectors on a pan/zoom board,
   with multi-selection, groups, undo/redo, copy/paste and auto-save to the API
   (/social/brands/:brand/canvas, Mongo collection social_canvas_boards).
   A selection becomes a Studio design (as arranged, or one slide per note) or a draft post.
   The board is plain DOM in world units under one CSS transform; the selection, marquee and
   handles are drawn in screen units on an overlay.
   ============================================================ */
import { IC } from './icons';
import { RATIOS, uid } from './templates';
import { STICKY, INK, FILLS, DEFAULT_INK, hasText, clone, boxOf, unionBox, intersects, connectorPts, smoothD, pathFrom, shapeD, captionOf, toLayers, notesToPages, generateRequest, photoLayers } from './canvas-model.js';

const NEW_ICONS = {
  sticky: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>',
  pointer: '<path d="M4.04 4.95a.68.68 0 0 1 .91-.91l15.53 6.33a.68.68 0 0 1-.09 1.29l-5.95 1.53a2 2 0 0 0-1.44 1.44l-1.53 5.95a.68.68 0 0 1-1.29.09Z"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  draw: '<path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85Z"/>',
  connect: '<path d="M5 19 19 5"/><path d="M10 5h9v9"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  diamond: '<path d="M12 2.8 21.2 12 12 21.2 2.8 12Z"/>',
  triangle: '<path d="M12 3.5 21 20H3Z"/>',
  fit: '<path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/>',
  group: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M7 15v2a2 2 0 0 0 2 2h2"/><path d="M17 9V7a2 2 0 0 0-2-2h-2"/>',
  canvasNav: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h4v4H7z"/><path d="M14 14h3"/><path d="m11 12 3 2"/>',
};

const TOOLS = [
  ['select', 'pointer', 'Select', 'V'], ['hand', 'hand', 'Hand', 'H'], ['text', 'type', 'Text', 'T'], ['sticky', 'sticky', 'Sticky note', 'S'],
  ['shape', 'square', 'Shape', 'R'], ['pen', 'draw', 'Pen', 'P'], ['connector', 'connect', 'Connector', 'C'], ['image', 'image', 'Image', 'I'],
];
const SHAPES = [['rect', 'square', 'Rectangle'], ['ellipse', 'circle', 'Ellipse'], ['diamond', 'diamond', 'Diamond'], ['triangle', 'triangle', 'Triangle']];
const Z_MIN = 0.1, Z_MAX = 4;
const CLIP = 'boga-canvas:';

export function installCanvas(ctx) {
  const { S, NAV, PAGES, ACT, api, ic, esc, toast, modal, brand, createDesign, persist, schedTz, nowIn, thumb } = ctx;
  const user = () => ctx.user || {};
  const route = () => ctx.route();
  const { document, addEventListener, setTimeout, clearTimeout, requestAnimationFrame } = ctx.scope;
  const save = () => ctx.save();
  Object.assign(IC, NEW_ICONS);
  NAV.splice(NAV.findIndex((n) => n[0] === 'studio') + 1, 0, ['canvas', 'Canvas', 'canvasNav', 'New']);

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const base = (b = S.active) => '/social/brands/' + encodeURIComponent(b) + '/canvas';
  const ro = () => !!persist.readOnly;
  const boardHash = () => { const m = /^#\/canvas\/([\w-]+)/.exec(location.hash); return m ? m[1] : null; };
  const ago = (t) => {
    if (!t) return ''; const m = Math.floor((Date.now() - new Date(t).getTime()) / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return m < 1 ? 'Just now' : m < 60 ? m + ' min ago' : h < 24 ? h + ' h ago' : d === 1 ? 'Yesterday' : d < 7 ? d + ' days ago' : new Date(t).toLocaleDateString('en', { day: 'numeric', month: 'short' });
  };

  /* ================= board list (#/canvas) ================= */
  const LST = { list: null, brand: null, loading: null, err: '', q: '', tab: 0, cache: {}, stale: false }; // cache: the last list per brand, shown at once while a fresh one loads
  function loadList(force) {
    if (LST.loading && !force) return LST.loading;
    const b = S.active;
    LST.loading = api(base(b)).then((r) => {
      const same = JSON.stringify(LST.cache[b]) === JSON.stringify(r); LST.cache[b] = r;
      if (S.active !== b) return false;
      const had = !!LST.list && !LST.err; LST.list = r; LST.brand = b; LST.err = '';
      return !(had && same); // redraw only when something changed
    }).catch((e) => { LST.err = e.message; return true; })
      .then((redraw) => { LST.loading = null; if (redraw && location.hash === '#/canvas') route(); });
    return LST.loading;
  }
  /** A board's miniature for its card: notes with their text, photos, shapes, drawings and links, scaled to fit */
  function miniMap(items) {
    const m = new Map(items.map((e) => [e.id, e]));
    const tw = (e) => (e.k === 'text' && !e.fixed ? Math.max(e.w, Math.round(String(e.text || '').split('\n').reduce((m, l) => Math.max(m, l.length), 0) * (e.size || 24) * 0.58)) : e.w);
    const box = unionBox(items.filter((e) => e.k !== 'connector' && (e.w || e.h)).map((e) => ({ x: e.x, y: e.y, w: tw(e), h: e.h })));
    if (!box) return `<span class="cv-mm-empty">${ic('sticky', 22)}<b>Empty board</b><small>Open it to add your first idea</small></span>`;
    const pad = Math.max(box.w, box.h) * 0.08 + 8, k = Math.max(box.w, box.h) / 400; // k: board units per card pixel, keeps strokes visible
    const ink = (c) => (!c || c === DEFAULT_INK ? 'currentColor' : esc(c));
    const label = (e, x, y, w, h, o = '') => `<foreignObject x="${x}" y="${y}" width="${Math.max(1, w)}" height="${Math.max(1, h)}"><div xmlns="http://www.w3.org/1999/xhtml" class="cv-mm-tx" style="font-size:${e.size || (e.k === 'text' ? 24 : 18)}px;${e.weight ? `font-weight:${e.weight};` : ''}${o}">${esc(e.text || '')}</div></foreignObject>`;
    const body = items.map((e, i) => {
      if (e.k === 'connector') { if (!e.a || !e.b) return ''; const [[ax, ay], [bx, by]] = connectorPts(e, m); return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${esc(e.stroke || '#64748b')}" stroke-width="${Math.max(e.sw || 2, 1.5 * k)}" stroke-linecap="round"/>`; }
      if (e.k === 'sticky') return `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="4" fill="${esc(e.fill || STICKY[0])}" filter="url(#cvmmSh)"/>${e.text ? label(e, e.x + 16, e.y + 16, e.w - 32, e.h - 32, 'color:#1f2937;') : ''}`;
      if (e.k === 'text') return e.text ? label(e, e.x, e.y, e.fixed ? e.w : 640, e.h + 4, `${e.color && e.color !== DEFAULT_INK ? `color:${esc(e.color)};` : ''}white-space:${e.fixed ? 'pre-wrap' : 'pre'};`) : '';
      if (e.k === 'image') return `<clipPath id="cvmmC${i}"><rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="4"/></clipPath><rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="4" fill="#cbd5e1"/>${e.src ? `<image href="${esc(e.src)}" x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cvmmC${i})"/>` : ''}`;
      if (e.k === 'shape') {
        const d = shapeD(e.shape, e.w, e.h), fill = e.fill && e.fill !== 'transparent' ? esc(e.fill) : 'none', st = e.stroke ? `stroke="${ink(e.stroke)}" stroke-width="${Math.max(e.sw || 2, k)}"` : '';
        const sh = d ? `<path transform="translate(${e.x} ${e.y})" d="${d}" fill="${fill}" ${st}/>` : e.shape === 'ellipse' ? `<ellipse cx="${e.x + e.w / 2}" cy="${e.y + e.h / 2}" rx="${e.w / 2}" ry="${e.h / 2}" fill="${fill}" ${st}/>` : `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="8" fill="${fill}" ${st}/>`;
        return sh + (e.text ? label(e, e.x + 10, e.y + e.h / 2 - (e.size || 18) * 0.7, e.w - 20, (e.size || 18) * 1.5, `text-align:center;${fill !== 'none' ? 'color:#1e1e1e;' : ''}`) : '');
      }
      if (e.k === 'path' && Array.isArray(e.pts) && e.pts.length >= 4) return `<path transform="translate(${e.x} ${e.y})" d="${smoothD(e.pts)}" fill="none" stroke="${ink(e.stroke)}" stroke-width="${Math.max(e.sw || 4, 1.5 * k)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      return '';
    }).join('');
    return `<svg viewBox="${box.x - pad} ${box.y - pad} ${box.w + 2 * pad} ${box.h + 2 * pad}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><defs><filter id="cvmmSh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="${2 * k}" stdDeviation="${2.5 * k}" flood-opacity=".14"/></filter></defs>${body}</svg>`;
  }
  PAGES.canvas = {
    t: 'Creative Canvas', s: 'Sketch ideas on an infinite board, then turn them into designs and drafts',
    actions: () => (boardHash() || ro() ? '' : `<button class="btn primary" data-act="cvNew">${ic('plus', 18)}New board</button>`),
    view() {
      const id = boardHash();
      if (id) { setTimeout(() => mountBoard(id), 0); return `<div id="cvRoot" class="cv-root"></div>`; }
      unmountBoard();
      // the last list shows right away; a fresh one loads in the background
      if (LST.brand !== S.active) { LST.list = LST.cache[S.active] || null; LST.brand = S.active; LST.stale = false; loadList(true); }
      else if (LST.stale || !LST.list) { LST.stale = false; loadList(true); }
      // the same building blocks as the Studio page: tiles, library bar (tabs + search), design cards
      const start = ro() ? '' : `<div class="tiles cv-tiles">${TEMPLATES.map((t) =>
        `<button class="tile" data-act="cvNew" data-tpl="${t.k}"><span class="shape cv-tpl-ic" style="--tc:${t.c}">${ic(t.i, 20)}</span><span><b>${t.n}</b><small>${t.d}</small></span></button>`).join('')}</div>`;
      const all = LST.list || [];
      const bar = `<div class="lib-bar"><h2 class="cv-h2">Your boards<span>${all.length}</span></h2>
        <label class="lib-q">${ic('search', 16)}<input id="cvQ" type="search" placeholder="Search boards" value="${esc(LST.q)}" aria-label="Search boards"></label></div>`;
      if (!LST.list) return start + (LST.err ? errBox(LST.err) : bar + `<div class="cards">${[0, 1, 2, 3].map(() => '<div class="card"><i class="skel cv-sk"></i><div class="meta"><i class="skel" style="display:block;width:60%;height:12px"></i></div></div>').join('')}</div>`);
      const q = LST.q.trim().toLowerCase(), list = all.filter((b) => !q || b.name.toLowerCase().includes(q));
      const card = (b) => `<div class="card dc cvb">
        <div class="dc-pv"><a class="pv" href="#/canvas/${esc(b.id)}" aria-label="Open ${esc(b.name)}">${miniMap(b.preview || [])}</a></div>
        <div class="meta"><div class="dc-h"><b title="${esc(b.name)}">${esc(b.name)}</b>${ro() ? '' : `<button class="btn ghost icon sm dc-more" data-act="cvMenu" data-id="${esc(b.id)}" title="More actions" aria-label="More actions for ${esc(b.name)}" aria-haspopup="menu">${ic('more', 16)}</button>`}</div>
        <small class="dc-sub"><span class="dc-fmt">${b.count} item${b.count === 1 ? '' : 's'}${b.updatedBy ? ' · ' + esc(b.updatedBy) : ''}</span><time${b.updatedAt ? ` datetime="${esc(new Date(b.updatedAt).toISOString())}"` : ''}>${esc(ago(b.updatedAt))}</time></small></div></div>`;
      const none = (icon, title, text, cta = '') => `<div class="lib-empty">${ic(icon, 24)}<b>${title}</b><p>${text}</p>${cta}</div>`;
      const body = list.length ? `<div class="cards">${list.map(card).join('')}</div>`
        : q ? none('search', 'No results', `Nothing matches “${esc(LST.q.trim())}”.`, '<button class="btn secondary sm" data-act="cvClearQ">Clear search</button>')
        : none('sticky', 'No boards yet', ro() ? 'Boards your team creates show up here.' : 'Pick a starting point above, or start from a blank board.', ro() ? '' : `<button class="btn primary sm" data-act="cvNew">${ic('plus', 16)}New board</button>`);
      return `${LST.err ? errBox(LST.err) : ''}${start}${bar}${body}`;
    },
  };
  setTimeout(() => { if (!LST.list && !ro()) { LST.brand = S.active; loadList(); } }, 1500);
  /** Starting points for a new board */
  const TEMPLATES = [
    { k: 'blank', n: 'Blank board', d: 'An empty board', i: 'plus', c: '#64748b' },
    { k: 'brainstorm', n: 'Brainstorm', d: 'Questions to find your next post', i: 'sticky', c: '#d97706' },
    { k: 'campaign', n: 'Campaign plan', d: 'Before, during and after a launch', i: 'cal', c: '#2563eb' },
    { k: 'carousel', n: 'Carousel outline', d: 'Five slides, hook to call to action', i: 'layers', c: '#7c3aed' },
  ];
  const errBox = (m) => `<div class="note warn">${ic('alert', 16)}<span>Couldn’t load the boards: ${esc(m)}</span><button class="btn secondary sm" data-act="cvReload">Retry</button></div>`;
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'cvQ') return;
    LST.q = e.target.value; const at = e.target.selectionStart; route();
    const f = document.getElementById('cvQ'); if (f) { f.focus(); f.setSelectionRange(at, at); }
  });
  ACT.cvClearQ = () => { LST.q = ''; route(); };
  ACT.cvReload = () => { LST.err = ''; loadList(true); route(); };
  ACT.cvNew = async (a) => {
    if (ro()) return;
    a && (a.disabled = true);
    const t = TEMPLATES.find((x) => x.k === (a && a.dataset.tpl)) || TEMPLATES[0];
    try { const b = await api(base(), { method: 'POST', body: { name: t.k === 'blank' ? 'Untitled board' : t.n, elements: starter(t.k) } }); LST.stale = true; BOARD = boardState(b); location.hash = '#/canvas/' + b.id; }
    catch (e) { toast('Couldn’t create the board: ' + e.message); a && (a.disabled = false); }
  };
  /** What a new board starts with, per template */
  function starter(k) {
    let z = 1;
    const note = (x, y, text, fill = STICKY[0]) => ({ id: uid(), k: 'sticky', x, y, w: 200, h: 200, text, fill, z: z++ });
    const title = (x, y, text, size = 32) => ({ id: uid(), k: 'text', x, y, w: Math.round(text.length * size * 0.6), h: Math.round(size * 1.3), text, size, weight: 700, z: z++ });
    const link = (a, b) => ({ id: uid(), k: 'connector', x: 0, y: 0, w: 0, h: 0, a: { id: a.id }, b: { id: b.id }, stroke: '#64748b', sw: 2, z: z++ });
    if (k === 'brainstorm') {
      const qs = [['Who is it for?', STICKY[0]], ['What do they need to hear?', STICKY[1]], ['Which format? Post, carousel, story', STICKY[5]], ['A hook in one line', STICKY[3]], ['Proof: a number, a quote, a photo', STICKY[6]], ['What should they do next?', STICKY[4]]];
      return [title(0, -80, 'Brainstorm'), ...qs.map(([t, f], i) => note((i % 3) * 230, Math.floor(i / 3) * 230, t, f))];
    }
    if (k === 'campaign') {
      const cols = [['Before launch', 'Teaser: what’s coming', STICKY[0]], ['Launch day', 'Announcement post', STICKY[6]], ['After', 'Results and thank-you', STICKY[5]]];
      return [title(0, -150, 'Campaign plan'), ...cols.flatMap(([h, t, f], i) => [title(i * 260, -70, h, 22), note(i * 260, 0, t, f)])];
    }
    if (k === 'carousel') {
      const slides = ['1 · Hook: stop the scroll', '2 · The problem', '3 · The tip', '4 · Proof or example', '5 · Call to action'];
      const ns = slides.map((t, i) => note(i * 260, 0, t, i === 0 || i === 4 ? STICKY[3] : STICKY[4]));
      return [title(0, -80, 'Carousel outline'), ...ns, ...ns.slice(1).map((n, i) => link(ns[i], n))];
    }
    return [];
  }
  ACT.cvMenu = (a) => {
    const id = a.dataset.id, b = (LST.list || []).find((x) => x.id === id); if (!b) return;
    $$('.cv-pop').forEach((m) => m.remove());
    const m = document.createElement('div'); m.className = 'menu cv-pop';
    m.innerHTML = `<button class="it" data-k="rename">${ic('type', 16)}<b>Rename</b></button><button class="it" data-k="dup">${ic('copy', 16)}<b>Duplicate</b></button><div class="div"></div><button class="it out" data-k="del">${ic('trash', 16)}<b>Delete</b></button>`;
    const r = a.getBoundingClientRect(); Object.assign(m.style, { position: 'fixed', top: r.bottom + 6 + 'px', left: Math.max(8, r.right - 180) + 'px', width: '180px', right: 'auto' });
    document.body.append(m);
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
    m.addEventListener('click', async (e) => {
      const k = e.target.closest('[data-k]') && e.target.closest('[data-k]').dataset.k; if (!k) return; m.remove(); document.removeEventListener('pointerdown', off, true);
      if (k === 'rename') renameBoard(b);
      if (k === 'dup') { try { await api(base() + '/' + id + '/duplicate', { method: 'POST' }); toast('Board duplicated'); loadList(true); } catch (x) { toast(x.message); } }
      if (k === 'del') modal(`<div class="mh"><h2>Delete “${esc(b.name)}”?</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
        <div class="mb"><p class="sm-t">The board and its ${b.count} item${b.count === 1 ? '' : 's'} are removed for everyone. Designs and posts made from it stay.</p></div>
        <div class="mf"><button class="btn secondary" data-close>Cancel</button><button class="btn danger" id="cvDel">${ic('trash', 16)}Delete board</button></div>`, {
        onMount: (bg, close) => $('#cvDel', bg).addEventListener('click', async () => { try { await api(base() + '/' + id, { method: 'DELETE' }); close(); toast('Board deleted'); LST.list = LST.list.filter((x) => x.id !== id); route(); } catch (x) { toast(x.message); } }),
      });
    });
  };
  function renameBoard(b, after) {
    modal(`<div class="mh"><h2>Rename board</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb"><input class="field" id="cvRn" maxlength="80" value="${esc(b.name)}"></div>
      <div class="mf"><button class="btn secondary" data-close>Cancel</button><button class="btn primary" id="cvRnGo">Save</button></div>`, {
      onMount: (bg, close) => {
        const f = $('#cvRn', bg); f.focus(); f.select();
        const go = async () => { const name = f.value.trim(); if (!name) return; try { await api(base() + '/' + b.id, { method: 'PUT', body: { name, force: true } }); b.name = name; close(); after ? after(name) : route(); } catch (x) { toast(x.message); } };
        $('#cvRnGo', bg).addEventListener('click', go); f.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      },
    });
  }

  /* ================= board state ================= */
  let BOARD = null; // { id, brand, name, els, rev, view, dirty, saving, status, hist }
  const boardState = (b) => ({ id: b.id, brand: S.active, name: b.name, els: b.elements || [], rev: b.rev || 1, view: b.viewport || { x: 0, y: 0, z: 1 }, fresh: !(b.viewport && (b.viewport.x || b.viewport.y)), dirty: false, saving: false, status: 'saved', past: [], future: [] });
  const U = { tool: 'select', shape: 'rect', sel: new Set(), edit: null, space: false, sticky: STICKY[0], ink: DEFAULT_INK, sw: 4, pop: null, gesture: null, hover: null, root: null };
  let T = {}; // timers

  /* ---------- mount / unmount ---------- */
  let dead = false; // this studio instance was unmounted (a request it started may still answer: it must not touch the page)
  async function mountBoard(id) {
    const root = $('#cvRoot'); if (!root || dead) return;
    document.body.classList.add('cv-full');
    if (!BOARD || BOARD.id !== id || BOARD.brand !== S.active) {
      if (BOARD && BOARD.dirty) await flush();
      root.innerHTML = `<div class="cv-loading">${ic('sticky', 22)}<span>Opening the board…</span></div>`;
      try { const b = await api(base() + '/' + id); if (dead || boardHash() !== id) return; BOARD = boardState(b); U.sel.clear(); }
      catch (e) { root.innerHTML = `<div class="cv-loading"><b>${esc(e.message)}</b><a class="btn secondary sm" href="#/canvas">Back to boards</a></div>`; return; }
    }
    if (dead || !$('#cvRoot')) return;
    U.root = $('#cvRoot'); U.edit = null; U.gesture = null;
    U.root.innerHTML = shellHTML();
    bindBoard();
    if (BOARD.fresh) { BOARD.fresh = false; fit(false); }
    paint(); chrome();
  }
  function unmountBoard() {
    document.body.classList.remove('cv-full');
    if (!U.root) return;
    endEdit(); closePop(); U.root.innerHTML = ''; U.root = null;
    if (BOARD && BOARD.dirty) flush();
    if (BOARD) saveView(true);
  }
  addEventListener('hashchange', () => { if (!boardHash()) unmountBoard(); });
  addEventListener('pagehide', () => { if (BOARD && BOARD.dirty) flush(true); });

  /* ---------- shell ---------- */
  function shellHTML() {
    const lock = ro();
    return `<div class="cv" id="cv" data-tool="${U.tool}">
      <div class="cv-stage" id="cvStage" tabindex="-1">
        <div class="cv-world" id="cvWorld"><div id="cvEls"></div><svg class="cv-links" id="cvLinks"></svg><svg class="cv-draft" id="cvDraft"></svg><div id="cvEditL"></div></div>
        <div class="cv-ov" id="cvOv"></div>
      </div>
      <div class="cv-bar cv-tl">
        <a class="btn ghost icon sm" href="#/canvas" title="All boards" aria-label="All boards">${ic('chevL', 18)}</a>
        <input class="cv-name" id="cvName" value="${esc(BOARD.name)}" maxlength="80" ${lock ? 'readonly' : ''} aria-label="Board name" title="${lock ? '' : 'Rename the board'}" spellcheck="false">
        <span class="cv-st" id="cvSt"></span>
      </div>
      <div class="cv-bar cv-tr">
        ${lock ? '<span class="cv-ro">View only</span>' : `<button class="btn secondary sm" data-cv="toDesign" id="cvToD">${ic('layout', 16)}<span>Make design</span></button><button class="btn primary sm cv-gen" data-cv="generate" id="cvGen">${ic('studio', 16)}<span>Generate design</span></button>`}
      </div>
      <div class="cv-tools" role="toolbar" aria-label="Canvas tools">
        ${TOOLS.filter(([k]) => !lock || k === 'select' || k === 'hand').map(([k, i, l, key]) => `<button data-cv="tool" data-k="${k}" data-cvtip="${l}" data-key="${key}" aria-label="${l} (${key})">${ic(k === 'shape' ? (SHAPES.find((s) => s[0] === U.shape) || SHAPES[0])[1] : i, 20)}</button>`).join('')}
      </div>
      <div class="cv-ctx" id="cvCtx" hidden></div>
      <div class="cv-bar cv-br">
        ${lock ? '' : `<button class="btn ghost icon sm" data-cv="undo" title="Undo (⌘Z)" aria-label="Undo">${ic('undo', 18)}</button><button class="btn ghost icon sm" data-cv="redo" title="Redo (⇧⌘Z)" aria-label="Redo">${ic('redo', 18)}</button><span class="sep"></span>`}
        <button class="btn ghost icon sm" data-cv="zout" title="Zoom out (⌘−)" aria-label="Zoom out">${ic('minus', 18)}</button>
        <button class="cv-zoom" data-cv="z100" id="cvZ" title="Reset to 100%">100%</button>
        <button class="btn ghost icon sm" data-cv="zin" title="Zoom in (⌘+)" aria-label="Zoom in">${ic('plus', 18)}</button>
        <button class="btn ghost icon sm" data-cv="fit" title="Zoom to fit (⇧1)" aria-label="Zoom to fit">${ic('fit', 18)}</button><span class="sep"></span>
        <button class="btn ghost icon sm" data-cv="theme" title="${S.theme === 'dark' ? 'Light' : 'Dark'} theme" aria-label="Switch theme">${ic(S.theme === 'dark' ? 'sun' : 'moon', 18)}</button>
      </div>
      <input type="file" id="cvFile" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    </div>`;
  }

  /* ---------- coordinates ---------- */
  const V = () => BOARD.view;
  const stage = () => $('#cvStage', U.root);
  const rectOf = () => stage().getBoundingClientRect();
  const toWorld = (cx, cy) => { const r = rectOf(), v = V(); return [(cx - r.left - v.x) / v.z, (cy - r.top - v.y) / v.z]; };
  const toScreen = (x, y) => { const v = V(); return [x * v.z + v.x, y * v.z + v.y]; };
  const byId = () => new Map(BOARD.els.map((e) => [e.id, e]));
  const getEl = (id) => BOARD.els.find((e) => e.id === id);
  const topZ = () => BOARD.els.reduce((m, e) => Math.max(m, e.z || 0), 0) + 1;
  const selEls = () => BOARD.els.filter((e) => U.sel.has(e.id));

  /* ---------- rendering ---------- */
  let raf = 0;
  function paint() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (!U.root) return; renderEls(); renderLinks(); applyView(); }); }
  function applyView() {
    if (!U.root) return; const v = V(), st = stage(), w = $('#cvWorld', U.root);
    w.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.z})`;
    let g = 22 * v.z; while (g < 16) g *= 2; while (g > 36) g /= 2; // dots stay evenly spaced on screen at any zoom
    st.style.backgroundSize = `${g}px ${g}px`; st.style.backgroundPosition = `${v.x}px ${v.y}px`;
    const z = $('#cvZ', U.root); if (z) z.textContent = Math.round(v.z * 100) + '%';
    renderOverlay();
  }
  const sorted = () => [...BOARD.els].sort((a, b) => (a.z || 0) - (b.z || 0));
  function elHTML(e) {
    const st = `left:${e.x}px;top:${e.y}px;width:${e.w}px;${e.k === 'text' ? 'min-height' : 'height'}:${e.h}px${e.rot ? `;transform:rotate(${e.rot}deg)` : ''}`;
    const cls = `cv-el cv-${e.k}${U.sel.has(e.id) ? ' on' : ''}${e.locked ? ' locked' : ''}${U.edit === e.id ? ' editing' : ''}${U.hover === e.id ? ' hov' : ''}`;
    const ink = (c) => (!c || c === DEFAULT_INK ? 'currentColor' : c);
    const tcol = e.color && e.color !== DEFAULT_INK ? e.color : e.k === 'shape' && e.fill && e.fill !== 'transparent' ? '#1e1e1e' : '';
    const txt = (o = '') => `<div class="cv-tx" style="font-size:${e.size || (e.k === 'sticky' ? 18 : e.k === 'shape' ? 18 : 24)}px;${tcol ? `color:${tcol};` : ''}${e.weight ? `font-weight:${e.weight};` : ''}${e.align ? `text-align:${e.align};` : ''}${o}">${esc(e.text || '')}</div>`;
    if (e.k === 'text') return `<div class="${cls}${e.fixed ? '' : ' auto'}" data-eid="${e.id}" style="${e.fixed ? st : st.replace(/width:[\d.]+px;/, `width:max-content;max-width:${TEXT_MAX}px;`)}">${e.text ? txt() : txt('opacity:.4').replace('></div>', '>Type something</div>')}</div>`;
    if (e.k === 'sticky') return `<div class="${cls}" data-eid="${e.id}" style="${st};background:${e.fill || STICKY[0]}">${e.text ? txt(`font-size:${fitSize(e)}px;`) : '<div class="cv-tx cv-ph">Click to write</div>'}</div>`;
    if (e.k === 'image') return `<div class="${cls}" data-eid="${e.id}" style="${st}"><img src="${esc(e.src)}" alt="${esc(e.name || '')}" draggable="false" loading="lazy"></div>`;
    if (e.k === 'shape') {
      const d = shapeD(e.shape, e.w, e.h), fill = e.fill || 'transparent', sw = e.stroke ? e.sw || 2 : 0, strokeA = e.stroke ? `stroke="${ink(e.stroke)}" stroke-width="${sw}"` : '';
      const body = d ? `<path d="${d}" fill="${fill}" ${strokeA} stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : e.shape === 'ellipse' ? `<ellipse cx="${e.w / 2}" cy="${e.h / 2}" rx="${Math.max(0, e.w / 2 - sw / 2)}" ry="${Math.max(0, e.h / 2 - sw / 2)}" fill="${fill}" ${strokeA}/>` : `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, e.w - sw)}" height="${Math.max(0, e.h - sw)}" rx="8" fill="${fill}" ${strokeA}/>`;
      return `<div class="${cls}" data-eid="${e.id}" style="${st}"><svg width="${e.w}" height="${e.h}" viewBox="0 0 ${e.w} ${e.h}">${body}</svg>${e.text ? txt('text-align:center') : ''}</div>`;
    }
    if (e.k === 'path') {
      const d = smoothD(e.pts);
      return `<div class="${cls}" data-eid="${e.id}" style="${st}"><svg width="${e.w}" height="${e.h}" viewBox="0 0 ${e.w} ${e.h}"><path class="cv-hit" data-eid="${e.id}" d="${d}" stroke-width="${Math.max(14, (e.sw || 4) + 10)}"/><path d="${d}" fill="none" stroke="${ink(e.stroke)}" stroke-width="${e.sw || 4}" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
    }
    return '';
  }
  function renderEls() {
    const host = $('#cvEls', U.root); host.innerHTML = sorted().filter((e) => e.k !== 'connector').map(elHTML).join('');
    // text boxes grow with their text: keep their stored height in step (not an edit: no history)
    $$('.cv-text', host).forEach((n) => { const e = getEl(n.dataset.eid); if (!e) return; if (Math.abs(n.offsetHeight - e.h) > 1) e.h = n.offsetHeight; if (!e.fixed && Math.abs(n.offsetWidth - e.w) > 1) e.w = n.offsetWidth; });
  }
  function renderLinks() {
    const m = byId(), svg = $('#cvLinks', U.root);
    svg.innerHTML = `<defs><marker id="cvArr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="context-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>` +
      sorted().filter((e) => e.k === 'connector').map((c) => {
        const [[ax, ay], [bx, by]] = connectorPts(c, m), d = `M${ax} ${ay}L${bx} ${by}`;
        return `<g class="cv-link${U.sel.has(c.id) ? ' on' : ''}"><path class="cv-hit" data-eid="${c.id}" d="${d}" stroke-width="16"/><path d="${d}" fill="none" stroke="${c.stroke || '#64748b'}" stroke-width="${c.sw || 2}" stroke-linecap="round"${c.dash ? ' stroke-dasharray="8 6"' : ''}${c.arrow === false ? '' : ' marker-end="url(#cvArr)"'}/>${c.label ? `<text x="${(ax + bx) / 2}" y="${(ay + by) / 2 - 8}" text-anchor="middle">${esc(c.label)}</text>` : ''}</g>`;
      }).join('');
  }
  /** Selection box, handles and marquee, in screen units */
  function renderOverlay() {
    const ov = U.root && $('#cvOv', U.root); if (!ov) return;
    let h = '';
    const els = selEls(), m = byId();
    if (els.length && !U.edit) {
      const b = unionBox(els.map((e) => boxOf(e, m)));
      const [x, y] = toScreen(b.x, b.y), w = b.w * V().z, hh = b.h * V().z;
      const onlyLinks = els.every((e) => e.k === 'connector'), locked = els.some((e) => e.locked);
      if (!onlyLinks) {
        h += `<div class="cv-selbox${locked ? ' locked' : ''}" style="left:${x}px;top:${y}px;width:${w}px;height:${hh}px"></div>`;
        if (!locked && !ro() && !(U.gesture && U.gesture.kind === 'move')) h += ['nw', 'ne', 'sw', 'se'].map((c) => `<span class="cv-h" data-h="${c}" style="left:${c[1] === 'w' ? x : x + w}px;top:${c[0] === 'n' ? y : y + hh}px"></span>`).join('');
        if (els.length > 1 || els[0].group) els.forEach((e) => { const q = boxOf(e, m), [ex, ey] = toScreen(q.x, q.y); h += `<div class="cv-selone" style="left:${ex}px;top:${ey}px;width:${q.w * V().z}px;height:${q.h * V().z}px"></div>`; });
      }
    }
    const g = U.gesture;
    if (g && g.kind === 'marquee' && g.moved) { const [x0, y0] = toScreen(Math.min(g.x0, g.x1), Math.min(g.y0, g.y1)); h += `<div class="cv-marq" style="left:${x0}px;top:${y0}px;width:${Math.abs(g.x1 - g.x0) * V().z}px;height:${Math.abs(g.y1 - g.y0) * V().z}px"></div>`; }
    if (g && g.kind === 'shape' && g.moved) { const [x0, y0] = toScreen(Math.min(g.x0, g.x1), Math.min(g.y0, g.y1)); h += `<div class="cv-marq cv-ghost" style="left:${x0}px;top:${y0}px;width:${Math.abs(g.x1 - g.x0) * V().z}px;height:${Math.abs(g.y1 - g.y0) * V().z}px;border-radius:${U.shape === 'ellipse' ? '50%' : '6px'}"></div>`; }
    ov.innerHTML = h;
    ctxBar();
  }
  function renderDraft() {
    const svg = $('#cvDraft', U.root), g = U.gesture; if (!svg) return;
    if (g && g.kind === 'pen') svg.innerHTML = `<path d="${smoothD(g.pts)}" fill="none" stroke="${U.ink === DEFAULT_INK ? 'currentColor' : U.ink}" stroke-width="${U.sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    else if (g && g.kind === 'link' && g.moved) { const m = byId(), c = { a: g.a, b: U.hover ? { id: U.hover } : { x: g.x1, y: g.y1 } }, [[ax, ay], [bx, by]] = connectorPts(c, m); svg.innerHTML = `<path d="M${ax} ${ay}L${bx} ${by}" stroke="#64748b" stroke-width="${2 / Math.min(1, V().z)}" stroke-dasharray="6 5" fill="none"/>`; }
    else svg.innerHTML = '';
  }

  /* ---------- chrome: tools, status, contextual bar ---------- */
  function chrome() {
    if (!U.root) return;
    const cv = $('#cv', U.root); cv.dataset.tool = U.tool;
    $$('[data-cv=tool]', U.root).forEach((b) => b.classList.toggle('on', b.dataset.k === U.tool));
    const u = $('[data-cv=undo]', U.root), r = $('[data-cv=redo]', U.root);
    if (u) u.disabled = !BOARD.past.length; if (r) r.disabled = !BOARD.future.length;
    const n = selEls().length, d = $('#cvToD', U.root), g = $('#cvGen', U.root);
    if (d) d.title = n ? 'Lay the selection out as a Studio design' : 'Lay the whole board out as a Studio design (or select items first)';
    if (g) { g.title = n ? 'Let the Studio Agent design a post from the selection' : 'Let the Studio Agent design a post from the whole board (or select items first)'; const sp = $('span', g); if (sp) sp.textContent = n ? `Generate from ${n} item${n === 1 ? '' : 's'}` : 'Generate design'; }
    hint(); status();
  }
  function hint() {
    const el = U.root && $('#cvHint', U.root); if (!el) return;
    const n = selEls().length, t = U.tool;
    const tip = ro() ? 'Drag to move around · ⌘ + scroll to zoom'
      : t === 'sticky' ? 'Click anywhere to place a note'
      : t === 'text' ? 'Click to add text'
      : t === 'shape' ? 'Drag to draw · hold Shift for a perfect square or circle'
      : t === 'pen' ? 'Draw freely · press Esc when you’re done'
      : t === 'connector' ? 'Drag from one item to another to link them'
      : t === 'hand' ? 'Drag to move around the board'
      : n === 1 && selEls()[0] && (hasText(selEls()[0]) || selEls()[0].k === 'sticky') ? `<b>Click again to write</b> · Tab adds the next note · ${ic('studio', 13)} Generate turns it into a post`
      : n ? `<b>${n} selected</b> · ${ic('studio', 13)} Generate turns ${n === 1 ? 'it' : 'them'} into a post · drag to move · ⌫ to delete`
      : BOARD.els.length ? 'Double-click to add a note · drag to select · drop or paste images' : '<b>Start here:</b> double-click anywhere to add your first idea';
    el.innerHTML = tip;
  }
  function status() {
    const el = U.root && $('#cvSt', U.root); if (!el) return;
    const s = ro() ? 'ro' : BOARD.status;
    el.dataset.s = s;
    el.innerHTML = { saved: `${ic('check', 14)}Saved`, saving: '<i class="cv-spin"></i>Saving…', unsaved: 'Unsaved changes', error: `${ic('alert', 14)}Offline, retrying`, conflict: `${ic('alert', 14)}Changed elsewhere`, ro: '' }[s] || '';
  }
  function ctxBar() {
    const bar = U.root && $('#cvCtx', U.root); if (!bar) return;
    const els = selEls();
    if (!els.length || U.edit || U.gesture || ro()) { bar.hidden = true; return; }
    const kinds = new Set(els.map((e) => e.k)), one = els.length === 1 ? els[0] : null, locked = els.some((e) => e.locked);
    const sw = (list, key, cur) => `<div class="cv-sw">${list.map((c) => `<button data-cv="set" data-p="${key}" data-v="${c}" class="${c === cur ? 'on' : ''}${c === 'transparent' ? ' none' : ''}" style="--c:${c}" title="${c}" aria-label="${key} ${c}"></button>`).join('')}</div>`;
    const all = (...k) => els.every((e) => k.includes(e.k));
    let h = '';
    if (!locked && els.some((e) => hasText(e) || e.k === 'image')) h += `<div class="cv-grp"><button class="btn primary sm cv-gen" data-cv="generate" title="Let the Studio Agent design a post from the selection">${ic('studio', 15)}Generate</button></div>`;
    if (!locked) {
      if (all('sticky')) h += `<div class="cv-grp">${sw(STICKY, 'fill', one && one.fill)}</div>`;
      else if (all('shape')) h += `<div class="cv-grp">${sw(FILLS.slice(0, 8), 'fill', one && one.fill)}</div>`;
      else if (all('text')) h += `<div class="cv-grp">${sw(INK.slice(0, 8), 'color', one && (one.color || DEFAULT_INK))}</div>`;
      else if (all('path', 'connector')) h += `<div class="cv-grp">${sw(INK.slice(0, 8), 'stroke', one && one.stroke)}</div>`;
      if (els.some((e) => e.k === 'text' || e.k === 'sticky' || e.k === 'shape')) {
        const size = one ? one.size || (one.k === 'text' ? 24 : 18) : '';
        h += `<div class="cv-grp"><button class="btn ghost icon sm" data-cv="font" data-n="-1" title="Smaller text" aria-label="Smaller text">${ic('minus', 14)}</button><span class="cv-fs" title="Text size">${size || 'Aa'}</span><button class="btn ghost icon sm" data-cv="font" data-n="1" title="Larger text" aria-label="Larger text">${ic('plus', 14)}</button>
          <button class="btn ghost icon sm${one && one.weight >= 700 ? ' on' : ''}" data-cv="bold" title="Bold (⌘B)" aria-label="Bold"><b style="font-size:14px">B</b></button>
          ${all('text', 'shape') ? ['left', 'center', 'right'].map((a, i) => `<button class="btn ghost icon sm${one && (one.align || (one.k === 'shape' ? 'center' : 'left')) === a ? ' on' : ''}" data-cv="set" data-p="align" data-v="${a}" title="Align ${a}" aria-label="Align ${a}">${ic(['alL', 'alC', 'alR'][i], 16)}</button>`).join('') : ''}</div>`;
      }
      if (kinds.has('connector') && one) h += `<div class="cv-grp"><button class="btn ghost sm${one.arrow === false ? '' : ' on'}" data-cv="toggle" data-p="arrow">Arrow</button><button class="btn ghost sm${one.dash ? ' on' : ''}" data-cv="toggle" data-p="dash">Dashed</button></div>`;
    }
    h += `<div class="cv-grp">${locked ? '' : `<button class="btn ghost icon sm" data-cv="dup" title="Duplicate (⌘D)" aria-label="Duplicate">${ic('copy', 16)}</button><button class="btn ghost icon sm" data-cv="del" title="Delete (⌫)" aria-label="Delete">${ic('trash', 16)}</button>`}
      <button class="btn ghost icon sm" data-cv="more" title="More" aria-label="More actions">${ic(locked ? 'lock' : 'more', 16)}</button></div>`;
    bar.innerHTML = h; bar.hidden = false;
    // above the selection, kept on screen
    const b = unionBox(els.map((e) => boxOf(e, byId()))), [sx, sy] = toScreen(b.x + b.w / 2, b.y), [, sy2] = toScreen(0, b.y + b.h), r = rectOf();
    if (!intersects(b, visibleBox())) { bar.hidden = true; return; } // the selection is off screen
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    const lift = 0;
    let top = sy - bh - 14 - lift; if (top < 64) top = Math.min(r.height - bh - 70, sy2 + 14 + lift);
    bar.style.left = Math.max(8, Math.min(r.width - bw - 8, sx - bw / 2)) + 'px'; bar.style.top = Math.max(64, top) + 'px';
  }

  /* ---------- history + auto-save ---------- */
  const snap = () => JSON.stringify(BOARD.els);
  function record(before) {
    if (before === snap()) return false;
    BOARD.past.push(before); if (BOARD.past.length > 100) BOARD.past.shift(); BOARD.future = [];
    dirty(); return true;
  }
  function change(fn) { if (ro()) return; const b = snap(); fn(); if (record(b)) { paint(); chrome(); } }
  function undo() { if (!BOARD.past.length || ro()) return; endEdit(); BOARD.future.push(snap()); BOARD.els = JSON.parse(BOARD.past.pop()); pruneSel(); dirty(); paint(); chrome(); }
  function redo() { if (!BOARD.future.length || ro()) return; endEdit(); BOARD.past.push(snap()); BOARD.els = JSON.parse(BOARD.future.pop()); pruneSel(); dirty(); paint(); chrome(); }
  const pruneSel = () => { const ids = new Set(BOARD.els.map((e) => e.id)); [...U.sel].forEach((id) => !ids.has(id) && U.sel.delete(id)); };
  function dirty() { BOARD.dirty = true; if (BOARD.status !== 'conflict') BOARD.status = 'unsaved'; status(); clearTimeout(T.save); T.save = setTimeout(flush, 700); }
  async function flush(keepalive) {
    const b = BOARD; if (!b || !b.dirty || b.saving || ro() || b.status === 'conflict') return;
    b.saving = true; b.dirty = false; b.status = 'saving'; status();
    try {
      const r = await api(base(b.brand) + '/' + b.id, { method: 'PUT', body: { elements: b.els, name: b.name, rev: b.rev }, ...(keepalive ? { keepalive: true } : {}) });
      b.rev = r.rev; b.status = b.dirty ? 'unsaved' : 'saved'; b.retry = 0; LST.stale = true;
    } catch (e) {
      b.dirty = true;
      if (e.status === 409) { b.status = 'conflict'; if (b === BOARD) conflict(); }
      else if (e.status === 404) { b.status = 'error'; toast('This board was deleted'); location.hash = '#/canvas'; }
      else { b.status = 'error'; b.retry = Math.min(30000, (b.retry || 2000) * 2); clearTimeout(T.save); T.save = setTimeout(flush, b.retry); }
    } finally { b.saving = false; if (b === BOARD) status(); if (b.dirty && b.status === 'unsaved') { clearTimeout(T.save); T.save = setTimeout(flush, 300); } }
  }
  function conflict() {
    modal(`<div class="mh"><h2>This board changed somewhere else</h2></div>
      <div class="mb"><p class="sm-t">Someone (or another tab) saved this board while you were editing. Load their version, or keep yours and replace it.</p></div>
      <div class="mf"><button class="btn secondary" id="cvTheirs">Load the latest</button><button class="btn primary" id="cvMine">Keep my version</button></div>`, {
      onMount: (bg, close) => {
        $('#cvTheirs', bg).addEventListener('click', async () => { close(); try { const b = await api(base() + '/' + BOARD.id); const v = BOARD.view; BOARD = boardState(b); BOARD.view = v; BOARD.fresh = false; U.sel.clear(); paint(); chrome(); toast('Loaded the latest version'); } catch (e) { toast(e.message); } });
        $('#cvMine', bg).addEventListener('click', async () => { close(); try { const r = await api(base() + '/' + BOARD.id, { method: 'PUT', body: { elements: BOARD.els, name: BOARD.name, force: true } }); BOARD.rev = r.rev; BOARD.dirty = false; BOARD.status = 'saved'; status(); } catch (e) { toast(e.message); } });
      },
    });
  }
  /** Pan and zoom are remembered per board (no revision, no history) */
  function saveView(now) {
    clearTimeout(T.view);
    const b = BOARD, go = () => api(base(b.brand) + '/' + b.id + '/view', { method: 'PUT', body: { viewport: b.view } }).catch(() => {});
    if (now) go(); else T.view = setTimeout(go, 1500);
  }

  /* ---------- view ---------- */
  function zoomAt(sx, sy, z) {
    const v = V(), nz = Math.min(Z_MAX, Math.max(Z_MIN, z)), wx = (sx - v.x) / v.z, wy = (sy - v.y) / v.z;
    v.z = nz; v.x = sx - wx * nz; v.y = sy - wy * nz; applyView(); saveView();
  }
  const zoomBy = (f) => { const r = rectOf(); zoomAt(r.width / 2, r.height / 2, V().z * f); };
  function fit(save = true) {
    const els = U.sel.size ? selEls() : BOARD.els, r = rectOf(), v = V();
    const b = unionBox(els.map((e) => boxOf(e, byId())));
    if (!b) { v.z = 1; v.x = r.width / 2; v.y = r.height / 2; }
    else { const pad = 120; v.z = Math.min(1, Math.max(Z_MIN, Math.min((r.width - pad * 2) / Math.max(1, b.w), (r.height - pad * 2) / Math.max(1, b.h)))); v.x = r.width / 2 - (b.x + b.w / 2) * v.z; v.y = r.height / 2 - (b.y + b.h / 2) * v.z; }
    applyView(); if (save) saveView();
  }
  const viewCenter = () => { const r = rectOf(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); };

  /* ---------- selection helpers ---------- */
  /** Selecting one member of a group selects the group */
  function withGroups(ids) {
    const groups = new Set(BOARD.els.filter((e) => ids.has(e.id) && e.group).map((e) => e.group));
    if (groups.size) BOARD.els.forEach((e) => e.group && groups.has(e.group) && ids.add(e.id));
    return ids;
  }
  function select(ids, add) { if (!add) U.sel.clear(); withGroups(new Set(ids)).forEach((id) => U.sel.add(id)); paint(); chrome(); }
  function setTool(t) {
    if (ro() && t !== 'select' && t !== 'hand') return;
    if (t === 'image') { $('#cvFile', U.root).click(); return; }
    endEdit(); closePop(); U.tool = t; if (t !== 'select') { U.sel.clear(); paint(); } chrome();
  }

  /* ---------- adding elements ---------- */
  function add(e, edit) {
    U.added = Date.now();
    const before = snap();
    if (edit) { e.z = topZ(); BOARD.els.push(e); U.fresh = { id: e.id, before }; } // recorded when its editing ends, only if it got text
    else change(() => { e.z = topZ(); BOARD.els.push(e); });
    U.sel.clear(); U.sel.add(e.id);
    if (U.tool !== 'pen' && U.tool !== 'connector') U.tool = 'select';
    paint(); chrome();
    if (edit) startEdit(e.id);
    return e;
  }
  const newText = (x, y, text = '') => ({ id: uid(), k: 'text', x: Math.round(x), y: Math.round(y - 16), w: 40, h: 31, text, size: 24, ...(U.ink !== DEFAULT_INK ? { color: U.ink } : {}) });
  const newSticky = (x, y, text = '') => ({ id: uid(), k: 'sticky', x: Math.round(x - 100), y: Math.round(y - 100), w: 200, h: 200, text, fill: U.sticky });

  /* ---------- text editing ---------- */
  function startEdit(id) {
    const e = getEl(id); if (!e || e.locked || ro() || !(e.k === 'text' || e.k === 'sticky' || e.k === 'shape')) return;
    endEdit(); U.edit = id; U.editBefore = U.fresh && U.fresh.id === id ? U.fresh.before : snap(); U.sel.clear(); U.sel.add(id);
    paint();
    const host = $('#cvEditL', U.root), ed = document.createElement('div');
    ed.className = 'cv-edit cv-edit-' + e.k; ed.contentEditable = 'plaintext-only'; if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true';
    ed.spellcheck = true; ed.textContent = e.text || '';
    const pad = e.k === 'sticky' ? 16 : e.k === 'shape' ? 10 : 0;
    Object.assign(ed.style, { left: e.x + pad + 'px', top: e.y + pad + 'px', width: e.k === 'text' && !e.fixed ? 'max-content' : Math.max(20, e.w - 2 * pad) + 'px', ...(e.k === 'text' && !e.fixed ? { maxWidth: TEXT_MAX + 'px', minWidth: '1ch' } : {}), fontSize: (e.k === 'sticky' ? fitSize(e) : e.size || (e.k === 'text' ? 24 : 18)) + 'px', fontWeight: e.weight || '', textAlign: e.align || (e.k === 'shape' ? 'center' : 'left'), color: e.color && e.color !== DEFAULT_INK ? e.color : e.k === 'shape' && e.fill && e.fill !== 'transparent' ? '#1e1e1e' : '' });
    if (e.k !== 'text') Object.assign(ed.style, { height: Math.max(20, e.h - 2 * pad) + 'px' });
    // the placeholder is its own layer under the editor: inside an empty editable box it would push the caret around
    const ph = document.createElement('div');
    ph.className = 'cv-edit cv-edit-ph cv-edit-' + e.k; ph.setAttribute('aria-hidden', 'true'); ph.textContent = e.k === 'text' ? 'Type something' : 'Type an idea…';
    ph.style.cssText = ed.style.cssText; ph.style.width = ''; ph.style.maxWidth = ''; ph.style.height = ''; ph.style.whiteSpace = 'nowrap';
    host.append(ph, ed);
    ed.addEventListener('input', () => {
      e.text = ed.innerText.replace(/\n$/, '');
      ph.hidden = !!e.text;
      if (e.k === 'text') { e.h = Math.max(20, ed.offsetHeight); if (!e.fixed) e.w = Math.max(20, ed.offsetWidth); }
      if (e.k === 'sticky') ed.style.fontSize = fitSize(e) + 'px';
      renderOverlay();
    });
    ph.hidden = !!e.text;
    ed.addEventListener('keydown', (k) => {
      k.stopPropagation();
      if (k.key === 'Escape' || (k.key === 'Enter' && (k.metaKey || k.ctrlKey))) { k.preventDefault(); endEdit(); }
      // Tab: done with this note, start the next one beside it (linked); Shift+Tab: below
      else if (k.key === 'Tab' && e.k === 'sticky') { k.preventDefault(); endEdit(); if (getEl(id)) { U.sel = new Set([id]); quickAdd(k.shiftKey ? 'b' : 'r'); } }
    });
    ed.addEventListener('blur', () => setTimeout(() => { if (U.edit === id) endEdit(); }, 0));
    ed.addEventListener('pointerdown', (k) => k.stopPropagation());
    ed.focus();
    // caret at the end: an existing text is not wiped by the first key
    const rg = document.createRange(); rg.selectNodeContents(ed); rg.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(rg);
  }
  const TEXT_MAX = 640;
  /** A note's text shrinks to fit the note (drawn size only; the stored size stays) */
  function fitSize(e) {
    const want = e.size || 18; if (!e.text || !U.root) return want;
    let m = $('#cvMeasure', U.root);
    if (!m) { m = document.createElement('div'); m.id = 'cvMeasure'; m.className = 'cv-measure'; $('#cv', U.root).append(m); }
    Object.assign(m.style, { width: Math.max(10, e.w - 32) + 'px', fontWeight: e.weight || '' }); m.textContent = e.text + ' ';
    let f = want; const room = e.h - 32;
    for (; f > 9; f -= f > 24 ? 2 : 1) { m.style.fontSize = f + 'px'; if (m.offsetHeight <= room) break; }
    return f;
  }
  function endEdit() {
    if (!U.edit || !BOARD) return;
    const id = U.edit, e = getEl(id), fresh = U.fresh && U.fresh.id === id; U.edit = null; U.fresh = null;
    if (U.root) $$('.cv-edit', U.root).forEach((n) => n.remove());
    try { getSelection().removeAllRanges(); } catch (x) {}
    // an empty text goes away, and so does a note made just now and left empty (a click by mistake)
    if (e && !String(e.text || '').trim() && (e.k === 'text' || (fresh && e.k === 'sticky'))) { BOARD.els = BOARD.els.filter((x) => x.id !== id && !(x.k === 'connector' && (x.a.id === id || x.b.id === id))); U.sel.delete(id); }
    else if (e && typeof e.text === 'string') e.text = e.text.replace(/\s+$/, '');
    record(U.editBefore);
    if (U.root) { paint(); chrome(); }
  }

  /* ---------- events ---------- */
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const onBoard = () => !dead && !!(U.root && U.root.isConnected && BOARD);
  function bindBoard() {
    const st = stage(), root = U.root;
    st.addEventListener('pointerdown', down);
    st.addEventListener('pointermove', move);
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
    st.addEventListener('dblclick', dbl);
    st.addEventListener('wheel', wheel, { passive: false });
    st.addEventListener('contextmenu', (e) => e.preventDefault());
    st.addEventListener('dragover', (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) { e.preventDefault(); st.classList.add('cv-drop'); } });
    st.addEventListener('dragleave', () => st.classList.remove('cv-drop'));
    st.addEventListener('drop', (e) => { st.classList.remove('cv-drop'); const f = [...(e.dataTransfer.files || [])].filter((x) => /^image\//.test(x.type)); if (!f.length) return; e.preventDefault(); images(f, toWorld(e.clientX, e.clientY)); });
    root.addEventListener('click', clickUI);
    $('#cvFile', root).addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) images(f, viewCenter()); });
    const nm = $('#cvName', root);
    if (nm && !ro()) {
      const fitW = () => { nm.style.width = Math.min(280, Math.max(60, nm.value.length * 8.4 + 20)) + 'px'; }; fitW();
      const commit = () => { const v = nm.value.trim(); if (!v) { nm.value = BOARD.name; fitW(); return; } if (v !== BOARD.name) { BOARD.name = v; LST.stale = true; dirty(); } };
      nm.addEventListener('input', fitW);
      nm.addEventListener('focus', () => nm.select());
      nm.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nm.blur(); } if (e.key === 'Escape') { nm.value = BOARD.name; fitW(); nm.blur(); } e.stopPropagation(); });
      nm.addEventListener('blur', commit);
    }
  }
  // page-level listeners: added through the studio runtime, so unmounting the studio removes them
  document.addEventListener('keydown', key);
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && U.space) { U.space = false; if (onBoard()) $('#cv', U.root).classList.remove('cv-panning'); } });
  document.addEventListener('copy', (e) => clip(e, false));
  document.addEventListener('cut', (e) => clip(e, true));
  document.addEventListener('paste', paste);
  addEventListener('resize', () => onBoard() && applyView());

  const pointers = new Map();
  function down(e) {
    if (!onBoard()) return;
    closePop();
    // the second click of a double-click that just placed a note, or a click on the note being typed in: keep typing
    const onEdited = U.edit && e.target.closest && e.target.closest(`[data-eid="${U.edit}"]`);
    if (Date.now() - (U.added || 0) < 500 || onEdited) { e.preventDefault(); const ed = U.root && $('.cv-edit', U.root); if (ed) ed.focus(); return; }
    if (U.edit) endEdit();
    // no native mousedown: it would move the focus back to the stage after a new note's editor took it
    e.preventDefault();
    if (document.activeElement && document.activeElement !== stage() && typing(document.activeElement)) document.activeElement.blur();
    stage().focus({ preventScroll: true });
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    stage().setPointerCapture(e.pointerId);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; U.gesture = { kind: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), z0: V().z, c0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v0: { ...V() } }; return; }
    const [wx, wy] = toWorld(e.clientX, e.clientY), t = e.target;
    if (e.button === 1 || e.button === 2 || U.space || U.tool === 'hand') { U.gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: V().x, vy: V().y }; $('#cv', U.root).classList.add('cv-panning'); return; }
    if (e.button !== 0) return;
    const hitEl = t.closest && t.closest('[data-eid]'), hit = hitEl && getEl(hitEl.dataset.eid);
    const T0 = U.tool;
    if (T0 === 'select') {
      const h = t.closest && t.closest('[data-h]');
      if (h && !ro()) { const els = selEls(), b = unionBox(els.map((x) => boxOf(x, byId()))); U.gesture = { kind: 'resize', c: h.dataset.h, b0: b, before: snap(), els0: clone(els), x0: wx, y0: wy }; return; }
      if (hit) {
        const again = !e.shiftKey && U.sel.size === 1 && U.sel.has(hit.id) && (hasText(hit) || hit.k === 'sticky' || hit.k === 'shape');
        if (e.shiftKey) { if (U.sel.has(hit.id)) { const g = hit.group; [...U.sel].forEach((id) => { const x = getEl(id); if (id === hit.id || (g && x && x.group === g)) U.sel.delete(id); }); paint(); chrome(); return; } select([hit.id], true); }
        else if (!U.sel.has(hit.id)) select([hit.id]);
        // alt-drag duplicates
        if (e.altKey && !ro()) { const b = snap(); dupSel(0); U.gesture = { kind: 'move', before: b, x0: wx, y0: wy, els0: clone(selEls()) }; return; }
        U.gesture = { kind: 'move', before: snap(), x0: wx, y0: wy, els0: clone(selEls()), again: again && hit.id };
        return;
      }
      if (!e.shiftKey) { U.sel.clear(); }
      U.gesture = { kind: 'marquee', x0: wx, y0: wy, x1: wx, y1: wy, keep: new Set(U.sel) }; paint(); chrome(); return;
    }
    if (ro()) return;
    // the text or note tool on something with text: edit it instead of stacking a new one on top
    if ((T0 === 'text' || T0 === 'sticky') && hit && (hasText(hit) || hit.k === 'sticky' || hit.k === 'shape')) { U.tool = 'select'; chrome(); startEdit(hit.id); return; }
    if (T0 === 'text') { add(newText(wx, wy), true); return; }
    if (T0 === 'sticky') { add(newSticky(wx, wy), true); return; }
    if (T0 === 'shape') { U.gesture = { kind: 'shape', x0: wx, y0: wy, x1: wx, y1: wy }; return; }
    if (T0 === 'pen') { U.gesture = { kind: 'pen', pts: [wx, wy] }; renderDraft(); return; }
    if (T0 === 'connector') { U.gesture = { kind: 'link', a: hit && hit.k !== 'connector' ? { id: hit.id } : { x: wx, y: wy }, x1: wx, y1: wy }; return; }
  }
  function move(e) {
    if (!onBoard()) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const g = U.gesture;
    if (!g) { // hover target for the connector tool
      if (U.tool === 'connector') { const h = e.target.closest && e.target.closest('[data-eid]'), id = h && getEl(h.dataset.eid) && getEl(h.dataset.eid).k !== 'connector' ? h.dataset.eid : null; if (id !== U.hover) { U.hover = id; paint(); } }
      return;
    }
    if (g.kind === 'pinch') {
      if (pointers.size < 2) return; const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], r = rectOf();
      const v = V(), nz = Math.min(Z_MAX, Math.max(Z_MIN, g.z0 * d / g.d0)), wx = (g.c0[0] - r.left - g.v0.x) / g.v0.z, wy = (g.c0[1] - r.top - g.v0.y) / g.v0.z;
      v.z = nz; v.x = c[0] - r.left - wx * nz; v.y = c[1] - r.top - wy * nz; applyView(); return;
    }
    if (g.kind === 'pan') { V().x = g.vx + e.clientX - g.sx; V().y = g.vy + e.clientY - g.sy; applyView(); return; }
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const far = Math.hypot(wx - (g.x0 ?? wx), wy - (g.y0 ?? wy)) * V().z > 3;
    if (g.kind === 'move') {
      if (!g.moved && !far) return; g.moved = true;
      let dx = wx - g.x0, dy = wy - g.y0;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      g.els0.forEach((o) => { const el = getEl(o.id); if (!el || el.locked) return; if (el.k === 'connector') { if (!o.a.id) el.a = { x: o.a.x + dx, y: o.a.y + dy }; if (!o.b.id) el.b = { x: o.b.x + dx, y: o.b.y + dy }; } else { el.x = Math.round(o.x + dx); el.y = Math.round(o.y + dy); } });
      paint(); return;
    }
    if (g.kind === 'resize') { resize(g, wx, wy, e.shiftKey); paint(); return; }
    if (g.kind === 'marquee') {
      g.x1 = wx; g.y1 = wy; g.moved = g.moved || far;
      const r = { x: Math.min(g.x0, wx), y: Math.min(g.y0, wy), w: Math.abs(wx - g.x0), h: Math.abs(wy - g.y0) }, m = byId();
      U.sel = withGroups(new Set([...g.keep, ...BOARD.els.filter((x) => intersects(r, boxOf(x, m))).map((x) => x.id)]));
      paint(); return;
    }
    if (g.kind === 'shape') { g.x1 = wx; g.y1 = wy; if (e.shiftKey) { const s = Math.max(Math.abs(wx - g.x0), Math.abs(wy - g.y0)); g.x1 = g.x0 + Math.sign(wx - g.x0 || 1) * s; g.y1 = g.y0 + Math.sign(wy - g.y0 || 1) * s; } g.moved = g.moved || far; renderOverlay(); return; }
    if (g.kind === 'pen') { const n = g.pts.length; if (Math.hypot(wx - g.pts[n - 2], wy - g.pts[n - 1]) * V().z > 1.5) { g.pts.push(Math.round(wx * 10) / 10, Math.round(wy * 10) / 10); renderDraft(); } return; }
    if (g.kind === 'link') {
      g.x1 = wx; g.y1 = wy; g.moved = true;
      const h = document.elementFromPoint(e.clientX, e.clientY), he = h && h.closest && h.closest('[data-eid]'), id = he && getEl(he.dataset.eid) && getEl(he.dataset.eid).k !== 'connector' && he.dataset.eid !== g.a.id ? he.dataset.eid : null;
      if (id !== U.hover) { U.hover = id; renderEls(); }
      renderDraft(); return;
    }
  }
  function up(e) {
    pointers.delete(e.pointerId);
    if (!onBoard()) return;
    const g = U.gesture; U.gesture = null; $('#cv', U.root).classList.remove('cv-panning');
    if (!g) return;
    if (g.kind === 'pinch' || g.kind === 'pan') { saveView(); if (pointers.size) U.gesture = null; return; }
    if (g.kind === 'move' && !g.moved && g.again && !ro()) { const el = getEl(g.again); if (el && !el.locked) return startEdit(el.id); } // second click on a note: write in it
    if (g.kind === 'move' || g.kind === 'resize') { record(g.before); paint(); chrome(); return; }
    if (g.kind === 'marquee') { paint(); chrome(); return; }
    if (g.kind === 'shape') {
      let x = Math.min(g.x0, g.x1), y = Math.min(g.y0, g.y1), w = Math.abs(g.x1 - g.x0), h = Math.abs(g.y1 - g.y0);
      if (!g.moved || w < 8 || h < 8) { w = U.shape === 'rect' ? 180 : 140; h = U.shape === 'rect' ? 120 : 140; x = g.x0 - w / 2; y = g.y0 - h / 2; }
      add({ id: uid(), k: 'shape', shape: U.shape, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), fill: '#ffffff', stroke: DEFAULT_INK, sw: 2 });
      renderOverlay(); return;
    }
    if (g.kind === 'pen') { renderDraft(); if (g.pts.length >= 6) { const p = pathFrom(g.pts, U.ink, U.sw); change(() => { p.z = topZ(); BOARD.els.push(p); }); } return; } // a tap is not a stroke
    if (g.kind === 'link') {
      const target = U.hover; U.hover = null; renderDraft();
      const b = target ? { id: target } : { x: Math.round(g.x1), y: Math.round(g.y1) };
      const len = Math.hypot(g.x1 - (g.a.x ?? g.x1), g.y1 - (g.a.y ?? g.y1)) * V().z;
      if (!g.moved || (!target && !g.a.id && len < 20) || (target && target === g.a.id)) { paint(); return; }
      add({ id: uid(), k: 'connector', x: 0, y: 0, w: 0, h: 0, a: g.a.id ? { id: g.a.id } : { x: Math.round(g.a.x), y: Math.round(g.a.y) }, b, stroke: '#64748b', sw: 2 });
      return;
    }
  }
  function resize(g, wx, wy, shift) {
    const b = g.b0, c = g.c, fx = c[1] === 'w' ? b.x + b.w : b.x, fy = c[0] === 'n' ? b.y + b.h : b.y; // the fixed corner
    let nw = Math.max(8, c[1] === 'w' ? fx - wx : wx - fx), nh = Math.max(8, c[0] === 'n' ? fy - wy : wy - fy);
    const single = g.els0.length === 1 ? g.els0[0] : null, keep = shift || (single && single.k === 'image') || g.els0.length > 1;
    if (single && single.k === 'text') { nh = b.h; const el = getEl(single.id); if (el) el.fixed = true; } // text: width only (it wraps there from now on), its height follows the text
    else if (keep) { const s = Math.max(nw / Math.max(1, b.w), nh / Math.max(1, b.h)); nw = b.w * s; nh = b.h * s; }
    const nx = c[1] === 'w' ? fx - nw : fx, ny = c[0] === 'n' ? fy - nh : fy, sx = nw / Math.max(1, b.w), sy = nh / Math.max(1, b.h);
    g.els0.forEach((o) => {
      const el = getEl(o.id); if (!el || el.k === 'connector') return;
      el.x = Math.round(nx + (o.x - b.x) * sx); el.y = Math.round(ny + (o.y - b.y) * sy); el.w = Math.max(8, Math.round(o.w * sx)); el.h = Math.max(8, Math.round(o.h * sy));
      if (el.k === 'path') el.pts = o.pts.map((v, i) => Math.round(v * (i % 2 ? sy : sx) * 10) / 10);
      if (!single && (el.k === 'text' || el.k === 'sticky' || el.k === 'shape') && o.size) el.size = Math.max(6, Math.round(o.size * Math.min(sx, sy)));
      if (!single && el.k === 'text' && !o.size) el.size = Math.max(6, Math.round(24 * Math.min(sx, sy)));
    });
  }
  function dbl(e) {
    if (!onBoard() || ro()) return;
    if (U.edit || (e.target.closest && e.target.closest('.cv-edit')) || Date.now() - (U.added || 0) < 600) return; // the click that placed a note is not a second note
    const h = e.target.closest && e.target.closest('[data-eid]'), el = h && getEl(h.dataset.eid);
    if (el && (el.k === 'text' || el.k === 'sticky' || el.k === 'shape')) return startEdit(el.id);
    if (el && el.k === 'connector') return linkLabel(el);
    if (!el && U.tool === 'select') { const [x, y] = toWorld(e.clientX, e.clientY); add(newSticky(x, y), true); }
  }
  function linkLabel(c) {
    modal(`<div class="mh"><h2>Connector label</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div><div class="mb"><input class="field" id="cvLb" maxlength="200" value="${esc(c.label || '')}" placeholder="e.g. leads to"></div><div class="mf"><button class="btn secondary" data-close>Cancel</button><button class="btn primary" id="cvLbGo">Save</button></div>`, {
      onMount: (bg, close) => { const f = $('#cvLb', bg); f.focus(); const go = () => { change(() => { const v = f.value.trim(); if (v) c.label = v; else delete c.label; }); close(); }; $('#cvLbGo', bg).addEventListener('click', go); f.addEventListener('keydown', (k) => k.key === 'Enter' && go()); },
    });
  }
  function wheel(e) {
    if (!onBoard()) return; e.preventDefault();
    const r = rectOf();
    if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX - r.left, e.clientY - r.top, V().z * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025) * (e.ctrlKey && !e.metaKey ? 4 : 1))); return; }
    const k = e.deltaMode ? 16 : 1, dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    V().x -= dx * k; V().y -= dy * k; applyView(); saveView();
  }

  /* ---------- toolbar + contextual actions ---------- */
  function clickUI(e) {
    const b = e.target.closest('[data-cv]'); if (!b || !onBoard()) return;
    const a = b.dataset.cv;
    if (b.closest('.cv-menu')) closePop();
    if (a === 'tool') { if (b.dataset.k === 'shape' && U.tool === 'shape') return shapePop(b); setTool(b.dataset.k); if (b.dataset.k === 'shape') shapePop(b); else if (b.dataset.k === 'sticky' || b.dataset.k === 'pen') stylePop(b, b.dataset.k); return; }
    if (a === 'undo') return undo();
    if (a === 'redo') return redo();
    if (a === 'zin') return zoomBy(1.25);
    if (a === 'zout') return zoomBy(0.8);
    if (a === 'z100') { const r = rectOf(); return zoomAt(r.width / 2, r.height / 2, 1); }
    if (a === 'fit') return fit();
    if (a === 'theme') return ACT.theme && ACT.theme(); // the studio redraws the page: the board comes back as it was
    if (a === 'toDesign') return convert();
    if (a === 'generate') return generate();
    if (a === 'more') return morePop(b);
    if (a === 'set') return change(() => selEls().forEach((el) => { if (el.locked) return; const p = b.dataset.p, v = b.dataset.v; if (p === 'fill' && (el.k === 'sticky' || el.k === 'shape')) el.fill = v; else if (p === 'stroke' && (el.k === 'shape' || el.k === 'path' || el.k === 'connector')) el.stroke = v; else if (p === 'color' && hasText(el)) el.color = v; else if (p === 'color' && (el.k === 'path' || el.k === 'connector')) el.stroke = v; else if (p === 'align' && hasText(el)) el.align = v; if (p === 'fill' && el.k === 'sticky') U.sticky = v; if ((p === 'color' || p === 'stroke') && el.k !== 'shape') U.ink = v; }));
    if (a === 'font') return change(() => selEls().forEach((el) => { if (el.locked || !(el.k === 'text' || el.k === 'sticky' || el.k === 'shape')) return; const s = el.size || (el.k === 'text' ? 24 : 18), steps = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80, 96, 128], i = steps.findIndex((x) => x >= s); el.size = +b.dataset.n > 0 ? steps[Math.min(steps.length - 1, (steps[i] === s ? i + 1 : Math.max(0, i)))] || 160 : steps[Math.max(0, (i < 0 ? steps.length : i) - 1)]; }));
    if (a === 'bold') return boldSel();
    if (a === 'toggle') return change(() => selEls().forEach((el) => { if (el.k !== 'connector') return; if (b.dataset.p === 'arrow') { if (el.arrow === false) delete el.arrow; else el.arrow = false; } else { if (el.dash) delete el.dash; else el.dash = true; } }));
    if (a === 'group') return groupSel();
    if (a === 'front') return order(1);
    if (a === 'back') return order(-1);
    if (a === 'dup') return change(() => dupSel(24));
    if (a === 'lock') return lockSel();
    if (a === 'del') return delSel();
    if (a === 'shape') { U.shape = b.dataset.k; closePop(); const t = $('[data-cv=tool][data-k=shape]', U.root); t.innerHTML = ic(SHAPES.find((s) => s[0] === U.shape)[1], 20); setTool('shape'); return; }
    if (a === 'pick') { if (b.dataset.p === 'sticky') U.sticky = b.dataset.v; else if (b.dataset.p === 'ink') U.ink = b.dataset.v; else U.sw = +b.dataset.v; closePop(); const t = $(`[data-cv=tool][data-k=${b.dataset.t}]`, U.root); t && stylePop(t, b.dataset.t); return; }
  }
  function morePop(btn) {
    const els = selEls(), locked = els.some((e) => e.locked), grouped = els.length > 1 && els.every((e) => e.group && e.group === els[0].group);
    const it = (k, i, l, key) => `<button class="cv-mi" data-cv="${k}">${ic(i, 16)}<span>${l}</span>${key ? `<kbd>${key}</kbd>` : ''}</button>`;
    closePop(); const m = document.createElement('div'); m.className = 'cv-popm cv-menu';
    m.innerHTML = (locked ? '' : it('front', 'front', 'Bring to front', ']') + it('back', 'back', 'Send to back', '[') + (els.length > 1 ? it('group', 'group', grouped ? 'Ungroup' : 'Group', '⌘G') : ''))
      + it('lock', locked ? 'unlock' : 'lock', locked ? 'Unlock' : 'Lock in place', '⇧⌘L') + (locked ? '' : it('toDesign', 'layout', 'Make design (as arranged)', ''));
    $('#cv', U.root).append(m);
    const r = btn.getBoundingClientRect(), R = U.root.getBoundingClientRect();
    m.style.top = r.bottom - R.top + 8 + 'px'; m.style.left = Math.max(8, Math.min(R.width - m.offsetWidth - 8, r.right - R.left - m.offsetWidth)) + 'px';
  }
  /** + next to a note: a new note of the same color on that side, linked to it, ready to type */
  function quickAdd(dir) {
    const s0 = selEls()[0]; if (!s0 || ro()) return;
    const [dx, dy] = { r: [1, 0], l: [-1, 0], b: [0, 1], t: [0, -1] }[dir], gap = 80, m = byId();
    const n = { id: uid(), k: 'sticky', x: s0.x, y: s0.y, w: s0.w, h: s0.h, text: '', fill: s0.fill || U.sticky };
    for (let i = 1; i < 12; i++) { // the first free spot on that side
      n.x = s0.x + dx * (s0.w + gap) * i; n.y = s0.y + dy * (s0.h + gap) * i;
      if (!BOARD.els.some((e) => e.k !== 'connector' && intersects({ x: n.x + 4, y: n.y + 4, w: n.w - 8, h: n.h - 8 }, boxOf(e, m)))) break;
    }
    U.fresh = { id: n.id, before: snap() }; U.added = Date.now(); // kept (with its link) only once it gets text
    { let z = topZ(); n.z = z++; BOARD.els.push(n, { id: uid(), k: 'connector', x: 0, y: 0, w: 0, h: 0, a: { id: s0.id }, b: { id: n.id }, stroke: '#64748b', sw: 2, z }); }
    U.sel = new Set([n.id]);
    const vb = visibleBox(); if (!intersects({ x: n.x, y: n.y, w: n.w, h: n.h }, vb) || n.x + n.w > vb.x + vb.w || n.y + n.h > vb.y + vb.h || n.x < vb.x || n.y < vb.y) { const r = rectOf(), v = V(); v.x = r.width / 2 - (n.x + n.w / 2) * v.z; v.y = r.height / 2 - (n.y + n.h / 2) * v.z; saveView(); }
    paint(); chrome(); startEdit(n.id);
  }
  const closePop = () => { if (U.root) $$('.cv-popm', U.root).forEach((m) => m.remove()); };
  function popAt(btn, html) {
    closePop(); const m = document.createElement('div'); m.className = 'cv-popm'; m.innerHTML = html; U.root.querySelector('#cv').append(m);
    const r = btn.getBoundingClientRect(), R = U.root.getBoundingClientRect();
    m.style.top = Math.max(8, r.top - R.top) + 'px'; m.style.left = r.right - R.left + 10 + 'px';
  }
  const shapePop = (btn) => popAt(btn, SHAPES.map(([k, i, l]) => `<button data-cv="shape" data-k="${k}" class="${U.shape === k ? 'on' : ''}" title="${l}" aria-label="${l}">${ic(i, 18)}</button>`).join(''));
  function stylePop(btn, t) {
    if (t === 'sticky') popAt(btn, `<div class="cv-sw">${STICKY.map((c) => `<button data-cv="pick" data-t="sticky" data-p="sticky" data-v="${c}" class="${U.sticky === c ? 'on' : ''}" style="--c:${c}" aria-label="Note color ${c}"></button>`).join('')}</div>`);
    else popAt(btn, `<div class="cv-sw">${INK.slice(0, 8).map((c) => `<button data-cv="pick" data-t="pen" data-p="ink" data-v="${c}" class="${U.ink === c ? 'on' : ''}" style="--c:${c}" aria-label="Pen color ${c}"></button>`).join('')}</div><div class="cv-sws">${[2, 4, 8, 16].map((w) => `<button data-cv="pick" data-t="pen" data-p="sw" data-v="${w}" class="${U.sw === w ? 'on' : ''}" aria-label="Pen width ${w}"><i style="height:${Math.max(2, w / 1.6)}px"></i></button>`).join('')}</div>`);
  }
  function dupSel(off) {
    const els = selEls(); if (!els.length) return;
    const map = new Map(), groups = new Map(); let z = topZ();
    els.forEach((e) => map.set(e.id, uid()));
    const copies = els.map((e) => {
      const c = clone(e); c.id = map.get(e.id); c.z = z++; delete c.locked;
      if (c.group) { if (!groups.has(c.group)) groups.set(c.group, uid()); c.group = groups.get(c.group); }
      if (c.k === 'connector') { ['a', 'b'].forEach((k) => { if (c[k].id) { if (map.has(c[k].id)) c[k] = { id: map.get(c[k].id) }; } else c[k] = { x: c[k].x + off, y: c[k].y + off }; }); }
      else { c.x += off; c.y += off; }
      return c;
    });
    BOARD.els.push(...copies); U.sel = new Set(copies.map((c) => c.id));
  }
  function delSel() {
    const ids = new Set(selEls().filter((e) => !e.locked).map((e) => e.id)); if (!ids.size) return;
    change(() => { BOARD.els = BOARD.els.filter((e) => !ids.has(e.id) && !(e.k === 'connector' && (ids.has(e.a.id) || ids.has(e.b.id)))); U.sel.clear(); });
  }
  function order(dir) {
    change(() => {
      const ids = new Set(U.sel), s = sorted(), mine = s.filter((e) => ids.has(e.id)), rest = s.filter((e) => !ids.has(e.id));
      (dir > 0 ? [...rest, ...mine] : [...mine, ...rest]).forEach((e, i) => (e.z = i + 1));
    });
  }
  function groupSel() {
    const els = selEls(); if (els.length < 2) return;
    const grouped = els.every((e) => e.group && e.group === els[0].group);
    change(() => { const g = uid(); els.forEach((e) => { if (grouped) delete e.group; else e.group = g; }); });
    toast(grouped ? 'Ungrouped' : 'Grouped');
  }
  function lockSel() { const els = selEls(); if (!els.length) return; const lock = !els.some((e) => e.locked); change(() => els.forEach((e) => { if (lock) e.locked = true; else delete e.locked; })); }
  function boldSel() { change(() => { const els = selEls().filter(hasText), on = !els.every((e) => (e.weight || 400) >= 700); els.forEach((e) => { if (on) e.weight = 700; else delete e.weight; }); }); }

  /* ---------- keyboard + clipboard ---------- */
  function key(e) {
    if (!onBoard() || U.edit || typing(e.target) || document.querySelector('.modal-bg')) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (e.code === 'Space' && !e.repeat) { U.space = true; $('#cv', U.root).classList.add('cv-panning'); e.preventDefault(); return; }
    if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && k === 'y') { e.preventDefault(); return redo(); }
    if (mod && k === 'a') { e.preventDefault(); return select(BOARD.els.map((x) => x.id)); }
    if (mod && k === 'd') { e.preventDefault(); return change(() => dupSel(24)); }
    if (mod && k === 'g') { e.preventDefault(); return groupSel(); }
    if (mod && k === 'b') { e.preventDefault(); return boldSel(); }
    if (mod && e.shiftKey && k === 'l') { e.preventDefault(); return lockSel(); }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); return zoomBy(1.25); }
    if (mod && k === '-') { e.preventDefault(); return zoomBy(0.8); }
    if (mod && k === '0') { e.preventDefault(); const r = rectOf(); return zoomAt(r.width / 2, r.height / 2, 1); }
    if (mod) return;
    if (e.shiftKey && (k === '!' || e.code === 'Digit1')) { e.preventDefault(); return fit(); }
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); return delSel(); }
    if (k === 'escape') { if (U.root && $('.cv-popm', U.root)) return closePop(); if (U.gesture) return; if (U.tool !== 'select') setTool('select'); else { U.sel.clear(); paint(); chrome(); } return; }
    if (k === 'enter' && U.sel.size === 1) { e.preventDefault(); return startEdit([...U.sel][0]); }
    if (k === 'g' && !ro()) { e.preventDefault(); return generate(); }
    if (k === ']') return order(1);
    if (k === '[') return order(-1);
    if (k.startsWith('arrow') && U.sel.size) {
      e.preventDefault(); const d = e.shiftKey ? 10 : 1, dx = k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, dy = k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0;
      return change(() => selEls().forEach((el) => { if (el.locked) return; if (el.k === 'connector') { if (!el.a.id) el.a = { x: el.a.x + dx, y: el.a.y + dy }; if (!el.b.id) el.b = { x: el.b.x + dx, y: el.b.y + dy }; } else { el.x += dx; el.y += dy; } }));
    }
    const t = { v: 'select', h: 'hand', t: 'text', s: 'sticky', r: 'shape', o: 'shape', p: 'pen', c: 'connector', i: 'image', l: 'connector' }[k];
    if (t) { if (k === 'o') { U.shape = 'ellipse'; } if (k === 'r') U.shape = 'rect'; const b = $('[data-cv=tool][data-k=shape]', U.root); if (b && (k === 'o' || k === 'r')) b.innerHTML = ic(U.shape === 'ellipse' ? 'circle' : 'square', 20); setTool(t); }
  }
  function clip(e, cut) {
    if (!onBoard() || U.edit || typing(e.target) || !U.sel.size) return;
    const els = selEls(), ids = new Set(els.map((x) => x.id));
    // connectors travel only with both of their attached ends
    const keep = els.filter((x) => x.k !== 'connector' || ((!x.a.id || ids.has(x.a.id)) && (!x.b.id || ids.has(x.b.id))));
    e.clipboardData.setData('text/plain', CLIP + JSON.stringify(keep));
    e.preventDefault();
    if (cut) delSel();
  }
  function paste(e) {
    if (!onBoard() || U.edit || typing(e.target) || ro()) return;
    const files = [...(e.clipboardData.files || [])].filter((f) => /^image\//.test(f.type));
    if (files.length) { e.preventDefault(); return images(files, viewCenter()); }
    const txt = e.clipboardData.getData('text/plain'); if (!txt) return;
    e.preventDefault();
    if (txt.startsWith(CLIP)) {
      let els; try { els = JSON.parse(txt.slice(CLIP.length)); } catch (x) { return; }
      if (!Array.isArray(els) || !els.length) return;
      const m = new Map(), groups = new Map(), b = unionBox(els.filter((x) => x.k !== 'connector').map((x) => ({ x: x.x, y: x.y, w: x.w, h: x.h }))) || { x: 0, y: 0, w: 0, h: 0 };
      const [cx, cy] = viewCenter(), here = els.some((x) => getEl(x.id)) && intersects(b, visibleBox()), dx = here ? 24 : Math.round(cx - (b.x + b.w / 2)), dy = here ? 24 : Math.round(cy - (b.y + b.h / 2));
      els.forEach((x) => m.set(x.id, uid()));
      change(() => {
        let z = topZ();
        const out = els.map((x) => { const c = { ...x, id: m.get(x.id), z: z++ }; if (c.group) { if (!groups.has(c.group)) groups.set(c.group, uid()); c.group = groups.get(c.group); } if (c.k === 'connector') ['a', 'b'].forEach((k) => { c[k] = c[k].id ? { id: m.get(c[k].id) } : { x: c[k].x + dx, y: c[k].y + dy }; }); else { c.x += dx; c.y += dy; } return c; });
        BOARD.els.push(...out); U.sel = new Set(out.map((c) => c.id));
      });
      return;
    }
    // plain text: one sticky note per paragraph (a list becomes a row of notes)
    const parts = txt.split(/\n\s*\n|\r\n\s*\r\n/).map((s) => s.trim()).filter(Boolean).slice(0, 40), [cx, cy] = viewCenter();
    change(() => {
      let z = topZ(); const out = parts.map((p, i) => ({ ...newSticky(cx + (i % 5) * 220 - Math.min(parts.length - 1, 4) * 110, cy + Math.floor(i / 5) * 220), text: p.slice(0, 5000), z: z++ }));
      BOARD.els.push(...out); U.sel = new Set(out.map((c) => c.id));
    });
  }
  const visibleBox = () => { const r = rectOf(), [x0, y0] = toWorld(r.left, r.top), [x1, y1] = toWorld(r.right, r.bottom); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };

  /* ---------- images ---------- */
  /** Big photos are scaled down (longest side 2400 px) before upload; GIFs are sent as they are */
  function readImage(f) {
    return new Promise((res, rej) => {
      const fr = new FileReader(); fr.onerror = () => rej(new Error('Couldn’t read ' + f.name));
      fr.onload = () => {
        const url = fr.result; if (f.type === 'image/gif') return res({ url, w: 0, h: 0 });
        const im = new Image(); im.onerror = () => rej(new Error(f.name + ' isn’t an image this browser can open'));
        im.onload = () => {
          const k = Math.min(1, 2400 / Math.max(im.naturalWidth, im.naturalHeight));
          if (k === 1 && f.size < 4e6) return res({ url, w: im.naturalWidth, h: im.naturalHeight });
          const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          res({ url: c.toDataURL(f.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.88), w: c.width, h: c.height });
        };
        im.src = url;
      };
      fr.readAsDataURL(f);
    });
  }
  async function images(files, [x, y]) {
    if (ro()) return;
    setTool('select');
    toast(files.length > 1 ? `Uploading ${files.length} images…` : 'Uploading the image…');
    let i = 0;
    for (const f of files.slice(0, 20)) {
      try {
        if (f.size > 25e6) throw new Error(f.name + ' is larger than 25 MB');
        const im = await readImage(f), r = await api('/media/assets', { method: 'POST', body: { dataUrl: im.url } });
        const W = r.width || im.w || 400, H = r.height || im.h || 300, k = Math.min(1, 480 / Math.max(W, H));
        if (!onBoard()) return;
        const w = Math.round(W * k), h = Math.round(H * k);
        add({ id: uid(), k: 'image', src: r.url, name: f.name.slice(0, 200), x: Math.round(x - w / 2 + i * 32), y: Math.round(y - h / 2 + i * 32), w, h });
        i++;
      } catch (e) { toast('Image not added: ' + e.message); }
    }
  }

  /* ---------- convert: selection → design or draft post ---------- */
  function lookOf() {
    const b = brand(), c = (b.colors || []).map((x) => x.hex).filter((h) => /^#[0-9a-f]{6}$/i.test(h || ''));
    // the darkest and lightest brand colors, when they are dark / light enough to read on each other
    const lum = (h) => { const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
    const byLum = [...c].sort((x, y) => lum(x) - lum(y)), dark = byLum[0], light = byLum[byLum.length - 1];
    return { accent: c[0] || '#fd0e35', dark: dark && lum(dark) < 0.2 ? dark : '#0b1220', light: light && lum(light) > 0.85 ? light : '#f8fafc', heading: (b.fonts && b.fonts.heading) || 'Poppins', body: (b.fonts && b.fonts.body) || 'Inter' };
  }
  /** The selection, or the whole board when nothing is selected */
  function pickEls() {
    let els = selEls();
    if (!els.length) els = BOARD.els;
    if (!els.length) { toast('The board is empty: add a few notes first'); return null; }
    endEdit(); closePop();
    return els;
  }
  /** Tomorrow 09:00 in the scheduling time zone, as a draft post of design d */
  function draftPost(cap) {
    const tz = schedTz(), n = nowIn(tz), t = new Date(n.date + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 1);
    return { date: t.toISOString().slice(0, 10), time: '09:00', pf: Object.keys(S.platforms || {}).filter((k) => S.platforms[k]).slice(0, 2), status: 'Draft', cap, tz };
  }
  const summary = (els) => {
    const n = els.filter(hasText).filter((e) => String(e.text || '').trim()).length, p = els.filter((e) => e.k === 'image');
    return `<div class="cv-sum"><span class="cv-chip">${ic('sticky', 14)}${n} note${n === 1 ? '' : 's'}</span>${p.length ? `<span class="cv-chip">${ic('image', 14)}${p.length} photo${p.length === 1 ? '' : 's'}</span>${p.slice(0, 4).map((e) => `<img src="${esc(e.src)}" alt="">`).join('')}` : ''}<span class="grow"></span><small>${U.sel.size ? 'Your selection' : 'The whole board'}</small></div>`;
  };
  const draftToggle = (cap) => `<label class="cv-tg"><input type="checkbox" id="cvPost"><span class="switch" aria-hidden="true"></span><span class="grow"><b>Also add a draft post</b><small>In the Planner for tomorrow at 09:00, captioned with your notes</small></span></label>
    <div id="cvCapW" hidden><textarea class="field" id="cvCap" rows="4" maxlength="3000" aria-label="Caption" placeholder="Caption">${esc(cap)}</textarea></div>`;
  const bindToggle = (bg) => { const c = $('#cvPost', bg), w = $('#cvCapW', bg), sw = $('.cv-tg .switch', bg); c.addEventListener('change', () => { w.hidden = !c.checked; sw.classList.toggle('on', c.checked); }); };

  /* ---------- Generate design: the Studio Agent designs a post from the selection ---------- */
  const FORMATS = [['auto', 'Auto', 'The agent picks', null, 1], ['1:1', 'Square', '1:1 post', '1:1', 1], ['4:5', 'Portrait', '4:5 post', '4:5', 1], ['9:16', 'Story', '9:16 story', '9:16', 1], ['car', 'Carousel', '4:5 slides', '4:5', 0]];
  function generate() {
    const els = pickEls(); if (!els) return;
    const notes = els.filter(hasText).filter((e) => String(e.text || '').trim()).length;
    const st = { f: 'auto', extra: '' };
    const cap = captionOf(els);
    modal(`<div class="mh"><h2>${ic('studio', 20)} Generate a design</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb cv-cvt">
        ${summary(els)}
        <label class="label" for="cvAsk">What should it be? <span class="muted">(optional)</span></label>
        <textarea class="field" id="cvAsk" rows="3" maxlength="1000" placeholder="e.g. A bold story announcing our Friday webinar, with a clear call to action"></textarea>
        <div class="cv-ideas">${['Announcement', 'Tips list', 'Quote card', 'Behind the scenes'].map((t) => `<button class="chip" data-idea="${t}">${t}</button>`).join('')}</div>
        <label class="label">Format</label>
        <div class="cv-fmt" id="cvFmt">${FORMATS.map(([k, l, sub]) => `<button data-f="${k}" class="${k === st.f ? 'on' : ''}"><b>${l}</b><small>${k === 'car' ? `${Math.min(10, Math.max(2, notes))} slides` : sub}</small></button>`).join('')}</div>
        ${draftToggle(cap)}
      </div>
      <div class="mf"><span class="xs-t muted grow">Opens in the editor while the Studio Agent works. Undo is there if you don’t like it.</span><button class="btn secondary" data-close>Cancel</button><button class="btn primary" id="cvGo">${ic('studio', 16)}Generate</button></div>`, {
      wide: true,
      onMount: (bg, close) => {
        const ask = $('#cvAsk', bg); setTimeout(() => ask.focus(), 30);
        bindToggle(bg);
        $('.cv-ideas', bg).addEventListener('click', (e) => { const b = e.target.closest('[data-idea]'); if (!b) return; ask.value = (ask.value.trim() ? ask.value.trim() + ' ' : '') + b.dataset.idea.toLowerCase() + ' post'; ask.value = ask.value.charAt(0).toUpperCase() + ask.value.slice(1); ask.focus(); });
        $('#cvFmt', bg).addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (!b) return; st.f = b.dataset.f; $$('#cvFmt button', bg).forEach((x) => x.classList.toggle('on', x === b)); });
        const go = async () => {
          const [, label, sub, ratio, n0] = FORMATS.find((f) => f[0] === st.f), slides = n0 || Math.min(10, Math.max(2, notes));
          const req = generateRequest(els, { extra: ask.value, slides, label: ratio ? `${label} (${sub})` : '' });
          const r = ratio || (brand().defaultRatio && RATIOS[brand().defaultRatio] ? brand().defaultRatio : '4:5'), [W, H] = RATIOS[r];
          const post = $('#cvPost', bg).checked ? draftPost(($('#cvCap', bg).value || '').trim()) : null;
          $('#cvGo', bg).disabled = true;
          close();
          const d = await ctx.generate({ text: req.text, note: req.note, ratio: r, slides, name: nameOf(els), layers: photoLayers(els, W, H), post });
          if (d && post) toast('Draft post added to the Planner');
        };
        $('#cvGo', bg).addEventListener('click', go);
        ask.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
      },
    });
  }

  /* ---------- Make design: the selection laid out as it is (or one slide per note), no AI ---------- */
  function convert() {
    const els = pickEls(); if (!els) return;
    const notes = els.filter(hasText).filter((e) => String(e.text || '').trim()).length;
    const st = { mode: notes > 1 && els.every((e) => hasText(e) || e.k === 'connector') ? 'slides' : 'board', ratio: brand().defaultRatio && RATIOS[brand().defaultRatio] ? brand().defaultRatio : '4:5', cap: captionOf(els), name: nameOf(els) };
    const L = lookOf();
    const pagesFor = () => {
      const [W, H] = RATIOS[st.ratio];
      return st.mode === 'slides' ? notesToPages(els, W, H, { bg: L.dark, ink: L.light, accent: L.accent, heading: L.heading, body: L.body })
        : [{ id: uid(), bg: '#ffffff', layers: toLayers(els, W, H, { bg: '#ffffff', ink: DEFAULT_INK, heading: L.heading, body: L.body }) }];
    };
    const ratios = ['1:1', '4:5', '9:16'].filter((r) => RATIOS[r]);
    const preview = () => { const p = pagesFor(); return p.slice(0, 4).map((pg) => thumb(pg, st.ratio, 120, 150)).join('') + (p.length > 4 ? `<span class="cv-more">+${p.length - 4}</span>` : ''); };
    modal(`<div class="mh"><h2>Make a design</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb cv-cvt">
        ${summary(els)}
        <div class="cv-prev" id="cvPrev">${preview()}</div>
        <div class="cv-row2"><div><label class="label">Layout</label>
        <div class="tabs" id="cvMode"><button data-m="board" class="${st.mode === 'board' ? 'on' : ''}">As arranged</button><button data-m="slides" class="${st.mode === 'slides' ? 'on' : ''}" ${notes ? '' : 'disabled title="No notes with text in the selection"'}>One slide per note</button></div></div>
        <div><label class="label">Size</label>
        <div class="tabs" id="cvRatio">${ratios.map((r) => `<button data-r="${r}" class="${st.ratio === r ? 'on' : ''}">${r}</button>`).join('')}</div></div></div>
        <label class="label" for="cvDn">Name</label><input class="field" id="cvDn" maxlength="80" value="${esc(st.name)}">
        ${draftToggle(st.cap)}
      </div>
      <div class="mf"><button class="btn ghost" id="cvToGen">${ic('studio', 16)}Generate with AI instead</button><span class="grow"></span><button class="btn secondary" data-close>Cancel</button><button class="btn primary" id="cvGo">${ic('layout', 16)}Create design</button></div>`, {
      wide: true,
      onMount: (bg, close) => {
        bindToggle(bg);
        const refresh = () => { $('#cvPrev', bg).innerHTML = preview(); $$('#cvMode button', bg).forEach((b) => b.classList.toggle('on', b.dataset.m === st.mode)); $$('#cvRatio button', bg).forEach((b) => b.classList.toggle('on', b.dataset.r === st.ratio)); };
        $('#cvMode', bg).addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b && !b.disabled) { st.mode = b.dataset.m; refresh(); } });
        $('#cvRatio', bg).addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) { st.ratio = b.dataset.r; refresh(); } });
        $('#cvToGen', bg).addEventListener('click', () => { close(); generate(); });
        $('#cvGo', bg).addEventListener('click', () => {
          const pages = pagesFor(); if (!pages.length) return toast('Nothing to put in the design');
          const name = $('#cvDn', bg).value.trim() || st.name, withPost = $('#cvPost', bg).checked;
          const d = createDesign({ name, tpl: 'blank', ratio: st.ratio, slides: 1, source: 'Canvas', mutate: (x) => { x.pages = pages; } });
          d.name = name;
          if (withPost) S.posts.push({ id: 'p' + uid(), d: d.id, ...draftPost(($('#cvCap', bg).value || '').trim()) });
          save(); close();
          modal(`<div class="mh"><h2>${withPost ? 'Design and draft created' : 'Design created'}</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
            <div class="mb"><div class="row" style="gap:14px;align-items:center">${thumb(d.pages[0], d.ratio, 80, 100)}<p class="sm-t grow">“${esc(d.name)}”${d.pages.length > 1 ? ` · ${d.pages.length} slides` : ''} ${withPost ? 'is in your Studio, with a draft post in the Planner.' : 'is in your Studio.'}</p></div></div>
            <div class="mf"><button class="btn secondary" data-close>Stay on the board</button>${withPost ? '<a class="btn secondary" href="#/planner" data-close>Open the Planner</a>' : ''}<a class="btn primary" href="#/editor/${esc(d.id)}" data-close>Open the design</a></div>`);
        });
      },
    });
  }
  function nameOf(els) {
    const t = readingOrderFirst(els);
    return t ? (t.length > 48 ? t.slice(0, 47) + '…' : t) : BOARD.name;
  }
  const readingOrderFirst = (els) => { const s = els.filter(hasText).sort((a, b) => a.y - b.y || a.x - b.x)[0]; return s ? String(s.text || '').split('\n')[0].trim() : ''; };

  return { leave: () => { unmountBoard(); dead = true; } };
}
