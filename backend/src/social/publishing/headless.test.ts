import { afterEach, describe, expect, it, vi } from 'vitest';

const launch = vi.fn(async (o: any) => o);
vi.mock('puppeteer-core', () => ({ default: { launch } }));

import { importEsm, launchChromium } from './headless';

describe('importEsm', () => {
  it('uses the native import when it works', async () => {
    const fallback = vi.fn();
    expect(await importEsm('x', async (s) => ({ s }), fallback)).toEqual({ s: 'x' });
    expect(fallback).not.toHaveBeenCalled();
  });
  it('falls back only for the missing dynamic import callback (vitest vm context)', async () => {
    const fallback = vi.fn(async (s: string) => ({ fb: s }));
    expect(await importEsm('y', async () => { throw new TypeError('A dynamic import callback was not specified.'); }, fallback)).toEqual({ fb: 'y' });
    await expect(importEsm('z', async () => { throw new Error('Cannot find module z'); }, fallback)).rejects.toThrow('Cannot find module z');
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe('launchChromium', () => {
  const prev = process.env.CHROME_PATH;
  afterEach(() => { if (prev === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = prev; launch.mockClear(); });
  it('appends extraArgs to the launch flags (and keeps the defaults without them)', async () => {
    process.env.CHROME_PATH = '/opt/chrome';
    const o: any = await launchChromium(['--use-gl=angle', '--use-angle=swiftshader']);
    expect(o.executablePath).toBe('/opt/chrome');
    expect(o.args).toEqual(['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--font-render-hinting=none', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader']);
    const d: any = await launchChromium();
    expect(d.args).toEqual(['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--font-render-hinting=none', '--disable-dev-shm-usage']);
  });
});
