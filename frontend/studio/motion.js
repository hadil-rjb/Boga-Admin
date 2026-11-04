/* Motion graphics: formats, animation presets, scene timing and the intro / body / outro starters.
   Pure data and math, no DOM. A motion design is a design with `motion` set; each page is a scene
   (`pg.scene`), each layer can carry an animation (`l.anim`). Times are in milliseconds. */
import { Tx, Rc, El, Im, BG } from './templates';

/* ---------- formats ---------- */
/** What admins pick when they start a video. `ratio` is a studio ratio key (custom sizes are "<w>x<h>"). */
export const FORMATS = [
  { k: 'reel', n: 'Reel', s: '9:16 · 1080 × 1920', ratio: '9:16', dur: 15000, nets: 'Instagram, TikTok, Shorts' },
  { k: 'story', n: 'Story', s: '9:16 · 1080 × 1920', ratio: '9:16', dur: 10000, nets: 'Instagram, Facebook' },
  { k: 'post', n: 'Animated post', s: '1:1 · 1080 × 1080', ratio: '1:1', dur: 8000, nets: 'Feed, LinkedIn, X' },
  { k: 'portrait', n: 'Portrait video', s: '4:5 · 1080 × 1350', ratio: '4:5', dur: 10000, nets: 'Instagram, Facebook feed' },
  { k: 'thumb', n: 'Thumbnail', s: '16:9 · 1280 × 720', ratio: '1280x720', dur: 5000, nets: 'YouTube, blog covers' },
  { k: 'wide', n: 'Landscape video', s: '16:9 · 1920 × 1080', ratio: '1920x1080', dur: 12000, nets: 'YouTube, LinkedIn' },
];
export const formatOf = (k) => FORMATS.find((f) => f.k === k) || FORMATS[0];

/* ---------- easing ---------- */
export const EASES = {
  smooth: ['Smooth', (p) => 1 - (1 - p) ** 3],
  snappy: ['Snappy', (p) => 1 - (1 - p) ** 5],
  bounce: ['Bounce', (p) => { const c = 1.70158, d = c + 1; return 1 + d * (p - 1) ** 3 + c * (p - 1) ** 2; }],
  gentle: ['Gentle', (p) => -(Math.cos(Math.PI * p) - 1) / 2],
  linear: ['Linear', (p) => p],
};
const ease = (k, p) => (EASES[k] || EASES.smooth)[1](p);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* ---------- layer animations ----------
   Each preset maps progress p (0 hidden → 1 in place) to a state change. D is the canvas' motion unit (8% of its short side). */
export const ENTER = {
  none: ['None', () => ({})],
  fade: ['Fade', (p) => ({ o: p })],
  rise: ['Rise', (p, D) => ({ o: p, ty: (1 - p) * D * 0.6 })],
  slideUp: ['Slide up', (p, D) => ({ o: clamp01(p * 2), ty: (1 - p) * D * 2 })],
  slideDown: ['Slide down', (p, D) => ({ o: clamp01(p * 2), ty: -(1 - p) * D * 2 })],
  slideLeft: ['Slide left', (p, D) => ({ o: clamp01(p * 2), tx: (1 - p) * D * 2.5 })],
  slideRight: ['Slide right', (p, D) => ({ o: clamp01(p * 2), tx: -(1 - p) * D * 2.5 })],
  zoom: ['Zoom in', (p) => ({ o: p, s: 0.7 + 0.3 * p })],
  pop: ['Pop', (p) => ({ o: clamp01(p * 3), s: Math.max(0, p) })],
  blur: ['Blur in', (p) => ({ o: p, blur: (1 - p) * 28 })],
  wipe: ['Wipe', (p) => ({ clip: [0, (1 - p) * 100, 0, 0] })],
  reveal: ['Reveal up', (p) => ({ clip: [(1 - p) * 100, 0, 0, 0] })],
  spin: ['Spin', (p) => ({ o: p, r: (1 - p) * -120, s: 0.5 + 0.5 * p })],
};
/** Exits play an enter preset backwards over the last `ot` ms of the scene */
export const EXIT = { none: ENTER.none, fade: ENTER.fade, rise: ['Sink', ENTER.rise[1]], slideUp: ['Slide up', (p, D) => ({ o: clamp01(p * 2), ty: -(1 - p) * D * 2 })], slideDown: ['Slide down', ENTER.slideUp[1]], zoom: ['Zoom out', ENTER.zoom[1]], blur: ['Blur out', ENTER.blur[1]], wipe: ENTER.wipe };
/** Loops run for the whole scene, on top of the enter and exit */
export const LOOP = {
  none: ['None', () => ({})],
  pulse: ['Pulse', (t) => ({ s: 1 + 0.035 * Math.sin((t / 1400) * Math.PI * 2) })],
  float: ['Float', (t, D) => ({ ty: Math.sin((t / 2200) * Math.PI * 2) * D * 0.12 })],
  wiggle: ['Wiggle', (t) => ({ r: Math.sin((t / 700) * Math.PI * 2) * 2.5 })],
  drift: ['Slow zoom', (t, D, dur) => ({ s: 1 + 0.08 * clamp01(t / Math.max(1, dur)) })],
  spin: ['Rotate', (t) => ({ r: (t / 6000) * 360 })],
};
export const ANIM_DEFAULT = { in: 'rise', d: 0, t: 700, e: 'smooth', out: 'none', ot: 450, loop: 'none' };
export const anim = (l) => ({ ...ANIM_DEFAULT, in: 'none', ...(l && l.anim) });

export const ID = () => ({ o: 1, tx: 0, ty: 0, s: 1, r: 0, blur: 0, clip: null });
/** Merges a partial state into an accumulated one (opacity and scale multiply, offsets add, the tightest clip wins) */
export function mix(a, b) {
  if (b.o != null) a.o *= b.o; if (b.s != null) a.s *= b.s;
  a.tx += b.tx || 0; a.ty += b.ty || 0; a.r += b.r || 0; a.blur += b.blur || 0;
  if (b.clip) a.clip = a.clip ? a.clip.map((v, i) => Math.max(v, b.clip[i])) : b.clip.slice();
  return a;
}
/** A layer's state at time t in a scene of length dur. D: motion unit in canvas pixels. */
export function layerState(l, t, dur, D) {
  const a = anim(l), st = ID();
  if (a.in !== 'none' && ENTER[a.in]) mix(st, ENTER[a.in][1](ease(a.e, clamp01((t - a.d) / Math.max(1, a.t))), D));
  if (a.out !== 'none' && EXIT[a.out]) { const q = clamp01((t - (dur - a.ot)) / Math.max(1, a.ot)); if (q > 0) mix(st, EXIT[a.out][1](1 - ease(a.e, q), D)); }
  if (a.loop !== 'none' && LOOP[a.loop]) mix(st, LOOP[a.loop][1](t, D, dur));
  return st;
}
/** Has the layer finished entering (and not started leaving) at time t? Used to show the layer when not playing. */
export const isStill = (st) => st.o === 1 && !st.tx && !st.ty && st.s === 1 && !st.r && !st.blur && !st.clip;

/* ---------- scenes ---------- */
export const KINDS = { intro: 'Intro', body: 'Scene', outro: 'Outro' };
export const TRANSITIONS = { cut: 'Cut', fade: 'Fade', slide: 'Slide', push: 'Push up', zoom: 'Zoom', wipe: 'Wipe' };
export const SCENE_DEFAULT = { k: 'body', dur: 3000, tr: 'fade', trd: 500 };
export const sceneOf = (pg) => ({ ...SCENE_DEFAULT, ...(pg && pg.scene) });
/** Intro first, outro last, scenes keep their order in between */
export const kindRank = (pg) => ({ intro: 0, body: 1, outro: 2 }[sceneOf(pg).k] ?? 1);
/** Start time of every scene and the total length */
export function timeline(pages) {
  let t = 0;
  const scenes = pages.map((pg, i) => { const s = sceneOf(pg), x = { i, start: t, dur: s.dur, tr: i ? s.tr : 'cut', trd: Math.min(s.trd, s.dur * 0.6), k: s.k }; t += s.dur; return x; });
  return { scenes, total: t };
}
/** What to draw at time t: the scene, its local time, and the scene it leaves while a transition plays */
export function frameAt(tl, t) {
  const S = tl.scenes; if (!S.length) return null;
  t = Math.max(0, Math.min(t, tl.total - 1));
  const k = S.findIndex((s) => t < s.start + s.dur), cur = S[k < 0 ? S.length - 1 : k], local = t - cur.start;
  const out = { cur, local, prev: null, p: 1 };
  if (cur.i > 0 && cur.tr !== 'cut' && local < cur.trd) { out.prev = S[cur.i - 1]; out.p = ease('gentle', local / cur.trd); }
  return out;
}
/** Scene containers during a transition: [incoming, outgoing] states, W × H canvas */
export function transition(kind, p, W, H) {
  const a = ID(), b = ID();
  if (kind === 'fade') a.o = p;
  else if (kind === 'slide') { a.tx = (1 - p) * W; b.tx = -p * W * 0.35; b.o = 1 - p * 0.4; }
  else if (kind === 'push') { a.ty = (1 - p) * H; b.ty = -p * H; }
  else if (kind === 'zoom') { a.s = 1.12 - 0.12 * p; a.o = p; b.s = 1 + 0.08 * p; }
  else if (kind === 'wipe') a.clip = [0, (1 - p) * 100, 0, 0];
  return [a, b];
}
export const fmtTime = (ms, tenths = true) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60), r = s - m * 60; return `${m}:${(tenths ? r.toFixed(1) : String(Math.floor(r))).padStart(tenths ? 4 : 2, '0')}`; };

/* ---------- auto-animate ---------- */
/** Gives every visible layer of a scene an entrance that suits it, staggered from top to bottom */
export function autoAnimate(layers, scene, W, H) {
  const s = { ...SCENE_DEFAULT, ...scene }, bg = (l) => l.locked && l.name === 'Background';
  const vis = layers.filter((l) => !l.hidden && l.type !== 'group' && !bg(l) && !l.pid).sort((a, b) => a.y - b.y || a.x - b.x);
  const big = Math.max(0, ...vis.filter((l) => l.type === 'text').map((l) => l.size || 0));
  const step = Math.min(160, (s.dur * 0.45) / Math.max(1, vis.length)), start = s.k === 'intro' ? 200 : 120;
  layers.forEach((l) => { if (bg(l)) l.anim = { ...ANIM_DEFAULT, in: 'none', loop: /url\(/.test(l.fill || '') ? 'drift' : 'none' }; });
  vis.forEach((l, i) => {
    let a;
    if (l.type === 'text') a = (l.size || 0) >= big * 0.7 ? { in: s.k === 'intro' ? 'slideUp' : 'rise', t: 750 } : { in: 'fade', t: 600 };
    else if (l.type === 'image') a = { in: 'zoom', t: 900, loop: l.w * l.h > W * H * 0.4 ? 'drift' : 'none' };
    else if (l.type === 'ellipse') a = { in: 'pop', t: 600, e: 'bounce' };
    else if (Math.min(l.w, l.h) < 24) a = { in: 'wipe', t: 650 };
    else if (/^logo/i.test(l.name || '')) a = { in: 'pop', t: 650, e: 'bounce' };
    else a = { in: 'fade', t: 600 };
    l.anim = { ...ANIM_DEFAULT, ...a, d: Math.round(start + i * step) }; // no exit: the transition to the next scene takes over
  });
  return layers;
}

/* ---------- starters: intro, body and outro scenes in the brand's look ----------
   o: { bg, fg, muted, accent, onAccent, head, body, logo, brand, site, handle, tagline, cta } */
const logoL = (x, y, w, h, o, align = 'center') => (o.logo
  ? Im(x, y, w, h, `url(${o.logo}) ${align} center/contain no-repeat`, { name: 'Logo' })
  : Tx(x, y + Math.round((h - h * 0.62) / 2), w, o.brand, { name: 'Logo', size: Math.round(h * 0.62), weight: 800, font: o.head, color: o.fg, align, ls: -1 }));
function frame(w, h) {
  const u = Math.min(w, h) / 1080, P = Math.round(Math.max(56, w * 0.08)), wide = w > h * 1.2;
  return { u, P, cw: w - P * 2, wide, z: (v) => Math.round(v * u) };
}
export const STARTERS = {
  intro: {
    blank: ['Blank', (w, h, o) => [BG(w, h, o.bg)]],
    title: ['Title', (w, h, o) => { const { P, cw, z } = frame(w, h), ts = z(132); return [
      BG(w, h, o.bg),
      El(w - z(420), -z(160), z(620), z(620), o.accent, { name: 'Glow', op: 0.22 }),
      logoL(P, P, z(240), z(72), o, 'left'),
      Rc(P, h / 2 - z(150), z(120), z(10), o.accent, { name: 'Accent bar', r: z(5) }),
      Tx(P, h / 2 - z(110), cw, 'Your big idea, in one line', { name: 'Title', size: ts, weight: 800, font: o.head, color: o.fg, lh: 1.02, ls: -2, lines: 2 }),
      Tx(P, h / 2 + ts * 1.02 * 2 - z(80), cw, o.tagline || 'A short line that sets up the story', { name: 'Subtitle', size: z(42), weight: 500, font: o.body, color: o.muted, lines: 2 }),
    ]; }],
    logo: ['Logo sting', (w, h, o) => { const { cw, P, z } = frame(w, h); return [
      BG(w, h, o.bg),
      El(w / 2 - z(330), h / 2 - z(330), z(660), z(660), 'transparent', { name: 'Ring', stroke: o.accent, sw: z(6), op: 0.5 }),
      El(w / 2 - z(230), h / 2 - z(230), z(460), z(460), o.accent, { name: 'Disc', op: 0.16 }),
      logoL(w / 2 - z(260), h / 2 - z(90), z(520), z(180), o),
      Tx(P, h / 2 + z(210), cw, o.tagline || o.brand, { name: 'Tagline', size: z(40), weight: 600, font: o.body, color: o.muted, align: 'center', ls: 2 }),
    ]; }],
    bold: ['Bold word', (w, h, o) => { const { P, cw, z } = frame(w, h); return [
      BG(w, h, o.accent),
      Tx(P, h / 2 - z(240), cw, 'NEW', { name: 'Kicker', size: z(48), weight: 700, font: o.body, color: o.onAccent, align: 'center', ls: 12 }),
      Tx(P, h / 2 - z(150), cw, 'Big news', { name: 'Title', size: z(200), weight: 900, font: o.head, color: o.onAccent, align: 'center', lh: 1, ls: -4 }),
      Rc(w / 2 - z(80), h / 2 + z(110), z(160), z(10), o.onAccent, { name: 'Accent bar', r: z(5) }),
    ]; }],
  },
  body: {
    blank: ['Blank', (w, h, o) => [BG(w, h, o.bg)]],
    headline: ['Headline', (w, h, o) => { const { P, cw, z } = frame(w, h); return [
      BG(w, h, o.bg),
      Rc(P, h * 0.3, z(220), z(56), o.accent, { name: 'Kicker pill', r: z(28) }),
      Tx(P, h * 0.3 + z(13), z(220), 'TIP 01', { name: 'Kicker', size: z(26), weight: 700, font: o.body, color: o.onAccent, align: 'center', ls: 3 }),
      Tx(P, h * 0.3 + z(100), cw, 'Say the one thing people should remember', { name: 'Headline', size: z(92), weight: 800, font: o.head, color: o.fg, lh: 1.05, ls: -1, lines: 3 }),
      Tx(P, h * 0.3 + z(100) + z(92) * 1.05 * 3 + z(36), cw, 'Then back it up with a sentence or two. Keep it short: people read while it moves.', { name: 'Body', size: z(38), weight: 400, font: o.body, color: o.muted, lh: 1.35, lines: 3 }),
    ]; }],
    stat: ['Big number', (w, h, o) => { const { P, cw, z } = frame(w, h); return [
      BG(w, h, o.bg),
      Tx(P, h / 2 - z(260), cw, '87%', { name: 'Number', size: z(300), weight: 900, font: o.head, color: o.accent, align: 'center', lh: 1, ls: -8 }),
      Tx(P, h / 2 + z(70), cw, 'of people decide in the first three seconds', { name: 'Label', size: z(52), weight: 600, font: o.head, color: o.fg, align: 'center', lh: 1.15, lines: 2 }),
      Tx(P, h / 2 + z(220), cw, 'Source: your research', { name: 'Source', size: z(28), weight: 400, font: o.body, color: o.muted, align: 'center' }),
    ]; }],
    list: ['List', (w, h, o) => { const { P, cw, z } = frame(w, h), top = h * 0.24, row = z(150); return [
      BG(w, h, o.bg),
      Tx(P, top, cw, '3 things to try today', { name: 'Title', size: z(80), weight: 800, font: o.head, color: o.fg, lh: 1.05, ls: -1, lines: 2 }),
      ...[0, 1, 2].flatMap((i) => [
        El(P, top + z(230) + i * row, z(80), z(80), o.accent, { name: 'Bullet ' + (i + 1) }),
        Tx(P, top + z(230) + i * row + z(18), z(80), String(i + 1), { name: 'Bullet number', size: z(38), weight: 800, font: o.head, color: o.onAccent, align: 'center' }),
        Tx(P + z(112), top + z(230) + i * row + z(16), cw - z(112), ['Start with the hook', 'Show, don’t tell', 'End with one clear ask'][i], { name: 'Point ' + (i + 1), size: z(44), weight: 600, font: o.body, color: o.fg }),
      ]),
    ]; }],
    quote: ['Quote', (w, h, o) => { const { P, cw, z } = frame(w, h); return [
      BG(w, h, o.bg),
      Tx(P, h * 0.26, z(200), '“', { name: 'Quote mark', size: z(260), weight: 800, font: o.head, color: o.accent, lh: 1 }),
      Tx(P, h * 0.26 + z(220), cw, 'A quote from a customer, an expert or your team.', { name: 'Quote', size: z(70), weight: 700, font: o.head, color: o.fg, lh: 1.15, lines: 3 }),
      Rc(P, h * 0.26 + z(520), z(64), z(6), o.accent, { name: 'Rule', r: z(3) }),
      Tx(P, h * 0.26 + z(550), cw, 'Name Surname · Role', { name: 'Author', size: z(34), weight: 500, font: o.body, color: o.muted }),
    ]; }],
    media: ['Photo + caption', (w, h, o) => { const { P, cw, z, wide } = frame(w, h), ih = wide ? h : Math.round(h * 0.58); return [
      BG(w, h, o.bg),
      Im(0, 0, wide ? Math.round(w * 0.55) : w, ih, 'linear-gradient(135deg,#334155 0%,#0b1220 100%)', { name: 'Photo' }),
      Tx(wide ? Math.round(w * 0.55) + P : P, wide ? h * 0.32 : ih + z(70), wide ? w * 0.45 - P * 2 : cw, 'Drop a photo here, then write the caption', { name: 'Caption', size: z(64), weight: 800, font: o.head, color: o.fg, lh: 1.1, lines: 3 }),
    ]; }],
  },
  outro: {
    blank: ['Blank', (w, h, o) => [BG(w, h, o.bg)]],
    cta: ['Call to action', (w, h, o) => { const { P, cw, z } = frame(w, h), bw = z(520); return [
      BG(w, h, o.bg),
      El(-z(200), h - z(420), z(600), z(600), o.accent, { name: 'Glow', op: 0.2 }),
      Tx(P, h / 2 - z(230), cw, o.cta || 'Follow for more', { name: 'CTA', size: z(110), weight: 800, font: o.head, color: o.fg, align: 'center', lh: 1.05, ls: -2, lines: 2 }),
      Rc(w / 2 - bw / 2, h / 2 + z(60), bw, z(110), o.accent, { name: 'Button', r: z(55) }),
      Tx(w / 2 - bw / 2, h / 2 + z(60) + z(32), bw, o.handle || o.site || '@yourbrand', { name: 'Button label', size: z(40), weight: 700, font: o.body, color: o.onAccent, align: 'center' }),
      logoL(w / 2 - z(150), h - P - z(70), z(300), z(70), o),
    ]; }],
    logo: ['Logo end card', (w, h, o) => { const { P, cw, z } = frame(w, h); return [
      BG(w, h, o.bg),
      logoL(w / 2 - z(280), h / 2 - z(150), z(560), z(190), o),
      Rc(w / 2 - z(60), h / 2 + z(70), z(120), z(6), o.accent, { name: 'Rule', r: z(3) }),
      Tx(P, h / 2 + z(110), cw, o.site || o.brand, { name: 'Website', size: z(42), weight: 600, font: o.body, color: o.muted, align: 'center', ls: 1 }),
    ]; }],
    subscribe: ['Subscribe', (w, h, o) => { const { P, cw, z } = frame(w, h), bw = z(560); return [
      BG(w, h, o.bg),
      Tx(P, h / 2 - z(200), cw, 'Thanks for watching', { name: 'Title', size: z(84), weight: 800, font: o.head, color: o.fg, align: 'center', ls: -1 }),
      Rc(w / 2 - bw / 2, h / 2 - z(30), bw, z(120), '#ff0033', { name: 'Button', r: z(24) }),
      Tx(w / 2 - bw / 2, h / 2 - z(30) + z(34), bw, '▶  Subscribe', { name: 'Button label', size: z(46), weight: 800, font: o.body, color: '#ffffff', align: 'center' }),
      Tx(P, h / 2 + z(150), cw, o.handle || o.site || '@yourchannel', { name: 'Handle', size: z(36), weight: 500, font: o.body, color: o.muted, align: 'center' }),
    ]; }],
  },
};
/** A fresh scene page from a starter: layers, scene settings and auto-animation */
export function starterPage(kind, key, w, h, o, dur) {
  const set = STARTERS[kind] || STARTERS.body, s = set[key] || Object.values(set)[0];
  const scene = { ...SCENE_DEFAULT, k: kind, dur: dur || (kind === 'body' ? 3500 : 2500), tr: kind === 'intro' ? 'cut' : 'fade' };
  const layers = autoAnimate(s[1](w, h, o), scene, w, h);
  return { bg: layers[0].fill, layers, scene };
}
