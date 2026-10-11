import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { createApp } from './app';
import { bootstrap } from './bootstrap';
import { loadConfig } from './config';

/**
 * Vercel function entry. The build bundles this file into .vercel/output/functions/api.func and
 * copies the font files next to it. One Express app serves every /api/* request.
 */
process.env.KDP_FONTS_DIR ??= fileURLToPath(new URL('./fonts/', import.meta.url));

let app: Express | null = null;
let ready: Promise<void> | null = null;

function startupError(res: ServerResponse, code: string, message: string) {
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { code, message } }));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!app) {
    try {
      loadConfig();
      app = createApp();
    } catch (e) {
      // Lists missing/invalid variable names only — never their values.
      return startupError(res, 'SERVER_NOT_CONFIGURED', `${(e as Error).message}. Set the environment variables in Vercel → Project → Settings → Environment Variables, then redeploy.`);
    }
  }
  ready ??= bootstrap().catch((e) => {
    ready = null;
    throw e;
  });
  try {
    await ready;
  } catch (e) {
    console.error('[startup] bootstrap failed:', e);
    return startupError(res, 'DATABASE_UNAVAILABLE', 'The database is not reachable or its tables have not been created. Check DATABASE_URL and that the build ran "prisma migrate deploy" (see the build log).');
  }
  app(req as Parameters<Express>[0], res as Parameters<Express>[1]);
}
