import { defineConfig } from '@playwright/test';

/**
 * UI end-to-end tests. They run against the API serving the built web app (single origin).
 * Prerequisites: Postgres (DATABASE_URL in apps/api/.env), `npm run build -w @kdp/web`.
 * Jobs run in-process (JOB_RUNNER=inline) so no Redis/worker is needed for this test.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4000', trace: 'retain-on-failure', viewport: { width: 1440, height: 1000 } },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'npm run start -w @kdp/api', cwd: '../..', url: 'http://localhost:4000/api/health', reuseExistingServer: true, timeout: 60_000, env: { JOB_RUNNER: 'inline', PORT: '4000' } },
});
