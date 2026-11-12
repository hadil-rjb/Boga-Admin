/* ============================================================
   Studio Agent, motion: what the agent's animation tools need that has no DOM.
   The agent has a mode (design / animate, see backend/src/ai/agent.ts): the server sends the tools of the
   mode, the studio (engine.js, v25 block) runs them. The model speaks in seconds and in its own field
   names (enter, delay, duration…); a design stores milliseconds (anim: in, d, t…; scene: k, dur, tr, trd).
   These helpers translate, clamp to what the timeline allows, and refuse presets motion.js does not know,
   naming the valid ones so the model can correct itself. Pure, unit-tested (agent-motion.test.js).
   ============================================================ */
import { ENTER, EXIT, LOOP, EASES, TRANSITIONS, KINDS, STARTERS, anim as animOf, timeline } from './motion.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** Milliseconds as seconds with one decimal: what the model reads */
export const sec = (ms) => Math.round((+ms || 0) / 100) / 10;
/** Seconds from the model as milliseconds, or null when it is not a number */
const ms = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : Math.round(+v * 1000));
const secs = (v) => `${sec(v)} s`;

/* ---------- modes ---------- */
/** The agent's mode for a design kind (still / reel / video) in an editor mode: an uploaded video is always 'video' */
export function agentMode(kind, editorMode) {
  if (kind === 'video') return 'video';
  return kind === 'reel' && editorMode === 'animate' ? 'animate' : 'design';
}
/** What make_video does: 'convert' a still, 'switch' a video shown in Design mode to Animate, or 'none' (already animating, or footage) */
export function videoStep(kind, editorMode) {
  if (kind === 'still') return 'convert';
  return kind === 'reel' && editorMode !== 'animate' ? 'switch' : 'none';
}
export const DESIGN_ONLY = new Set(['manage_slides', 'resize_canvas', 'apply_brand_template', 'build_live_slide', 'make_video']);
export const ANIMATE_ONLY = new Set(['animate_layers', 'auto_animate', 'manage_scenes', 'set_scene', 'view_frame']);
export const VIDEO_ONLY = new Set(['set_grade', 'set_audio']);
/** Captions are edited the same way on uploaded videos and animated designs */
export const CAPTION_TOOLS = new Set(['read_captions', 'edit_captions', 'style_captions']);
/** Voice-over and music on an animated design */
export const SOUND_ONLY = new Set(['write_voiceover', 'make_voices', 'set_voice', 'remove_voice', 'set_music']);
/** The other tools an uploaded video gets (it has no layers, slides or scenes) */
const VIDEO_SHARED = new Set(['view_frame', 'write_caption', 'rename_design', 'read_planner', 'propose_schedule', 'propose_automation', ...CAPTION_TOOLS]);
/** Whether a tool may run in a mode (the server only offers a mode's tools; an old call in the conversation may still name another) */
export function allowed(tool, mode) {
  if (mode === 'video') return VIDEO_ONLY.has(tool) || VIDEO_SHARED.has(tool);
  if (VIDEO_ONLY.has(tool)) return false;
  if (mode === 'animate') return !DESIGN_ONLY.has(tool);
  return !ANIMATE_ONLY.has(tool) && !SOUND_ONLY.has(tool) && !CAPTION_TOOLS.has(tool);
}

/* ---------- a layer's animation ---------- */
const PRESETS = [['enter', 'in', ENTER], ['exit', 'out', EXIT], ['loop', 'loop', LOOP], ['ease', 'e', EASES]];
/** Keeps an animation inside its scene: the entrance fits the scene, the delay fits what is left, the exit fits the scene */
function fit(a, sceneMs) {
  const t = clamp(a.t, 100, Math.max(100, sceneMs));
  return { ...a, t, d: clamp(a.d, 0, Math.max(0, sceneMs - t)), ot: clamp(a.ot, 100, Math.max(100, sceneMs)) };
}
/**
 * The animation a layer gets from the model's input: { anim, notes }. Only the fields given change; `anim` is the
 * whole stored object. notes: what was refused (unknown preset, not a number) or clamped. The layer is not changed.
 */
export function animPatch(layer, input, sceneMs) {
  const p = input && typeof input === 'object' ? input : {}, a = { ...animOf(layer) }, notes = [];
  PRESETS.forEach(([name, key, set]) => {
    if (p[name] == null) return;
    if (has(set, p[name])) a[key] = p[name];
    else notes.push(`Unknown ${name} "${String(p[name]).slice(0, 40)}". Use: ${Object.keys(set).join(', ')}`);
  });
  const asked = {};
  [['delay', 'd'], ['duration', 't'], ['exitDuration', 'ot']].forEach(([name, key]) => {
    if (p[name] == null) return;
    const v = ms(p[name]);
    if (v == null) notes.push(`${name} ignored: not a number`); else { a[key] = v; asked[key] = [name, v]; }
  });
  const out = fit(a, sceneMs);
  // a delay given with a duration that leaves it no room is reported too, though only the duration was "wrong"
  Object.entries(asked).forEach(([key, [name, v]]) => { if (out[key] !== v) notes.push(`${name} clamped to ${secs(out[key])}`); });
  return { anim: out, notes };
}
/** After a scene got shorter: clamps each layer's own animation in place; returns how many layers changed */
export function fitAnims(layers, sceneMs) {
  let n = 0;
  (layers || []).forEach((l) => {
    if (!l.anim) return;
    const a = animOf(l), b = fit(a, sceneMs);
    if (b.t !== a.t || b.d !== a.d || b.ot !== a.ot) { l.anim = b; n++; }
  });
  return n;
}
/** A layer's animation as the model reads it; undefined when the layer does not move */
export function animOut(layer) {
  const a = animOf(layer);
  if (a.in === 'none' && a.out === 'none' && a.loop === 'none') return undefined;
  return { enter: a.in, delay: sec(a.d), duration: sec(a.t), ease: a.e, exit: a.out, exitDuration: sec(a.ot), loop: a.loop };
}

/* ---------- a scene ---------- */
export const SCENE_MIN = 500, SCENE_MAX = 60000, MAX_SCENES = 20;
/**
 * The scene a page gets from the model's input: { scene, notes }. `scene` is the whole stored object ({ k, dur, tr, trd });
 * isFirst: the scene opens the video and has no transition. A transition lasts at most half its scene.
 */
export function scenePatch(scene, input, isFirst) {
  const p = input && typeof input === 'object' ? input : {}, s = { ...scene }, notes = [];
  if (p.seconds != null) {
    const v = ms(p.seconds);
    if (v == null) notes.push('seconds ignored: not a number');
    else { s.dur = clamp(v, SCENE_MIN, SCENE_MAX); if (s.dur !== v) notes.push(`seconds clamped to ${secs(s.dur)}`); }
  }
  if (p.role != null) { if (has(KINDS, p.role)) s.k = p.role; else notes.push(`Unknown role "${String(p.role).slice(0, 40)}". Use: ${Object.keys(KINDS).join(', ')}`); }
  if (p.transition != null) {
    if (isFirst) notes.push('The first scene opens the video: it has no transition');
    else if (has(TRANSITIONS, p.transition)) s.tr = p.transition;
    else notes.push(`Unknown transition "${String(p.transition).slice(0, 40)}". Use: ${Object.keys(TRANSITIONS).join(', ')}`);
  }
  let asked = null;
  if (p.transitionSeconds != null && !isFirst) {
    asked = ms(p.transitionSeconds);
    if (asked == null) notes.push('transitionSeconds ignored: not a number'); else s.trd = asked;
  }
  s.trd = clamp(+s.trd || 0, s.tr === 'cut' ? 0 : 100, Math.max(100, Math.round(s.dur / 2)));
  if (asked != null && s.trd !== asked) notes.push(`transitionSeconds clamped to ${secs(s.trd)}`);
  return { scene: s, notes };
}
/** The scene library entry for manage_scenes add: { role, key }; throws with the valid names on a miss */
export function starterFor(role = 'body', key = 'blank') {
  if (!has(STARTERS, role)) throw new Error(`Unknown role "${String(role).slice(0, 40)}". Use: ${Object.keys(STARTERS).join(', ')}`);
  if (!has(STARTERS[role], key)) throw new Error(`Unknown starter "${String(key).slice(0, 40)}" for ${role}. Use: ${Object.keys(STARTERS[role]).join(', ')}`);
  return { role, key };
}

/* ---------- what the model sees of the video ---------- */
/** The video block of the agent's context: length and scenes, in seconds, as the timeline plays them */
export function videoCtx(pages, fps) {
  const tl = timeline(pages || []);
  return {
    fps: +fps || 30, seconds: sec(tl.total),
    scenes: tl.scenes.map((s) => ({ number: s.i + 1, role: s.k, start: sec(s.start), seconds: sec(s.dur), transition: s.tr, transitionSeconds: s.tr === 'cut' ? 0 : sec(s.trd) })),
  };
}
/**
 * The moment view_frame shows: { ms, scene (1-based), offsetMs }. input.at: seconds from the start of the video;
 * or input.scene (1-based) with input.offset seconds into it; neither: the current scene at 60 % of its length.
 * Times are kept inside the video (and the scene); a scene that does not exist throws.
 */
export function frameTime(tl, input, currentIndex) {
  const p = input && typeof input === 'object' ? input : {}, S = tl.scenes;
  if (!S.length) throw new Error('The video has no scene');
  const at = p.scene == null ? ms(p.at) : null;
  if (at != null) {
    const t = clamp(at, 0, Math.max(0, tl.total - 1)), s = S.find((x) => t < x.start + x.dur) || S[S.length - 1];
    return { ms: t, scene: s.i + 1, offsetMs: t - s.start };
  }
  const i = p.scene == null ? clamp(+currentIndex || 0, 0, S.length - 1) : Math.round(+p.scene) - 1, s = S[i];
  if (!s) throw new Error(`There is no scene ${p.scene}`);
  const off = ms(p.offset), offsetMs = clamp(off == null ? Math.round(s.dur * 0.6) : off, 0, Math.max(0, s.dur - 1));
  return { ms: s.start + offsetMs, scene: s.i + 1, offsetMs };
}

/* ---------- the agent panel's words, by mode ---------- */
const ANIMATE_PROMPTS = [
  ['animate', 'Animate this scene', 'Animate this scene: entrances in reading order, the headline first'],
  ['animateAll', 'Animate every scene', 'Animate every scene of this video with a consistent style'],
  ['bookends', 'Add an intro and an outro', "Add an intro scene and an outro scene in the brand's look, and animate them"],
];
/**
 * The panel's copy for a mode: pi the open page (0-based), n the pages, scope 'slide' | 'all'.
 * empty '' and prompts [] mean "as the panel is today" (design keeps its own empty state and quick actions).
 * prompts: [[key, label, the request sent to the agent]]
 */
const VIDEO_PROMPTS = [
  ['fix', 'Fix the captions', 'Fix the spelling and punctuation of every caption line'],
  ['pop', 'Make the captions pop', 'Give the captions a bold, high-contrast style that stands out, and check a frame'],
  ['music', 'Add calm music', 'Add calm music that ducks under the speech'],
];
export function agentCopy(mode, pi, n, scope) {
  if (mode === 'video') return {
    sub: 'Edits this video', chip: 'Whole video', scopeTitle: 'The agent works on the whole video', placeholder: 'Ask for caption, colour or sound changes',
    empty: 'Describe what to change: caption text and style, colours, sound. I edit the video for you.', prompts: VIDEO_PROMPTS.map((p) => [...p]),
  };
  const an = mode === 'animate', one = an ? 'scene' : 'slide', One = an ? 'Scene' : 'Slide';
  return {
    sub: `Edits ${one} ${pi + 1} of ${n}`,
    chip: scope === 'all' ? `All ${n} ${one}s` : `${One} ${pi + 1}`,
    scopeTitle: an ? 'Choose which scenes the agent works on' : 'Choose what the agent edits',
    placeholder: an ? 'Ask for animation changes' : 'Ask for changes',
    empty: an ? 'Describe the motion you want: entrances, timing, scenes, transitions. I animate the video for you.' : '',
    prompts: an ? ANIMATE_PROMPTS.map((p) => [...p]) : [],
  };
}
