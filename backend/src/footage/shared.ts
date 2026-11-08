import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Native dynamic import: tsc would compile a plain import() to require() under CommonJS.
const nativeImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;

async function importEsm(href: string): Promise<any> {
  try {
    return await nativeImport(href);
  } catch (e: any) {
    // Inside vitest's vm context the Function-wrapped import has no callback; its own
    // transformed import() works there (tsc is not involved in that path).
    if (!/dynamic import callback/i.test(String(e?.message))) throw e;
    return import(/* @vite-ignore */ href);
  }
}

type Shared = { look: any; captions: any };
let cached: Promise<Shared> | null = null;

export function loadShared(): Promise<Shared> {
  if (!cached) {
    const load = (name: string) => importEsm(pathToFileURL(join(__dirname, 'shared', name)).href);
    cached = Promise.all([load('look.mjs'), load('captions.mjs')]).then(([look, captions]) => ({ look, captions }));
  }
  return cached;
}
