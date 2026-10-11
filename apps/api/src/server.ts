import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app';
import { bootstrap } from './bootstrap';
import { config, loadConfig } from './config';
import { getRunner } from './jobs/runner';
import { startCatalogRefresh } from './services/image-catalog';

loadConfig();
const app = createApp();

// Serve the built web app (single-origin deployment) when present.
const webDist = resolve(process.cwd(), '../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
}

await bootstrap();
getRunner();
if (config().JOB_RUNNER === 'inline') startCatalogRefresh();
app.listen(config().PORT, () => console.log(`KDP Product Factory API on http://localhost:${config().PORT} (jobs: ${config().JOB_RUNNER}) — docs at /api/docs`));
