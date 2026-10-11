import type { GenerationJob, Prisma, Project, ProjectStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { withTimeout } from '../providers/retry';
import { ProviderError } from '../providers/types';
import { runBatchItem } from '../services/batch';
import { runImageJob } from '../services/image-jobs';
import { runColoringJob } from '../services/coloring';
import { buildAndValidate } from '../services/build';
import { createExport, ExportKind } from '../services/exports';
import { stageContent, stageCover, stageInterior, stageMetadata, stageResearch, type GenCtx } from '../services/generation';
import { advanceStatus } from '../services/projects';
import { GenerationSettings } from '../services/schemas';

export const JOB_TYPES = ['GENERATE', 'VALIDATE', 'EXPORT', 'BATCH_ITEM', 'IMAGE_GENERATE', 'MODEL_COMPARE', 'COLORING_GENERATE'] as const;
export const JobType = z.enum(JOB_TYPES);

export class CancelledError extends Error {}

export interface StageDef {
  name: string;
  status?: ProjectStatus;
  run: (ctx: GenCtx) => Promise<unknown>;
}

export async function appendLog(jobId: string, message: string, level: 'info' | 'warn' | 'error' = 'info') {
  const job = await prisma.generationJob.findUnique({ where: { id: jobId }, select: { logs: true } });
  const logs = ((job?.logs as unknown[]) ?? []).slice(-499);
  logs.push({ at: new Date().toISOString(), level, message: message.slice(0, 2000) });
  await prisma.generationJob.update({ where: { id: jobId }, data: { logs: logs as Prisma.InputJsonValue } });
}

/** The ordered stages for a generation job, honouring the wizard's generation settings. */
export function generationStages(settings: z.infer<typeof GenerationSettings>): StageDef[] {
  const s: StageDef[] = [];
  if (settings.outline || settings.titleSuggestions) s.push({ name: 'research', status: 'RESEARCH', run: stageResearch });
  if (settings.content) s.push({ name: 'content', status: 'CONTENT', run: stageContent });
  if (settings.interior) s.push({ name: 'interior', status: 'INTERIOR', run: stageInterior });
  if (settings.metadata) s.push({ name: 'metadata', run: stageMetadata });
  if (settings.coverConcept) s.push({ name: 'cover', status: 'COVER', run: (ctx) => stageCover(ctx, { useImage: true }) });
  if (settings.similarity || settings.validate) s.push({ name: 'validation', status: 'VALIDATION', run: validateStage });
  return s;
}

async function validateStage(ctx: GenCtx) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: ctx.project.id } });
  const { build, reportId } = await buildAndValidate(project);
  ctx.log?.(`Preflight: ${JSON.stringify(build.preflight.summary)}; blocked=${build.preflight.blocked}.`);
  if (!build.preflight.blocked) await advanceStatus(project.id, 'READY_FOR_REVIEW');
  return { reportId, blocked: build.preflight.blocked, summary: build.preflight.summary };
}

async function isCancelled(jobId: string) {
  const j = await prisma.generationJob.findUnique({ where: { id: jobId }, select: { cancelRequested: true } });
  return !!j?.cancelRequested;
}

/** Whether a failure should be retried by the runner. */
export function isRetryable(e: unknown) {
  return e instanceof ProviderError && e.retryable;
}

/**
 * Executes one attempt of a job. Throws on failure; the runner decides whether to retry.
 * Stages already completed in a previous attempt are skipped (resume after retry).
 */
export async function processJob(jobId: string): Promise<void> {
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
  if (job.status === 'CANCELLED' || job.status === 'SUCCEEDED') return;
  if (job.cancelRequested) {
    await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'CANCELLED', finishedAt: new Date(), stage: 'cancelled' } });
    return;
  }
  await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: job.startedAt ?? new Date(), attempts: { increment: 1 }, error: null } });
  await appendLog(jobId, `Attempt ${job.attempts + 1}/${job.maxAttempts} started.`);
  const ctrl = new AbortController();
  const result = ((job.result as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const save = (data: Prisma.GenerationJobUpdateInput) => prisma.generationJob.update({ where: { id: jobId }, data });

  const runStages = async (project: Project, stages: StageDef[]) => {
    const done = new Set((result.completedStages as string[]) ?? []);
    for (const [i, st] of stages.entries()) {
      if (done.has(st.name)) continue;
      if (await isCancelled(jobId)) throw new CancelledError('Cancelled by user');
      await save({ stage: st.name, progress: Math.round((i / stages.length) * 100) });
      await appendLog(jobId, `Stage "${st.name}" started.`);
      if (st.status) await advanceStatus(project.id, st.status);
      const ctx: GenCtx = { project, workspaceId: project.workspaceId, projectId: project.id, jobId, operation: st.name, signal: ctrl.signal, log: (m) => void appendLog(jobId, m) };
      const out = await withTimeout(() => st.run(ctx), job.timeoutMs, `stage ${st.name}`, ctrl.signal);
      result[st.name] = out ?? null;
      done.add(st.name);
      result.completedStages = [...done];
      await save({ result: result as Prisma.InputJsonValue });
      await appendLog(jobId, `Stage "${st.name}" completed.`);
    }
  };

  try {
    const input = job.input as Record<string, unknown>;
    switch (job.type) {
      case 'GENERATE': {
        const project = await prisma.project.findUniqueOrThrow({ where: { id: job.projectId! } });
        await runStages(project, generationStages(GenerationSettings.parse(input.settings ?? {})));
        break;
      }
      case 'VALIDATE': {
        const project = await prisma.project.findUniqueOrThrow({ where: { id: job.projectId! } });
        await runStages(project, [{ name: 'validation', status: 'VALIDATION', run: validateStage }]);
        break;
      }
      case 'EXPORT': {
        const project = await prisma.project.findUniqueOrThrow({ where: { id: job.projectId! } });
        const kinds = z.array(ExportKind).parse(input.kinds);
        await save({ stage: 'export', progress: 10 });
        const r = await createExport(project, kinds, (m) => void appendLog(jobId, m));
        result.export = r;
        await save({ result: result as Prisma.InputJsonValue });
        break;
      }
      case 'IMAGE_GENERATE':
      case 'MODEL_COMPARE':
        await save({ stage: 'images' });
        await runImageJob(job, () => isCancelled(jobId), (m) => void appendLog(jobId, m), ctrl.signal);
        if (await isCancelled(jobId)) throw new CancelledError('Cancelled by user');
        break;
      case 'COLORING_GENERATE':
        await save({ stage: 'coloring-pages' });
        await runColoringJob(job, () => isCancelled(jobId), (m) => void appendLog(jobId, m), ctrl.signal);
        if (await isCancelled(jobId)) throw new CancelledError('Cancelled by user');
        break;
      case 'BATCH_ITEM':
        await runBatchItem(job, (project, stages) => runStages(project, stages), (m) => appendLog(jobId, m));
        break;
      default:
        throw new Error(`Unknown job type ${job.type}`);
    }
    await save({ status: 'SUCCEEDED', stage: 'done', progress: 100, finishedAt: new Date() });
    await appendLog(jobId, 'Job completed.');
  } catch (e) {
    ctrl.abort();
    if (e instanceof CancelledError) {
      await save({ status: 'CANCELLED', stage: 'cancelled', finishedAt: new Date() });
      await appendLog(jobId, 'Job cancelled at a safe point.', 'warn');
      return;
    }
    const message = formatJobError(e);
    await appendLog(jobId, `Stage failed: ${message}`, 'error');
    await save({ error: message.slice(0, 2000) });
    throw e;
  }
}

export function formatJobError(e: unknown): string {
  if (e instanceof HttpError) return `${e.message}${e.details ? ' ' + JSON.stringify(e.details) : ''}`.slice(0, 2000);
  return ((e as Error)?.message ?? String(e)).slice(0, 2000);
}

/** Called by runners when an attempt failed and no retry will follow. */
export async function markFailed(jobId: string, e: unknown) {
  await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'FAILED', finishedAt: new Date(), error: formatJobError(e) } });
  await appendLog(jobId, 'Job failed; no further automatic retries. Use Retry to run it again.', 'error');
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (job?.batchItemId) await prisma.batchItem.update({ where: { id: job.batchItemId }, data: { status: 'FAILED', error: job.error } });
}

export async function markRetrying(jobId: string, e: unknown, delayMs: number) {
  await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'QUEUED', stage: 'retry-wait' } });
  await appendLog(jobId, `Transient failure (${(e as Error).message}); retrying in ${Math.round(delayMs / 1000)}s.`, 'warn');
}

export type { GenerationJob };
