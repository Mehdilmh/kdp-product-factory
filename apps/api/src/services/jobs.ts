import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { conflict, HttpError, notFound } from '../lib/errors';
import { getRunner } from '../jobs/runner';
import { assertWithinQuota } from '../providers/gateway';

export async function assertDailyJobLimit(workspaceId: string) {
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const since = new Date(Date.now() - 86400_000);
  const n = await prisma.generationJob.count({ where: { workspaceId, createdAt: { gte: since } } });
  if (n >= ws.dailyJobLimit) throw new HttpError(429, 'QUOTA_JOBS', `Daily job limit of ${ws.dailyJobLimit} reached. Adjust it in Settings → Usage limits.`);
}

export async function createJob(opts: { workspaceId: string; projectId?: string | null; batchItemId?: string | null; type: string; input: Prisma.InputJsonValue; userId?: string | null; maxAttempts?: number; usesAi?: boolean; exclusive?: boolean }) {
  await assertDailyJobLimit(opts.workspaceId);
  if (opts.usesAi) await assertWithinQuota(opts.workspaceId);
  if (opts.projectId && opts.exclusive !== false) {
    const active = await prisma.generationJob.findFirst({ where: { projectId: opts.projectId, status: { in: ['QUEUED', 'RUNNING'] }, type: opts.type } });
    if (active) throw conflict(`A ${opts.type.toLowerCase()} job is already in progress for this project.`, { jobId: active.id });
  }
  const job = await prisma.generationJob.create({
    data: { workspaceId: opts.workspaceId, projectId: opts.projectId ?? null, batchItemId: opts.batchItemId ?? null, type: opts.type, input: opts.input, createdById: opts.userId ?? null, maxAttempts: opts.maxAttempts ?? 3 },
  });
  await getRunner().enqueue(job.id);
  return job;
}

export async function getJob(workspaceId: string, id: string) {
  const job = await prisma.generationJob.findFirst({ where: { id, workspaceId } });
  if (!job) throw notFound('Job');
  return job;
}

export async function cancelJob(workspaceId: string, id: string) {
  const job = await getJob(workspaceId, id);
  if (job.status === 'QUEUED') return prisma.generationJob.update({ where: { id }, data: { status: 'CANCELLED', cancelRequested: true, finishedAt: new Date(), stage: 'cancelled' } });
  if (job.status === 'RUNNING') {
    if (job.type === 'EXPORT') throw conflict('Exports cannot be cancelled while files are being written.');
    // Running jobs stop at the next stage boundary (a safe point).
    return prisma.generationJob.update({ where: { id }, data: { cancelRequested: true } });
  }
  throw conflict(`Job is already ${job.status.toLowerCase()}.`);
}

export async function retryJob(workspaceId: string, id: string) {
  const job = await getJob(workspaceId, id);
  if (job.status !== 'FAILED' && job.status !== 'CANCELLED') throw conflict('Only failed or cancelled jobs can be retried.');
  await assertDailyJobLimit(workspaceId);
  // Completed stages are kept in job.result and skipped on resume.
  const updated = await prisma.generationJob.update({ where: { id }, data: { status: 'QUEUED', cancelRequested: false, error: null, finishedAt: null, maxAttempts: job.attempts + 3, stage: 'queued' } });
  if (updated.batchItemId) await prisma.batchItem.update({ where: { id: updated.batchItemId }, data: { status: 'QUEUED', error: null } });
  await getRunner().enqueue(id);
  return updated;
}
