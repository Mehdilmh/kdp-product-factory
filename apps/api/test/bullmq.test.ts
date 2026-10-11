import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQRunner, InlineRunner, setRunner, startWorker } from '../src/jobs/runner';
import { providerOverrides } from '../src/providers/gateway';
import { MockTextProvider } from '../src/providers/mock';
import { briefBody, H, prisma, signUp } from './helpers';
import { runner as inline } from './setup';

/** Exercises the production queue path against a real Redis (skipped if Redis is unavailable). */
let redisUp = false;
beforeAll(async () => {
  const r = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await r.connect();
    redisUp = (await r.ping()) === 'PONG';
  } catch {
    redisUp = false;
  }
  r.disconnect();
});

describe('BullMQ runner (Redis)', () => {
  let bull: BullMQRunner;
  let worker: ReturnType<typeof startWorker>;
  afterAll(async () => {
    delete providerOverrides.text;
    setRunner(inline as InlineRunner);
    await worker?.close();
    await bull?.close();
  });

  it('retries a transient failure through the queue with backoff', async (ctx) => {
    if (!redisUp) ctx.skip();
    bull = new BullMQRunner();
    worker = startWorker(1);
    setRunner(bull);
    const mock = new MockTextProvider(1);
    providerOverrides.text = () => mock;
    providerOverrides.retry = { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 }; // no in-call retry: exercise queue-level retry
    const { agent } = await signUp('Bull');
    const p = await agent.post('/api/projects').set(H).send(briefBody());
    const job = await agent.post(`/api/projects/${p.body.id}/generate`).set(H).send({ settings: { outline: true, content: false, interior: false, coverConcept: false, titleSuggestions: true, metadata: false, similarity: false, validate: false } });
    let status = '';
    for (let i = 0; i < 150; i++) {
      status = (await prisma.generationJob.findUniqueOrThrow({ where: { id: job.body.id } })).status;
      if (status === 'SUCCEEDED' || status === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const final = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.body.id } });
    providerOverrides.retry = { attempts: 3, baseDelayMs: 5, maxDelayMs: 20 };
    expect(final.status).toBe('SUCCEEDED');
    expect(final.attempts).toBe(2);
    expect(JSON.stringify(final.logs)).toMatch(/retrying in/);
  });
});
