import { defineConfig } from 'vitest/config';

const e2e = process.env.DECK_E2E === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: e2e ? ['tests/e2e/**/*.e2e.test.ts'] : ['src/**/*.test.{ts,tsx}', 'site/**/*.test.ts'],
    setupFiles: e2e ? [] : ['src/test/setup.ts'],
    testTimeout: e2e ? 180_000 : 10_000,
    hookTimeout: e2e ? 180_000 : 10_000,
  },
});
