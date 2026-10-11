import { findSimilar, jaccard, tokens, titleSimilarity } from '@kdp/core';
import { Prisma, type GenerationJob, type Project } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { badRequest, conflict, notFound } from '../lib/errors';
import { estimateProductCost } from '../providers/gateway';
import type { StageDef } from '../jobs/processor';
import { createJob } from './jobs';
import { createProject } from './projects';
import { BriefInput, FormatInput, GenerationSettings } from './schemas';

export const BatchItemBrief = z.object({ brief: BriefInput, format: FormatInput, generation: GenerationSettings.default({}) });
export type BatchItemBrief = z.infer<typeof BatchItemBrief>;

export const QUALITY_CHECKLIST = [
  'interiorReviewed',
  'contentOriginalAndSpecific',
  'coverMatchesMetadata',
  'noBlockingPreflight',
  'humanReviewItemsResolved',
  'aiDisclosureAnswered',
] as const;
export const QualityChecklist = z.object(Object.fromEntries(QUALITY_CHECKLIST.map((k) => [k, z.literal(true)])) as Record<(typeof QUALITY_CHECKLIST)[number], z.ZodLiteral<true>>);

/** RFC 4180-ish CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export const CSV_COLUMNS = ['workingTitle', 'category', 'contentType', 'targetReader', 'readerProblem', 'niche', 'differentiation', 'authorName', 'format', 'trimId', 'ink', 'paper', 'bleed', 'pageCount', 'language', 'designTheme'] as const;

export function csvToBriefs(text: string): { items: BatchItemBrief[]; errors: { row: number; message: string }[] } {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw badRequest('CSV needs a header row and at least one product row.');
  const header = rows[0].map((h) => h.trim());
  const missing = ['workingTitle', 'category', 'contentType', 'targetReader', 'readerProblem', 'niche', 'differentiation', 'authorName', 'format'].filter((c) => !header.includes(c));
  if (missing.length) throw badRequest(`CSV is missing required columns: ${missing.join(', ')}`, { expected: CSV_COLUMNS });
  if (rows.length - 1 > 500) throw badRequest('A single CSV import is limited to 500 rows; split larger batches.');
  const items: BatchItemBrief[] = [];
  const errors: { row: number; message: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    const o = Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()]));
    const parsed = BatchItemBrief.safeParse({
      brief: { workingTitle: o.workingTitle, category: o.category, contentType: o.contentType, targetReader: o.targetReader, readerProblem: o.readerProblem, niche: o.niche, differentiation: o.differentiation, authorName: o.authorName, language: o.language || undefined, designTheme: o.designTheme || undefined },
      format: { format: o.format, trimId: o.trimId || undefined, ink: o.ink || undefined, paper: o.paper || undefined, bleed: /^(true|yes|1)$/i.test(o.bleed ?? ''), targetPageCount: o.pageCount ? Number(o.pageCount) : null },
    });
    if (parsed.success) items.push(parsed.data);
    else errors.push({ row: i + 2, message: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
  });
  return { items, errors };
}

/**
 * Differentiation check. Products that differ only by title/profession/colour/keyword are
 * flagged DUPLICATE and never generated.
 */
export function differentiation(item: BatchItemBrief, others: BatchItemBrief[], portfolioTitles: { projectId: string; title: string }[]) {
  const core = (b: BatchItemBrief) => new Set(tokens(`${b.brief.readerProblem} ${b.brief.differentiation} ${b.brief.contentType} ${b.brief.category}`, true));
  const mine = core(item);
  const notes: string[] = [];
  let worst = 0;
  let dupOf: string | null = null;
  others.forEach((o, i) => {
    const sim = jaccard(mine, core(o));
    const t = titleSimilarity(item.brief.workingTitle, o.brief.workingTitle);
    const score = Math.max(sim, (sim + t) / 2);
    if (score > worst) worst = score;
    if (sim >= 0.8) {
      notes.push(`Brief is ${Math.round(sim * 100)}% identical to batch row ${i + 1} ("${o.brief.workingTitle}") apart from title/audience words.`);
      dupOf = dupOf ?? `row:${i + 1}`;
    }
  });
  for (const m of findSimilar({ title: item.brief.workingTitle }, portfolioTitles.map((p) => ({ ...p, fingerprint: null })))) {
    notes.push(`Title is ${Math.round(m.score * 100)}% similar to existing project "${m.title}".`);
    worst = Math.max(worst, m.score);
  }
  const diffWords = new Set(tokens(item.brief.differentiation, true)).size;
  if (diffWords < 8) notes.push('Differentiation statement is too thin (fewer than 8 meaningful words).');
  const score = Math.max(0, Math.round((1 - worst) * 100) / 100);
  return { score, notes, duplicate: dupOf !== null || diffWords < 8, duplicateOf: dupOf };
}

export async function createBatch(workspaceId: string, userId: string, name: string, items: BatchItemBrief[], settings: { concurrency: number }) {
  if (!items.length) throw badRequest('A batch needs at least one product.');
  const portfolio = await prisma.project.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, title: true } });
  const perItem = await estimateProductCost(workspaceId, { chapters: 6, images: 1 });
  return prisma.batchJob.create({
    data: {
      workspaceId,
      name,
      createdById: userId,
      settings: settings as Prisma.InputJsonValue,
      items: {
        create: items.map((it, i) => {
          const d = differentiation(it, items.slice(0, i), portfolio.map((p) => ({ projectId: p.id, title: p.title })));
          return {
            position: i,
            brief: it as unknown as Prisma.InputJsonValue,
            status: d.duplicate ? 'DUPLICATE' : 'PENDING',
            differentiationScore: d.score,
            differentiationNotes: d.notes as Prisma.InputJsonValue,
            duplicateOfProjectId: d.duplicateOf,
            estimatedCostUsd: new Prisma.Decimal(perItem.toFixed(4)),
          };
        }),
      },
    },
    include: { items: true },
  });
}

export async function getBatch(workspaceId: string, id: string) {
  const b = await prisma.batchJob.findFirst({ where: { id, workspaceId }, include: { items: { orderBy: { position: 'asc' }, include: { jobs: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, stage: true, progress: true, error: true } } } } } });
  if (!b) throw notFound('Batch');
  return b;
}

/** Enqueue pending items up to the batch concurrency. Called on start/resume and after each item. */
export async function pumpBatch(batchId: string, userId: string | null) {
  const batch = await prisma.batchJob.findUniqueOrThrow({ where: { id: batchId } });
  if (batch.status !== 'RUNNING') return 0;
  const conc = (batch.settings as { concurrency?: number }).concurrency ?? 2;
  const active = await prisma.batchItem.count({ where: { batchId, status: { in: ['QUEUED', 'RUNNING'] } } });
  const next = await prisma.batchItem.findMany({ where: { batchId, status: 'PENDING' }, orderBy: { position: 'asc' }, take: Math.max(0, conc - active) });
  for (const item of next) {
    await prisma.batchItem.update({ where: { id: item.id }, data: { status: 'QUEUED' } });
    try {
      await createJob({ workspaceId: batch.workspaceId, batchItemId: item.id, type: 'BATCH_ITEM', input: { batchId }, userId, usesAi: true });
    } catch (e) {
      await prisma.batchItem.update({ where: { id: item.id }, data: { status: 'PENDING' } });
      await prisma.batchJob.update({ where: { id: batchId }, data: { status: 'PAUSED' } });
      throw e;
    }
  }
  const remaining = await prisma.batchItem.count({ where: { batchId, status: { in: ['PENDING', 'QUEUED', 'RUNNING'] } } });
  if (remaining === 0) await prisma.batchJob.update({ where: { id: batchId }, data: { status: 'COMPLETED' } });
  return next.length;
}

export async function setBatchState(workspaceId: string, id: string, action: 'start' | 'pause' | 'resume' | 'cancel', userId: string) {
  const b = await getBatch(workspaceId, id);
  const allowed: Record<string, string[]> = { start: ['DRAFT'], pause: ['RUNNING'], resume: ['PAUSED'], cancel: ['DRAFT', 'RUNNING', 'PAUSED'] };
  if (!allowed[action].includes(b.status)) throw conflict(`Cannot ${action} a batch that is ${b.status.toLowerCase()}.`);
  const status = action === 'pause' ? 'PAUSED' : action === 'cancel' ? 'CANCELLED' : 'RUNNING';
  await prisma.batchJob.update({ where: { id }, data: { status } });
  if (action === 'cancel') {
    await prisma.generationJob.updateMany({ where: { batchItem: { batchId: id }, status: 'QUEUED' }, data: { status: 'CANCELLED', cancelRequested: true } });
    await prisma.generationJob.updateMany({ where: { batchItem: { batchId: id }, status: 'RUNNING' }, data: { cancelRequested: true } });
    await prisma.batchItem.updateMany({ where: { batchId: id, status: { in: ['PENDING', 'QUEUED'] } }, data: { status: 'REJECTED', error: 'Batch cancelled' } });
  }
  if (status === 'RUNNING') await pumpBatch(id, userId);
  return getBatch(workspaceId, id);
}

/** Job body for one batch item: create the project (first attempt), then run generation stages. */
export async function runBatchItem(job: GenerationJob, runStages: (p: Project, s: StageDef[]) => Promise<void>, log: (m: string) => Promise<void>) {
  const item = await prisma.batchItem.findUniqueOrThrow({ where: { id: job.batchItemId! }, include: { batch: true } });
  if (item.batch.status === 'CANCELLED') throw new Error('Batch cancelled');
  await prisma.batchItem.update({ where: { id: item.id }, data: { status: 'RUNNING' } });
  const brief = BatchItemBrief.parse(item.brief);
  let projectId = item.projectId;
  if (!projectId) {
    const p = await createProject(item.batch.workspaceId, item.batch.createdById ?? '', brief);
    projectId = p.id;
    await prisma.batchItem.update({ where: { id: item.id }, data: { projectId } });
    await prisma.generationJob.update({ where: { id: job.id }, data: { projectId } });
    await log(`Created project ${p.id} for "${brief.brief.workingTitle}".`);
  }
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const { generationStages } = await import('../jobs/processor');
  await runStages(project, generationStages(brief.generation));
  await prisma.batchItem.update({ where: { id: item.id }, data: { status: 'AWAITING_APPROVAL' } });
  await log('Awaiting manual approval before final export.');
  await pumpBatch(item.batchId, item.batch.createdById).catch((e) => log(`Could not queue next item: ${(e as Error).message}`));
}

export async function approveItem(workspaceId: string, itemId: string, userId: string, decision: 'APPROVED' | 'REJECTED', checklist: unknown) {
  const item = await prisma.batchItem.findFirst({ where: { id: itemId, batch: { workspaceId } } });
  if (!item) throw notFound('Batch item');
  if (item.status !== 'AWAITING_APPROVAL' && !(decision === 'REJECTED' && item.status === 'APPROVED')) throw conflict(`Item is ${item.status.toLowerCase()}, not awaiting approval.`);
  if (decision === 'APPROVED') {
    QualityChecklist.parse(checklist);
    const report = await prisma.validationReport.findFirst({ where: { projectId: item.projectId! }, orderBy: { createdAt: 'desc' } });
    if (!report || report.blocked) throw conflict('Cannot approve: the latest preflight has blocking failures.');
  }
  return prisma.batchItem.update({ where: { id: itemId }, data: { status: decision, approvedById: userId, approvedAt: new Date(), qualityChecklist: (checklist ?? {}) as Prisma.InputJsonValue } });
}

