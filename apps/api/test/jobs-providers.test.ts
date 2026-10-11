import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { GeminiTextProvider } from '../src/providers/gemini';
import { FalImageProvider } from '../src/providers/fal';
import { providerOverrides } from '../src/providers/gateway';
import { MockTextProvider } from '../src/providers/mock';
import { OpenAICompatibleTextProvider } from '../src/providers/openai-compatible';
import { withRetry, withTimeout } from '../src/providers/retry';
import { ProviderError, type FetchLike } from '../src/providers/types';
import { briefBody, H, prisma, signUp, waitForJob } from './helpers';

const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('provider adapters', () => {
  it('Gemini: parses text + usage, sends the key in a header, never in the URL', async () => {
    let seenUrl = '';
    let seenKey = '';
    const f: FetchLike = async (url, init) => {
      seenUrl = url;
      seenKey = (init?.headers as Record<string, string>)['x-goog-api-key'];
      return json(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 } });
    };
    const r = await new GeminiTextProvider('secret-key', 'gemini-2.5-flash', f).generate({ system: 's', prompt: 'p', json: true });
    expect(r).toMatchObject({ text: '{"ok":true}', inputTokens: 12, outputTokens: 5 });
    expect(seenUrl).not.toContain('secret-key');
    expect(seenKey).toBe('secret-key');
  });

  it('classifies 429/5xx as retryable and 4xx as permanent, redacting keys', async () => {
    const mk = (status: number) => new GeminiTextProvider('k', 'm', async () => json(status, 'error for key=abc123'));
    await expect(mk(429).generate({ system: '', prompt: '', json: false })).rejects.toMatchObject({ retryable: true, status: 429 });
    await expect(mk(503).generate({ system: '', prompt: '', json: false })).rejects.toMatchObject({ retryable: true });
    const e = await mk(400).generate({ system: '', prompt: '', json: false }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.retryable).toBe(false);
    expect(e.message).not.toContain('abc123');
  });

  it('treats network errors as retryable and safety blocks as permanent', async () => {
    const net = new OpenAICompatibleTextProvider('k', 'm', 'https://x', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(net.generate({ system: '', prompt: '', json: false })).rejects.toMatchObject({ retryable: true });
    const blocked = new GeminiTextProvider('k', 'm', async () => json(200, { promptFeedback: { blockReason: 'SAFETY' } }));
    await expect(blocked.generate({ system: '', prompt: '', json: false })).rejects.toMatchObject({ retryable: false });
  });

  it('fal.ai: downloads the generated image and validates it is PNG/JPEG', async () => {
    const png = Buffer.concat([Buffer.from('89504E470D0A1A0A0000000D49484452000000400000002008060000', 'hex'), Buffer.alloc(30)]);
    const f: FetchLike = async (url) => (url.startsWith('https://fal.run') ? json(200, { images: [{ url: 'https://cdn.fal.media/x.png' }] }) : new Response(png, { status: 200 }));
    const r = await new FalImageProvider('k', 'fal-ai/flux/schnell', f).generate({ prompt: 'x', widthPx: 64, heightPx: 32 });
    expect(r.mimeType).toBe('image/png');
    const bad = new FalImageProvider('k', 'm', async (url) => (url.startsWith('https://fal.run') ? json(200, { images: [{ url: 'https://cdn/x' }] }) : new Response('<html>', { status: 200 })));
    await expect(bad.generate({ prompt: 'x', widthPx: 1, heightPx: 1 })).rejects.toMatchObject({ retryable: false });
  });

  it('withRetry retries transient errors with backoff and stops on permanent ones', async () => {
    let n = 0;
    const out = await withRetry(async () => {
      if (++n < 3) throw new ProviderError('flaky', 'x', true);
      return 'ok';
    }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
    expect(out).toBe('ok');
    expect(n).toBe(3);
    let m = 0;
    await expect(withRetry(async () => { m++; throw new ProviderError('bad key', 'x', false); }, { attempts: 5, baseDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow('bad key');
    expect(m).toBe(1);
    await expect(withTimeout(() => new Promise(() => {}), 20, 'slow')).rejects.toThrow(/timed out/);
  });
});

describe('generation jobs: retries, failure handling, cancellation, quotas', () => {
  afterEach(() => {
    delete providerOverrides.text;
  });

  it('retries a transient provider failure and completes the job', async () => {
    const mock = new MockTextProvider(2);
    providerOverrides.text = () => mock;
    const { agent } = await signUp('Retry');
    const p = await agent.post('/api/projects').set(H).send(briefBody());
    const job = await agent.post(`/api/projects/${p.body.id}/generate`).set(H).send({ settings: { outline: true, content: false, interior: false, coverConcept: false, titleSuggestions: true, metadata: false, similarity: false, validate: false } });
    expect(job.status).toBe(202);
    const done = await waitForJob(agent, job.body.id);
    expect(done.status).toBe('SUCCEEDED');
    expect(mock.calls).toBe(3);
    expect(done.logs.some((l) => /retrying/i.test(l.message))).toBe(true);
    const usage = await prisma.usageRecord.findMany({ where: { projectId: p.body.id } });
    expect(usage.filter((u) => u.success)).toHaveLength(1);
  });

  it('fails fast on a permanent provider error with a clear stage error, then can be retried', async () => {
    providerOverrides.text = () => new MockTextProvider(100, true);
    const { agent } = await signUp('Perm');
    const p = await agent.post('/api/projects').set(H).send(briefBody());
    const job = await agent.post(`/api/projects/${p.body.id}/generate`).set(H).send({ settings: { outline: true, content: false, interior: false, coverConcept: false, titleSuggestions: false, metadata: false, similarity: false, validate: false } });
    const failed = await waitForJob(agent, job.body.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.attempts).toBe(1);
    expect(failed.error).toMatch(/mock transient failure/);
    expect(failed.logs.some((l) => l.message.includes('Stage failed'))).toBe(true);

    providerOverrides.text = () => new MockTextProvider();
    const retried = await agent.post(`/api/jobs/${job.body.id}/retry`).set(H);
    expect(retried.status).toBe(200);
    expect((await waitForJob(agent, job.body.id)).status).toBe('SUCCEEDED');
  });

  it('resumes after completed stages on retry', async () => {
    let calls = 0;
    providerOverrides.text = () => ({ id: 'mock', model: 'm', generate: async (req) => {
      calls++;
      if (req.task?.name === 'metadata') throw new ProviderError('boom', 'mock', false);
      return new MockTextProvider().generate(req);
    } });
    const { agent } = await signUp('Resume');
    const p = await agent.post('/api/projects').set(H).send(briefBody());
    const job = await agent.post(`/api/projects/${p.body.id}/generate`).set(H).send({ settings: { outline: true, content: false, interior: false, coverConcept: false, titleSuggestions: true, metadata: true, similarity: false, validate: false } });
    expect((await waitForJob(agent, job.body.id)).status).toBe('FAILED');
    const before = calls;
    providerOverrides.text = () => new MockTextProvider();
    await agent.post(`/api/jobs/${job.body.id}/retry`).set(H);
    const done = await waitForJob(agent, job.body.id);
    expect(done.status).toBe('SUCCEEDED');
    expect((done.result.completedStages as string[]).sort()).toEqual(['metadata', 'research']);
    expect(before).toBe(2); // research once, metadata once (permanent failure, no retry)
  });

  it('cancels a queued job and refuses to cancel finished ones', async () => {
    const { agent, workspaceId } = await signUp('Cancel');
    const p = await agent.post('/api/projects').set(H).send(briefBody());
    const j = await prisma.generationJob.create({ data: { workspaceId, projectId: p.body.id, type: 'VALIDATE', input: {} } });
    const c = await agent.post(`/api/jobs/${j.id}/cancel`).set(H);
    expect(c.body.status).toBe('CANCELLED');
    expect((await agent.post(`/api/jobs/${j.id}/cancel`).set(H)).status).toBe(409);
  });

  it('cancels a running job at the next safe point', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    providerOverrides.text = () => ({ id: 'mock', model: 'm', generate: async (req) => {
      await gate;
      return new MockTextProvider().generate(req);
    } });
    const { agent } = await signUp('CancelRun');
    const p = await agent.post('/api/projects').set(H).send(briefBody());
    const job = await agent.post(`/api/projects/${p.body.id}/generate`).set(H).send({ settings: { outline: true, content: false, interior: false, coverConcept: false, titleSuggestions: true, metadata: true, similarity: false, validate: false } });
    for (let i = 0; i < 50 && (await prisma.generationJob.findUniqueOrThrow({ where: { id: job.body.id } })).status !== 'RUNNING'; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await agent.post(`/api/jobs/${job.body.id}/cancel`).set(H)).status).toBe(200);
    release();
    const done = await waitForJob(agent, job.body.id);
    expect(done.status).toBe('CANCELLED');
    expect((done.result.completedStages as string[])).toEqual(['research']);
  });

  it('enforces daily cost and job quotas', async () => {
    const { agent, workspaceId } = await signUp('Quota');
    const p = await agent.post('/api/projects').set(H).send(briefBody());
    await prisma.usageRecord.create({ data: { workspaceId, provider: 'gemini', model: 'm', kind: 'TEXT', operation: 'x', estimatedCostUsd: new Prisma.Decimal(6) } });
    const r = await agent.post(`/api/projects/${p.body.id}/generate`).set(H).send({});
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('QUOTA_DAILY');
    await prisma.workspace.update({ where: { id: workspaceId }, data: { dailyJobLimit: 1, dailyCostLimitUsd: new Prisma.Decimal(1000), monthlyCostLimitUsd: new Prisma.Decimal(1000) } });
    expect((await agent.post(`/api/projects/${p.body.id}/validate`).set(H)).status).toBe(202);
    const second = await agent.post(`/api/projects/${p.body.id}/validate`).set(H);
    expect([409, 429]).toContain(second.status);
    const usage = await agent.get('/api/usage');
    expect(usage.body.totals.dayUsd).toBeCloseTo(6, 4);
    expect(usage.body.note).toMatch(/estimates/);
  });
});
