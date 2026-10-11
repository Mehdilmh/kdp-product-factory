import { defineConfig } from 'vitest/config';
export default defineConfig({
  css: { postcss: {} },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/kdp_factory_test',
      APP_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
      JOB_RUNNER: 'inline',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_DIR: './storage-test',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },
  },
});
