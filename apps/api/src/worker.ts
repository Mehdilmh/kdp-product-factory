import { loadConfig } from './config';
import { startWorker } from './jobs/runner';
import { ensureCatalog, startCatalogRefresh } from './services/image-catalog';

loadConfig();
const worker = startWorker(Number(process.env.WORKER_CONCURRENCY ?? 2));
console.log('KDP Product Factory worker started.');
await ensureCatalog();
startCatalogRefresh();
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    // Let in-flight jobs reach a safe point before exiting.
    await worker.close();
    process.exit(0);
  });
