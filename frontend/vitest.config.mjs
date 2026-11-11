import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The studio's pure-module tests and lib unit tests
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '') } },
  test: {
    include: ['studio/**/*.test.js', 'lib/**/*.test.ts'],
    environment: 'node',
  },
});
