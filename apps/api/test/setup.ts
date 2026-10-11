import { afterAll } from 'vitest';
import { loadConfig } from '../src/config';
import { InlineRunner, setRunner } from '../src/jobs/runner';
import { providerOverrides } from '../src/providers/gateway';

loadConfig();
export const runner = new InlineRunner(10);
setRunner(runner);
providerOverrides.retry = { attempts: 3, baseDelayMs: 5, maxDelayMs: 20 };

afterAll(async () => {
  await runner.drain();
});
