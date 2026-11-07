/* ============================================================
   Caption panels: the Video Studio's shared Captions panel, for videos and reels (video-studio.js draws it through VS.panel).
   Every panel edit writes `d.captions` (caption-store.js) in one mutate().
   - Video: the lines come from the speech (footage-editor.js) and are stored in `d.captions.lines`.
   - Reel: while `source` is 'voiceover' (or unset) the lines are built from the scenes' voice-over (reelCaptions), so they
     follow every change of the script or the voices; the first hand edit stores them with `source: 'manual'` and the
     voice-over signature (voSig), and "Rebuild from voice-over" appears once the voice-over changes again (needsRebuild).
   The panel: Captions on / off, search (Arabic and Latin, diacritics ignored), one row per line (time, inline edit, menu:
   split at playhead, merge with next, delete), Add line at the playhead, and the source's own action (Re-transcribe).
   A source helps through `source.captions`: { body() -> html | null (the panel's body while there are no lines),
   foot() -> html (extra buttons), light() (the preview follows an edit without redrawing the panel) }.
   The pure helpers at the top are unit-tested; installCaptionPanels is a DOM module.
   ============================================================ */
import { group, retext, retime, split, merge, addLine, DEFAULT_STYLE, FONTS_CSS } from './captions.js';
import { capsOf, kindOf, migrateCaptions, CAPTIONS_DEFAULT } from './caption-store.js';
import { voiceoverWords, spreadScript, needsRebuild, voSig } from './caption-sources.js';
import { timeline } from './motion.js';
import { audioOf, voOf, LEAD } from './audio.js';
import { fmtMs } from './footage-player.js';

/* ---------- pure helpers ---------- */
/** Text as search compares it: lowercase, without Latin accents, Arabic diacritics, hamza marks or tatweel */
export const fold = (s) => String(s || '').normalize('NFD')
  .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u06d6-\u06ed]/g, '').replace(/\u0640/g, '').toLowerCase();
/** The text of a line as the field shows it */
export const lineText = (l) => (l.words || []).map((w) => w.t).join(' ');
/** "0:12.4 – 0:14.1" */
export const rangeLabel = (l) => `${fmtMs(l.start)} – ${fmtMs(l.end)}`;
/** The lines whose text contains the search (all of them for an empty search) */
export function filterRows(lines, q) {
  const k = fold(q).trim().replace(/\s+/g, ' ');
  if (!k) return lines;
  return lines.filter((l) => fold(lineText(l)).replace(/\s+/g, ' ').includes(k));
}
/**
 * The edited text of line `id` committed: the new lines, or null when nothing changes (same words, or the line is gone).
 * Called when the field loses focus, which a drag on the timeline or the video forces first (so a drag never drops typed text).
 */
export function textCommit(lines, id, value) {
  const ls = lines || [], i = ls.findIndex((l) => l.id === id); if (i < 0) return null;
  if (String(value || '').trim().split(/\s+/).filter(Boolean).join(' ') === lineText(ls[i])) return null;
  return ls.map((l, k) => (k === i ? retext(l, value) : l));
}

/** A design's captions without writing anything: a reel never opened since keeps its switch in `d.audio.captions` */
export function capsView(d) {
  if (d && d.captions) return d.captions;
  if (kindOf(d) === 'reel') return { ...CAPTIONS_DEFAULT, lines: [], on: !!(d.audio && d.audio.captions), source: 'voiceover' };
  return { ...CAPTIONS_DEFAULT, lines: [] };
}
/** Some scene of the reel has a voice-over line */
export const hasVoiceover = (d) => !!d && Array.isArray(d.pages) && d.pages.some((pg) => { const vo = voOf(pg); return !!(vo && String(vo.text || '').trim()); });

/**
 * The reel's captions as timeline blocks, one per scene with a voice-over line: while its clip plays (plus a 400 ms tail,
 * inside its scene), or the whole scene when the line has no clip yet (inside the whole-video voice track when there is one).
 */
export function captionBlocks(d) {
  if (!d || !Array.isArray(d.pages)) return [];
  const tl = timeline(d.pages), a = audioOf(d), tr = a.track && a.track.src && a.track.dur ? a.track : null;
  return tl.scenes.map((s) => {
    const vo = voOf(d.pages[s.i]), text = vo && String(vo.text || '').trim(); if (!text) return null;
    const sEnd = s.start + s.dur;
    let start = s.start, end = sEnd;
    if (vo.src && vo.dur) { start = s.start + LEAD; end = Math.min(start + vo.dur + 400, sEnd); }
    else if (tr) { start = Math.max(start, tr.at || 0); end = Math.min(end, (tr.at || 0) + tr.dur + 400); }
    return end > start ? { i: s.i, start, end, text } : null;
  }).filter(Boolean);
}

/** The voice-over lines, grouped scene by scene (a line never runs across two scenes), with ids stable across rebuilds */
let memo = { key: null, lines: null };
function voiceoverLines(d) {
  const style = capsView(d).style || DEFAULT_STYLE, tl = timeline(d.pages), a = audioOf(d);
  const key = JSON.stringify([voSig(d.pages), tl.scenes.map((s) => s.start), a.track && [a.track.at, a.track.dur, !!a.track.src], style]);
  if (memo.key === key) return memo.lines;
  const blocks = captionBlocks(d), out = [];
  for (const sc of tl.scenes) {
    const vo = voOf(d.pages[sc.i]);
    let words = voiceoverWords(d.pages, { scenes: [sc] }, LEAD);
    if (!words.length && vo && !(vo.dur > 0)) { // a script line without a voice yet: spread over its block, as before
      const b = blocks.find((x) => x.i === sc.i);
      if (b) words = spreadScript(b.text.replace(/\s+/g, ' '), b.start, b.end).words;
    }
    if (words.length) out.push(...group(words, style));
  }
  const lines = out.map((l, k) => ({ ...l, id: 'vo' + k }));
  memo = { key, lines };
  return lines;
}
/** The lines a reel shows: built from the voice-over for `source` 'voiceover' (or unset), else the stored lines untouched */
export function reelCaptions(d) {
  const c = capsView(d);
  if (c.source === 'voiceover' || c.source == null) return voiceoverLines(d);
  return c.lines || [];
}
/** The lines of a design, whatever its kind */
export const linesOf = (d) => (kindOf(d) === 'reel' ? reelCaptions(d) : capsView(d).lines || []);

/* the writers below change `d` in place: call them inside mutate() */
/** A reel's captions on the design (the legacy switch moved over): off and from the voice-over when it never had any */
export function prepareReel(d) {
  if (kindOf(d) !== 'reel') return false;
  let changed = migrateCaptions(d);
  if (!d.captions) { d.captions = { ...CAPTIONS_DEFAULT, lines: [], on: false, source: 'voiceover' }; changed = true; }
  return changed;
}
/** Captions on or off (preview and export) */
export function toggleCaptions(d) {
  prepareReel(d);
  const c = capsOf(d); c.on = c.on === false;
  return c.on;
}
/** fn(lines) -> new lines; the lines become the user's ('manual'), and a reel remembers the voice-over they were made from */
export function editCaptions(d, fn) {
  const reel = kindOf(d) === 'reel';
  if (reel) prepareReel(d);
  const base = linesOf(d), c = capsOf(d);
  c.lines = fn(base);
  c.source = 'manual';
  if (reel) c.voSig = voSig(d.pages);
}
/** A reel's lines go back to following the voice-over */
export function rebuildFromVoiceover(d) {
  prepareReel(d);
  const c = capsOf(d); c.source = 'voiceover'; c.voSig = null; c.lines = [];
}

/* ---------- DOM ---------- */
export function installCaptionPanels(ctx, VS) {
  const { ED, ACT, ic, esc, mutate, save, canEdit, toast, ed } = ctx;
  const $ = (s) => document.querySelector(s);
  const can = () => !canEdit || canEdit();
  const src = () => VS.source();
  const hooks = () => { const S = src(); return (S && S.captions) || {}; };
  const now = () => { const S = src(), P = S && S.player; return P && (!P.ready || P.ready()) ? Math.round(P.time()) : 0; };
  /** The search, kept while the panel is redrawn (another design starts empty) */
  let q = '', qFor = null, lastRow = null;

  /** After an edit: the preview, the timeline and the current row follow */
  function light() { const h = hooks(); if (h.light) h.light(); VS.refresh(); rehilite(); }
  function panelToo() { const p = $('#edPanel'), y = p ? p.scrollTop : 0; ed.panel(); const p2 = $('#edPanel'); if (p2) p2.scrollTop = y; light(); }
  /** One undoable caption edit: fn(lines) -> lines */
  function edit(fn, redraw = panelToo) {
    if (!ED.d || !can()) return;
    mutate(() => editCaptions(ED.d, fn), redraw); save();
  }
  function setOn() {
    if (!ED.d || !can()) return;
    mutate(() => toggleCaptions(ED.d), panelToo); save();
  }

  /* ---- the panel ---- */
  function rowHTML(l, ro, hide) {
    return `<div class="ft-row" data-id="${esc(l.id)}"${hide ? ' hidden' : ''}><button class="ft-t" data-act="cpSeek" data-ms="${+l.start || 0}" title="Go to this caption">${esc(rangeLabel(l))}</button>
      <input class="ft-in" dir="auto" data-cp-text="${esc(l.id)}" value="${esc(lineText(l))}" placeholder="Type the caption" aria-label="Caption text" spellcheck="false" ${ro ? 'readonly' : ''}>
      ${ro ? '' : `<button class="btn ghost icon sm ft-more" data-act="cpMore" data-id="${esc(l.id)}" aria-haspopup="menu" aria-label="Caption actions" title="More">${ic('more', 16)}</button>`}</div>`;
  }
  function render(d, kind) {
    if (qFor !== d) { q = ''; qFor = d; }
    const c = capsView(d), on = c.on !== false, lines = linesOf(d), ro = !can(), h = hooks();
    const head = `<div class="cp-head"><h3>Captions</h3><label class="cp-on"><span>${on ? 'On' : 'Off'}</span><button class="sw ${on ? 'on' : ''}" data-act="cpOn" aria-label="Captions on or off" aria-pressed="${on}" ${ro ? 'disabled' : ''}><span></span></button></label></div>`;
    if (kind === 'reel' && !lines.length && !hasVoiceover(d)) {
      return `${head}<div class="cp-empty"><p class="sm-t muted">Captions come from the voice-over script.</p><button class="btn secondary sm" data-act="cpAudio">${ic('music38', 15)}Open Audio</button></div>`;
    }
    const rebuild = kind === 'reel' && needsRebuild(c, d.pages) && !ro
      ? `<div class="note cp-rebuild">${ic('alert', 15)}<span>The voice-over changed since you edited these captions.</span><button class="btn secondary sm" data-act="cpRebuild">${ic('refresh', 14)}Rebuild from voice-over</button></div>` : '';
    let body;
    if (lines.length) {
      const keep = new Set(filterRows(lines, q).map((l) => l.id));
      body = `<label class="cp-search">${ic('search', 15)}<input class="field" type="search" data-cp-q value="${esc(q)}" placeholder="Search captions" aria-label="Search captions" dir="auto"></label>
        <div class="ft-rows">${lines.map((l) => rowHTML(l, ro, !keep.has(l.id))).join('')}</div><p class="xs-t muted cp-none" ${keep.size ? 'hidden' : ''}>No caption matches.</p>`;
    } else body = (h.body && h.body()) || '<p class="sm-t muted">No captions yet.</p>';
    const foot = ro ? '' : `<div class="ft-foot"><button class="btn secondary sm" data-act="cpAdd">${ic('plus', 15)}Add a line at the playhead</button>${h.foot ? h.foot() : ''}</div>`;
    return `<div class="cp${on ? '' : ' off'}">${head}${rebuild}${body}${foot}</div>`;
  }
  function drawn() { lastRow = null; rehilite(); }
  VS.panel('captions', render, drawn);

  /** The row being spoken */
  function hilite(ms, playing) {
    if (!ED.d || ED.tab !== 'captions') return;
    const lines = linesOf(ED.d), l = lines.find((x) => ms >= x.start && ms < x.end), id = l ? l.id : null;
    if (id === lastRow) return; lastRow = id;
    document.querySelectorAll('#edPanel .ft-row.on').forEach((x) => x.classList.remove('on'));
    if (id) { const r = document.querySelector(`#edPanel .ft-row[data-id="${CSS.escape(id)}"]`); if (r) { r.classList.add('on'); if (playing && !r.contains(document.activeElement)) r.scrollIntoView({ block: 'nearest' }); } }
  }
  function rehilite() { lastRow = undefined; hilite(now(), false); }
  const _tick = VS.tick;
  VS.tick = (ms, playing) => { _tick(ms, playing); if (src()) hilite(ms, playing); };
  /** A caption block was clicked on the timeline: its row comes into view */
  function reveal(id) { const r = document.querySelector(`#edPanel .ft-row[data-id="${CSS.escape(id)}"]`); if (r) { r.hidden = false; r.scrollIntoView({ block: 'nearest' }); } }

  /* ---- editing ---- */
  function commitText(inp) {
    if (!ED.d || !can() || !src()) return;
    const id = inp.dataset.cpText, lines = linesOf(ED.d), i = lines.findIndex((l) => l.id === id); if (i < 0) return;
    const next = textCommit(lines, id, inp.value);
    if (!next) { inp.value = lineText(lines[i]); return; }
    // the rows keep focus: only the preview and the timeline follow (a reel's ids stay those of the built lines)
    edit(() => next, light);
  }
  function splitAt(id) {
    const t = now(), lines = linesOf(ED.d), i = lines.findIndex((l) => l.id === id), l = lines[i];
    if (!l || !(t > l.start && t < l.end) || !l.words.some((w) => w.s >= t) || !l.words.some((w) => w.s < t)) { toast('Move the playhead inside the caption, between two words, to split it.'); return; }
    edit((a) => [...a.slice(0, i), ...split(a[i], t), ...a.slice(i + 1)]);
  }
  function mergeNext(id) {
    const lines = linesOf(ED.d), k = lines.findIndex((l) => l.id === id);
    if (k >= 0 && k < lines.length - 1) edit((a) => [...a.slice(0, k), merge(a[k], a[k + 1]), ...a.slice(k + 2)]);
  }
  function addAtPlayhead() {
    if (!ED.d || !can()) return;
    const before = linesOf(ED.d), after = addLine(before, now());
    if (after === before) { toast('There is no room for a line here. Move the playhead to a gap.'); return; }
    const old = new Set(before.map((l) => l.id)), fresh = after.find((l) => !old.has(l.id));
    q = ''; edit(() => after);
    const inp = fresh && document.querySelector(`#edPanel [data-cp-text="${CSS.escape(fresh.id)}"]`);
    if (inp) { inp.focus(); inp.scrollIntoView({ block: 'nearest' }); }
  }
  function openMenu(btn, rows) {
    document.querySelectorAll('#ctx').forEach((x) => x.remove());
    const r = btn.getBoundingClientRect(), c = document.createElement('div'); c.className = 'ctx'; c.id = 'ctx'; c.setAttribute('role', 'menu');
    c.innerHTML = rows.map((x, k) => `<button role="menuitem" data-k="${k}" class="${x[2] || ''}" ${x[3] ? 'disabled' : ''}><span class="ci">${x[0]}</span></button>`).join('');
    document.body.append(c); btn.setAttribute('aria-expanded', 'true');
    const hh = c.offsetHeight, ww = c.offsetWidth;
    c.style.left = Math.max(8, Math.min(r.right - ww, innerWidth - ww - 8)) + 'px';
    c.style.top = (r.bottom + 6 + hh < innerHeight ? r.bottom + 6 : Math.max(8, r.top - hh - 6)) + 'px';
    const close = () => { c.remove(); btn.removeAttribute('aria-expanded'); removeEventListener('pointerdown', gone, true); };
    const gone = (ev) => { if (!c.contains(ev.target)) close(); };
    c.onclick = (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { close(); rows[+b.dataset.k][1](); } };
    c.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { close(); btn.focus(); } };
    setTimeout(() => addEventListener('pointerdown', gone, true));
    const f = c.querySelector('button:not(:disabled)'); f && f.focus();
  }
  function rowMenu(btn) {
    if (!ED.d || !can()) return;
    const id = btn.dataset.id, lines = linesOf(ED.d), i = lines.findIndex((l) => l.id === id); if (i < 0) return;
    openMenu(btn, [
      ['Split at playhead', () => splitAt(id)],
      ['Merge with next', () => mergeNext(id), '', i >= lines.length - 1],
      ['Delete', () => edit((a) => a.filter((l) => l.id !== id)), 'dl'],
    ]);
  }

  Object.assign(ACT, {
    cpSeek: (a) => { const S = src(), P = S && S.player; if (P && (!P.ready || P.ready())) P.seek(+a.dataset.ms); },
    cpMore: (a) => rowMenu(a),
    cpAdd: () => addAtPlayhead(),
    cpOn: () => setOn(),
    cpRebuild: () => { if (ED.d && can()) { mutate(() => rebuildFromVoiceover(ED.d), panelToo); save(); } },
    cpAudio: () => ACT.edTab({ dataset: { k: 'audio' } }),
  });
  document.addEventListener('focusout', (e) => { const t = e.target; if (t && t.matches && t.matches('[data-cp-text]')) commitText(t); });
  document.addEventListener('keydown', (e) => {
    const t = e.target; if (!t || !t.matches || !t.matches('[data-cp-text]')) return;
    if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const l = ED.d && linesOf(ED.d).find((x) => x.id === t.dataset.cpText); t.value = l ? lineText(l) : ''; t.blur(); }
  }, true);
  /* the search hides rows in place: the field keeps focus while typing */
  document.addEventListener('input', (e) => {
    const t = e.target; if (!t || !t.matches || !t.matches('[data-cp-q]') || !ED.d) return;
    q = t.value;
    const keep = new Set(filterRows(linesOf(ED.d), q).map((l) => l.id));
    document.querySelectorAll('#edPanel .ft-row[data-id]').forEach((r) => { r.hidden = !keep.has(r.dataset.id); });
    const none = $('#edPanel .cp-none'); if (none) none.hidden = keep.size > 0;
  });

  /** The caption fonts (the stacks of captions.js), once */
  let fontsHooked = false;
  function loadFonts() {
    if (typeof document === 'undefined') return;
    if (!fontsHooked && document.fonts && document.fonts.addEventListener) { // a paused preview redraws once a caption font arrives
      fontsHooked = true; document.fonts.addEventListener('loadingdone', () => { const h = hooks(); if (h.light) h.light(); });
    }
    if (document.querySelector('link[data-ft-fonts]')) return;
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = FONTS_CSS; l.dataset.ftFonts = '1'; document.head.append(l);
  }

  /** What sources use: one undoable edit of the lines, the on / off switch, a row brought into view, the fonts */
  VS.captions = { edit: (fn) => edit(fn), toggle: setOn, reveal, loadFonts, light };
  return VS.captions;
}
