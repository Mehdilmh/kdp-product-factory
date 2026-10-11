import { AUDIENCE_PRESETS, Audience, buildColoringPrompt, COLORING_TRIMS, ColoringInteriorSettings, defaultSpecSource, QcThresholds, qcThresholdsFor, STYLE_PRESETS, StyleProfile, THEME_PRESETS } from '@kdp/core';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { defineRoute, IdParams, queryBool } from '../lib/route';
import { ProcessingOptions, type QcResult } from '../services/coloring-image';
import {
  addPages,
  addVersion,
  bookDetail,
  buildInterior,
  coloringPreflight,
  createColoringBook,
  CreateColoringBookInput,
  estimateBatch,
  getBook,
  processVersion,
  rebuildPrompts,
  requestForPage,
  spentOnBook,
  styleOf,
  themeConcepts,
} from '../services/coloring';
import { kickStaleJobs } from '../jobs/runner';
import { createJob } from '../services/jobs';
import { cachedLayout } from '../services/preview';

export const coloringRouter = Router();
const PageParams = z.object({ id: z.string().max(64), pageId: z.string().max(64) });

defineRoute(coloringRouter, { method: 'get', path: '/coloring/presets', summary: 'Audience, style, theme presets and supported trims', tag: 'Coloring' }, async () => {
  const lib = defaultSpecSource.getLibrary();
  return {
    audiences: Object.entries(AUDIENCE_PRESETS).map(([id, a]) => ({ id, ...a, style: StyleProfile.parse(a.style) })),
    styles: Object.entries(STYLE_PRESETS).map(([id, s]) => ({ id, label: s.label })),
    themes: Object.entries(THEME_PRESETS).map(([id, t]) => ({ id, label: t.label, conceptCount: t.concepts.length })),
    trims: COLORING_TRIMS.map((id) => lib.trimSizes.find((t) => t.id === id)).filter(Boolean).map((t) => ({ id: t!.id, label: t!.label, verification: t!.verification.status })),
    interiorDefaults: ColoringInteriorSettings.parse({}),
    processingDefaults: ProcessingOptions.parse({}),
    specVersion: lib.version,
  };
});

/* ----------------------------------------- Books ------------------------------------------ */

defineRoute(
  coloringRouter,
  { method: 'get', path: '/coloring', summary: 'Coloring books dashboard (search, sort, filter)', tag: 'Coloring', query: z.object({ q: z.string().max(100).optional(), stage: z.string().max(20).optional(), sort: z.enum(['updated', 'created', 'title', 'approved']).default('updated'), archived: queryBool(false) }) },
  async ({ ws, query }) => {
    const books = await prisma.coloringBook.findMany({
      where: { workspaceId: ws.workspaceId, stage: query.stage || undefined, project: { archivedAt: query.archived ? { not: null } : null, title: query.q ? { contains: query.q, mode: 'insensitive' } : undefined } },
      include: { project: { select: { id: true, title: true, status: true, archivedAt: true, format: { select: { trimId: true } } } } },
      orderBy: query.sort === 'created' ? { createdAt: 'desc' } : { updatedAt: 'desc' },
      take: 200,
    });
    const ids = books.map((b) => b.id);
    const [byStatus, costs] = await Promise.all([
      prisma.coloringPage.groupBy({ by: ['bookId', 'status'], where: { bookId: { in: ids } }, _count: true }),
      prisma.coloringPageVersion.groupBy({ by: ['pageId'], where: { page: { bookId: { in: ids } } }, _sum: { estimatedCostUsd: true, actualCostUsd: true } }),
    ]);
    const pageBook = new Map((await prisma.coloringPage.findMany({ where: { bookId: { in: ids } }, select: { id: true, bookId: true } })).map((p) => [p.id, p.bookId]));
    const cost: Record<string, { est: number; act: number }> = {};
    for (const c of costs) {
      const b = pageBook.get(c.pageId)!;
      cost[b] ??= { est: 0, act: 0 };
      cost[b].est += Number(c._sum.estimatedCostUsd ?? 0);
      cost[b].act += Number(c._sum.actualCostUsd ?? 0);
    }
    const rows = books.map((b) => {
      const counts = Object.fromEntries(byStatus.filter((s) => s.bookId === b.id).map((s) => [s.status, s._count]));
      const total = Object.values(counts).reduce((x, y) => x + (y as number), 0);
      return { id: b.id, projectId: b.projectId, title: b.project.title, trimId: b.project.format?.trimId, audience: b.audience, theme: b.theme, stage: b.stage, projectStatus: b.project.status, archived: !!b.project.archivedAt, illustrationTarget: b.illustrationTarget, pages: total, approved: counts.APPROVED ?? 0, counts, estimatedCostUsd: cost[b.id]?.est ?? 0, actualCostUsd: cost[b.id]?.act ?? 0, budgetCapUsd: b.budgetCapUsd !== null ? Number(b.budgetCapUsd) : null, progress: Math.round(((counts.APPROVED ?? 0) / Math.max(1, b.illustrationTarget)) * 100), updatedAt: b.updatedAt, createdAt: b.createdAt };
    });
    if (query.sort === 'title') rows.sort((a, b) => a.title.localeCompare(b.title));
    if (query.sort === 'approved') rows.sort((a, b) => b.approved - a.approved);
    return rows;
  },
);

defineRoute(coloringRouter, { method: 'post', path: '/coloring', summary: 'Create a coloring book (project + studio settings + optional page plan)', tag: 'Coloring', body: CreateColoringBookInput, status: 201 }, async ({ ws, body, req }) => {
  const b = await createColoringBook(ws.workspaceId, ws.user.id, body);
  await audit(req, 'coloring.create', 'ColoringBook', b.id);
  return bookDetail(await getBook(ws.workspaceId, b.id));
});

defineRoute(coloringRouter, { method: 'get', path: '/coloring/:id', summary: 'Book detail: pages, versions, QC, costs, similarity', tag: 'Coloring', params: IdParams }, async ({ ws, params }) => {
  await kickStaleJobs(ws.workspaceId);
  return bookDetail(await getBook(ws.workspaceId, params.id));
});

const PatchBook = z.object({
  audience: Audience.optional(),
  theme: z.string().max(60).optional(),
  description: z.string().max(2000).optional(),
  ageRange: z.string().max(20).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  illustrationTarget: z.number().int().min(1).max(300).optional(),
  seriesName: z.string().max(120).optional(),
  seriesNumber: z.number().int().min(1).max(999).nullable().optional(),
  style: StyleProfile.partial().optional(),
  rebuildPrompts: z.boolean().default(true),
  interior: ColoringInteriorSettings.partial().optional(),
  qcThresholds: QcThresholds.partial().optional(),
  modelId: z.string().max(64).nullable().optional(),
  budgetCapUsd: z.number().min(0).max(100000).nullable().optional(),
  processing: ProcessingOptions.partial().optional(),
  backCoverCopy: z.string().max(4000).optional(),
  checklist: z.record(z.boolean()).optional(),
});

defineRoute(coloringRouter, { method: 'patch', path: '/coloring/:id', summary: 'Update concept, style profile, interior, QC thresholds, model, budget, metadata extras', tag: 'Coloring', params: IdParams, body: PatchBook }, async ({ ws, params, body, req }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const data: Prisma.ColoringBookUpdateInput = {};
  for (const k of ['audience', 'theme', 'description', 'ageRange', 'difficulty', 'illustrationTarget', 'seriesName', 'seriesNumber', 'modelId'] as const) if (body[k] !== undefined) (data as Record<string, unknown>)[k] = body[k];
  let styleChanged = false;
  if (body.style) {
    const s = StyleProfile.parse({ ...styleOf(b), ...body.style });
    data.styleProfile = s as unknown as Prisma.InputJsonValue;
    data.qcThresholds = { ...qcThresholdsFor(s), ...(body.qcThresholds ?? {}) } as unknown as Prisma.InputJsonValue;
    styleChanged = true;
  } else if (body.qcThresholds) data.qcThresholds = QcThresholds.parse({ ...(b.qcThresholds as object), ...body.qcThresholds }) as unknown as Prisma.InputJsonValue;
  if (body.interior) {
    const next = ColoringInteriorSettings.parse({ ...(b.interiorSettings as object), ...body.interior });
    data.interiorSettings = next as unknown as Prisma.InputJsonValue;
    if (next.fullBleed !== b.project.format?.bleed) await prisma.productFormat.update({ where: { projectId: b.projectId }, data: { bleed: next.fullBleed } });
  }
  if (body.budgetCapUsd !== undefined) {
    data.budgetCapUsd = body.budgetCapUsd === null ? null : new Prisma.Decimal(body.budgetCapUsd);
    await prisma.project.update({ where: { id: b.projectId }, data: { aiSpendLimitUsd: data.budgetCapUsd as Prisma.Decimal | null } });
  }
  if (body.processing || body.backCoverCopy !== undefined || body.checklist) {
    const extras = { ...((b.metadataExtras as object) ?? {}) } as Record<string, unknown>;
    if (body.processing) extras.processing = ProcessingOptions.partial().parse({ ...((extras.processing as object) ?? {}), ...body.processing });
    if (body.backCoverCopy !== undefined) extras.backCoverCopy = body.backCoverCopy;
    if (body.checklist) extras.checklist = { ...((extras.checklist as object) ?? {}), ...body.checklist };
    data.metadataExtras = extras as Prisma.InputJsonValue;
  }
  if (body.modelId) {
    const m = await prisma.imageModel.findFirst({ where: { OR: [{ id: body.modelId }, { endpointId: body.modelId }] } });
    if (!m) throw notFound('Model');
    data.modelId = m.id;
  }
  const updated = await prisma.coloringBook.update({ where: { id: b.id }, data });
  let rebuilt = 0;
  if (styleChanged && body.rebuildPrompts) rebuilt = await rebuildPrompts(updated);
  await audit(req, 'coloring.update', 'ColoringBook', b.id, { fields: Object.keys(body), promptsRebuilt: rebuilt });
  return bookDetail(await getBook(ws.workspaceId, b.id));
});

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/duplicate', summary: 'Duplicate settings and page plan into a new book (no images, no costs)', tag: 'Coloring', params: IdParams, status: 201 }, async ({ ws, params, req }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const pages = await prisma.coloringPage.findMany({ where: { bookId: b.id }, orderBy: { position: 'asc' } });
  const brief = await prisma.productBrief.findUniqueOrThrow({ where: { projectId: b.projectId } });
  const nb = await createColoringBook(ws.workspaceId, ws.user.id, {
    title: `${b.project.title} (copy)`,
    subtitle: '',
    author: brief.authorName,
    audience: b.audience as Audience,
    theme: b.theme,
    description: b.description,
    language: brief.language,
    ageRange: b.ageRange,
    difficulty: b.difficulty as 'EASY',
    illustrationTarget: b.illustrationTarget,
    seriesName: b.seriesName,
    seriesNumber: b.seriesNumber,
    trimId: b.project.format?.trimId ?? '8.5x11',
    interior: ColoringInteriorSettings.parse(b.interiorSettings),
    style: StyleProfile.parse(b.styleProfile),
    modelId: b.modelId,
    budgetCapUsd: b.budgetCapUsd !== null ? Number(b.budgetCapUsd) : null,
    concepts: pages.map((p) => p.concept),
  });
  await audit(req, 'coloring.duplicate', 'ColoringBook', nb.id, { from: b.id });
  return { id: nb.id, projectId: nb.projectId };
});

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/archive', summary: 'Archive or restore a coloring book', tag: 'Coloring', params: IdParams, body: z.object({ archived: z.boolean() }) }, async ({ ws, params, body, req }) => {
  const b = await getBook(ws.workspaceId, params.id);
  await prisma.project.update({ where: { id: b.projectId }, data: { archivedAt: body.archived ? new Date() : null } });
  await audit(req, body.archived ? 'coloring.archive' : 'coloring.unarchive', 'ColoringBook', b.id);
  return { ok: true };
});

/* -------------------------------------- Style profiles ------------------------------------- */

defineRoute(coloringRouter, { method: 'get', path: '/coloring-styles', summary: 'Saved style profiles', tag: 'Coloring' }, async ({ ws }) => prisma.coloringStyleProfile.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { name: 'asc' } }));

defineRoute(coloringRouter, { method: 'post', path: '/coloring-styles', summary: 'Save a reusable style profile', tag: 'Coloring', body: z.object({ name: z.string().trim().min(1).max(80), profile: StyleProfile.partial() }), status: 201 }, async ({ ws, body }) => {
  const profile = StyleProfile.parse({ ...body.profile, name: body.name });
  for (const id of profile.referenceAssetIds) if (!(await prisma.asset.findFirst({ where: { id, workspaceId: ws.workspaceId } }))) throw badRequest(`Reference asset ${id} not found.`);
  return prisma.coloringStyleProfile.create({ data: { workspaceId: ws.workspaceId, name: body.name, profile: profile as unknown as Prisma.InputJsonValue, createdById: ws.user.id } });
});

defineRoute(coloringRouter, { method: 'delete', path: '/coloring-styles/:id', summary: 'Delete a style profile', tag: 'Coloring', params: IdParams }, async ({ ws, params }) => {
  const r = await prisma.coloringStyleProfile.deleteMany({ where: { id: params.id, workspaceId: ws.workspaceId } });
  if (!r.count) throw notFound('Style profile');
  return { ok: true };
});

/* -------------------------------------- Page plan ------------------------------------------ */

defineRoute(
  coloringRouter,
  { method: 'post', path: '/coloring/:id/pages', summary: 'Add pages from concepts or a theme preset', tag: 'Coloring', params: IdParams, body: z.object({ concepts: z.array(z.string().trim().min(2).max(300)).max(300).default([]), fromTheme: z.object({ theme: z.string().max(60), count: z.number().int().min(1).max(300) }).optional() }), status: 201 },
  async ({ ws, params, body }) => {
    const b = await getBook(ws.workspaceId, params.id);
    const existing = (await prisma.coloringPage.findMany({ where: { bookId: b.id }, select: { concept: true } })).map((p) => p.concept);
    const concepts = [...body.concepts, ...(body.fromTheme ? themeConcepts(body.fromTheme.theme, body.fromTheme.count, [...existing, ...body.concepts]) : [])];
    if (!concepts.length) throw badRequest('Provide concepts or a theme with presets.');
    if (existing.length + concepts.length > 300) throw badRequest('A book can have at most 300 pages in the plan.');
    const n = await addPages(b, concepts);
    return { added: n };
  },
);

const PagePatch = z.object({ concept: z.string().trim().min(2).max(300).optional(), prompt: z.string().trim().min(5).max(4000).optional(), negativePrompt: z.string().max(2000).optional(), resetPrompt: z.boolean().optional(), notes: z.string().max(2000).optional(), favorite: z.boolean().optional(), modelId: z.string().max(64).nullable().optional() });

async function getPage(bookId: string, pageId: string) {
  const p = await prisma.coloringPage.findFirst({ where: { id: pageId, bookId } });
  if (!p) throw notFound('Page');
  return p;
}

defineRoute(coloringRouter, { method: 'patch', path: '/coloring/:id/pages/:pageId', summary: 'Edit concept / prompt / notes / favorite', tag: 'Coloring', params: PageParams, body: PagePatch }, async ({ ws, params, body }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const p = await getPage(b.id, params.pageId);
  const data: Prisma.ColoringPageUpdateInput = { notes: body.notes, favorite: body.favorite, modelId: body.modelId };
  const concept = body.concept ?? p.concept;
  if (body.concept) data.concept = body.concept;
  if (body.prompt !== undefined || body.negativePrompt !== undefined) {
    data.prompt = body.prompt ?? p.prompt;
    data.negativePrompt = body.negativePrompt ?? p.negativePrompt;
    data.promptEdited = true;
  } else if (body.resetPrompt || (body.concept && !p.promptEdited)) {
    const built = buildColoringPrompt(concept, styleOf(b), { audience: b.audience as Audience });
    Object.assign(data, { prompt: built.prompt, negativePrompt: built.negativePrompt, promptVersion: built.version, promptEdited: false });
  }
  return prisma.coloringPage.update({ where: { id: p.id }, data });
});

defineRoute(coloringRouter, { method: 'delete', path: '/coloring/:id/pages/:pageId', summary: 'Remove a page from the plan (versions and assets are kept in the asset library)', tag: 'Coloring', params: PageParams }, async ({ ws, params }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const p = await getPage(b.id, params.pageId);
  if (p.status === 'GENERATING' || p.status === 'QUEUED') throw conflict('This page is being generated.');
  await prisma.coloringPage.delete({ where: { id: p.id } });
  return { ok: true };
});

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/pages/reorder', summary: 'Set page order', tag: 'Coloring', params: IdParams, body: z.object({ pageIds: z.array(z.string().max(64)).max(300) }) }, async ({ ws, params, body }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const pages = await prisma.coloringPage.findMany({ where: { bookId: b.id }, select: { id: true } });
  if (pages.length !== body.pageIds.length || !pages.every((p) => body.pageIds.includes(p.id))) throw badRequest('pageIds must list every page of the book exactly once.');
  await prisma.$transaction(body.pageIds.map((id, i) => prisma.coloringPage.update({ where: { id }, data: { position: i } })));
  return { ok: true };
});

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/pages/:pageId/duplicate', summary: 'Duplicate a page (concept, prompt and current image as a new page)', tag: 'Coloring', params: PageParams, status: 201 }, async ({ ws, params }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const p = await getPage(b.id, params.pageId);
  await prisma.coloringPage.updateMany({ where: { bookId: b.id, position: { gt: p.position } }, data: { position: { increment: 1 } } });
  const copy = await prisma.coloringPage.create({ data: { bookId: b.id, position: p.position + 1, concept: p.concept, prompt: p.prompt, negativePrompt: p.negativePrompt, promptVersion: p.promptVersion, promptEdited: p.promptEdited, modelId: p.modelId, params: p.params as Prisma.InputJsonValue, referenceAssetIds: p.referenceAssetIds, status: 'PLANNED', notes: p.notes } });
  const cur = p.currentVersionId ? await prisma.coloringPageVersion.findUnique({ where: { id: p.currentVersionId } }) : null;
  if (cur) {
    const v = await prisma.coloringPageVersion.create({ data: { pageId: copy.id, version: 1, source: cur.source, generationId: cur.generationId, prompt: cur.prompt, negativePrompt: cur.negativePrompt, modelId: cur.modelId, params: cur.params as Prisma.InputJsonValue, originalAssetId: cur.originalAssetId, processedAssetId: cur.processedAssetId, processing: cur.processing as Prisma.InputJsonValue, qc: cur.qc as Prisma.InputJsonValue, dhash: cur.dhash } });
    await prisma.coloringPage.update({ where: { id: copy.id }, data: { currentVersionId: v.id, status: 'NEEDS_REVIEW' } });
  }
  return copy;
});

/* ---------------------------------------- Review ------------------------------------------- */

const ApproveBody = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'NEEDS_REVIEW']), overrideNote: z.string().max(1000).optional() });

async function setPageStatus(bookId: string, pageId: string, status: 'APPROVED' | 'REJECTED' | 'NEEDS_REVIEW', userId: string, overrideNote?: string) {
  const p = await getPage(bookId, pageId);
  if (status === 'APPROVED') {
    if (!p.currentVersionId) throw conflict(`Page ${p.position + 1} has no image to approve.`);
    const v = await prisma.coloringPageVersion.findUniqueOrThrow({ where: { id: p.currentVersionId } });
    const fails = ((v.qc as unknown as QcResult | null)?.checks ?? []).filter((c) => c.status === 'FAIL');
    if (fails.length) {
      if (!overrideNote?.trim()) throw new HttpError(409, 'QC_OVERRIDE_REQUIRED', `Page ${p.position + 1} has failed checks (${fails.map((f) => f.label).join(', ')}). Fix them or approve with an override note.`, { failed: fails.map((f) => f.id) });
      await prisma.coloringPage.update({ where: { id: p.id }, data: { qcOverride: { checks: fails.map((f) => f.id), note: overrideNote, by: userId, at: new Date().toISOString(), versionId: v.id } } });
    }
  }
  return prisma.coloringPage.update({ where: { id: p.id }, data: { status } });
}

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/pages/:pageId/status', summary: 'Approve / reject / send back to review (failed QC needs an override note)', tag: 'Coloring', params: PageParams, body: ApproveBody }, async ({ ws, params, body, req }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const r = await setPageStatus(b.id, params.pageId, body.status, ws.user.id, body.overrideNote);
  await audit(req, `coloring.page.${body.status.toLowerCase()}`, 'ColoringPage', r.id, body.overrideNote ? { overrideNote: body.overrideNote } : undefined);
  return r;
});

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/pages/:pageId/override', summary: 'Record a manual override of heuristic QC warnings', tag: 'Coloring', params: PageParams, body: z.object({ checks: z.array(z.string().max(40)).min(1).max(20), note: z.string().trim().min(3).max(1000) }) }, async ({ ws, params, body, req }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const p = await getPage(b.id, params.pageId);
  const r = await prisma.coloringPage.update({ where: { id: p.id }, data: { qcOverride: { checks: body.checks, note: body.note, by: ws.user.id, at: new Date().toISOString(), versionId: p.currentVersionId } } });
  await audit(req, 'coloring.page.qc_override', 'ColoringPage', p.id, body);
  return r;
});

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/pages/:pageId/restore', summary: 'Make an earlier version current', tag: 'Coloring', params: PageParams, body: z.object({ versionId: z.string().max(64) }) }, async ({ ws, params, body }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const p = await getPage(b.id, params.pageId);
  const v = await prisma.coloringPageVersion.findFirst({ where: { id: body.versionId, pageId: p.id } });
  if (!v) throw notFound('Version');
  return prisma.coloringPage.update({ where: { id: p.id }, data: { currentVersionId: v.id, status: 'NEEDS_REVIEW', qcOverride: Prisma.DbNull } });
});

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/pages/:pageId/replace', summary: 'Replace the image with an uploaded asset (new version; original kept)', tag: 'Coloring', params: PageParams, body: z.object({ assetId: z.string().max(64) }) }, async ({ ws, params, body, req }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const p = await getPage(b.id, params.pageId);
  const a = await prisma.asset.findFirst({ where: { id: body.assetId, workspaceId: ws.workspaceId } });
  if (!a || !a.mimeType.startsWith('image/')) throw notFound('Image asset');
  const v = await addVersion(b, p, { source: 'UPLOAD', originalAssetId: a.id, prompt: '', negativePrompt: '', userId: ws.user.id });
  await audit(req, 'coloring.page.replace', 'ColoringPage', p.id, { assetId: a.id });
  return v;
});

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/pages/:pageId/process', summary: 'Re-process a version (cleanup, grayscale, threshold, denoise, resample, crop/position); original preserved', tag: 'Coloring', params: PageParams, body: z.object({ versionId: z.string().max(64).optional(), options: ProcessingOptions.partial().default({}) }) }, async ({ ws, params, body }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const p = await getPage(b.id, params.pageId);
  const vid = body.versionId ?? p.currentVersionId;
  const v = vid ? await prisma.coloringPageVersion.findFirst({ where: { id: vid, pageId: p.id } }) : null;
  if (!v) throw notFound('Version');
  const out = await processVersion(b, v, body.options);
  if (p.status === 'APPROVED' && v.id === p.currentVersionId) await prisma.coloringPage.update({ where: { id: p.id }, data: { status: 'NEEDS_REVIEW' } });
  return out;
});

defineRoute(
  coloringRouter,
  { method: 'post', path: '/coloring/:id/bulk', summary: 'Bulk approve / reject / favorite / delete / process', tag: 'Coloring', params: IdParams, body: z.object({ pageIds: z.array(z.string().max(64)).min(1).max(300), action: z.enum(['approve', 'reject', 'review', 'favorite', 'unfavorite', 'delete', 'process']), options: ProcessingOptions.partial().optional() }) },
  async ({ ws, params, body, req }) => {
    const b = await getBook(ws.workspaceId, params.id);
    const results: { pageId: string; ok: boolean; error?: string }[] = [];
    for (const id of body.pageIds) {
      try {
        if (body.action === 'approve') await setPageStatus(b.id, id, 'APPROVED', ws.user.id);
        else if (body.action === 'reject') await setPageStatus(b.id, id, 'REJECTED', ws.user.id);
        else if (body.action === 'review') await setPageStatus(b.id, id, 'NEEDS_REVIEW', ws.user.id);
        else if (body.action === 'favorite' || body.action === 'unfavorite') await prisma.coloringPage.update({ where: { id: (await getPage(b.id, id)).id }, data: { favorite: body.action === 'favorite' } });
        else if (body.action === 'delete') {
          const p = await getPage(b.id, id);
          if (p.status === 'GENERATING' || p.status === 'QUEUED') throw conflict('Page is being generated.');
          await prisma.coloringPage.delete({ where: { id: p.id } });
        } else if (body.action === 'process') {
          const p = await getPage(b.id, id);
          if (!p.currentVersionId) throw conflict('No image.');
          await processVersion(b, await prisma.coloringPageVersion.findUniqueOrThrow({ where: { id: p.currentVersionId } }), body.options ?? {});
        }
        results.push({ pageId: id, ok: true });
      } catch (e) {
        results.push({ pageId: id, ok: false, error: (e as Error).message });
      }
    }
    await audit(req, `coloring.bulk.${body.action}`, 'ColoringBook', b.id, { count: body.pageIds.length, failed: results.filter((r) => !r.ok).length });
    return { results };
  },
);

/* --------------------------------------- Generation ---------------------------------------- */

const GenBody = z.object({ pageIds: z.array(z.string().max(64)).min(1).max(300), modelId: z.string().max(64), mode: z.enum(['NEW', 'VARIATION', 'EDIT']).default('NEW') });

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/estimate', summary: 'Estimate generating the selected pages (per page, total, budget)', tag: 'Coloring', params: IdParams, minRole: 'VIEWER', body: GenBody }, async ({ ws, params, body }) => estimateBatch(await getBook(ws.workspaceId, params.id), body.pageIds, body.modelId, body.mode));

defineRoute(
  coloringRouter,
  { method: 'post', path: '/coloring/:id/generate', summary: 'Queue generation for the selected pages after confirming the total estimate', tag: 'Coloring', params: IdParams, body: GenBody.extend({ confirmation: z.object({ acceptedTotalUsd: z.number().min(0), acceptUnverifiedCost: z.boolean().default(false) }) }), status: 202 },
  async ({ ws, params, body, req }) => {
    const b = await getBook(ws.workspaceId, params.id);
    const est = await estimateBatch(b, body.pageIds, body.modelId, body.mode);
    const bad = est.pages.filter((p) => p.errors.length);
    if (bad.length) throw badRequest('Settings are not valid for this model.', { pages: bad.map((p) => ({ position: p.position + 1, errors: p.errors })) });
    const model = await prisma.imageModel.findFirst({ where: { OR: [{ id: body.modelId }, { endpointId: body.modelId }] } });
    if (!model || !(model.enabled && (model.availability === 'VERIFIED' || model.availability === 'OFFLINE_MOCK'))) throw new HttpError(409, 'MODEL_NOT_AVAILABLE', 'This model is not verified/enabled for generation.');
    if (body.confirmation.acceptedTotalUsd + 1e-9 < est.knownTotalUsd) throw new HttpError(409, 'CONFIRMATION_REQUIRED', `The estimated total is $${est.knownTotalUsd}; confirm that amount.`, est);
    if (est.unverifiedCount && !body.confirmation.acceptUnverifiedCost) throw new HttpError(409, 'CONFIRMATION_REQUIRED', `${est.unverifiedCount} page(s) have no verified price. Confirm that you accept an unverified cost.`, est);
    if (est.budget.exceeds) throw new HttpError(429, 'QUOTA_BOOK_BUDGET', `This batch would exceed the book budget ($${est.budget.capUsd}; $${est.budget.spentUsd.toFixed(4)} spent).`, est);
    const pages = await prisma.coloringPage.findMany({ where: { bookId: b.id, id: { in: body.pageIds } }, orderBy: { position: 'asc' } });
    if (pages.some((p) => p.status === 'GENERATING' || p.status === 'QUEUED')) throw conflict('Some selected pages are already queued or generating.');
    const items = [];
    for (const p of pages) {
      const request = await requestForPage(b, p, model.id, body.mode, (await prisma.coloringPageVersion.count({ where: { pageId: p.id } })) + 1);
      const e = est.pages.find((x) => x.pageId === p.id)!.estimate;
      items.push({ pageId: p.id, request, confirmation: { acceptedEstimateUsd: e.total, acceptUnverifiedCost: e.status !== 'OK' } });
    }
    const job = await createJob({ workspaceId: ws.workspaceId, projectId: b.projectId, type: 'COLORING_GENERATE', userId: ws.user.id, usesAi: model.provider !== 'mock', input: { bookId: b.id, modelId: model.id, mode: body.mode, userId: ws.user.id, items } as unknown as Prisma.InputJsonValue });
    await prisma.coloringPage.updateMany({ where: { id: { in: pages.map((p) => p.id) } }, data: { status: 'QUEUED', error: null } });
    await prisma.coloringBook.update({ where: { id: b.id }, data: { stage: 'GENERATING', modelId: b.modelId ?? model.id } });
    await audit(req, 'coloring.generate', 'ColoringBook', b.id, { pages: pages.length, model: model.endpointId, knownTotalUsd: est.knownTotalUsd, unverified: est.unverifiedCount });
    return { jobId: job.id, estimate: est };
  },
);

/* --------------------------------------- Interior etc. ------------------------------------- */

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/interior', summary: 'Build the interior from approved pages (deterministic) and return a layout summary', tag: 'Coloring', params: IdParams }, async ({ ws, params, req }) => {
  const b = await getBook(ws.workspaceId, params.id);
  const r = await buildInterior(b);
  const { layout } = await cachedLayout(b.projectId);
  await audit(req, 'coloring.interior', 'ColoringBook', b.id, r);
  return {
    illustrations: r.illustrations,
    pageCount: layout.pageCount,
    trim: layout.spec.trim,
    pageWidthIn: layout.spec.pageWidthIn,
    pageHeightIn: layout.spec.pageHeightIn,
    margins: layout.margins,
    warnings: layout.warnings,
    pages: layout.pages.map((p, i) => ({ index: i, blank: !!p.intentionalBlank, hasImage: p.ops.some((o) => o.op === 'image'), number: p.displayNumber ?? null })),
  };
});

defineRoute(coloringRouter, { method: 'post', path: '/coloring/:id/preflight', summary: 'Unified preflight: automated checks, visual (heuristic) warnings, manual review, unverified official requirements', tag: 'Coloring', params: IdParams }, async ({ ws, params }) => coloringPreflight(await getBook(ws.workspaceId, params.id)));

defineRoute(coloringRouter, { method: 'get', path: '/coloring/:id/cost', summary: 'Estimated vs actual cost for the book', tag: 'Coloring', params: IdParams }, async ({ ws, params }) => {
  const b = await getBook(ws.workspaceId, params.id);
  return { ...(await spentOnBook(b)), capUsd: b.budgetCapUsd !== null ? Number(b.budgetCapUsd) : null };
});
