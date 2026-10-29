import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const e2e = process.env.DECK_E2E === '1';
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Production code-splits these views. Tests keep the synchronous components.
      // Match the whole specifier. Vite replaces only the matched span, so a
      // suffix pattern would leave "./" or a directory prefix in front of the absolute path.
      { find: /^(?:.*\/)?lazyViews(?:\.tsx)?$/, replacement: path.join(root, 'src/ui/lazyViews.sync.tsx') },
    ],
  },
  test: {
    environment: 'node',
    include: e2e ? ['tests/e2e/**/*.e2e.test.ts'] : ['src/**/*.test.{ts,tsx}'],
    setupFiles: e2e ? [] : ['src/test/setup.ts'],
    testTimeout: e2e ? 180_000 : 10_000,
    hookTimeout: e2e ? 180_000 : 10_000,
  },
});
