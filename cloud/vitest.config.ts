import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/** Test-only vars: `.test` origins so `log` mail and dev routes pass checkConfig. Dummy secrets only. */
const TEST_VARS = {
  PUBLIC_ORIGIN: 'https://app.test',
  RELAY_ORIGIN: 'https://relay.test',
  EMAIL_MODE: 'log',
  DEV_ROUTES: '1',
  SESSION_SECRET: 's'.repeat(32),
  EMAIL_HASH_SECRET: 'e'.repeat(32),
  CHECKOUT_SECRET: 'k'.repeat(32),
  PADDLE_WEBHOOK_SECRET: 'w'.repeat(32),
  PADDLE_ENV: 'sandbox',
  PADDLE_IP_CHECK: '0',
};

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { ...TEST_VARS, TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
    })),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
