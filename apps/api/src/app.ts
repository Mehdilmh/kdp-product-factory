import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { RULES } from '@kdp/core';
import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { prisma } from './db';
import { csrfGuard, loadSession } from './lib/auth';
import { errorHandler, HttpError } from './lib/errors';
import { registry } from './lib/route';
import { assetRouter } from './routes/assets';
import { authRouter } from './routes/auth';
import { batchRouter } from './routes/batches';
import { coverRouter } from './routes/covers';
import { exportRouter } from './routes/exports';
import { coloringRouter } from './routes/coloring';
import { imageModelRouter } from './routes/image-models';
import { interiorRouter } from './routes/interior';
import { jobRouter } from './routes/jobs';
import { metadataRouter } from './routes/metadata';
import { projectRouter } from './routes/projects';
import { settingsRouter } from './routes/settings';
import { validationRouter } from './routes/validation';
import { getRunner } from './jobs/runner';
import { rememberOrigin, verifyInternalJobToken } from './lib/origin';
import { syncCatalog } from './services/image-catalog';
import { workspaceRouter } from './routes/workspaces';

let openapiDoc: ReturnType<OpenApiGeneratorV3['generateDocument']> | null = null;
export function openapi() {
  openapiDoc ??= new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: { title: 'KDP Product Factory API', version: '0.1.0', description: 'REST API for project management, deterministic rendering, preflight validation, and exports. Authentication: session cookie. State-changing requests must send `X-Requested-With: kdp-factory`.' },
    servers: [{ url: '/' }],
  });
  return openapiDoc;
}

/** Mirrors the code-defined rules registry into the database for auditing. */
export async function syncRules() {
  for (const r of RULES) {
    await prisma.validationRule.upsert({
      where: { ruleId_version: { ruleId: r.id, version: r.version } },
      create: { ruleId: r.id, version: r.version, title: r.title, category: r.category, severity: r.severity, blocking: r.blocking, source: r.source, sourceVerification: r.sourceVerification, lastVerified: r.lastVerified },
      update: { title: r.title, category: r.category, severity: r.severity, blocking: r.blocking, source: r.source, sourceVerification: r.sourceVerification, lastVerified: r.lastVerified, active: true, syncedAt: new Date() },
    });
  }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"], fontSrc: ["'self'", 'data:'], scriptSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'self'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  app.use(express.json({ limit: '5mb' }));
  app.use(rememberOrigin);
  // Serverless runner continuation (called by the app itself; authenticated by a per-job HMAC token).
  app.post('/api/internal/jobs/:id/continue', async (req, res) => {
    if (!verifyInternalJobToken(req.params.id, req.get('x-kdp-job-token'))) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid job token' } });
      return;
    }
    await getRunner().enqueue(req.params.id);
    res.status(202).json({ ok: true });
  });
  // Scheduled catalog/price refresh (Vercel Cron sends "Authorization: Bearer $CRON_SECRET").
  app.get('/api/internal/cron/catalog', async (req, res, next) => {
    try {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.get('authorization') !== `Bearer ${secret}`) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cron secret required' } });
        return;
      }
      if (!config().FAL_KEY) {
        res.json({ skipped: 'FAL_KEY is not configured' });
        return;
      }
      const r = await syncCatalog({ discover: true, pricing: true });
      res.json({ verified: r.verified.length, discovered: r.discovered.length, priced: r.priced.length, errors: r.errors.length });
    } catch (e) {
      next(e);
    }
  });
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60_000, limit: config().NODE_ENV === 'test' ? 100_000 : 600, standardHeaders: true, legacyHeaders: false }));
  app.use('/api', loadSession, csrfGuard);

  app.get('/api/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, runner: config().JOB_RUNNER });
  });
  app.get('/api/openapi.json', (_req, res) => res.json(openapi()));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(undefined, { swaggerOptions: { url: '/api/openapi.json' } }));

  for (const r of [authRouter, workspaceRouter, projectRouter, interiorRouter, coverRouter, metadataRouter, validationRouter, exportRouter, jobRouter, batchRouter, assetRouter, settingsRouter, imageModelRouter, coloringRouter]) app.use('/api', r);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Unknown API route')));
  app.use(errorHandler);
  return app;
}
