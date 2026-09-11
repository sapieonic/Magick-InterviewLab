import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

/**
 * `.env` is loaded here, not left to the shell.
 *
 * `test/e2e/helpers.ts` signs in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, and the
 * seeded admin was created from the same variables. Without this import those
 * reads fall through to their hard-coded fallbacks, every spec fails on the
 * first sign-in with "Incorrect email or password", and the cause looks like a
 * product bug rather than an unloaded env file.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * Locked-down build agents sometimes ship a Chromium that does not match the
 * revision this Playwright version would download. Honour an explicit path so
 * those environments can run the suite without a network fetch.
 */
const executablePath = process.env.E2E_CHROMIUM_PATH || undefined;

/**
 * The end-to-end suite drives a real build against a real Postgres. It is
 * deliberately not part of `npm test` — see README "Testing".
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npm run start -- --port ${PORT}`,
        url: `http://127.0.0.1:${PORT}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: { PORT: String(PORT) },
      },
});
