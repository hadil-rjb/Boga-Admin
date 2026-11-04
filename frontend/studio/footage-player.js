/* ============================================================
   Footage player: the proxy video with the matched grade (3D LUT + tweaks) in WebGL2 and the subtitles drawn on top.
   Pure DOM / WebGL, no engine imports. createPlayer(host, opts) builds everything inside `host` and fills it
   (the caller sizes `host` at the output aspect ratio). The pure helpers at the top are unit-tested.
   ============================================================ */
import { GLSL_TWEAK } from './look.js';
import { draw as drawCaptions, DEFAULT_STYLE } from './captions.js';

/* ---------- pure helpers ---------- */
/** object-fit: cover of a src (sw × sh) into an output (ow × oh): the centred source rectangle to show, in 0..1 texture units.
    The export (Task 13) crops the same way: scale=…:force_original_aspect_ratio=increase, crop=w:h. */
export function coverCrop(sw, sh, ow, oh) {
  if (!(sw > 0 && sh > 0 && ow > 0 && oh > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  const s = sw / sh, o = ow / oh;
  if (s > o) { const w = o / s; return { x: (1 - w) / 2, y: 0, w, h: 1 }; } // source wider: crop the sides
  const h = s / o; return { x: 0, y: (1 - h) / 2, w: 1, h };
}
/** The largest ow:oh box that fits in bw × bh (CSS pixels, rounded down) */
export function fitBox(bw, bh, ow, oh) {
  if (!(bw > 0 && bh > 0 && ow > 0 && oh > 0)) return { w: 0, h: 0 };
  const k = Math.min(bw / ow, bh / oh);
  return { w: Math.floor(ow * k), h: Math.floor(oh * k) };
}
/** Backing-store size of the canvases: the CSS size × devicePixelRatio, never above the output size */
export function canvasSize(cssW, cssH, dpr, ow, oh) {
  const k = Math.min(dpr || 1, ow / Math.max(1, cssW), oh / Math.max(1, cssH));
  return { w: Math.max(1, Math.round(cssW * Math.max(k, 0.01))), h: Math.max(1, Math.round(cssH * Math.max(k, 0.01))) };
}
/** "1:02.4" (minutes, seconds, tenths) */
export function fmtMs(ms) {
  const t = Math.max(0, Math.floor((+ms || 0) / 100)), m = Math.floor(t / 600), s = Math.floor((t % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${t % 10}`;
}

/* ---------- shaders ---------- */
const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D u_vid; uniform sampler3D u_lut;
uniform vec4 u_crop; uniform float u_n, u_hasLut, u_strength, u_exposure, u_temp, u_sat, u_split;
${GLSL_TWEAK}
void main() {
  vec3 c = texture(u_vid, u_crop.xy + vec2(uv.x, 1.0 - uv.y) * u_crop.zw).rgb;
  if (uv.x < u_split) { o = vec4(c, 1.0); return; } // Before: the raw proxy
  vec3 g = u_hasLut > 0.5 ? texture(u_lut, (clamp(c, 0.0, 1.0) * (u_n - 1.0) + 0.5) / u_n).rgb : c;
  o = vec4(lookTweak(mix(c, g, u_strength), u_exposure, u_temp, u_sat), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function glSetup(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const pr = gl.createProgram();
  gl.attachShader(pr, compile(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(pr, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(pr));
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = (unit, target) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t); return t; };
  const vid = tex(0, gl.TEXTURE_2D);
  [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach((k) => gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  const lut = tex(1, gl.TEXTURE_3D);
  [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R].forEach((k) => gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE));
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const U = {}; ['u_vid', 'u_lut', 'u_crop', 'u_n', 'u_hasLut', 'u_strength', 'u_exposure', 'u_temp', 'u_sat', 'u_split'].forEach((n) => (U[n] = gl.getUniformLocation(pr, n)));
  gl.uniform1i(U.u_vid, 0); gl.uniform1i(U.u_lut, 1);
  return { gl, U, vid, lut };
}

/**
 * @param {HTMLElement} host
 * @param {{ proxyUrl?: string, out: { w: number, h: number, fps?: number }, look?: object, captions?: { style?: object, lines?: any[] },
 *   cube?: (lut: string) => ({ size: number, data: Float32Array } | null), onTime?: (ms: number, playing: boolean) => void,
 *   onError?: (err: MediaError | null) => void, onReady?: (durMs: number) => void }} opts
 */
export function createPlayer(host, opts) {
  const out = { w: 1080, h: 1920, fps: 30, ...(opts.out || {}) };
  const st = { look: { lut: null, strength: 1, exposure: 0, temp: 0, sat: 0 }, captions: { style: null, lines: [] }, split: null, lutKey: null, hasLut: false, dead: false, raf: 0, vfc: 0, ms: 0 };
  host.classList.add('ftp');
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous'; video.playsInline = true; video.preload = 'auto'; video.muted = false;
  video.setAttribute('playsinline', ''); video.className = 'ftp-v';
  const cv = document.createElement('canvas'), ov = document.createElement('canvas');
  cv.className = 'ftp-c'; ov.className = 'ftp-o';
  host.append(video, cv, ov);
  const o2 = ov.getContext('2d');
  let G = null, c2 = null, note = null;
  try { G = glSetup(cv); } catch (e) { G = null; console.warn('footage player: WebGL setup failed', e); }
  if (!G) {
    c2 = cv.getContext('2d');
    note = document.createElement('p'); note.className = 'ftp-note';
    note.textContent = "Your browser can't show the colour grade. The export still uses it.";
    host.append(note);
  }

  /* sizes: the canvases follow the host's CSS size */
  const resize = () => {
    const r = host.getBoundingClientRect(); if (!r.width || !r.height) return;
    const { w, h } = canvasSize(r.width, r.height, window.devicePixelRatio || 1, out.w, out.h);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
    render(false);
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro && ro.observe(host);

  function uploadLut() {
    if (!G) return;
    const key = st.look.lut || null;
    if (key === st.lutKey) return;
    const cube = key && opts.cube ? opts.cube(key) : null;
    if (key && !cube) { st.hasLut = false; return; } // not loaded yet: try again on the next setLook
    st.lutKey = key; st.hasLut = !!cube;
    if (!cube) return;
    const { gl } = G, n = cube.size;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, G.lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, n, n, n, 0, gl.RGB, gl.FLOAT, cube.data); // r fastest, then g, then b: the .cube order
    gl.uniform1f(G.U.u_n, n);
  }

  function render(upload = true) {
    if (st.dead) return;
    const W = cv.width, H = cv.height, vw = video.videoWidth, vh = video.videoHeight, ready = video.readyState >= 2 && vw > 0;
    const crop = coverCrop(vw, vh, out.w, out.h);
    if (G) {
      const { gl, U } = G;
      gl.viewport(0, 0, W, H);
      if (ready && upload) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, G.vid);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch (e) { /* tainted or not decodable yet */ }
      }
      const L = st.look;
      gl.uniform4f(U.u_crop, crop.x, crop.y, crop.w, crop.h);
      gl.uniform1f(U.u_hasLut, st.hasLut ? 1 : 0);
      gl.uniform1f(U.u_strength, st.hasLut ? Math.max(0, Math.min(1, +L.strength))  : 0);
      gl.uniform1f(U.u_exposure, +L.exposure || 0); gl.uniform1f(U.u_temp, +L.temp || 0); gl.uniform1f(U.u_sat, +L.sat || 0);
      gl.uniform1f(U.u_split, st.split == null ? -1 : st.split);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (c2) {
      c2.fillStyle = '#000'; c2.fillRect(0, 0, W, H);
      if (ready) c2.drawImage(video, crop.x * vw, crop.y * vh, crop.w * vw, crop.h * vh, 0, 0, W, H);
    }
    o2.clearRect(0, 0, ov.width, ov.height);
    const lines = st.captions.lines || [];
    if (lines.length) drawCaptions(o2, lines, st.captions.style || DEFAULT_STYLE, st.ms, ov.width, ov.height);
    opts.onTime && opts.onTime(st.ms, !video.paused);
  }

  /* frame loop: requestVideoFrameCallback gives the exact presented media time; rAF otherwise (and while paused nothing runs) */
  const hasVfc = typeof video.requestVideoFrameCallback === 'function';
  const onVfc = (_now, meta) => { if (st.dead) return; st.ms = meta && meta.mediaTime != null ? meta.mediaTime * 1000 : video.currentTime * 1000; render(); st.vfc = video.requestVideoFrameCallback(onVfc); };
  const onRaf = () => { if (st.dead || video.paused) { st.raf = 0; return; } st.ms = video.currentTime * 1000; render(); st.raf = requestAnimationFrame(onRaf); };
  if (hasVfc) st.vfc = video.requestVideoFrameCallback(onVfc);
  const still = () => { st.ms = video.currentTime * 1000; render(); };
  const on = (ev, fn) => video.addEventListener(ev, fn);
  on('loadeddata', still); on('seeked', still);
  on('loadedmetadata', () => { opts.onReady && opts.onReady(video.duration * 1000); });
  on('play', () => { if (!hasVfc && !st.raf) st.raf = requestAnimationFrame(onRaf); opts.onTime && opts.onTime(st.ms, true); });
  on('pause', () => { st.ms = video.currentTime * 1000; render(false); });
  on('ended', () => { opts.onTime && opts.onTime(st.ms, false); });
  on('error', () => { opts.onError && opts.onError(video.error); });

  const P = {
    video,
    play: () => video.play().catch((e) => { if (e && e.name !== 'AbortError') console.warn('footage player:', e.message); }),
    pause: () => video.pause(),
    toggle: () => (video.paused || video.ended ? P.play() : P.pause()),
    playing: () => !video.paused && !video.ended,
    seek: (ms) => { const d = isFinite(video.duration) ? video.duration * 1000 : Infinity; const t = Math.max(0, Math.min(+ms || 0, d)); st.ms = t; video.currentTime = t / 1000; render(false); },
    time: () => (video.paused ? st.ms : video.currentTime * 1000),
    duration: () => (isFinite(video.duration) ? video.duration * 1000 : 0),
    frameMs: () => 1000 / (out.fps || 30),
    /** Re-uploads the 3D texture only when `look.lut` changes (or when its cube was not loaded on the last call) */
    setLook: (look) => { st.look = { ...st.look, ...(look || {}) }; uploadLut(); render(false); },
    setCaptions: (c) => { st.captions = { style: null, lines: [], ...(c || {}) }; render(false); },
    setSplit: (x) => { st.split = x == null ? null : Math.max(0, Math.min(1, +x)); render(false); },
    /** A new signed URL for the same video (expired link): keeps the time and the play state */
    setSrc: (url) => {
      const t = st.ms, wasPlaying = P.playing();
      if (!url || video.src === url) return;
      video.src = url;
      video.addEventListener('loadedmetadata', () => { video.currentTime = t / 1000; if (wasPlaying) P.play(); }, { once: true });
    },
    /** Redraws the overlay (after web fonts load) */
    redraw: () => render(false),
    hasGL: () => !!G,
    destroy: () => {
      if (st.dead) return; st.dead = true;
      ro && ro.disconnect(); if (st.raf) cancelAnimationFrame(st.raf);
      if (hasVfc && st.vfc) video.cancelVideoFrameCallback(st.vfc);
      video.pause(); video.removeAttribute('src'); video.load();
      if (G) { const ext = G.gl.getExtension('WEBGL_lose_context'); ext && ext.loseContext(); }
      host.classList.remove('ftp'); [video, cv, ov, note].forEach((el) => el && el.remove());
    },
  };
  if (opts.look) P.setLook(opts.look);
  if (opts.captions) P.setCaptions(opts.captions);
  if (opts.proxyUrl) video.src = opts.proxyUrl;
  resize();
  return P;
}
