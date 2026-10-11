#!/usr/bin/env node
/**
 * Builds KDP Product Factory for Vercel using the Build Output API (v3):
 *
 *   .vercel/output/static/              the web app (Vite build)
 *   .vercel/output/functions/api.func/  one Node.js function serving /api/* (Express)
 *   .vercel/output/config.json          routes (API → function, SPA fallback) and the daily cron
 *
 * Steps: run database migrations (when DATABASE_URL is set), build the web app, bundle the API
 * with esbuild, copy native/runtime-file packages (Prisma engine, sharp, resvg, swagger UI,
 * BullMQ) next to the bundle, copy the fonts, write the function and routing config.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.vercel/output');
const fn = join(out, 'functions/api.func');
const apiDir = join(root, 'apps/api');
const log = (m) => console.log(`[vercel-build] ${m}`);
const run = (cmd, env = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

/* 1. Database migrations ---------------------------------------------------------------------- */
const migrateUrl = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
if (process.env.SKIP_MIGRATIONS === '1') log('SKIP_MIGRATIONS=1 — not running migrations.');
else if (migrateUrl) {
  log('Applying database migrations (prisma migrate deploy)…');
  run('npx prisma migrate deploy --schema apps/api/prisma/schema.prisma', { DATABASE_URL: migrateUrl });
} else {
  log('WARNING: DATABASE_URL is not set — skipping migrations. The app will report "database unavailable" until you add it and redeploy.');
}

/* 2. Web app ---------------------------------------------------------------------------------- */
log('Building the web app…');
run('npm run build -w @kdp/web');

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });
cpSync(join(root, 'apps/web/dist'), join(out, 'static'), { recursive: true });

/* 3. API bundle ------------------------------------------------------------------------------- */
// Packages that load native binaries or read their own files at runtime stay outside the bundle.
const EXTERNAL = ['@prisma/client', '.prisma/client', 'sharp', '@resvg/resvg-js', 'swagger-ui-dist', 'bullmq', 'ioredis'];
log('Bundling the API…');
await build({
  entryPoints: [join(apiDir, 'src/vercel.ts')],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  external: EXTERNAL.flatMap((p) => [p, `${p}/*`]),
  // CommonJS dependencies inside an ESM bundle need require/__dirname.
  banner: { js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" },
  logLevel: 'warning',
});

/* 4. Runtime packages (with their dependency closure) ----------------------------------------- */
const req = createRequire(join(apiDir, 'package.json'));
const copied = new Set();
function pkgDir(name, from) {
  const r = createRequire(join(from, 'package.json'));
  try {
    return dirname(r.resolve(`${name}/package.json`));
  } catch {
    // Packages without an exported package.json: walk node_modules upwards.
    let d = from;
    for (;;) {
      const c = join(d, 'node_modules', name);
      if (existsSync(join(c, 'package.json'))) return c;
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
  }
}
function copyPackage(name, from = apiDir) {
  const dir = pkgDir(name, from);
  if (!dir || copied.has(dir)) return;
  copied.add(dir);
  const rel = relative(root, dir); // e.g. node_modules/sharp
  cpSync(dir, join(fn, rel), { recursive: true, dereference: true, filter: (src) => !/\/(test|tests|docs|\.github)(\/|$)/.test(src.slice(dir.length)) });
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const dep of [...Object.keys(pj.dependencies ?? {}), ...Object.keys(pj.optionalDependencies ?? {})]) {
    if (/(darwin|win32|freebsd|android|wasm32|linuxmusl|-musl|linux-arm|-ia32|s390x|ppc64|riscv64|loong64)/i.test(dep)) continue; // Vercel runs linux-x64 glibc
    copyPackage(dep, dir);
  }
}
for (const p of ['@prisma/client', 'sharp', '@resvg/resvg-js', 'swagger-ui-dist', 'bullmq', 'ioredis']) copyPackage(p);
// The generated Prisma client (and its query engine) lives in node_modules/.prisma.
const prismaGen = join(dirname(pkgDir('@prisma/client', apiDir)), '..', '.prisma');
if (!existsSync(join(prismaGen, 'client'))) throw new Error('Generated Prisma client not found — did "prisma generate" run during install?');
cpSync(prismaGen, join(fn, relative(root, prismaGen)), { recursive: true });

/* 5. Fonts ------------------------------------------------------------------------------------ */
cpSync(join(root, 'packages/core/fonts'), join(fn, 'fonts'), { recursive: true });

/* 6. Function + routing config ---------------------------------------------------------------- */
writeFileSync(
  join(fn, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: Number(process.env.FUNCTION_MAX_DURATION ?? 300), memory: Number(process.env.FUNCTION_MEMORY_MB ?? 2048) }, null, 2),
);
writeFileSync(join(fn, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/api(?:/.*)?$', dest: '/api' },
        { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { handle: 'filesystem' },
        { src: '^/(?!api/).*$', dest: '/index.html' },
      ],
      crons: [{ path: '/api/internal/cron/catalog', schedule: '17 6 * * *' }],
    },
    null,
    2,
  ),
);

const size = (p) => (statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + size(join(p, f)), 0) : statSync(p).size);
log(`Function size: ${(size(fn) / 1048576).toFixed(1)} MB (limit 250 MB). Static: ${(size(join(out, 'static')) / 1048576).toFixed(1)} MB.`);
log('Done → .vercel/output');
