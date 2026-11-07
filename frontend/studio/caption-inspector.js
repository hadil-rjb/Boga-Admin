/* ============================================================
   Caption inspector: the Video Studio's caption style tabs, on the right, for videos and reels (video-studio.js routes a
   caption selection, or the Captions / Styles panel being open, here through VS.inspector('caption')).
   A 4 × 2 icon grid of tabs: Font, Colors, Spacing, Layout, Box, Animate, Timing, Reference. Every control writes
   `capsOf(d).style` (caption-store.js): live preview on `input` (the source's `captions.preview(style)`), one mutate() on
   `change` through editStyle (caption-panels.js: the style becomes custom, preset null).
   Words per line, max characters, minimum duration and gap regroup the lines (group() in captions.js reads them):
   a video's untouched speech lines from the transcript words (GET /footage/:id/words), hand-edited / script / SRT lines from
   their own words (after a confirmation), a reel's voice-over lines by themselves (they are built from the style).
   Reference: "Copy from a video" uploads a reference as its own record (upload.js, role 'reference'; the server reads its
   caption style by itself: probe, proxy, frames, caption-style), for videos and reels alike: nothing is paired, the grade is
   untouched. Only its caption style is applied, when it lands. Then the brand looks with a caption style.
   dragCaption (shared by the video's frame and the reel's preview): drag the caption to set its height (style y).
   The pure helpers at the top are unit-tested; installCaptionInspector is a DOM module.
   ============================================================ */
import { group, layout, lineAt, withDefaults, DEFAULT_STYLE, FONT_STACKS } from './captions.js';
import { capsOf, kindOf } from './caption-store.js';
import { capsView, linesOf, editStyle, applyBrandStyle, styleLabel, captionsOn } from './caption-panels.js';
import { presetById } from './caption-presets.js';
import { uploadFootage, isVideoFile, isAbort } from './upload.js';

/* ---------- pure helpers ---------- */
/** The tabs, in order: [key, label, icon] */
export const INSPECTOR_TABS = [
  ['font', 'Font', 'csFont'], ['colors', 'Colors', 'csColors'], ['spacing', 'Spacing', 'csSpacing'], ['layout', 'Layout', 'csLayout'],
  ['box', 'Box', 'csBox'], ['animate', 'Animate', 'csAnim'], ['timing', 'Timing', 'csTiming'], ['reference', 'Reference', 'csRef'],
];
export const FONT_NAMES = { 'sans-bold': 'Cairo bold sans', sans: 'Noto Sans Arabic', serif: 'Amiri serif', display: 'Lalezar display' };
export const WEIGHT_LIST = [[400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']];
export const ANIM_LIST = [['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['karaoke', 'Karaoke'], ['word', 'Word by word'], ['typewriter', 'Typewriter'], ['bounce', 'Bounce'], ['slide', 'Slide up']];
export const HL_LIST = [['box', 'Box'], ['color', 'Colour'], ['scale', 'Scale'], ['none', 'None']];
/** Numeric fields: [min, max, integer] */
const NUM = {
  size: [0.02, 0.12], ls: [-0.05, 0.3], lh: [0.9, 2], x: [0, 1], y: [0, 1], offset: [-1000, 1000, true], animSpeed: [0.5, 2],
  boxOpacity: [0, 1], minDur: [0, 3000, true], gap: [0, 1000, true], maxWords: [1, 8, true], maxChars: [8, 60, true], lines: [1, 2, true],
  'stroke.width': [0.001, 0.02], 'shadow.blur': [0, 0.03], 'box.pad': [0, 0.04], 'box.radius': [0, 0.5],
};
const ENUM = {
  font: Object.keys(FONT_STACKS), case: ['none', 'upper', 'lower'], align: ['left', 'center', 'right'],
  anim: ANIM_LIST.map((a) => a[0]), 'highlight.mode': HL_LIST.map((a) => a[0]),
};
const COLORS = new Set(['color', 'stroke.color', 'shadow.color', 'highlight.color', 'highlight.text', 'box.color']);
/** What an object field starts from when it is switched on, or edited while off */
const PARENTS = {
  stroke: () => ({ color: '#000000', width: 0.004 }), shadow: () => ({ ...DEFAULT_STYLE.shadow }),
  highlight: () => ({ ...DEFAULT_STYLE.highlight }), box: () => ({ color: '#000000', pad: 0.012, radius: 0.18 }),
};
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const get0 = (st, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), st);
const RGBA = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i;
/** The opacity of a CSS colour (1 for hex or anything unreadable) */
export const alphaOf = (c) => { const m = RGBA.exec(String(c || '').trim()); return m && m[4] != null && isFinite(+m[4]) ? clamp(+m[4], 0, 1) : 1; };
/** #rgb / #rrggbb with an opacity, as rgba() */
function rgbaOf(hex, a) {
  const h = hex6(hex); return `rgba(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)},${Math.round(a * 1000) / 1000})`;
}
/**
 * One field of a caption style set, as a new style (a missing style starts from the default; the input is never changed).
 * `path` is a field ('size') or an object's field ('stroke.color'); 'stroke', 'shadow', 'box' take true / false (on / off).
 * Numbers are clamped to the field's range, colours must be #rgb or #rrggbb, choices must be known; anything else changes nothing.
 */
export function setStyleField(style, path, value) {
  const s = JSON.parse(JSON.stringify(style || DEFAULT_STYLE));
  if (PARENTS[path] && path !== 'highlight') { s[path] = value ? (s[path] || PARENTS[path]()) : null; return s; }
  let v;
  if (NUM[path]) {
    const [a, b, int] = NUM[path], n = typeof value === 'string' && !value.trim() ? NaN : +value;
    if (!isFinite(n)) return s;
    v = clamp(int ? Math.round(n) : Math.round(n * 10000) / 10000, a, b);
  } else if (path === 'weight') {
    const n = +value; if (!isFinite(n) || n < 100 || n > 900) return s; v = Math.round(n / 100) * 100;
  } else if (ENUM[path]) { if (!ENUM[path].includes(value)) return s; v = value; }
  else if (COLORS.has(path)) {
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || ''))) return s;
    const a = alphaOf(get0(s, path)); // a translucent colour (the default shadow's rgba) keeps its opacity
    v = a < 1 ? rgbaOf(String(value), a) : String(value);
  }
  else return s;
  const [p, k] = path.split('.');
  if (k) s[p] = { ...(s[p] || PARENTS[p]()), [k]: v }; else s[p] = v;
  return s;
}
/** The fields group() reads: changing one regroups the lines */
export const REGROUP_FIELDS = new Set(['maxWords', 'maxChars', 'minDur', 'gap']);
/**
 * Where regrouped lines take their words from: 'voiceover' (a reel's built lines follow the style by themselves),
 * 'speech' (a video's untouched speech lines: the transcript words) or 'lines' (hand-edited, script or SRT lines: their own words).
 */
export function regroupFrom(kind, caps) {
  const src = caps && caps.source;
  if (kind === 'reel') return src === 'voiceover' || src == null ? 'voiceover' : 'lines';
  return src === 'speech' || src == null ? 'speech' : 'lines';
}
/** Every word of the lines, in time order */
export const wordsOfLines = (lines) => (lines || []).flatMap((l) => (l && l.words) || []).slice().sort((a, b) => a.s - b.s);
/** A colour for <input type=color> */
export const hex6 = (v, fb = '#000000') => {
  const r = RGBA.exec(String(v || '').trim());
  if (r) return '#' + [r[1], r[2], r[3]].map((x) => clamp(+x, 0, 255).toString(16).padStart(2, '0')).join('');
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim()); if (!m) return fb;
  return '#' + (m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]).toLowerCase();
};
/** A reference record's caption-style step is over: 'done' (style ready), 'failed', or null while it is still coming */
export function refStyleState(rec) {
  if (!rec) return null;
  const j = (rec.jobs && rec.jobs['caption-style']) || {};
  if (j.state === 'done' && rec.captionStyle) return 'done';
  if (j.state === 'failed' || j.state === 'skipped' || rec.status === 'failed') return 'failed';
  if (rec.status === 'ready' && !['queued', 'running'].includes(j.state)) return rec.captionStyle ? 'done' : 'failed';
  return null;
}

export const REF_GONE = 'That video is no longer available. Upload it again.';
export const REF_FAILED = 'Couldn’t read the caption style. Try again.';
/**
 * A poll of the reference failed (`err` from api()): { stop, fails, msg }. A 404 stops at once; any other error stops after
 * 3 failures in a row (`fails` is the count before this one; a successful poll starts it again from 0).
 */
export function pollFailure(fails, err) {
  const n = (fails || 0) + 1;
  if (err && err.status === 404) return { stop: true, fails: n, msg: REF_GONE };
  return n >= 3 ? { stop: true, fails: n, msg: REF_FAILED } : { stop: false, fails: n };
}
/** The pointer at (px, py) (fractions of the frame) is on the caption block L (px of a W × H frame), `pad` around it */
export function captionHit(L, W, H, px, py, pad = 0.025) {
  if (!L || !W || !H) return false;
  return px >= L.x / W - pad && px <= (L.x + L.w) / W + pad && py >= L.y / H - pad && py <= (L.y + L.h) / H + pad;
}

/**
 * Starts dragging the caption shown on `frame` (`canvas` is the caption layer drawn over it, at its own pixel size) when the
 * pointer is on it: returns false otherwise. While dragging, onMove(style) previews and the inspector's Vertical slider follows;
 * onEnd(y) on release (y null: nothing changed or cancelled), for one mutate() by the caller.
 */
export function dragCaption(e, { frame, canvas, lines, style, ms, onMove, onEnd }) {
  if (!frame || !canvas || !canvas.width || !canvas.height || (e.button || 0) > 0) return false;
  const st = style || DEFAULT_STYLE, line = lineAt(lines || [], ms - (+withDefaults(st).offset || 0)); if (!line) return false;
  const g = canvas.getContext && canvas.getContext('2d'); if (!g) return false;
  const W = canvas.width, H = canvas.height, L = layout(g, line, st, W, H), r = frame.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
  if (!captionHit(L, W, H, px, py)) return false;
  e.preventDefault();
  const y0 = st.y, off = py - y0; let y = y0;
  try { frame.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  frame.classList.add('cs-drag');
  const at = (ev) => {
    y = setStyleField(st, 'y', (ev.clientY - r.top) / r.height - off).y;
    onMove({ ...st, y });
    const sl = document.querySelector('#edProps [data-cs="y"]');
    if (sl) { sl.value = String(Math.round(y * 100)); sl.dispatchEvent(new Event('cs:out', { bubbles: true })); }
  };
  const done = (commit) => {
    frame.removeEventListener('pointermove', at); frame.removeEventListener('pointerup', up); frame.removeEventListener('pointercancel', cancel); frame.removeEventListener('lostpointercapture', cancel);
    frame.classList.remove('cs-drag');
    onEnd(commit && y !== y0 ? y : null);
  };
  const up = () => done(true), cancel = () => done(false);
  frame.addEventListener('pointermove', at); frame.addEventListener('pointerup', up); frame.addEventListener('pointercancel', cancel); frame.addEventListener('lostpointercapture', cancel);
  return true;
}

/* ---------- DOM ---------- */
export function installCaptionInspector(ctx, VS) {
  const { ED, ACT, IC, ic, esc, mutate, save, canEdit, toast, brand, modal, ed, api } = ctx;
  Object.assign(IC, {
    csFont: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    csColors: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2a10 10 0 0 0 0 20c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2Z"/>',
    csSpacing: '<path d="M3 4v16M21 4v16"/><path d="M7 12h10"/><path d="m10 9-3 3 3 3M14 9l3 3-3 3"/>',
    csLayout: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 15h10M9 18h6"/>',
    csBox: '<rect width="20" height="10" x="2" y="7" rx="3"/><path d="M7 12h10"/>',
    csAnim: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0Z"/>',
    csTiming: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    csRef: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
    csAlL: '<path d="M21 6H3M15 12H3M17 18H3"/>',
    csAlC: '<path d="M21 6H3M17 12H7M19 18H5"/>',
    csAlR: '<path d="M21 6H3M21 12H9M21 18H7"/>',
  });
  const $ = (s) => document.querySelector(s);
  const can = () => !canEdit || canEdit();
  const src = () => VS.source();
  const hooks = () => { const S = src(); return (S && S.captions) || {}; };
  const TAB_KEY = 'boga.capTab';
  let tab = 'font'; try { const t = localStorage.getItem(TAB_KEY); if (INSPECTOR_TABS.some((x) => x[0] === t)) tab = t; } catch (e) { /* default */ }
  /** The safe-zone guide on a video's frame (session only) */
  let guide = false, guideFor = null;
  /** The reference being read: { d, id, state: 'upload' | 'reading' | 'failed', pct, msg, ac, timer } */
  let ref = null;
  const getBrand = () => { try { return (brand && brand()) || null; } catch (e) { return null; } };
  const styleNow = (d) => capsView(d).style || DEFAULT_STYLE;

  /* ---- controls (units: the model's value × k is what the slider shows) ---- */
  const dis = () => (can() ? '' : 'disabled');
  const fmt = {
    pct: (v) => `${Math.round(v)}%`, ms: (v) => `${(v / 1000).toFixed(2)} s`, sms: (v) => `${v > 0 ? '+' : ''}${(v / 1000).toFixed(2)} s`,
    x: (v) => `${(+v).toFixed(1)}×`, n: (v) => String(+(+v).toFixed(2)), int: (v) => String(Math.round(v)),
  };
  const get = (st, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), st);
  function range(st, path, label, min, max, step, k, f, fallback) {
    const raw = get(st, path), v = Math.round(((raw == null ? fallback : +raw) || 0) * k * 1000) / 1000, c = clamp(v, min, max);
    return `<label class="ft-rg"><span>${esc(label)}</span><input type="range" data-cs="${path}" data-k="${k}" data-f="${f}" min="${min}" max="${max}" step="${step}" value="${c}" style="--p:${((c - min) / (max - min)) * 100}%" ${dis()}><output>${esc(fmt[f](c))}</output></label>`;
  }
  const color = (st, path, label, fb) => `<label class="ft-rg ft-cl"><span>${esc(label)}</span><input type="color" data-cs="${path}" value="${hex6(get(st, path), fb)}" ${dis()}></label>`;
  const sw = (path, label, on) => `<label class="ft-rg ft-sw"><span>${esc(label)}</span><input type="checkbox" data-cs="${path}" ${on ? 'checked' : ''} ${dis()}></label>`;
  const pick = (st, path, label, list) => { const cur = get(st, path); return `<label class="ft-rg ft-se"><span>${esc(label)}</span><select class="field" data-cs="${path}" ${dis()}>${list.map(([v, l]) => `<option value="${esc(String(v))}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`; };
  const num = (st, path, label, min, max, off) => `<label class="ft-rg ft-wpl"><span>${esc(label)}</span><input type="number" data-cs="${path}" min="${min}" max="${max}" step="1" value="${get(st, path) == null ? DEFAULT_STYLE[path] : get(st, path)}" ${dis() || (off ? 'disabled' : '')}></label>`;
  /** Choice buttons: one click is one edit */
  const seg = (st, path, label, list, cur = get(st, path)) => `<div class="ft-rg cs-seg-r"><span>${esc(label)}</span><div class="seg cs-seg" role="radiogroup" aria-label="${esc(label)}">${list.map(([v, l, i]) => `<button type="button" role="radio" class="${String(v) === String(cur) ? 'on' : ''}" aria-checked="${String(v) === String(cur)}" data-act="csSet" data-path="${path}" data-v="${esc(String(v))}" ${i ? `aria-label="${esc(l)}" title="${esc(l)}"` : ''} ${dis()}>${i ? ic(i, 16) : esc(l)}</button>`).join('')}</div></div>`;

  function fontTab(st) {
    const wl = WEIGHT_LIST.some(([w]) => w === st.weight) ? WEIGHT_LIST : [...WEIGHT_LIST, [st.weight, String(st.weight)]];
    return `${pick(st, 'font', 'Family', Object.keys(FONT_STACKS).map((k) => [k, FONT_NAMES[k] || k]))}
      ${pick(st, 'weight', 'Weight', wl)}
      ${range(st, 'size', 'Size', 2, 12, 0.5, 100, 'n')}
      ${seg(st, 'case', 'Case', [['none', 'Aa'], ['upper', 'AA']], st.case === 'upper' ? 'upper' : 'none')}
      <p class="xs-t muted">Size is a share of the frame’s height. Every family reads Arabic and Latin.</p>`;
  }
  function colorsTab(st) {
    return `${color(st, 'color', 'Text', '#ffffff')}
      <span class="label cs-sub">Active word</span>
      ${color(st, 'highlight.text', 'Text', '#1a1a1a')}${color(st, 'highlight.color', 'Fill', '#e8b54a')}
      <span class="label cs-sub">Outline</span>
      ${sw('stroke', 'On', !!st.stroke)}${st.stroke ? `${color(st, 'stroke.color', 'Colour', '#000000')}${range(st, 'stroke.width', 'Width', 1, 20, 1, 1000, 'int')}` : ''}
      <span class="label cs-sub">Shadow</span>
      ${sw('shadow', 'On', !!st.shadow)}${st.shadow ? `${color(st, 'shadow.color', 'Colour', '#000000')}${range(st, 'shadow.blur', 'Blur', 0, 30, 1, 1000, 'int')}` : ''}`;
  }
  function spacingTab(st, d) {
    const has = linesOf(d).length > 0, vo = regroupFrom(kindOf(d), capsView(d)) === 'voiceover';
    return `${range(st, 'ls', 'Letter spacing', -5, 30, 1, 100, 'int', 0)}
      ${range(st, 'lh', 'Line height', 0.9, 2, 0.05, 1, 'n', 1.15)}
      ${num(st, 'maxWords', 'Words per line', 1, 8, !has && !vo)}
      ${num(st, 'maxChars', 'Max characters', 8, 60, !has && !vo)}
      ${seg(st, 'lines', 'Max lines', [[1, '1'], [2, '2']], st.lines === 2 ? 2 : 1)}
      <p class="xs-t muted">${vo ? 'Lines follow the voice-over and regroup by themselves.' : 'Words per line and max characters regroup the lines.'}</p>`;
  }
  function layoutTab(st, d) {
    const video = kindOf(d) === 'video', on = video ? guide && guideFor === d : !!ED.safe;
    return `${range(st, 'y', 'Vertical', 0, 100, 1, 100, 'pct')}
      ${range(st, 'x', 'Horizontal', 0, 100, 1, 100, 'pct', 0.5)}
      ${seg(st, 'align', 'Alignment', [['left', 'Align left', 'csAlL'], ['center', 'Align centre', 'csAlC'], ['right', 'Align right', 'csAlR']], st.align || 'center')}
      <label class="ft-rg ft-sw"><span>Safe-zone guide</span><input type="checkbox" data-cs-guide ${on ? 'checked' : ''}></label>
      ${can() ? `<p class="xs-t muted">You can also drag the caption on the ${video ? 'video' : 'preview'} to move it.</p>` : ''}`;
  }
  function boxTab(st) {
    return `${sw('box', 'Background box', !!st.box)}
      ${st.box ? `${color(st, 'box.color', 'Colour', '#000000')}${range(st, 'boxOpacity', 'Opacity', 0, 100, 1, 100, 'pct', 1)}
        ${range(st, 'box.pad', 'Padding', 0, 40, 1, 1000, 'int', 0.012)}${range(st, 'box.radius', 'Radius', 0, 50, 1, 100, 'pct', 0.18)}` : ''}
      <span class="label cs-sub">Active word</span>
      <div class="seg cs-seg cs-seg-w" role="radiogroup" aria-label="Highlight">${HL_LIST.map(([v, l]) => { const on = ((st.highlight && st.highlight.mode) || 'none') === v; return `<button type="button" role="radio" class="${on ? 'on' : ''}" aria-checked="${on}" data-act="csSet" data-path="highlight.mode" data-v="${v}" ${dis()}>${esc(l)}</button>`; }).join('')}</div>`;
  }
  function animateTab(st) {
    const cur = st.anim || 'none';
    return `<div class="cs-anims" role="radiogroup" aria-label="Animation">${ANIM_LIST.map(([v, l]) => `<button type="button" role="radio" class="cs-anim${cur === v ? ' on' : ''}" aria-checked="${cur === v}" data-act="csSet" data-path="anim" data-v="${v}" ${dis()}>${esc(l)}</button>`).join('')}</div>
      ${range(st, 'animSpeed', 'Speed', 0.5, 2, 0.1, 1, 'x', 1)}`;
  }
  function timingTab(st, d) {
    const vo = regroupFrom(kindOf(d), capsView(d)) === 'voiceover';
    return `${range(st, 'offset', 'Offset', -1000, 1000, 50, 1, 'sms', 0)}
      ${range(st, 'minDur', 'Minimum line', 0, 3000, 100, 1, 'ms', 0)}
      ${range(st, 'gap', 'Gap between lines', 0, 1000, 50, 1, 'ms', 0)}
      <p class="xs-t muted">Offset moves every caption earlier or later. ${vo ? 'The voice-over lines follow the other two.' : 'The other two regroup the lines.'}</p>`;
  }
  function referenceTab(st, d) {
    const mine = ref && ref.d === d ? ref : null, ro = !can();
    let status = '';
    if (mine && mine.state === 'upload') status = `<div class="prog-w"><div class="prog"><i style="width:${Math.round(mine.pct * 100)}%"></i></div><span class="prog-pct">${Math.round(mine.pct * 100)}%</span></div><p class="xs-t muted" role="status">Uploading the reference…</p>`;
    else if (mine && mine.state === 'reading') status = `<p class="xs-t muted cs-busy" role="status"><span class="ft-dot"></span>Reading the caption style…</p>`;
    else if (mine && mine.state === 'failed') status = `<div class="note warn" role="alert">${ic('alert', 15)}<span>${esc(mine.msg || 'The caption style could not be read.')}</span></div>`;
    const busy = mine && (mine.state === 'upload' || mine.state === 'reading');
    const copy = ro ? '' : `<button class="btn secondary sm" data-act="csRefPick" ${busy ? 'disabled' : ''}>${ic('upload', 15)}Copy from a video</button><input type="file" accept="video/*,.mp4,.mov,.m4v,.webm" data-cs-ref hidden>
      ${busy ? `<button class="btn ghost sm" data-act="csRefStop">Stop</button>` : ''}`;
    const b = getBrand(), looks = (b && Array.isArray(b.looks) ? b.looks : []).filter((l) => l && l.id && l.captionStyle);
    const c = capsView(d);
    const rows = looks.length ? `<ul class="ft-lks cs-lks">${looks.map((l) => { const on = c.preset === 'bl:' + l.id; return `<li class="ft-lkr${on ? ' on' : ''}">${l.refThumb && /^data:image\//.test(l.refThumb) ? `<img src="${esc(l.refThumb)}" alt="" width="40" height="40">` : '<span class="ft-th"></span>'}
      <span class="ft-ln" title="${esc(l.name || l.id)}">${esc(l.name || l.id)}</span>
      ${ro ? '' : `<button class="btn secondary sm" data-act="csLook" data-id="${esc(l.id)}" ${on ? 'disabled' : ''}>${on ? 'In use' : 'Apply'}</button>`}</li>`; }).join('')}</ul>`
      : '<p class="xs-t muted">No brand look has a caption style yet.</p>';
    return `<span class="label cs-sub">Reference video</span>
      <p class="xs-t muted">Upload a video with burned-in captions to copy their style. Only the caption style changes.</p>
      <div class="cs-ref-act">${copy}</div>${status}
      <span class="label cs-sub">Brand looks</span>${rows}`;
  }
  const TABS = { font: fontTab, colors: colorsTab, spacing: spacingTab, layout: layoutTab, box: boxTab, animate: animateTab, timing: timingTab, reference: referenceTab };

  function render(sel, d) {
    if (!d || kindOf(d) === 'still') return null;
    // a reel's layer picked on the canvas after the panel opened: its properties win (a caption clicked on the timeline keeps the tabs)
    if (kindOf(d) === 'reel' && !(sel && sel.id) && ED.sel && ED.sel !== selAtOpen) return null;
    const st = { ...styleNow(d) }, c = capsView(d);
    const label = styleLabel(c, (id) => { const b = getBrand(); const lk = b && Array.isArray(b.looks) && String(id).startsWith('bl:') ? b.looks.find((l) => 'bl:' + l.id === id) : null; const bs = b && Array.isArray(b.captionStyles) && String(id).startsWith('bs:') ? b.captionStyles.find((x) => 'bs:' + x.id === id) : null; return (lk && lk.name) || (bs && bs.name) || null; });
    const grid = INSPECTOR_TABS.map(([k, l, i]) => `<button type="button" role="tab" class="cs-tab${tab === k ? ' on' : ''}" aria-selected="${tab === k}" data-act="csTab" data-k="${k}">${ic(i, 18)}<span>${esc(l)}</span></button>`).join('');
    const off = captionsOn(d) ? '' : '<p class="xs-t muted cs-off">Captions are off. Turn them on in the Captions panel to see this style.</p>';
    return `<div class="cs" data-cs-root><div class="cs-head"><h3>Caption style</h3><span class="xs-t muted" title="${esc(presetById(c.preset) ? 'Preset' : 'Style')}">${esc(label)}</span></div>
      <div class="cs-tabs" role="tablist" aria-label="Caption style">${grid}</div>
      <div class="cs-body" role="tabpanel" aria-label="${esc((INSPECTOR_TABS.find((t) => t[0] === tab) || [])[1] || '')}">${off}${TABS[tab](st, d)}</div></div>`;
  }
  VS.inspector('caption', render);

  /** The inspector drawn again, with the focus back on the control that had it */
  function redrawInspector() {
    const a = document.activeElement, key = a && a.closest && a.closest('#edProps') && (a.dataset.cs ? `[data-cs="${a.dataset.cs}"]` : a.dataset.act === 'csSet' ? `[data-act=csSet][data-path="${a.dataset.path}"][data-v="${a.dataset.v}"]` : a.dataset.act === 'csTab' ? `[data-act=csTab][data-k="${a.dataset.k}"]` : null);
    ed.props();
    if (key) { const n = document.querySelector('#edProps ' + key); if (n) n.focus(); }
  }
  /** After a style edit: the preview, the timeline, the Styles panel (its applied card and label) and the inspector */
  function after() {
    const h = hooks(); if (h.preview) h.preview(null); if (h.light) h.light(); VS.refresh();
    if (ED.tab === 'styles') { const p = $('#edPanel'), y = p ? p.scrollTop : 0; ed.panel(); const p2 = $('#edPanel'); if (p2) p2.scrollTop = y; }
    redrawInspector(); applyGuide();
  }

  /* ---- edits ---- */
  const valueOf = (el) => {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range') return +el.value / (+el.dataset.k || 1);
    if (el.type === 'number') return +el.value;
    if (el.dataset.cs === 'weight') return +el.value;
    return el.value;
  };
  function setOut(el) {
    if (el.type !== 'range') return;
    const o = el.closest('.ft-rg') && el.closest('.ft-rg').querySelector('output'); if (o) o.textContent = (fmt[el.dataset.f] || fmt.n)(+el.value);
    el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
  }
  function preview(el) {
    if (!ED.d || !can()) return; setOut(el);
    const h = hooks(); if (h.preview) h.preview(setStyleField(styleNow(ED.d), el.dataset.cs, valueOf(el)));
  }
  /** One field committed: one mutate() (a regrouping field also rebuilds the lines, in the same step) */
  function commit(path, value, el) {
    if (!ED.d || !can()) return;
    const d = ED.d, cur = styleNow(d), next = setStyleField(cur, path, value);
    if (JSON.stringify(next) === JSON.stringify(cur) && capsView(d).style) { const h = hooks(); if (h.preview) h.preview(null); if (el) redrawInspector(); return; }
    if (REGROUP_FIELDS.has(path)) { regroup(d, next, el); return; }
    mutate(() => editStyle(ED.d, next), after); save();
  }
  /** A style that changes the grouping: the lines are rebuilt from their words in the same undoable step */
  function regroup(d, next, el) {
    const kind = kindOf(d), c = capsView(d), from = regroupFrom(kind, c), lines = linesOf(d);
    const back = () => { const h = hooks(); if (h.preview) h.preview(null); redrawInspector(); };
    if (from === 'voiceover' || !lines.length) { mutate(() => editStyle(ED.d, next), after); save(); return; }
    const go = (words) => {
      if (ED.d !== d) return;
      if (!words.length) { toast('There are no words to group yet.'); back(); return; }
      mutate(() => { editStyle(ED.d, next); const cc = capsOf(ED.d); cc.lines = group(words, cc.style); }, after); save();
    };
    if (from === 'speech') {
      const id = d.footage && d.footage.src; if (!id || !api) { go(wordsOfLines(lines)); return; }
      api(`/footage/${id}/words`).then((w) => go(Array.isArray(w) && w.length ? w : wordsOfLines(lines)))
        .catch((e) => { toast((e && e.message) || 'Could not load the words'); back(); });
      return;
    }
    // hand-edited, script or SRT lines: their line breaks are replaced, so ask first
    ask('Regroup the captions?', 'This replaces your line breaks. The words and their timing stay.', 'Regroup', () => go(wordsOfLines(linesOf(ED.d))), back);
  }
  function ask(title, text, okLabel, onOk, onNo) {
    if (!modal) { onOk(); return; }
    let ok = false;
    modal(`<div class="mh"><h2>${esc(title)}</h2><button class="btn ghost icon sm" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="mb"><p class="sm-t">${esc(text)}</p></div>
      <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-cs-ok>${esc(okLabel)}</button></div>`,
    { onClose: () => { if (!ok && onNo) onNo(); }, onMount: (bg, close) => { const b = bg.querySelector('[data-cs-ok]'); b.addEventListener('click', () => { ok = true; close(); onOk(); }); b.focus(); } });
  }

  /* ---- the safe-zone guide: a video's frame gets bands; a reel uses the editor's safe zones ---- */
  function applyGuide() {
    const fr = $('#ftFrame'); if (!fr) return;
    const on = guide && guideFor === ED.d && kindOf(ED.d) === 'video';
    let g = fr.querySelector('.cs-guide');
    if (!on) { if (g) g.remove(); return; }
    if (!g) { g = document.createElement('div'); g.className = 'cs-guide'; g.setAttribute('aria-hidden', 'true'); fr.append(g); }
    const out = (ED.d.footage && ED.d.footage.out) || {}, tall = (+out.h || 16) / (+out.w || 9) > 1.5;
    g.innerHTML = tall ? '<i style="top:0;height:13%">Profile bar</i><i style="bottom:0;height:20%">Reply bar</i><b></b>' : '<i style="bottom:0;height:10%">Caption overlap on feed</i><b></b>';
  }
  function toggleGuide(on) {
    if (!ED.d) return;
    if (kindOf(ED.d) === 'video') { guide = !!on; guideFor = ED.d; applyGuide(); return; }
    if (!!ED.safe !== !!on && ACT.edSafe) ACT.edSafe();
  }
  const _tick = VS.tick; // the frame can be rebuilt: keep the guide on it
  VS.tick = (ms, playing) => { _tick(ms, playing); if (guide && guideFor === ED.d && !document.querySelector('#ftFrame .cs-guide')) applyGuide(); };

  /* ---- Reference: copy the caption style of an uploaded video ---- */
  function refDraw() { if (ED.d && tab === 'reference' && document.querySelector('#edProps [data-cs-root]')) redrawInspector(); }
  function refStop() { if (!ref) return; clearTimeout(ref.timer); if (ref.ac) ref.ac.abort(); ref = null; refDraw(); }
  async function copyFrom(file) {
    if (!ED.d || !can()) return;
    if (!isVideoFile(file)) { toast('Choose a video file'); return; }
    const b = getBrand(); if (!b || !b.id) { toast('Pick a brand first.'); return; }
    refStop();
    const d = ED.d, me = ref = { d, id: null, state: 'upload', pct: 0, msg: '', ac: new AbortController(), timer: 0 };
    const live = () => ref === me && ED.d === d;
    refDraw();
    let rec;
    try {
      rec = await uploadFootage(file, { role: 'reference', brand: b.id, api, signal: me.ac.signal, onProgress: (v) => {
        if (ref !== me) return; me.pct = v;
        const bar = document.querySelector('#edProps .cs .prog i'), pc = document.querySelector('#edProps .cs .prog-pct');
        if (bar) bar.style.width = Math.round(v * 100) + '%'; if (pc) pc.textContent = Math.round(v * 100) + '%';
      } });
    } catch (e) {
      if (ref !== me) return;
      if (isAbort(e)) { ref = null; refDraw(); return; }
      me.state = 'failed'; me.msg = (e && e.message) || 'The upload failed. Try again.'; refDraw(); return;
    }
    if (!live()) { if (ref === me) ref = null; return; }
    me.id = rec.id; me.state = 'reading'; refDraw();
    let tries = 0, fails = 0;
    const poll = async () => {
      if (!live()) return;
      let r = null;
      try { r = await api('/footage/' + rec.id, { signal: me.ac.signal }); fails = 0; } catch (e) {
        if (isAbort(e) || !live()) return;
        const f = pollFailure(fails, e); fails = f.fails;
        if (f.stop) { me.state = 'failed'; me.msg = f.msg; refDraw(); return; }
        me.timer = setTimeout(poll, 2000); return;
      }
      if (!live()) return;
      const s = refStyleState(r);
      // a reference that finished without reading its captions (an older server, a lost job): ask for the step once
      if (r && r.status === 'ready' && !(r.jobs && r.jobs['caption-style']) && !tries++) { api(`/footage/${rec.id}/retry`, { method: 'POST', body: { step: 'caption-style' } }).catch(() => {}); me.timer = setTimeout(poll, 2000); return; }
      if (s === 'done' && r.captionNote) { me.state = 'failed'; me.msg = r.captionNote; refDraw(); return; }
      if (s === 'done') { ref = null; applyStyle(r.captionStyle, 'reference', null, 'Copied the caption style'); return; }
      if (s === 'failed') { me.state = 'failed'; me.msg = (r && (r.captionNote || (r.jobs && r.jobs['caption-style'] && r.jobs['caption-style'].error) || r.error)) || 'The caption style could not be read.'; refDraw(); return; }
      me.timer = setTimeout(poll, 2000);
    };
    poll();
  }
  function applyStyle(style, from, id, msg) {
    if (!ED.d || !can() || !style) return;
    const c = capsView(ED.d);
    if (JSON.stringify(c.style) === JSON.stringify(style) && c.preset === id) { refDraw(); return; }
    mutate(() => applyBrandStyle(ED.d, style, from, id), after); save();
    if (msg) toast(msg);
  }
  function applyLook(id) {
    const b = getBrand(), l = b && Array.isArray(b.looks) ? b.looks.find((x) => x && x.id === id) : null;
    if (!l || !l.captionStyle) return;
    applyStyle(l.captionStyle, 'look', 'bl:' + l.id, `Applied “${l.name || 'Brand look'}”`);
  }

  /* ---- events ---- */
  /** The reel's selected layer when Captions or Styles was opened (see render) */
  let selAtOpen = null;
  const _tab = ACT.edTab;
  ACT.edTab = function (a) { const k = a && a.dataset && a.dataset.k; if (k === 'captions' || k === 'styles') selAtOpen = ED.sel; return _tab.apply(this, arguments); };
  Object.assign(ACT, {
    csTab: (a) => { tab = a.dataset.k; try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* not remembered */ } redrawInspector(); },
    csSet: (a) => { const p = a.dataset.path, v = a.dataset.v; commit(p, NUM[p] ? +v : v, a); },
    csLook: (a) => applyLook(a.dataset.id),
    csRefStop: () => refStop(),
    csRefPick: () => { const i = document.querySelector('#edProps [data-cs-ref]'); if (i) i.click(); },
  });
  const inInsp = (t) => t && t.matches && t.closest && t.closest('#edProps [data-cs-root]');
  document.addEventListener('input', (e) => { const t = e.target; if (inInsp(t) && t.matches('[data-cs]') && t.type !== 'number') preview(t); });
  /* a slider moved from outside (the caption dragged on the video): its number follows */
  document.addEventListener('cs:out', (e) => { if (inInsp(e.target)) setOut(e.target); });
  document.addEventListener('change', (e) => {
    const t = e.target; if (!inInsp(t)) return;
    if (t.matches('[data-cs]')) commit(t.dataset.cs, valueOf(t), t);
    else if (t.matches('[data-cs-guide]')) toggleGuide(t.checked);
    else if (t.matches('[data-cs-ref]')) { const f = t.files && t.files[0]; t.value = ''; if (f) copyFrom(f); }
  });
  /* another design: the reference read for the last one stops */
  addEventListener('hashchange', () => setTimeout(() => { if (ref && ref.d !== ED.d) refStop(); }));
  /** The sources call this when a session starts (for `d`) or ends (no `d`): a reference read for another design stops */
  const stopRef = (d) => { if (ref && (!d || ref.d !== d)) refStop(); };

  VS.captionInspector = { redraw: redrawInspector, applyGuide, stopRef };
  return VS.captionInspector;
}
