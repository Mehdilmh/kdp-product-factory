import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { defineRoute, IdParams } from '../lib/route';
import { kickStaleJobs } from '../jobs/runner';
import { cancelJob, getJob, retryJob } from '../services/jobs';

export const jobRouter = Router();

defineRoute(jobRouter, { method: 'get', path: '/jobs', summary: 'List generation jobs', tag: 'Jobs', query: z.object({ status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']).optional(), projectId: z.string().optional(), take: z.coerce.number().int().min(1).max(200).default(50) }) }, async ({ ws, query }) => {
  await kickStaleJobs(ws.workspaceId);
  return prisma.generationJob.findMany({
    where: { workspaceId: ws.workspaceId, status: query.status, projectId: query.projectId },
    orderBy: { createdAt: 'desc' },
    take: query.take,
    select: { id: true, type: true, status: true, stage: true, progress: true, attempts: true, maxAttempts: true, error: true, projectId: true, batchItemId: true, createdAt: true, startedAt: true, finishedAt: true, cancelRequested: true, project: { select: { title: true } } },
  });
});

defineRoute(jobRouter, { method: 'get', path: '/jobs/:id', summary: 'Job detail with logs and stage results', tag: 'Jobs', params: IdParams }, async ({ ws, params }) => {
  await kickStaleJobs(ws.workspaceId);
  return getJob(ws.workspaceId, params.id);
});

defineRoute(jobRouter, { method: 'post', path: '/jobs/:id/cancel', summary: 'Cancel a job (queued: immediately; running: at the next safe point)', tag: 'Jobs', params: IdParams }, async ({ ws, params, req }) => {
  const j = await cancelJob(ws.workspaceId, params.id);
  await audit(req, 'job.cancel', 'GenerationJob', j.id);
  return j;
});

defineRoute(jobRouter, { method: 'post', path: '/jobs/:id/retry', summary: 'Retry a failed or cancelled job (resumes after completed stages)', tag: 'Jobs', params: IdParams }, async ({ ws, params, req }) => {
  const j = await retryJob(ws.workspaceId, params.id);
  await audit(req, 'job.retry', 'GenerationJob', j.id);
  return j;
});
