/* ============================================================
   Studio Agent, uploaded videos: what the agent's video tools need that has no DOM.
   The model speaks in seconds and in the sliders' units (−100…100, 0…100); a video design stores milliseconds,
   grade values (sliderToGrade) and volumes 0…1. These helpers turn the model's input into new caption lines,
   grade values and sound settings, skipping and naming what cannot apply, and build the `video` block of the
   agent's context. The editor applies the results in its own undoable steps (footage-editor.js FT.agent,
   engine.js). Pure, unit-tested (agent-video.test.js).
   ============================================================ */
import { retext, split, merge, retime } from './captions.js';
import { analysis, firstFailed, lookPath, gradeToSlider, sliderToGrade, GRADE_KEYS } from './footage-editor.js';

const MAX_EDITS = 100, MAX_TEXT = 300, MIN_LINE = 200;
const MOODS = ['upbeat', 'chill', 'corporate', 'cinematic'];
const sec = (ms) => Math.round((+ms || 0) / 100) / 10;
const ms = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : Math.round(+v * 1000));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const textOf = (l) => (l.words || []).map((w) => w.t).join(' ');
const newId = () => 'l' + Math.random().toString(36).slice(2, 10);

/* ---------- captions ---------- */
/**
 * The model's caption edits applied in order to a copy of `lines`: { lines, done, notes, added }.
 * done: what changed ("a: text"); notes: what was skipped or clamped, named by line id; added: ids of new lines.
 * durMs: the video's length (retimed and added lines stay inside it).
 */
export function captionEdits(lines, edits, durMs) {
  let L = JSON.parse(JSON.stringify(lines || []));
  const done = [], notes = [], added = [], list = Array.isArray(edits) ? edits : [];
  if (list.length > MAX_EDITS) notes.push(`Only the first ${MAX_EDITS} edits were applied`);
  const at = (id) => L.findIndex((l) => l.id === id);
  for (const e of list.slice(0, MAX_EDITS)) {
    const a = e && e.action, id = e && e.id, i = a === 'add' ? -1 : at(id);
    if (!['text', 'delete', 'merge', 'split', 'retime', 'add'].includes(a)) { notes.push(`${id || '?'}: unknown action "${String(a).slice(0, 20)}"`); continue; }
    if (a !== 'add' && i < 0) { notes.push(`${String(id).slice(0, 40)}: no such line`); continue; }
    const line = L[i];
    if (a === 'text') {
      const t = String(e.text == null ? '' : e.text).slice(0, MAX_TEXT).trim();
      if (!t) { notes.push(`${id}: empty text (use delete to remove a line)`); continue; }
      L[i] = retext(line, t); done.push(`${id}: text`);
    } else if (a === 'delete') { L.splice(i, 1); done.push(`${id}: deleted`); }
    else if (a === 'merge') {
      if (i === L.length - 1) { notes.push(`${id}: the last line has no next line to merge with`); continue; }
      const m = merge(line, L[i + 1]); m.id = line.id; L.splice(i, 2, m); done.push(`${id}: merged with the next line`);
    } else if (a === 'split') {
      const k = Math.round(+e.atWord);
      if (!(k >= 1 && k < (line.words || []).length)) { notes.push(`${id}: atWord out of range (1–${Math.max(1, (line.words || []).length - 1)})`); continue; }
      const [p, q] = split(line, line.words[k].s); p.id = line.id; L.splice(i, 1, p, q); added.push(q.id); done.push(`${id}: split, new line ${q.id}`);
    } else if (a === 'retime') {
      const s0 = ms(e.start), e0 = ms(e.end);
      if (s0 == null || e0 == null) { notes.push(`${id}: start and end are needed`); continue; }
      if (e0 <= s0) { notes.push(`${id}: the end must be after the start`); continue; }
      const lo = i > 0 ? L[i - 1].end : 0, hi = i < L.length - 1 ? L[i + 1].start : durMs;
      const s1 = clamp(s0, lo, hi), e1 = clamp(e0, lo, hi);
      if (e1 - s1 < MIN_LINE) { notes.push(`${id}: no room between its neighbours`); continue; }
      L[i] = retime(line, s1, e1); done.push(`${id}: retimed`);
      if (s1 !== s0 || e1 !== e0) notes.push(`${id}: clamped to ${sec(s1)}–${sec(e1)} s`);
    } else {
      const s0 = ms(e.start), e0 = ms(e.end), t = String(e.text == null ? '' : e.text).slice(0, MAX_TEXT).trim();
      if (s0 == null || e0 == null || !t) { notes.push('add: start, end and text are needed'); continue; }
      const s1 = clamp(s0, 0, durMs), e1 = clamp(e0, 0, durMs);
      if (e1 - s1 < MIN_LINE || L.some((l) => l.start < e1 && s1 < l.end)) { notes.push(`add at ${sec(s0)} s: no room there`); continue; }
      const nl = retext({ id: newId(), start: s1, end: e1, words: [] }, t), k = L.findIndex((l) => l.start > s1);
      L.splice(k < 0 ? L.length : k, 0, nl); added.push(nl.id); done.push(`added ${nl.id}`);
    }
  }
  return { lines: L, done, notes, added };
}
/** The lines overlapping [fromS, toS] (seconds; either may be missing), as the model reads them, at most `max` */
export function linesIn(lines, fromS, toS, max) {
  const a = ms(fromS) ?? -Infinity, b = ms(toS) ?? Infinity;
  return (lines || []).filter((l) => l.end > a && l.start < b).slice(0, max).map((l) => ({ id: l.id, start: sec(l.start), end: sec(l.end), text: textOf(l) }));
}

/* ---------- colour grade ---------- */
/**
 * The grade the model asks for: { look?: 'matched' | brand look id, values: stored grade values, notes }. 'none' becomes values.
 * ctx: { looks: [{ id, name }], matched: whether a matched grade exists }.
 */
export function gradeInput(cur, input, ctx) {
  const p = input && typeof input === 'object' ? input : {}, values = {}, notes = [];
  let look;
  if (p.look != null) {
    const v = String(p.look);
    // the editor has no lasting "no LUT" state (the matched grade comes back on open): neutral sliders and no strength instead
    if (v === 'none') Object.assign(values, { strength: 0, exposure: 0, temp: 0, sat: 0 });
    else if (v === 'matched') { if (ctx.matched) look = 'matched'; else notes.push('This video has no matched grade (match a reference video in the Scenes panel)'); }
    else if ((ctx.looks || []).some((l) => l.id === v)) look = v;
    else notes.push(`Unknown look "${v.slice(0, 40)}". Use: matched, none${(ctx.looks || []).map((l) => ', ' + l.id).join('')}`);
  }
  Object.keys(GRADE_KEYS).forEach((k) => {
    if (p[k] == null) return;
    const n = +p[k]; if (!Number.isFinite(n)) { notes.push(`${k} ignored: not a number`); return; }
    const [a, b] = GRADE_KEYS[k], c = clamp(Math.round(n), a, b);
    if (c !== Math.round(n)) notes.push(`${k} clamped to ${c}`);
    values[k] = sliderToGrade(k, c);
  });
  return look ? { look, values, notes } : { values, notes };
}

/* ---------- sound ---------- */
/**
 * The sound the model asks for: { audio: { vol, music }, compose?: mood, musicPatch: { vol?, duck? }, notes }.
 * When a new track is to be composed, its volume and ducking come in musicPatch, applied once it exists.
 */
export function audioInput(cur, input, ctx) {
  const p = input && typeof input === 'object' ? input : {}, notes = [], audio = { vol: cur.vol, music: cur.music ? { ...cur.music } : null }, musicPatch = {};
  const pct = (v, name) => { const n = +v; if (!Number.isFinite(n)) { notes.push(`${name} ignored: not a number`); return null; } const c = clamp(Math.round(n), 0, 100); if (c !== Math.round(n)) notes.push(`${name} clamped to ${c}`); return c / 100; };
  if (p.originalVolume != null) { const v = pct(p.originalVolume, 'originalVolume'); if (v != null) audio.vol = v; }
  const m = p.music && typeof p.music === 'object' ? p.music : null;
  let compose;
  if (m) {
    if (m.volume != null) { const v = pct(m.volume, 'music volume'); if (v != null) musicPatch.vol = v; }
    if (m.ducking != null) musicPatch.duck = !!m.ducking;
    if (m.remove) audio.music = null;
    else if (m.compose != null) {
      if (MOODS.includes(m.compose)) compose = m.compose;
      else notes.push(`Unknown mood "${String(m.compose).slice(0, 30)}". Use: ${MOODS.join(', ')}`);
    } else if (Object.keys(musicPatch).length) {
      if (ctx.hasMusic && audio.music) Object.assign(audio.music, musicPatch);
      else notes.push('There is no music yet: compose a track first');
    }
  }
  return compose ? { audio, compose, musicPatch, notes } : { audio, musicPatch, notes };
}

/* ---------- context ---------- */
const STEP_WORDS = { transcribe: 'transcribing', grade: 'matching the grade', style: 'reading the caption style', proxy: 'preparing the video' };
/** Where the server's analysis is: { state: 'ready' | 'running' | 'failed' | 'no video', label } */
export function analysisState(rec, ref) {
  if (!rec) return { state: 'no video', label: 'no video' };
  // only a failed record stops the video (the server fails it for probe and proxy); a failed side step (grade, transcribe) leaves it usable
  const A = analysis(rec, ref), failed = firstFailed(rec);
  if (A.failed) return { state: 'failed', label: `${failed || 'analysis'} failed` };
  if (A.settled) return { state: 'ready', label: failed ? `ready (${failed} failed)` : 'ready' };
  const run = ['transcribe', 'grade', 'style', 'proxy'].find((k) => A.busy(A[k])), s = run && A[run];
  return { state: 'running', label: s ? `${STEP_WORDS[run]}${s.state === 'running' && s.progress ? ` ${Math.round(s.progress * 100)}%` : ''}` : 'starting' };
}
/** The `video` block of the agent's context (sliders' units, seconds) */
export function videoCtx({ d, caps, style, state, looks, matched, maxLines }) {
  const ft = d.footage || {}, look = ft.look || {}, au = ft.audio || {}, mus = au.music || null, lines = (caps && caps.lines) || [];
  const lut = look.lut || null, brand = lut && /^looks\//.test(lut) ? (looks || []).find((l) => l.id === ft.lookId) : null;
  const kind = !lut ? 'none' : lut === lookPath(ft.src) ? 'matched' : brand ? 'brand look' : 'custom';
  const st = style || {};
  const out = {
    seconds: sec(ft.dur), size: ft.out ? `${ft.out.w}×${ft.out.h}` : '', analysis: state.state === 'failed' ? `failed: ${state.label}` : state.state === 'no video' ? 'no video' : state.label,
    captions: {
      on: !!(caps && caps.on !== false), preset: (caps && caps.preset) || null, language: (caps && caps.lang) || null, lines: lines.length,
      style: { font: st.font, size: st.size, weight: st.weight, color: st.color, case: st.case, y: st.y, maxWords: st.maxWords, anim: st.anim, highlightMode: st.highlight && st.highlight.mode },
    },
    lines: linesIn(lines, undefined, undefined, maxLines),
    grade: { kind, ...(brand ? { look: brand.name } : {}), strength: gradeToSlider('strength', look.strength), exposure: gradeToSlider('exposure', look.exposure), temp: gradeToSlider('temp', look.temp), sat: gradeToSlider('sat', look.sat), matchedAvailable: !!matched },
    brandLooks: (looks || []).map((l) => ({ id: l.id, name: l.name })),
    audio: { originalVolume: Math.round((au.vol == null ? 1 : au.vol) * 100), music: mus ? { name: mus.name, volume: Math.round((mus.vol == null ? 0.6 : mus.vol) * 100), ducking: mus.duck !== false } : null },
  };
  if (lines.length > maxLines) out.moreLines = true;
  return out;
}
