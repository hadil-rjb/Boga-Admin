import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PyWorker } from './local-tts.service';

let dir: string, w: PyWorker | undefined;
afterEach(() => { w?.stop(); rmSync(dir, { recursive: true, force: true }); });

/** Worker script: the first process never answers (a hung model), later ones echo */
const script = (marker: string) => `
import json, os, sys
print(json.dumps({"ready": True}), flush=True)
hang = not os.path.exists(${JSON.stringify(marker)})
open(${JSON.stringify(marker)}, "w").write(str(os.getpid()))
for line in sys.stdin:
    req = json.loads(line)
    if hang:
        import time; time.sleep(600)
    print(json.dumps({"id": req["id"], "ok": True, "pid": os.getpid()}), flush=True)
`;

describe('PyWorker timeout', () => {
  it('ask: a timed-out request stops the worker and the next request gets a fresh one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pyw-'));
    const py = join(dir, 'w.py'), marker = join(dir, 'marker');
    writeFileSync(py, script(marker));
    w = new PyWorker(new Logger('t'), 'Test', 'python3', py, {}, 10_000, 10_000, 60_000);
    await expect(w.ask({ x: 1 }, 400)).rejects.toThrow(/too long/);
    expect(existsSync(marker)).toBe(true);
    const r = await w.ask({ x: 2 }, 10_000);
    expect(r.ok).toBe(true);
  });
  it('the second request is answered by a different process than the hung one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pyw-'));
    const py = join(dir, 'w.py'), marker = join(dir, 'marker');
    writeFileSync(py, script(marker));
    w = new PyWorker(new Logger('t'), 'Test', 'python3', py, {}, 10_000, 10_000, 60_000);
    await expect(w.ask({}, 400)).rejects.toThrow();
    const hungPid = require('node:fs').readFileSync(marker, 'utf8');
    const r = await w.ask({}, 10_000);
    expect(String(r.pid)).not.toBe(hungPid);
  });
});
