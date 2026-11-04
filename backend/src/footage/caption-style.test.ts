import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCaptionCropArgs, cropBand } from './ffmpeg';
import { mergeStyle, NoAnthropicKey, NOTE_NO_KEY, NOTE_NO_TEXT, parseJsonLoose } from './caption-style';
import { FootageStore } from './footage.store';
import { JobsService } from './jobs.service';
import { loadShared } from './shared';

let DEFAULT_STYLE: any;
beforeEach(async () => { DEFAULT_STYLE = (await loadShared()).captions.DEFAULT_STYLE; });

describe('mergeStyle', () => {
  it('pixel colors override AI colors', () => expect(mergeStyle({ color: '#000000', highlight: { color: '#112233' } }, { text: '#FFFFFF', highlight: '#E8B54A' }, DEFAULT_STYLE).style).toMatchObject({ color: '#FFFFFF', highlight: { color: '#E8B54A' } }));
  it('clamps out-of-range numbers', () => expect(mergeStyle({ y: 4, maxWords: 0, size: 2 }, {}, DEFAULT_STYLE).style).toMatchObject({ y: 0.95, maxWords: 1, size: 0.12 }));
  it('clamps every range', () => {
    const lo = mergeStyle({ y: -1, size: 0, maxWords: -3, maxChars: 1, lines: 0, weight: 10, highlight: { radius: -1 } }, {}, DEFAULT_STYLE).style;
    expect(lo).toMatchObject({ y: 0.05, size: 0.02, maxWords: 1, maxChars: 8, lines: 1, weight: 300, highlight: { radius: 0 } });
    const hi = mergeStyle({ maxWords: 99, maxChars: 99, lines: 5, weight: 2000, highlight: { radius: 3 } }, {}, DEFAULT_STYLE).style;
    expect(hi).toMatchObject({ maxWords: 8, maxChars: 40, lines: 2, weight: 900, highlight: { radius: 0.5 } });
  });
  it('garbage from the AI falls back to defaults', () => {
    expect(mergeStyle('not json', {}, DEFAULT_STYLE).style).toEqual(DEFAULT_STYLE);
    expect(mergeStyle(null, {}, DEFAULT_STYLE).style).toEqual(DEFAULT_STYLE);
    expect(mergeStyle([1, 2], {}, DEFAULT_STYLE).style).toEqual(DEFAULT_STYLE);
    expect(mergeStyle({ font: 'comic', case: 5, y: 'high', anim: 'spin', color: 'red', highlight: 'box' }, {}, DEFAULT_STYLE).style).toEqual(DEFAULT_STYLE);
  });
  it('accepts JSON text and a partial object, keeps the rest default', () => {
    const r = mergeStyle('Here: {"font":"serif","case":"upper","highlight":{"mode":"color","textLight":true},"stroke":{"width":0.005},"shadow":null,"box":{"radius":0.3,"pad":0.02}}', {}, DEFAULT_STYLE).style;
    expect(r).toMatchObject({ font: 'serif', case: 'upper', shadow: null, stroke: { color: '#000000', width: 0.005 }, box: { radius: 0.3, pad: 0.02 }, highlight: { mode: 'color', text: '#FFFFFF', color: DEFAULT_STYLE.highlight.color }, y: DEFAULT_STYLE.y });
  });
  it('does not mutate the defaults', () => { const copy = JSON.stringify(DEFAULT_STYLE); mergeStyle({ y: 0.5, highlight: { mode: 'none' } }, { text: '#000000' }, DEFAULT_STYLE); expect(JSON.stringify(DEFAULT_STYLE)).toBe(copy); });
  it('parseJsonLoose', () => { expect(parseJsonLoose('x {"a":1} y')).toEqual({ a: 1 }); expect(parseJsonLoose('nope')).toBeNull(); expect(parseJsonLoose(3)).toBeNull(); });
});

describe('crop args', () => {
  it('converts the band fractions: band + 5 % on each side, clamped to the frame', () => {
    expect(cropBand([0.6, 0.7])).toEqual([0.55, 0.75]);
    expect(cropBand([0.02, 0.98])).toEqual([0, 1]);
    const a = buildCaptionCropArgs('p.mp4', [1, 2.5], [0.6, 0.7], '/o');
    expect(a).toContain('crop=iw:ih*0.2:0:ih*0.55');
    expect(a.filter((x) => x === '-i')).toHaveLength(2);
    expect(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 4)).toEqual(['-ss', '1.000', '-i', 'p.mp4']);
    expect(a).toContain('scale=-2:540');
    expect(a.at(-1)).toBe('/o/full.jpg');
  });
});

// ---- the pipeline step ----
function fakeModel(initial: Record<string, any>) {
  const docs: Record<string, any> = {};
  for (const [id, d] of Object.entries(initial)) docs[id] = { _id: id, status: 'processing', jobs: {}, ...d };
  const setPath = (o: any, path: string, v: any) => { const k = path.split('.'); let c = o; for (const x of k.slice(0, -1)) c = c[x] ??= {}; c[k.at(-1)!] = v; };
  return {
    docs,
    updateOne: vi.fn(async (q: any, u: any) => { const d = docs[String(q._id)]; if (d) for (const [k, v] of Object.entries(u.$set)) setPath(d, k, v); }),
    findById: (id: string) => ({ select: () => ({ lean: async () => docs[id] }) }),
    find: () => ({ select: () => ({ lean: async () => [] }) }),
  } as any;
}

const ID = 'a'.repeat(24), ID_ORIG = 'b'.repeat(24);
let root: string, store: FootageStore, model: any, svc: JobsService, ai: { captionStyle: ReturnType<typeof vi.fn> };
let calls: { cmd: string; args: string[] }[], textframes: any;

let failFfmpeg = false;
/** Fake runners may only write inside the test's tmp dir; unknown argument shapes throw */
const safeWrite = (path: string, data: string) => {
  if (!resolve(path).startsWith(resolve(root) + sep)) throw new Error(`fake runner refused to write outside ${root}: ${path}`);
  writeFileSync(path, data);
};
const runner = async (cmd: string, args: string[]) => {
  calls.push({ cmd, args });
  if (args[0]?.endsWith('grade.py')) {
    if (args[1] !== 'textframes') throw new Error(`unexpected grade.py call: ${args.join(' ')}`);
    return { stdout: typeof textframes === 'string' ? textframes : JSON.stringify(textframes), stderr: '' };
  }
  if (cmd === 'ffmpeg') {
    if (failFfmpeg) throw new Error('ffmpeg exploded');
    if (args.some((a) => a.endsWith('%03d.png'))) return { stdout: '', stderr: '' }; // frames step
    const outs = args.filter((a) => a.endsWith('.jpg'));
    if (!outs.length) throw new Error(`unexpected ffmpeg call: ${args.join(' ')}`);
    for (const a of outs) safeWrite(a, 'jpeg');
    return { stdout: '', stderr: '' };
  }
  throw new Error(`unexpected command: ${cmd}`);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cap-')); process.env.FOOTAGE_DIR = root; store = new FootageStore();
  failFfmpeg = false; calls = []; textframes = { ok: true, frames: ['003.png', '031.png'], band: [0.6, 0.7], colors: { text: '#FFFFFF', highlight: '#E8B54A' } };
  model = fakeModel({ [ID]: { role: 'reference', meta: { dur: 60, w: 1080, h: 1920, rotation: 0, fps: 30, hdr: null, audio: true } }, [ID_ORIG]: { role: 'original', meta: { dur: 60, w: 1080, h: 1920, rotation: 0, fps: 30, hdr: null, audio: true } } });
  ai = { captionStyle: vi.fn(async () => ({ style: { highlight: { mode: 'box', textLight: false }, y: 0.66, maxWords: 3, color: '#000000' }, model: 'claude-sonnet-5-5' })) };
  svc = new JobsService(model, store, ai as any); svc.runner = runner;
  await fs.mkdir(join(store.dir(ID), 'frames'), { recursive: true });
  writeFileSync(join(store.dir(ID), 'proxy.mp4'), 'x');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('caption-style step', () => {
  it('stores the merged style, sends the crops from the proxy and cleans up', async () => {
    await svc.enqueue(ID, 'caption-style'); await svc.idle(ID);
    const d = model.docs[ID];
    expect(d.jobs['caption-style']).toMatchObject({ state: 'done' });
    expect(d.captionStyle).toMatchObject({ color: '#FFFFFF', y: 0.66, maxWords: 3, highlight: { mode: 'box', color: '#E8B54A', text: DEFAULT_STYLE.highlight.text } });
    expect(d.captionNote).toBeNull();
    const [images, sampled, , band] = ai.captionStyle.mock.calls[0];
    expect(images).toHaveLength(3); // whole frame + 2 crops
    expect(images[0]).toMatchObject({ media: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') });
    expect(sampled).toEqual({ text: '#FFFFFF', highlight: '#E8B54A' });
    expect(band).toEqual([0.6, 0.7]);
    const ff = calls.find((c) => c.cmd === 'ffmpeg')!.args;
    expect(ff).toContain('crop=iw:ih*0.2:0:ih*0.55'); // 0.6-0.05 .. 0.7+0.05 of the height
    expect(ff.filter((x) => x === '-ss')).toHaveLength(2);
    expect(ff.filter((_, k) => ff[k - 1] === '-ss')).toEqual(['2.500', '30.500']); // frame 003 -> i = 2, 031 -> i = 30: t = (i + .5) * 60 / 60
    expect(readdirSync(store.dir(ID)).filter((n) => n.startsWith('caption.'))).toEqual([]);
  });
  it('no text found: defaults with a note, Claude and ffmpeg are not called', async () => {
    textframes = { ok: true, frames: [], band: null, colors: { text: null, highlight: null } };
    await svc.enqueue(ID, 'caption-style'); await svc.idle(ID);
    expect(model.docs[ID].captionStyle).toEqual(DEFAULT_STYLE);
    expect(model.docs[ID].captionNote).toBe(NOTE_NO_TEXT);
    expect(NOTE_NO_TEXT).toBe('No subtitles found in the reference. Using the default style.');
    expect(ai.captionStyle).not.toHaveBeenCalled();
    expect(calls.some((c) => c.cmd === 'ffmpeg')).toBe(false);
  });
  it('no Anthropic key: defaults with a note, the step is done and the footage is ready', async () => {
    ai.captionStyle.mockRejectedValue(new NoAnthropicKey());
    await svc.enqueue(ID, 'caption-style'); await svc.idle(ID);
    const d = model.docs[ID];
    expect(d.captionStyle).toEqual(DEFAULT_STYLE);
    expect(d.captionNote).toBe(NOTE_NO_KEY);
    expect(NOTE_NO_KEY).toBe('Add an Anthropic key in Settings, AI to copy the subtitle style.');
    expect(d.jobs['caption-style'].state).toBe('done');
    expect(d.status).toBe('ready');
  });
  it('another AI failure keeps the sampled colors on the default style', async () => {
    ai.captionStyle.mockRejectedValue(new Error('overloaded'));
    await svc.enqueue(ID, 'caption-style'); await svc.idle(ID);
    expect(model.docs[ID].captionStyle).toMatchObject({ ...DEFAULT_STYLE, highlight: { ...DEFAULT_STYLE.highlight, color: '#E8B54A' } });
    expect(model.docs[ID].captionNote).toMatch(/default style/);
    expect(model.docs[ID].jobs['caption-style'].state).toBe('done');
  });
  it('follows frames of a reference only, never of an original', async () => {
    writeFileSync(join(store.dir(ID), 'source.mp4'), 'x');
    await fs.mkdir(store.dir(ID_ORIG), { recursive: true }); writeFileSync(join(store.dir(ID_ORIG), 'proxy.mp4'), 'x');
    await svc.enqueue(ID, 'frames'); await svc.idle(ID);
    await svc.enqueue(ID_ORIG, 'frames'); await svc.idle(ID_ORIG);
    expect(model.docs[ID].jobs['caption-style']).toMatchObject({ state: 'done' });
    expect(model.docs[ID_ORIG].jobs['caption-style']).toBeUndefined();
    expect(model.docs[ID_ORIG].status).toBe('ready');
  });
  it.each([
    ['ok:false', { ok: false, error: 'boom' }],
    ['garbage output', 'Traceback (most recent call last)'],
    ['NaN band', { ok: true, frames: ['003.png'], band: [null, 'x'], colors: { text: '#FFFFFF', highlight: null } }],
  ])('unreadable textframes (%s): default style with a note, step done, Claude not called', async (_n, tf) => {
    textframes = tf;
    await svc.enqueue(ID, 'caption-style'); await svc.idle(ID);
    expect(model.docs[ID].captionStyle).toEqual(DEFAULT_STYLE);
    expect(model.docs[ID].captionNote).toBe('The subtitle style could not be read from the reference. Using the default style.');
    expect(model.docs[ID].jobs['caption-style'].state).toBe('done');
    expect(ai.captionStyle).not.toHaveBeenCalled();
  });
  it('an ffmpeg crop failure falls back to the default style with the same note and cleans up', async () => {
    failFfmpeg = true;
    await svc.enqueue(ID, 'caption-style'); await svc.idle(ID);
    expect(model.docs[ID].captionStyle).toEqual(DEFAULT_STYLE);
    expect(model.docs[ID].captionNote).toBe('The subtitle style could not be read from the reference. Using the default style.');
    expect(model.docs[ID].jobs['caption-style'].state).toBe('done');
    expect(readdirSync(store.dir(ID)).filter((n) => n.startsWith('caption.'))).toEqual([]);
  });
});
