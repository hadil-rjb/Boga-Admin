/* ============================================================
   Studio Agent, sound on animated designs: what the agent's voice-over and music tools need that has no DOM.
   A scene's voice-over is pg.scene.vo ({ text, src, dur, srcText, by }); the design's sound settings are d.audio
   ({ music: { name, vol 0–1, fadeIn, fadeOut }, duck, voice, speed, language }). The model speaks in scene numbers,
   0–100 volumes and voice ids; these helpers check its input, name what cannot apply, and build the `sound` block of
   its context. The editor applies the results (engine.js, RT.reelSound). Pure, unit-tested (agent-sound.test.js).
   ============================================================ */

const MAX_TEXT = 600, MOODS = ['upbeat', 'chill', 'corporate', 'cinematic'];
const voOf = (pg) => (pg && pg.scene && pg.scene.vo) || null;
const textOf = (pg) => String((voOf(pg) || {}).text || '').trim();
const sec = (ms) => Math.round((+ms || 0) / 100) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Whether a scene's voice-over has text that is not voiced yet, or was voiced from other text (an imported file never is) */
export function needsVoice(pg) {
  const vo = voOf(pg) || {}, t = textOf(pg);
  return !!t && vo.by !== 'file' && (!vo.src || String(vo.srcText || '').trim() !== t);
}

/** write_voiceover: { set: [{ i (0-based), text }], notes } in the order given */
export function voiceoverLines(pages, lines) {
  const set = [], notes = [];
  (Array.isArray(lines) ? lines : []).forEach((l) => {
    const n = Math.round(+(l && l.scene)), i = n - 1;
    if (!(i >= 0 && i < (pages || []).length)) { notes.push(`scene ${l && l.scene}: no such scene`); return; }
    const text = String((l && l.text) == null ? '' : l.text).trim().slice(0, MAX_TEXT);
    if (!text) { notes.push(`scene ${n}: empty text (use remove_voice to remove a voice)`); return; }
    set.push({ i, text });
  });
  return { set, notes };
}

/** make_voices: the 0-based scenes to voice — the listed ones that have text, or by default every scene that needs a voice */
export function scenesToVoice(pages, scenes) {
  const P = pages || [];
  if (!Array.isArray(scenes)) return P.map((pg, i) => (needsVoice(pg) ? i : -1)).filter((i) => i >= 0);
  return [...new Set(scenes.map((n) => Math.round(+n) - 1))].filter((i) => i >= 0 && i < P.length && textOf(P[i])).sort((a, b) => a - b);
}

/** set_voice: { patch for d.audio, notes }. ctx: { voices: [{ id, name }] installed for the language, languages } */
export function voiceInput(audio, input, ctx) {
  const p = input && typeof input === 'object' ? input : {}, patch = {}, notes = [];
  if (p.voice != null) {
    if ((ctx.voices || []).some((v) => v.id === p.voice)) patch.voice = p.voice;
    else notes.push(`Unknown voice "${String(p.voice).slice(0, 40)}". Use: ${(ctx.voices || []).slice(0, 30).map((v) => v.id).join(', ') || 'no voice is installed'}`);
  }
  if (p.speed != null) {
    const n = +p.speed;
    if (!Number.isFinite(n)) notes.push('speed ignored: not a number');
    else { const c = Math.round(clamp(n, 0.7, 1.3) * 100) / 100; patch.speed = c; if (c !== n) notes.push(`speed clamped to ${c}`); }
  }
  if (p.language != null) {
    if ((ctx.languages || []).includes(p.language)) patch.language = p.language;
    else notes.push(`Unknown language "${String(p.language).slice(0, 30)}". Use: ${(ctx.languages || []).join(', ')}`);
  }
  return { patch, notes };
}

/**
 * set_music: { music (the new d.audio.music, or null), duck?, compose?, notes }. With compose, the settings are kept
 * in `music` as a patch to apply to the composed track ({ vol?, fadeIn?, fadeOut? }).
 */
export function musicInput(music, input) {
  const p = input && typeof input === 'object' ? input : {}, notes = [], patch = {};
  if (p.volume != null) {
    const n = +p.volume;
    if (!Number.isFinite(n)) notes.push('volume ignored: not a number');
    else { const c = clamp(Math.round(n), 0, 100); patch.vol = c / 100; if (c !== Math.round(n)) notes.push(`volume clamped to ${c}`); }
  }
  if (p.fadeIn != null) patch.fadeIn = !!p.fadeIn;
  if (p.fadeOut != null) patch.fadeOut = !!p.fadeOut;
  const duck = p.ducking == null ? undefined : !!p.ducking, out = (o) => (duck === undefined ? o : { ...o, duck });
  if (p.remove) return out({ music: null, notes });
  if (p.compose != null) {
    if (MOODS.includes(p.compose)) return out({ music: patch, compose: p.compose, notes });
    notes.push(`Unknown mood "${String(p.compose).slice(0, 30)}". Use: ${MOODS.join(', ')}`);
    return out({ music: music ? { ...music } : null, notes });
  }
  if (Object.keys(patch).length && !music) { notes.push('There is no music yet: compose a track first'); return out({ music: null, notes }); }
  return out({ music: music ? { ...music, ...patch } : null, notes });
}

/** The `sound` block of the agent's context in Animate mode */
export function soundCtx({ pages, audio, voices, ready, voiceId, voiceName, language, caps }) {
  const a = audio || {}, m = a.music || null;
  return {
    voice: { id: voiceId || null, name: voiceName || null, language, speed: a.speed || 1 },
    voices: (voices || []).slice(0, 30).map((v) => ({ id: v.id, name: v.name })),
    voicesReady: !!ready,
    music: m ? { name: m.name, volume: Math.round((m.vol == null ? 0.35 : m.vol) * 100), fadeIn: m.fadeIn !== false, fadeOut: m.fadeOut !== false, ducking: a.duck !== false } : null,
    scenes: (pages || []).map((pg, i) => { const vo = voOf(pg) || {}; return { number: i + 1, text: textOf(pg), voiced: !!vo.src, voiceSeconds: vo.src ? sec(vo.dur) : 0, needsVoice: needsVoice(pg) }; }),
    captions: { on: !!(caps && caps.on !== false), from: caps && caps.source === 'manual' ? 'manual' : 'voiceover', preset: (caps && caps.preset) || null },
  };
}
