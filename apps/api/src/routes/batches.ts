import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest } from '../lib/errors';
import { defineRoute, IdParams } from '../lib/route';
import { approveItem, BatchItemBrief, createBatch, csvToBriefs, CSV_COLUMNS, getBatch, QUALITY_CHECKLIST, setBatchState } from '../services/batch';

export const batchRouter = Router();

defineRoute(batchRouter, { method: 'get', path: '/batches', summary: 'List batches', tag: 'Batches' }, async ({ ws }) => {
  const batches = await prisma.batchJob.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { createdAt: 'desc' }, take: 100, include: { items: { select: { status: true, estimatedCostUsd: true } } } });
  return batches.map((b) => ({
    id: b.id,
    name: b.name,
    status: b.status,
    createdAt: b.createdAt,
    counts: b.items.reduce<Record<string, number>>((acc, i) => ((acc[i.status] = (acc[i.status] ?? 0) + 1), acc), {}),
    estimatedCostUsd: b.items.filter((i) => i.status !== 'DUPLICATE').reduce((a, i) => a + Number(i.estimatedCostUsd), 0),
    total: b.items.length,
  }));
});

defineRoute(batchRouter, { method: 'get', path: '/batches/csv-template', summary: 'CSV columns for batch import', tag: 'Batches' }, async () => ({ columns: CSV_COLUMNS, qualityChecklist: QUALITY_CHECKLIST }));

defineRoute(
  batchRouter,
  { method: 'post', path: '/batches', summary: 'Create a batch from CSV text or JSON briefs (each item gets a differentiation check)', tag: 'Batches', body: z.object({ name: z.string().trim().min(1).max(120), csv: z.string().max(2_000_000).optional(), items: z.array(BatchItemBrief).max(500).optional(), concurrency: z.number().int().min(1).max(10).default(2) }), status: 201 },
  async ({ ws, auth, body, req }) => {
    let items = body.items ?? [];
    let errors: { row: number; message: string }[] = [];
    if (body.csv) ({ items, errors } = csvToBriefs(body.csv));
    if (errors.length) throw badRequest(`${errors.length} CSV row(s) are invalid.`, { rowErrors: errors });
    const b = await createBatch(ws.workspaceId, auth.user.id, body.name, items, { concurrency: body.concurrency });
    await audit(req, 'batch.create', 'BatchJob', b.id, { items: items.length });
    return getBatch(ws.workspaceId, b.id);
  },
);

defineRoute(batchRouter, { method: 'get', path: '/batches/:id', summary: 'Batch detail with per-item progress', tag: 'Batches', params: IdParams }, async ({ ws, params }) => getBatch(ws.workspaceId, params.id));

defineRoute(batchRouter, { method: 'post', path: '/batches/:id/:action', summary: 'Start, pause, resume, or cancel a batch', tag: 'Batches', params: z.object({ id: z.string(), action: z.enum(['start', 'pause', 'resume', 'cancel']) }) }, async ({ ws, auth, params, req }) => {
  const b = await setBatchState(ws.workspaceId, params.id, params.action, auth.user.id);
  await audit(req, `batch.${params.action}`, 'BatchJob', b.id);
  return b;
});

defineRoute(
  batchRouter,
  { method: 'post', path: '/batch-items/:id/review', summary: 'Approve (with quality checklist) or reject a generated batch product', tag: 'Batches', params: IdParams, body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), checklist: z.record(z.boolean()).optional() }) },
  async ({ ws, auth, params, body, req }) => {
    const item = await approveItem(ws.workspaceId, params.id, auth.user.id, body.decision, body.checklist);
    await audit(req, `batch_item.${body.decision.toLowerCase()}`, 'BatchItem', item.id);
    return item;
  },
);
