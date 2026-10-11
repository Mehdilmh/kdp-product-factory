import { defineConfig } from 'vitest/config';
// Inline (empty) PostCSS config so Vite does not pick up the parent repository's config.
export default defineConfig({ css: { postcss: {} }, test: { include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 } });
