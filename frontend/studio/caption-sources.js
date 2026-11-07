// Where caption text and timing come from: voice-over scenes, a pasted script, or an SRT/VTT file.
// Pure ESM, no DOM.
import { group, lcsPairs } from './captions.js';

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const toks = (s) => String(s || '').split(/\s+/).filter(Boolean);
const norm = (s) => String(s).normalize('NFKC').toLowerCase()
  .replace(/[ً-ٰٟ]/g, '').replace(/ـ/g, '').replace(/[\p{P}\p{S}]/gu, '');
const mkLine = (words) => ({ id: rid(), start: words[0].s, end: words[words.length - 1].e, words });

// Words timed by character count across [s, e].
function spreadTokens(tokens, s, e) {
  const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
  let acc = 0;
  return tokens.map((t) => {
    const a = s + ((e - s) * acc) / total; acc += t.length;
    return { t, s: Math.round(a), e: Math.round(s + ((e - s) * acc) / total) };
  });
}

export function voiceoverWords(pages, tl, lead = 150) {
  const out = [];
  for (const sc of tl.scenes) {
    const vo = pages[sc.i] && pages[sc.i].scene && pages[sc.i].scene.vo;
    const text = vo && String(vo.text || '').trim();
    if (!text || !(vo.dur > 0)) continue;
    out.push(...spreadTokens(toks(text), sc.start + lead, sc.start + lead + vo.dur));
  }
  return out;
}

// Script tokens plus the indices of tokens that start a new script line.
function scriptTokens(text) {
  const tokens = [], breaks = [];
  String(text || '').split(/\r?\n/).forEach((ln) => {
    const t = toks(ln);
    if (!t.length) return;
    if (tokens.length) breaks.push(tokens.length);
    tokens.push(...t);
  });
  return { tokens, breaks };
}

export function spreadScript(text, startMs, endMs) {
  const { tokens, breaks } = scriptTokens(text);
  return { words: spreadTokens(tokens, startMs, endMs), breaks };
}

export function alignScript(text, speechWords) {
  const { tokens, breaks } = scriptTokens(text);
  if (!tokens.length) return { words: [], matched: 0, breaks };
  const pairs = lcsPairs(tokens.map(norm), speechWords.map((w) => norm(w.t)));
  const words = new Array(tokens.length);
  const first = speechWords.length ? speechWords[0].s : 0;
  const last = speechWords.length ? speechWords[speechWords.length - 1].e : 0;
  let ni = 0, gapStart = first;
  for (const [ti, si] of [...pairs, [tokens.length, -1]]) {
    const gapEnd = si < 0 ? last : speechWords[si].s;
    if (ti > ni) spreadTokens(tokens.slice(ni, ti), gapStart, Math.max(gapStart, gapEnd)).forEach((w, k) => { words[ni + k] = w; });
    if (si >= 0) { words[ti] = { t: tokens[ti], s: speechWords[si].s, e: speechWords[si].e }; gapStart = speechWords[si].e; }
    ni = ti + 1;
  }
  return { words, matched: pairs.length / tokens.length, breaks };
}

export function linesFromScript(text, { speechWords = [], start = 0, end = 0, style } = {}) {
  let r = speechWords.length ? alignScript(text, speechWords) : null;
  const spread = !(r && r.matched >= 0.4);
  if (spread) r = spreadScript(text, start, end);
  const lines = [];
  let from = 0;
  for (const b of [...r.breaks, r.words.length]) {
    const chunk = r.words.slice(from, b);
    if (chunk.length) lines.push(...group(chunk, style || {}));
    from = b;
  }
  return { lines, spread };
}

const TS = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const parseTs = (m) => ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0'));

export function parseSubtitles(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = [];
  for (const block of src.split(/\n{2,}/)) {
    const rows = block.split('\n');
    const at = rows.findIndex((r) => r.includes('-->'));
    if (at < 0 || /^NOTE\b/.test(rows[0])) continue;
    const [a, b] = rows[at].split('-->');
    const ma = TS.exec(a), mb = TS.exec(b);
    if (!ma || !mb) continue;
    const s = parseTs(ma), e = parseTs(mb);
    const body = rows.slice(at + 1).join(' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const tokens = toks(body);
    if (!tokens.length) continue;
    lines.push(mkLine(spreadTokens(tokens, s, Math.max(e, s))));
  }
  if (!lines.length) throw new Error('This file has no readable captions');
  return lines;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmt = (ms) => {
  const t = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:${pad(Math.floor(t / 1000) % 60)},${pad(t % 1000, 3)}`;
};
export const toSrt = (lines) => lines
  .map((l, i) => `${i + 1}\n${fmt(l.start)} --> ${fmt(l.end)}\n${l.words.map((w) => w.t).join(' ')}\n`).join('\n');

export function voSig(pages) {
  return (pages || []).map((pg, i) => {
    const vo = pg && pg.scene && pg.scene.vo;
    return vo && (vo.text || vo.dur) ? `${i}:${String(vo.text || '').trim()}:${vo.dur || 0}` : '';
  }).join('|');
}

export const needsRebuild = (captions, pages) => !!captions && captions.source === 'manual' && captions.voSig !== voSig(pages);
