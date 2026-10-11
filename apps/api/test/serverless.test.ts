import { afterAll, describe, expect, it } from 'vitest';
import { InlineRunner, kickStaleJobs, ServerlessRunner, setRunner } from '../src/jobs/runner';
import { internalJobToken } from '../src/lib/origin';
import { DbStorage } from '../src/lib/storage';
import { ensureCatalog } from '../src/services/image-catalog';
import { loadConfig } from '../src/config';
import { app, briefBody, H, prisma, signUp, type Agent } from './helpers';
import request from 'supertest';

/** Vercel runtime pieces: time-sliced jobs that pause and continue, the lease, DB file storage. */
const settings = { outline: true, content: true, interior: true, coverConcept: false, titleSuggestions: true, metadata: true, similarity: true, validate: true };

async function waitDone(agent: Agent, id: string, runner: ServerlessRunner) {
  for (let i = 0; i < 200; i++) {
    await runner.drain();
    const j = (await agent.get(`/api/jobs/${id}`)).body;
    if (!['QUEUED', 'RUNNING'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}

afterAll(() => {
  loadConfig();
  setRunner(new InlineRunner(10));
});

describe('serverless job runner', () => {
  it('pauses at safe points when the slice is used up and finishes without repeating stages or burning attempts', async () => {
    loadConfig({ JOB_RUNNER: 'serverless' });
    const runner = new ServerlessRunner(1, 10, 'local'); // 1 ms slices: pause after every stage
    setRunner(runner);
    const { agent } = await signUp('Slicer');
    const p = await agent.post('/api/projects').set(H).send(briefBody());
    const job = await agent.post(`/api/projects/${p.body.id}/generate`).set(H).send({ settings });
    const done = await waitDone(agent, job.body.id, runner);
    expect(done.status).toBe('SUCCEEDED');
    const pauses = done.logs.filter((l: { message: string }) => l.message.startsWith('Paused at a safe point')).length;
    expect(pauses).toBeGreaterThanOrEqual(3);
    // Each stage ran exactly once.
    const started = done.logs.filter((l: { message: string }) => /^Stage ".*" started\.$/.test(l.message)).map((l: { message: string }) => l.message);
    expect(new Set(started).size).toBe(started.length);
    expect(done.attempts).toBe(1);
    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.body.id } });
    expect(row.lockedUntil).toBeNull();
  });

  it('a coloring batch paused between pages generates each page exactly once', async () => {
    loadConfig({ JOB_RUNNER: 'serverless' });
    const runner = new ServerlessRunner(1, 10, 'local');
    setRunner(runner);
    await ensureCatalog();
    const mock = await prisma.imageModel.findUniqueOrThrow({ where: { endpointId: 'mock/line-art' } });
    const { agent } = await signUp('Slice Colorist');
    const b = await agent.post('/api/coloring').set(H).send({ title: 'Sliced', author: 'A', audience: 'KIDS', theme: 'farm', illustrationTarget: 4, concepts: ['cow', 'pig', 'hen', 'goat'] });
    const ids = b.body.pages.map((p: { id: string }) => p.id);
    const g = await agent.post(`/api/coloring/${b.body.id}/generate`).set(H).send({ pageIds: ids, modelId: mock.id, confirmation: { acceptedTotalUsd: 0 } });
    const done = await waitDone(agent, g.body.jobId, runner);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.logs.filter((l: { message: string }) => l.message.startsWith('Paused at a safe point')).length).toBeGreaterThanOrEqual(2);
    const pages = (await agent.get(`/api/coloring/${b.body.id}`)).body.pages;
    for (const p of pages) {
      expect(p.status).toBe('NEEDS_REVIEW');
      expect(p.versions).toHaveLength(1);
    }
    expect(await prisma.imageGeneration.count({ where: { jobId: g.body.jobId } })).toBe(4);
  });

  it('a lease prevents two invocations from processing the same job; an expired lease is resumed by a status poll', async () => {
    loadConfig({ JOB_RUNNER: 'serverless' });
    const runner = new ServerlessRunner(60_000, 10, 'local');
    setRunner(runner);
    const { agent, workspaceId } = await signUp('Lease');
    const p = await agent.post('/api/projects').set(H).send(briefBody());
    // Simulate an invocation that was killed mid-job: RUNNING with a lease that is still valid.
    const j = await prisma.generationJob.create({ data: { workspaceId, projectId: p.body.id, type: 'VALIDATE', input: {}, status: 'RUNNING', lockedUntil: new Date(Date.now() + 60_000) } });
    await runner.runSlice(j.id);
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('RUNNING'); // not claimed
    await kickStaleJobs(workspaceId);
    await runner.drain();
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('RUNNING');
    // Lease expires → the next poll resumes it.
    await prisma.generationJob.update({ where: { id: j.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await agent.get(`/api/jobs/${j.id}`);
    await runner.drain();
    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(after.status).toBe('SUCCEEDED');
    expect(after.lockedUntil).toBeNull();
  });

  it('the internal continuation endpoint requires the per-job token', async () => {
    loadConfig({ JOB_RUNNER: 'serverless' });
    const runner = new ServerlessRunner(60_000, 10, 'local');
    setRunner(runner);
    const { workspaceId } = await signUp('Token');
    const j = await prisma.generationJob.create({ data: { workspaceId, type: 'VALIDATE', input: {}, status: 'CANCELLED' } });
    expect((await request(app).post(`/api/internal/jobs/${j.id}/continue`).set(H).set('x-kdp-job-token', 'x'.repeat(64))).status).toBe(403);
    expect((await request(app).post(`/api/internal/jobs/${j.id}/continue`).set(H)).status).toBe(403);
    expect((await request(app).post(`/api/internal/jobs/${j.id}/continue`).set(H).set('x-kdp-job-token', internalJobToken(j.id))).status).toBe(202);
    await runner.drain();
  });

  it('cron endpoint refuses requests without the cron secret', async () => {
    expect((await request(app).get('/api/internal/cron/catalog')).status).toBe(403);
  });
});

describe('database file storage', () => {
  it('stores, reads, overwrites and deletes bytes; rejects unsafe keys', async () => {
    const s = new DbStorage();
    const key = `ws/test/${Date.now()}/a.png`;
    await s.put(key, new Uint8Array([1, 2, 3]), 'image/png');
    expect([...(await s.get(key))]).toEqual([1, 2, 3]);
    await s.put(key, new Uint8Array([9]), 'image/png');
    expect([...(await s.get(key))]).toEqual([9]);
    await s.delete(key);
    await expect(s.get(key)).rejects.toThrow(/not found/);
    await expect(s.put('../etc/passwd', new Uint8Array([1]), 'text/plain')).rejects.toThrow(/Unsafe/);
  });
});
