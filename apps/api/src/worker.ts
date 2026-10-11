import { loadConfig } from './config';
import { startWorker } from './jobs/runner';
import { bootstrap } from './bootstrap';
import { startCatalogRefresh } from './services/image-catalog';

loadConfig();
const worker = startWorker(Number(process.env.WORKER_CONCURRENCY ?? 2));
console.log('KDP Product Factory worker started.');
await bootstrap();
startCatalogRefresh();
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    // Let in-flight jobs reach a safe point before exiting.
    await worker.close();
    process.exit(0);
  });
