import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { concatText, CaptionRenderer, exportHash, ExportInvalid, ExportRequest, ExportService, INTERRUPTED, MAX_ACTIVE, overlayPlan, validateExport } from './export.service';
import { FootageStore } from './footage.store';
import { JobsService } from './jobs.service';
import { loadShared } from './shared';

const SRC = 'a'.repeat(24), REF = 'b'.repeat(24);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(5);
const PNG = 'data:image/png;base64,' + Buffer.from('png').toString('base64');

/** In-memory stand-in for the mongoose model: findById / findOne(exports.<id> exists) / updateOne with dotted $set and $unset */
function fakeModel(initial: Record<string, any>) {
  const docs: Record<string, any> = JSON.parse(JSON.stringify(initial));
  const path = (o: any, p: string, v: any, del = false) => { const k = p.split('.'); let c = o; for (const x of k.slice(0, -1)) c = c[x] ??= {}; if (del) delete c[k.at(-1)!]; else c[k.at(-1)!] = v; };
  const q = (v: any) => ({ select: () => ({ lean: async () => (v ? JSON.parse(JSON.stringify(v)) : null) }) });
  return {
    docs,
    findById: (id: string) => q(docs[id]),
    findOne: (f: any) => { const [k] = Object.keys(f); const [, id] = k.split('.'); return q(Object.values(docs).find((d: any) => d.exports && id in d.exports)); },
    updateOne: vi.fn(async (f: any, u: any) => {
      const d = docs[String(f._id)]; if (!d) return;
      for (const [k, v] of Object.entries(u.$set ?? {})) path(d, k, v);
      for (const k of Object.keys(u.$unset ?? {})) path(d, k, null, true);
    }),
  };
}

let root: string, store: FootageStore, model: ReturnType<typeof fakeModel>, pipeline: JobsService, svc: ExportService;
let ffmpegCalls: string[][], ffmpegActive: number, ffmpegMax: number, failFfmpeg: boolean, opened: number, drawCalls: { lines: any[]; times: number[] }[];
let gate: Promise<void> | null;

const safeWrite = (p: string | undefined, data: string) => {
  if (!p || !resolve(p).startsWith(resolve(root) + sep)) throw new Error(`fake runner refused to write outside ${root}: ${p}`);
  writeFileSync(p, data);
};
let lastConcat = '';
const fakeRunner = async (cmd: string, args: string[], o?: { onLine?: (l: string) => void }) => {
  if (cmd !== 'ffmpeg') throw new Error(`unexpected ${cmd}`);
  ffmpegCalls.push(args); ffmpegActive++; ffmpegMax = Math.max(ffmpegMax, ffmpegActive);
  try {
    lastConcat = readFileSync(args[args.indexOf('concat') + 4], 'utf8'); // -f concat -safe 0 -i <concat>
    await sleep(10);
    o?.onLine?.('out_time_us=1000000');
    if (failFfmpeg) throw new Error('ffmpeg said no');
    safeWrite(args.at(-1), 'mp4');
    return { stdout: '', stderr: '' };
  } finally { ffmpegActive--; }
};
const fakeRenderer: CaptionRenderer = {
  open: async () => {
    opened++;
    if (gate) await gate;
    return { draw: async (lines, _s, _w, _h, times) => { drawCalls.push({ lines, times }); return times.map(() => PNG); }, close: async () => undefined };
  },
};

const W = (t: string, s: number, e: number) => ({ t, s, e });
const lines = [{ id: 'l1', start: 1000, end: 2000, words: [W('one', 1000, 1500), W('two', 1500, 2000)] }, { id: 'l2', start: 3000, end: 3500, words: [W('three', 3000, 3500)] }];
const body = (o: Record<string, any> = {}) => ({ designId: 'd1', footage: { src: SRC, look: { lut: `footage/${SRC}/look.cube`, strength: 0.8, exposure: 0.1, temp: 0, sat: 0 }, captions: { style: null, lines }, out: { w: 1080, h: 1920, fps: 30 } }, w: 1080, h: 1920, fps: 30, ...o });
const req = (o: Record<string, any> = {}): ExportRequest => validateExport(body(o));

function newService() {
  const s = new ExportService(model as any, store, pipeline);
  s.runner = fakeRunner as any; s.renderer = fakeRenderer;
  return s;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'export-')); process.env.FOOTAGE_DIR = root; store = new FootageStore();
  ffmpegCalls = []; ffmpegActive = 0; ffmpegMax = 0; failFfmpeg = false; opened = 0; drawCalls = []; gate = null; lastConcat = '';
  model = fakeModel({
    [SRC]: { _id: SRC, role: 'original', status: 'ready', meta: { dur: 5, w: 1080, h: 1920, rotation: 90, fps: 30, hdr: 'hlg', audio: true } },
    [REF]: { _id: REF, role: 'reference', status: 'ready', meta: { dur: 5 } },
  });
  pipeline = new JobsService(model as any, store, {} as any);
  const { look } = await loadShared();
  await fs.mkdir(store.dir(SRC), { recursive: true });
  writeFileSync(join(store.dir(SRC), 'source.mov'), 'x');
  writeFileSync(store.file(SRC, 'look.cube'), look.writeCube(look.identityCube(33)));
  writeFileSync(pipeline.cube, look.writeCube(look.identityCube(17), 'hlg')); // a different size: export.cube must still come out 33³
  svc = newService();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('validateExport', () => {
  it('accepts the editor payload and copies only known fields', () => {
    const r = validateExport({ ...body(), extra: 1, footage: { ...body().footage, evil: '$where' } });
    expect(r).toMatchObject({ designId: 'd1', src: SRC, w: 1080, h: 1920, fps: 30, look: { strength: 0.8, exposure: 0.1 } });
    expect(r).not.toHaveProperty('extra'); expect(r.captions.lines[0].words[0]).toEqual({ t: 'one', s: 1000, e: 1500 });
  });
  it('rejects bad lut paths and traversal', () => {
    for (const lut of ['footage/../x/look.cube', `footage/${SRC}/../../etc/look.cube`, 'looks/../../secret.cube', '/etc/passwd', 'looks/a b.cube', `footage/${SRC}/proxy.mp4`, 'looks/x.cube/../y.cube'])
      expect(() => validateExport(body({ footage: { ...body().footage, look: { lut } } })), lut).toThrow(ExportInvalid);
    expect(validateExport(body({ footage: { ...body().footage, look: { lut: 'looks/abc-1_2.cube' } } })).look.lut).toBe('looks/abc-1_2.cube');
    expect(validateExport(body({ footage: { ...body().footage, look: { lut: null } } })).look).toEqual({ lut: null, strength: 1, exposure: 0, temp: 0, sat: 0 });
  });
  it('rejects huge or malformed captions', () => {
    const cap = (c: any) => () => validateExport(body({ footage: { ...body().footage, captions: c } }));
    const line = (n: number, t = 'w') => ({ start: 0, end: 10, words: Array.from({ length: n }, () => W(t, 0, 10)) });
    expect(cap({ lines: Array.from({ length: 5001 }, () => line(1)) })).toThrow(/5000/);
    expect(cap({ lines: [line(61)] })).toThrow(/60 words/);
    expect(cap({ lines: [line(1, 'x'.repeat(201))] })).toThrow(ExportInvalid);
    expect(cap({ lines: [{ start: '0', end: 10, words: [] }] })).toThrow(/milliseconds/);
    expect(cap({ lines: [{ start: 0, end: 10, words: [{ t: 'a', s: 0, e: NaN }] }] })).toThrow(/milliseconds/);
    expect(cap({ lines: 'nope' })).toThrow(ExportInvalid);
    expect(cap({ style: { font: 'x'.repeat(9000) }, lines: [] })).toThrow(/style/);
    expect(cap({ lines: Array.from({ length: 5000 }, () => line(1)) })).not.toThrow();
  });
  it('rejects bad sizes, fps, grade values, ids and limitMs outside tests', () => {
    for (const o of [{ w: 1081 }, { h: 200 }, { w: 4000 }, { w: '1080' }, { fps: 29 }, { designId: '../x' }, { footage: { ...body().footage, src: 'x' } }, { footage: { ...body().footage, look: { lut: null, strength: 1.5 } } }, { footage: { ...body().footage, look: { lut: null, temp: -2 } } }, { limitMs: 10000 }])
      expect(() => validateExport(body(o)), JSON.stringify(o).slice(0, 60)).toThrow(ExportInvalid);
    expect(validateExport(body({ limitMs: 10000 }), { allowLimit: true }).limitMs).toBe(10000);
  });
});

describe('exportHash', () => {
  it('ignores line ids, follows everything drawn', () => {
    const a = req(), b = validateExport(body({ footage: { ...body().footage, captions: { style: null, lines: lines.map((l) => ({ ...l, id: 'other' })) } } }));
    expect(exportHash(a, 'c')).toBe(exportHash(b, 'c'));
    expect(exportHash(a, 'c')).not.toBe(exportHash(a, 'd'));
    expect(exportHash(a, 'c')).not.toBe(exportHash({ ...a, fps: 60 }, 'c'));
    expect(exportHash(a, 'c')).not.toBe(exportHash({ ...a, captions: { ...a.captions, style: { y: 0.5 } } }, 'c'));
  });
});

describe('overlay plan and concat', () => {
  it('durations sum to the clip duration, caption-free stretches merge into one blank entry', async () => {
    const { captions } = await loadShared();
    const dur = 5000, times = captions.changeTimes(lines, null, dur), plan = overlayPlan(times, (t) => !!captions.lineAt(lines, t), dur);
    expect(plan.reduce((a, s) => a + s.dur, 0)).toBe(dur);
    expect(plan.map((s) => [s.t, s.blank])).toEqual([[0, true], [1000, false], [1500, false], [2000, true], [3000, false], [3500, true]]);
    expect(overlayPlan([0, 0, 200, 9000], () => true, 1000).map((s) => s.dur)).toEqual([200, 800]);
    expect(overlayPlan([300], () => false, 1000)).toEqual([{ t: 0, dur: 1000, blank: true }]);
  });
  it('concat text: seconds, quoted paths, last file repeated', () => {
    const t = concatText([{ file: '/a b/blank.png', dur: 1000 }, { file: "/x/it's.png", dur: 1500 }]);
    expect(t).toBe("ffconcat version 1.0\nfile '/a b/blank.png'\nduration 1.000000\nfile '/x/it'\\''s.png'\nduration 1.500000\nfile '/x/it'\\''s.png'\n");
    const secs = [...t.matchAll(/duration ([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0); expect(secs).toBeCloseTo(2.5);
  });
});

describe('ExportService', () => {
  it('bakes a 33³ cube, writes the overlay and concat, encodes, then serves a signed url', async () => {
    const { jobId } = await svc.start(req()); await svc.idle();
    const st = await svc.status(jobId);
    expect(st).toMatchObject({ state: 'done', progress: 1 });
    expect(st!.url).toMatch(new RegExp(`^/footage/${SRC}/exports/${jobId}\\.mp4\\?t=\\d+\\.[0-9a-f]{64}$`));
    expect(existsSync(store.file(SRC, `exports/${jobId}.mp4`))).toBe(true);
    expect(readdirSync(join(store.dir(SRC), 'exports'))).toEqual([`${jobId}.mp4`]); // work folder and temp file gone
    const a = ffmpegCalls[0], fc = a[a.indexOf('-filter_complex') + 1];
    expect(fc).toMatch(/transpose=1/); expect(a).toContain(join(store.dir(SRC), 'source.mov'));
    // the concat: blank, 2 drawn, blank, 1 drawn, blank; files from the overlay folder
    expect([...lastConcat.matchAll(/duration ([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0)).toBeCloseTo(5);
    expect((lastConcat.match(/blank\.png/g) || []).length).toBe(4); // 3 blank stretches, the last one repeated
    expect(lastConcat).toMatch(/overlay\/00000\.png'[\s\S]*overlay\/00002\.png'[\s\S]*blank\.png'\n$/);
    expect(drawCalls.slice(1).flatMap((c) => c.times)).toEqual([1000, 1500, 3000]);
    expect(model.docs[SRC].exports[jobId]).toMatchObject({ state: 'done' });
  });
  it('export.cube = bakeExport(hlg, grade at strength, tweaks), 33³', async () => {
    const { look } = await loadShared();
    let cubeText = '';
    svc.runner = (async (cmd: string, args: string[]) => { const f = args[args.indexOf('-filter_complex') + 1]; cubeText = readFileSync(/lut3d=file=([^:]+):/.exec(f)![1], 'utf8'); safeWrite(args.at(-1), 'mp4'); return { stdout: '', stderr: '' }; }) as any;
    await svc.start(req()); await svc.idle();
    const got = look.parseCube(cubeText);
    expect(got.size).toBe(33);
    const want = look.bakeExport({ look: look.identityCube(33), hlg: look.parseCube(readFileSync(pipeline.cube, 'utf8')), strength: 0.8, tweaks: { exposure: 0.1, temp: 0, sat: 0 } });
    let worst = 0; for (let i = 0; i < want.data.length; i++) worst = Math.max(worst, Math.abs(got.data[i] - want.data[i]));
    expect(worst).toBeLessThan(1e-6);
  });
  it('same hash returns the previous export without re-encoding, also after a restart', async () => {
    const a = await svc.start(req()); await svc.idle();
    const b = await svc.start(req()); await svc.idle();
    expect(b).toEqual({ jobId: a.jobId, state: 'done' }); expect(ffmpegCalls).toHaveLength(1);
    const again = newService();
    expect(await again.start(req())).toEqual({ jobId: a.jobId, state: 'done' }); expect(ffmpegCalls).toHaveLength(1);
    expect(await again.status(a.jobId)).toMatchObject({ state: 'done', url: expect.stringContaining(a.jobId) });
    // a different size, strength or a re-matched grade cube is a new export
    const c = await svc.start(req({ w: 720, h: 1280 })); await svc.idle();
    expect(c.jobId).not.toBe(a.jobId);
    writeFileSync(store.file(SRC, 'look.cube'), readFileSync(store.file(SRC, 'look.cube'), 'utf8').replace('LUT_3D_SIZE 33', '# new\nLUT_3D_SIZE 33'));
    const d = await svc.start(req()); await svc.idle();
    expect(d.jobId).not.toBe(a.jobId); expect(ffmpegCalls).toHaveLength(3);
  });
  it('a request already running is joined, not started twice', async () => {
    const a = await svc.start(req()), b = await svc.start(req());
    expect(b.jobId).toBe(a.jobId); await svc.idle(); expect(ffmpegCalls).toHaveLength(1);
  });
  it('third concurrent export waits; the encodes still run one at a time', async () => {
    let open!: () => void; gate = new Promise((r) => (open = r));
    const ids = [];
    for (const w of [1080, 720, 2160]) ids.push((await svc.start(req({ w, h: (w * 16) / 9 }))).jobId);
    for (let i = 0; i < 200 && opened < 2; i++) await tick(); // the first two bake their cube, then open a page
    await sleep(50);
    expect(MAX_ACTIVE).toBe(2); expect(opened).toBe(2);
    expect((await svc.status(ids[2]))!.state).toBe('queued');
    expect((await svc.status(ids[0]))!.state).toBe('running');
    open(); gate = null; await svc.idle();
    expect(opened).toBe(3); expect(ffmpegCalls).toHaveLength(3); expect(ffmpegMax).toBe(1);
    for (const id of ids) expect((await svc.status(id))!.state).toBe('done');
  });
  it('the encode takes the pipeline ffmpeg lock', async () => {
    let release!: () => void; const held = pipeline.withFfmpeg(() => new Promise<void>((r) => (release = r)));
    await svc.start(req()); await sleep(30);
    expect(ffmpegCalls).toHaveLength(0);
    release(); await held; await svc.idle(); expect(ffmpegCalls).toHaveLength(1);
  });
  it('a failed encode reports the error and leaves no file; a job cut by a restart reads as interrupted', async () => {
    failFfmpeg = true;
    const { jobId } = await svc.start(req()); await svc.idle();
    expect(await svc.status(jobId)).toMatchObject({ state: 'failed', error: 'ffmpeg said no' });
    expect(readdirSync(join(store.dir(SRC), 'exports'))).toEqual([]);
    expect(await newService().status(jobId)).toMatchObject({ state: 'failed', error: 'ffmpeg said no' });
    model.docs[SRC].exports['c'.repeat(24)] = { hash: 'x', state: 'running' };
    expect(await newService().status('c'.repeat(24))).toEqual({ state: 'failed', progress: 0, error: INTERRUPTED });
    expect(await svc.status('d'.repeat(24))).toBeNull(); expect(await svc.status('../x')).toBeNull();
  });
  it('refuses a reference, a video still processing, a missing brand look', async () => {
    await expect(svc.start({ ...req(), src: REF })).rejects.toThrow(/not found/);
    model.docs[SRC].status = 'processing';
    await expect(svc.start(req())).rejects.toThrow(/still being prepared/);
    model.docs[SRC].status = 'ready';
    await expect(svc.start(validateExport(body({ footage: { ...body().footage, look: { lut: 'looks/gone.cube' } } })))).rejects.toThrow(/no longer exists/);
  });
  it('limitMs shortens the overlay and adds -t; no lut means an identity grade with tweaks only', async () => {
    await svc.start(validateExport(body({ limitMs: 2000, footage: { ...body().footage, look: { lut: null } } }), { allowLimit: true })); await svc.idle();
    const a = ffmpegCalls[0];
    expect(a[a.indexOf('-t') + 1]).toBe('2');
    expect([...lastConcat.matchAll(/duration ([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0)).toBeCloseTo(2);
  });
});
