import type { GenerationJob, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { ProviderError } from '../providers/types';
import { Confirmation, NormalizedRequestSchema, runGeneration } from './image-generation';

export const ImageJobItem = z.object({
  key: z.string().max(80),
  modelId: z.string().max(64),
  request: NormalizedRequestSchema,
  confirmation: Confirmation,
});
export const ImageJobInput = z.object({
  purpose: z.enum(['COVER_ART', 'COMPARISON', 'COLORING_PAGE', 'UPSCALE', 'TEST']),
  userId: z.string().nullable().optional(),
  comparisonId: z.string().nullable().optional(),
  assetKind: z.string().optional(),
  items: z.array(ImageJobItem).min(1).max(100),
});
export type ImageJobInput = z.infer<typeof ImageJobInput>;

interface ItemState {
  generationId?: string;
  status: 'SUCCEEDED' | 'FAILED';
  error?: string;
  retryable?: boolean;
}

/**
 * Runs each item of an image job. Items that already succeeded are skipped on retry and items
 * with a stored provider request id are resumed (not resubmitted), so a retry never pays twice
 * for completed work. One item failing does not discard the others.
 */
export async function runImageJob(job: GenerationJob, isCancelled: () => Promise<boolean>, log: (m: string) => void, signal: AbortSignal) {
  const input = ImageJobInput.parse(job.input);
  const result = ((job.result as Record<string, unknown>) ?? {}) as { items?: Record<string, ItemState> };
  const items: Record<string, ItemState> = result.items ?? {};
  const save = (progress: number) => prisma.generationJob.update({ where: { id: job.id }, data: { result: { ...result, items } as unknown as Prisma.InputJsonValue, progress } });
  let retryable: Error | null = null;

  for (const [i, it] of input.items.entries()) {
    const prev = items[it.key];
    if (prev?.status === 'SUCCEEDED') continue;
    if (prev?.status === 'FAILED' && !prev.retryable) continue;
    if (await isCancelled()) break;
    // Re-use the generation row created by an earlier attempt (keeps its provider request id).
    const existing = prev?.generationId ?? (await prisma.imageGeneration.findFirst({ where: { jobId: job.id, workspaceId: job.workspaceId, settings: { path: ['__key'], equals: it.key } }, select: { id: true } }))?.id;
    try {
      const g = await runGeneration({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        userId: input.userId ?? job.createdById,
        jobId: job.id,
        comparisonId: input.comparisonId ?? null,
        purpose: input.purpose,
        modelId: it.modelId,
        request: { ...it.request, extra: it.request.extra },
        confirmation: it.confirmation,
        generationId: existing ?? null,
        signal,
        log,
        assetKind: input.assetKind,
        generationKey: it.key,
      });
      items[it.key] = { generationId: g.id, status: 'SUCCEEDED' };
      log(`Item ${it.key}: done (${g.assetIds.length} image(s)).`);
    } catch (e) {
      const err = e as Error;
      const isRetry = err instanceof ProviderError && err.retryable;
      const gen = await prisma.imageGeneration.findFirst({ where: { jobId: job.id, settings: { path: ['__key'], equals: it.key } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      items[it.key] = { generationId: gen?.id, status: 'FAILED', error: err instanceof HttpError ? err.message : err.message.slice(0, 500), retryable: isRetry };
      log(`Item ${it.key} failed: ${err.message}`);
      if (isRetry) retryable = err;
    }
    await save(Math.round(((i + 1) / input.items.length) * 100));
  }

  if (input.comparisonId) {
    const states = Object.values(items);
    await prisma.modelComparison.update({ where: { id: input.comparisonId }, data: { status: states.length && states.every((s) => s.status === 'SUCCEEDED') ? 'COMPLETED' : states.some((s) => s.status === 'SUCCEEDED') ? 'PARTIAL' : 'FAILED' } });
  }
  if (retryable) throw retryable; // runner retries; finished items are preserved
  const failed = Object.values(items).filter((s) => s.status === 'FAILED');
  if (failed.length === input.items.length) throw new Error(`All ${failed.length} image request(s) failed: ${failed[0]?.error ?? 'unknown error'}`);
}
