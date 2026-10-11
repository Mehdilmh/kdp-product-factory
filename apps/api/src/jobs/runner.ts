import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { config } from '../config';
import { prisma } from '../db';
import { isRetryable, markFailed, markRetrying, processJob } from './processor';

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

let runner: JobRunner | null = null;
export function getRunner(): JobRunner {
  if (!runner) runner = config().JOB_RUNNER === 'inline' ? new InlineRunner(2000) : new BullMQRunner();
  return runner;
}
export function setRunner(r: JobRunner) {
  runner = r;
}
