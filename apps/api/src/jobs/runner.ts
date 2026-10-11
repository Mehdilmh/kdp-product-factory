import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { config } from '../config';
import { prisma } from '../db';
import { waitUntil } from '@vercel/functions';
import { appOrigin, internalJobToken } from '../lib/origin';
import { isRetryable, markFailed, markRetrying, processJob, YieldError } from './processor';

export interface JobRunner {
  enqueue(jobId: string): Promise<void>;
  close(): Promise<void>;
}

const QUEUE = 'kdp-jobs';
export const BACKOFF_MS = 5000;

export function redisConnection() {
  const u = new URL(config().REDIS_URL);
  return { host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined, db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0, maxRetriesPerRequest: null };
}

/** Production runner: BullMQ queue; a separate worker process executes jobs (see worker.ts). */
export class BullMQRunner implements JobRunner {
  private queue = new Queue(QUEUE, { connection: redisConnection() });
  async enqueue(jobId: string) {
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    await this.queue.add(job.type, { jobId }, { jobId: `${jobId}-${job.attempts}`, attempts: job.maxAttempts - job.attempts, backoff: { type: 'exponential', delay: BACKOFF_MS }, removeOnComplete: 1000, removeOnFail: 1000 });
  }
  async close() {
    await this.queue.close();
  }
}

export function startWorker(concurrency = 2) {
  const worker = new Worker(
    QUEUE,
    async (job: Job<{ jobId: string }>) => {
      try {
        await processJob(job.data.jobId);
      } catch (e) {
        const remaining = (job.opts.attempts ?? 1) - job.attemptsMade - 1;
        if (isRetryable(e) && remaining > 0) {
          await markRetrying(job.data.jobId, e, BACKOFF_MS * 2 ** job.attemptsMade);
          throw e; // BullMQ schedules the retry with backoff
        }
        await markFailed(job.data.jobId, e);
        // Non-retryable: tell BullMQ not to retry.
        throw new UnrecoverableError((e as Error).message);
      }
    },
    { connection: redisConnection(), concurrency, lockDuration: 10 * 60_000 },
  );
  return worker;
}

/** In-process runner for tests and single-process development. Same retry semantics. */
export class InlineRunner implements JobRunner {
  private running = new Set<Promise<void>>();
  constructor(private backoffMs = 50) {}
  async enqueue(jobId: string) {
    const p = this.run(jobId).finally(() => this.running.delete(p));
    this.running.add(p);
  }
  private async run(jobId: string) {
    await new Promise((r) => setImmediate(r));
    for (;;) {
      const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
      if (!job) return;
      try {
        await processJob(jobId);
        return;
      } catch (e) {
        const fresh = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
        if (isRetryable(e) && fresh.attempts < fresh.maxAttempts) {
          const delay = this.backoffMs * 2 ** (fresh.attempts - 1);
          await markRetrying(jobId, e, delay);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        await markFailed(jobId, e);
        return;
      }
    }
  }
  /** Test helper: wait for all in-flight jobs. */
  async drain() {
    while (this.running.size) await Promise.all([...this.running]);
  }
  async close() {
    await this.drain();
  }
}

/**
 * Serverless runner (Vercel). Each invocation works on a job for at most JOB_SLICE_SECONDS, holding
 * a lease (lockedUntil) so two invocations never process the same job. At the next safe point after
 * the slice it pauses (finished stages/items/pages are saved) and asks a fresh invocation to
 * continue. If a continuation is lost (or an invocation is killed), the lease expires and the next
 * status poll restarts the job — see kickStaleJobs().
 */
export class ServerlessRunner implements JobRunner {
  private running = new Set<Promise<void>>();
  /** `continuation: 'local'` continues in this process (tests, or when no public origin is known). */
  constructor(private sliceMs = config().JOB_SLICE_SECONDS * 1000, private backoffMs = BACKOFF_MS, private continuation: 'http' | 'local' = 'http') {}
  async enqueue(jobId: string) {
    const p = this.runSlice(jobId).catch((e) => console.error(`[jobs] slice for ${jobId} crashed:`, e));
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
    waitUntil(p);
  }
  private release(jobId: string) {
    return prisma.generationJob.update({ where: { id: jobId }, data: { lockedUntil: null } }).catch(() => undefined);
  }
  async runSlice(jobId: string) {
    const now = new Date();
    const claimed = await prisma.generationJob.updateMany({
      where: { id: jobId, status: { in: ['QUEUED', 'RUNNING'] }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedUntil: new Date(now.getTime() + this.sliceMs + 90_000) },
    });
    if (!claimed.count) return;
    try {
      await processJob(jobId, { deadline: Date.now() + this.sliceMs });
      await this.release(jobId);
    } catch (e) {
      if (e instanceof YieldError) {
        await this.release(jobId);
        await this.continueLater(jobId, 0);
        return;
      }
      const fresh = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
      if (isRetryable(e) && fresh.attempts < fresh.maxAttempts) {
        const delay = Math.min(this.backoffMs * 2 ** Math.max(0, fresh.attempts - 1), 15_000);
        await markRetrying(jobId, e, delay);
        await this.release(jobId);
        await this.continueLater(jobId, delay);
        return;
      }
      await markFailed(jobId, e);
      await this.release(jobId);
    }
  }
  /** Ask a fresh invocation to continue (falls back to this process when no public origin is known). */
  private async continueLater(jobId: string, delayMs: number) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const origin = this.continuation === 'http' ? appOrigin() : null;
    if (!origin) return void (await this.runSlice(jobId));
    try {
      const res = await fetch(`${origin}/api/internal/jobs/${encodeURIComponent(jobId)}/continue`, {
        method: 'POST',
        headers: { 'x-requested-with': 'kdp-factory', 'x-kdp-job-token': internalJobToken(jobId) },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) console.warn(`[jobs] continuation for ${jobId} returned HTTP ${res.status}; the next status poll will resume it.`);
    } catch (e) {
      console.warn(`[jobs] continuation for ${jobId} failed (${(e as Error).message}); the next status poll will resume it.`);
    }
  }
  async drain() {
    while (this.running.size) await Promise.all([...this.running]);
  }
  async close() {
    await this.drain();
  }
}

/** Serverless safety net: restart queued/running jobs whose lease expired (or that never started). */
export async function kickStaleJobs(workspaceId: string) {
  if (config().JOB_RUNNER !== 'serverless') return;
  const now = Date.now();
  const stale = await prisma.generationJob.findMany({
    where: {
      workspaceId,
      status: { in: ['QUEUED', 'RUNNING'] },
      OR: [{ lockedUntil: { lt: new Date(now) } }, { lockedUntil: null, createdAt: { lt: new Date(now - 20_000) } }],
    },
    select: { id: true, stage: true, logs: true },
    take: 5,
  });
  for (const j of stale) {
    // A job waiting out a retry backoff is not stale until its last log entry is older than 30s.
    const last = ((j.logs as { at: string }[]) ?? []).at(-1)?.at;
    if (j.stage === 'retry-wait' && last && now - Date.parse(last) < 30_000) continue;
    await getRunner().enqueue(j.id);
  }
}

let runner: JobRunner | null = null;
export function getRunner(): JobRunner {
  if (!runner) {
    const kind = config().JOB_RUNNER;
    runner = kind === 'inline' ? new InlineRunner(2000) : kind === 'serverless' ? new ServerlessRunner() : new BullMQRunner();
  }
  return runner;
}
export function setRunner(r: JobRunner) {
  runner = r;
}
