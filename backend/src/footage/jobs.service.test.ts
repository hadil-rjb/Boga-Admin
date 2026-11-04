import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FootageStore } from './footage.store';
import { HLG_CUBE_NAME, JobsService, PQ_UNSUPPORTED, runProcess } from './jobs.service';

const fx = (n: string) => readFileSync(join(__dirname, '__fixtures__', n), 'utf8');
const ID1 = '1'.repeat(24), ID2 = '2'.repeat(24);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal in-memory stand-in for the mongoose model: $set with dotted keys, find().select().lean(), findById */
function fakeModel(initial: Record<string, any> = {}) {
  const docs: Record<string, any> = {};
  for (const [id, d] of Object.entries(initial)) docs[id] = { _id: id, status: 'processing', jobs: {}, ...d };
  const setPath = (o: any, path: string, v: any) => { const k = path.split('.'); let c = o; for (const x of k.slice(0, -1)) c = c[x] ??= {}; c[k.at(-1)!] = v; };
  const hooks: { before?: (id: string, set: any) => Promise<void> | void } = {};
  const m: any = {
    docs, hooks,
    updateOne: vi.fn(async (q: any, u: any) => {
      await hooks.before?.(String(q._id), u.$set);
      const d = docs[String(q._id)]; if (!d) return;
      for (const [k, v] of Object.entries(u.$set)) setPath(d, k, v);
    }),
    updateMany: vi.fn(async (q: any, u: any) => { for (const id of q._id.$in) if (docs[id].status === q.status) Object.assign(docs[id], u.$set); }),
    findById: (id: string) => ({ select: () => ({ lean: async () => docs[id] }) }),
    find: (q: any) => ({ select: () => ({ lean: async () => Object.values(docs).filter((d: any) => q.status.$in.includes(d.status)) }) }),
  };
  return m;
}

let root: string, store: FootageStore, model: ReturnType<typeof fakeModel>, svc: JobsService;
let calls: { cmd: string; args: string[] }[];
let probeJson: string, failProxy: boolean, failFrames: boolean, ffmpegActive: number, ffmpegMax: number;

/** Fake ffmpeg / ffprobe: writes the proxy temp file, counts concurrency */
const fakeRunner = async (cmd: string, args: string[]) => {
  calls.push({ cmd, args });
  if (cmd === 'ffprobe') return { stdout: probeJson, stderr: '' };
  ffmpegActive++; ffmpegMax = Math.max(ffmpegMax, ffmpegActive);
  try {
    await sleep(15);
    const isFrames = args.some((a) => a.endsWith('%03d.png'));
    if (isFrames ? failFrames : failProxy) throw new Error('boom: ffmpeg said no');
    if (!isFrames) writeFileSync(args.at(-1)!, 'proxy');
    return { stdout: '', stderr: '' };
  } finally { ffmpegActive--; }
};

async function seed(id: string) {
  await fs.mkdir(store.dir(id), { recursive: true });
  writeFileSync(join(store.dir(id), 'source.mp4'), 'x');
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jobs-')); process.env.FOOTAGE_DIR = root; store = new FootageStore();
  calls = []; probeJson = fx('probe-hlg-1080.json'); failProxy = false; failFrames = false; ffmpegActive = 0; ffmpegMax = 0;
  model = fakeModel({ [ID1]: {}, [ID2]: {} });
  svc = new JobsService(model, store); svc.runner = fakeRunner;
  writeFileSync(svc.cube, 'cube');
  await seed(ID1); await seed(ID2);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('JobsService chain', () => {
  it('probe -> proxy -> frames -> ready, proxy renamed from a unique temp name', async () => {
    await svc.enqueue(ID1, 'probe'); await svc.idle(ID1);
    const d = model.docs[ID1];
    expect(d.status).toBe('ready');
    expect(d.jobs).toMatchObject({ probe: { state: 'done' }, proxy: { state: 'done', progress: 1 }, frames: { state: 'done' } });
    expect(d.meta).toMatchObject({ hdr: 'hlg', w: 1080, h: 1920 });
    expect(existsSync(store.file(ID1, 'proxy.mp4'))).toBe(true);
    expect(readdirSync(store.dir(ID1)).filter((n) => n.endsWith('.tmp.mp4'))).toEqual([]);
    expect(calls.find((c) => c.args.at(-1)?.includes('.tmp.mp4'))!.args.at(-1)).toMatch(/proxy\.[0-9a-f]{12}\.tmp\.mp4$/);
  });
  it('enqueue persists queued before returning', async () => {
    const p = svc.enqueue(ID1, 'probe');
    await p;
    expect(model.updateOne.mock.calls[0][1].$set['jobs.probe']).toEqual({ state: 'queued', progress: 0 });
    await svc.idle(ID1);
  });
  it('PQ footage fails the probe step with the exact message and never builds a proxy', async () => {
    const j = JSON.parse(probeJson); j.streams.find((s: any) => s.codec_type === 'video').color_transfer = 'smpte2084'; probeJson = JSON.stringify(j);
    await svc.enqueue(ID1, 'probe'); await svc.idle(ID1);
    expect(model.docs[ID1]).toMatchObject({ status: 'failed', error: PQ_UNSUPPORTED, jobs: { probe: { state: 'failed', error: PQ_UNSUPPORTED } } });
    expect(PQ_UNSUPPORTED).toBe('HDR10 footage is not supported yet. Record in HLG or SDR, or convert it first.');
    expect(calls.filter((c) => c.cmd === 'ffmpeg')).toHaveLength(0);
  });
  it('proxy failure marks the footage failed with the stderr text and leaves no proxy', async () => {
    failProxy = true;
    await svc.enqueue(ID1, 'probe'); await svc.idle(ID1);
    expect(model.docs[ID1]).toMatchObject({ status: 'failed', error: 'boom: ffmpeg said no', jobs: { proxy: { state: 'failed' } } });
    expect(model.docs[ID1].jobs.frames).toBeUndefined();
    expect(readdirSync(store.dir(ID1)).filter((n) => n.includes('proxy'))).toEqual([]);
  });
  it('frames failure does not fail the footage: it still ends ready', async () => {
    failFrames = true;
    await svc.enqueue(ID1, 'probe'); await svc.idle(ID1);
    expect(model.docs[ID1]).toMatchObject({ status: 'ready', jobs: { proxy: { state: 'done' }, frames: { state: 'failed', error: 'boom: ffmpeg said no' } } });
  });
  it('runs one ffmpeg at a time across two footage', async () => {
    await Promise.all([svc.enqueue(ID1, 'probe'), svc.enqueue(ID2, 'probe')]);
    await Promise.all([svc.idle(ID1), svc.idle(ID2)]);
    expect(model.docs[ID1].status).toBe('ready'); expect(model.docs[ID2].status).toBe('ready');
    expect(calls.filter((c) => c.cmd === 'ffmpeg')).toHaveLength(4);
    expect(ffmpegMax).toBe(1);
  });
});

describe('JobsService queue races', () => {
  it('a step requested while the final status=ready is being saved still runs', async () => {
    let fired = false, release!: () => void;
    model.hooks.before = async (id, set) => {
      if (set.status === 'ready' && !fired) {
        fired = true;
        const gate = new Promise<void>((r) => (release = r));
        const enq = svc.enqueue(id, 'frames'); // arrives between the last check and the runner's exit
        await sleep(5); release(); await enq; await gate;
      }
    };
    await svc.enqueue(ID1, 'probe'); await svc.idle(ID1);
    expect(calls.filter((c) => c.args.some((a) => a.endsWith('%03d.png')))).toHaveLength(2);
    expect(model.docs[ID1].jobs.frames.state).toBe('done'); expect(model.docs[ID1].status).toBe('ready');
  });
  it('a step requested after the runner has fully exited starts a new runner', async () => {
    await svc.enqueue(ID1, 'probe'); await svc.idle(ID1);
    await svc.enqueue(ID1, 'frames'); await svc.idle(ID1);
    expect(calls.filter((c) => c.args.some((a) => a.endsWith('%03d.png')))).toHaveLength(2);
  });
  it('an earlier step requested while a later one runs is run afterwards, in pipeline order', async () => {
    let enq: Promise<void> | undefined;
    const base = svc.runner;
    svc.runner = async (cmd, args, o) => {
      if (cmd === 'ffmpeg' && !enq && !args.some((a) => a.endsWith('%03d.png'))) enq = svc.enqueue(ID1, 'probe'); // while proxy runs
      return base(cmd, args, o);
    };
    await svc.enqueue(ID1, 'probe'); await svc.idle(ID1); await enq;
    expect(calls.filter((c) => c.cmd === 'ffprobe')).toHaveLength(2);
    // proxy (first run), then probe again, proxy again, and one frames run (the pending frames request is deduplicated)
    expect(calls.map((c) => c.cmd === 'ffprobe' ? 'probe' : c.args.some((a) => a.endsWith('%03d.png')) ? 'frames' : 'proxy')).toEqual(['probe', 'proxy', 'probe', 'proxy', 'frames'])
    expect(model.docs[ID1].status).toBe('ready');
  });
});

describe('JobsService timeouts', () => {
  it('a hung ffmpeg is killed, the step fails with a timeout message and the lock is released', async () => {
    let first = true;
    svc.runner = async (cmd, args, o) => {
      if (cmd === 'ffmpeg' && first) { first = false; return runProcess('sleep', ['30'], { ...o, timeoutMs: 100 }); } // stands in for a hung ffmpeg
      return fakeRunner(cmd, args);
    };
    await Promise.all([svc.enqueue(ID1, 'probe'), svc.enqueue(ID2, 'probe')]);
    await Promise.all([svc.idle(ID1), svc.idle(ID2)]);
    const failed = [model.docs[ID1], model.docs[ID2]].filter((d) => d.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/timed out/);
    expect([model.docs[ID1], model.docs[ID2]].filter((d) => d.status === 'ready')).toHaveLength(1); // the other one was not stalled
  });
  it('runProcess kills the child after the timeout and reports it', async () => {
    const live = new Set<any>();
    await expect(runProcess('sleep', ['30'], { timeoutMs: 80 }, live)).rejects.toThrow(/timed out after 0 s|timed out/);
    expect(live.size).toBe(0);
  });
  it('passes the spec timeouts to the runner (probe 60 s, proxy 4 x dur + 5 min)', async () => {
    const seen: Record<string, number | undefined> = {};
    svc.runner = async (cmd, args, o) => { seen[cmd + (args.some((a) => a.endsWith('%03d.png')) ? ':frames' : '')] = o?.timeoutMs; return fakeRunner(cmd, args); };
    await svc.enqueue(ID1, 'probe'); await svc.idle(ID1);
    expect(seen.ffprobe).toBe(60_000);
    expect(seen.ffmpeg).toBe(4 * 72.852188 * 1000 + 300_000);
  });
});

describe('JobsService recovery and cube', () => {
  it('recover() resets stale assembling records and re-enqueues interrupted steps', async () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    model = fakeModel({
      [ID1]: { status: 'assembling', updatedAt: new Date(now - 20 * 60_000) },
      [ID2]: { status: 'processing', jobs: { probe: { state: 'done' }, proxy: { state: 'running', progress: 0.3 } } },
    });
    svc = new JobsService(model, store); svc.runner = fakeRunner;
    const enq = vi.spyOn(svc, 'enqueue').mockResolvedValue();
    await svc.recover(now);
    expect(model.docs[ID1].status).toBe('uploading');
    expect(enq).toHaveBeenCalledWith(ID2, 'proxy');
    expect(enq).toHaveBeenCalledTimes(1);
  });
  it('the cube file name is versioned by the SDR peak', () => expect(HLG_CUBE_NAME).toBe('hlg2709-300.cube'));
  it('ensureCube generates through grade.py hlg2709 into the versioned file, with a timeout', async () => {
    rmSync(svc.cube);
    const r = vi.fn(async (_c: string, args: string[]) => { writeFileSync(args.at(-1)!, 'c'); return { stdout: '{"ok": true}', stderr: '' }; });
    svc.runner = r as any;
    await svc.ensureCube();
    expect(r.mock.calls[0][1].slice(0, 2)[1]).toBe('hlg2709'); expect(r.mock.calls[0][2]).toMatchObject({ timeoutMs: 120_000 });
    expect(existsSync(join(root, 'hlg2709-300.cube'))).toBe(true);
  });
});
