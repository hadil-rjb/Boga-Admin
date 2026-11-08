// Copies pure-ESM modules shared with the frontend studio into the backend,
// byte-for-byte. Append one [from, to] entry per shared module.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED = [
  ['frontend/studio/look.js', 'backend/src/footage/shared/look.mjs'],
  ['frontend/studio/captions.js', 'backend/src/footage/shared/captions.mjs'],
];

for (const [from, to] of SHARED) {
  mkdirSync(dirname(resolve(root, to)), { recursive: true });
  copyFileSync(resolve(root, from), resolve(root, to));
  console.log('synced', from, '->', to);
}
