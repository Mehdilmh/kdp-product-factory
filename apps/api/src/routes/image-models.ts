import { EDITORIAL_TAGS, IMAGE_TASKS, normalizeUnit, PricingAssumptions, type CostEstimate } from '@kdp/core';
import { Prisma } from '@prisma/client';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { requireUser } from '../lib/auth';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors';
import { defineRoute, IdParams, queryBool } from '../lib/route';
import { ensureCatalogOnce, getModel, modelDto, syncCatalog, syncProviderUsage, estimateFor } from '../services/image-catalog';
import { checkConfirmation, NormalizedRequestSchema, prepareGeneration } from '../services/image-generation';
import { createJob } from '../services/jobs';

export const imageModelRouter = Router();

/** Platform admins manage the shared model catalog and prices (not workspace admins). */
export async function isPlatformAdmin(userId: string, email: string) {
  const listed = config()
    .PLATFORM_ADMIN_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
  if (listed) return true;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } });
  return !!u?.isPlatformAdmin;
}
async function requirePlatformAdmin(req: Request) {
  const a = requireUser(req);
  if (!(await isPlatformAdmin(a.user.id, a.user.email))) throw forbidden('Platform administrator access is required to manage the model catalog.');
  return a;
}

const SORTS = ['recommended', 'price', 'name', 'verified'] as const;
const FILTERS = ['cheapest', 'commercial-info', 'text-to-image', 'image-to-image', ...EDITORIAL_TAGS] as const;

const ListQuery = z.object({
  q: z.string().max(100).optional(),
  task: z.enum(IMAGE_TASKS).optional(),
  filter: z.enum(FILTERS).optional(),
  sort: z.enum(SORTS).default('recommended'),
  includeUnavailable: queryBool(false),
  includeMock: queryBool(true),
  widthPx: z.coerce.number().int().min(64).max(16384).optional(),
  heightPx: z.coerce.number().int().min(64).max(16384).optional(),
  numImages: z.coerce.number().int().min(1).max(1000).default(1),
  resolution: z.string().max(10).optional(),
});

defineRoute(imageModelRouter, { method: 'get', path: '/image-models', summary: 'Image model library with pricing and an estimate for the given settings', tag: 'Image models', query: ListQuery }, async ({ query, ws: auth }) => {
  await ensureCatalogOnce();
  const where: Prisma.ImageModelWhereInput = {};
  if (!query.includeUnavailable) where.OR = [{ enabled: true }, { availability: 'CANDIDATE_UNVERIFIED' }];
  if (!query.includeMock) where.provider = { not: 'mock' };
  if (query.task) where.tasks = { has: query.task };
  if (query.filter === 'text-to-image' || query.filter === 'image-to-image') where.tasks = { has: query.filter };
  else if (query.filter && (EDITORIAL_TAGS as readonly string[]).includes(query.filter)) where.editorialTags = { has: query.filter };
  if (query.filter === 'commercial-info') where.AND = [{ OR: [{ commercialUseUrl: { not: '' } }, { commercialUseNote: { not: '' } }] }];
  if (query.q) where.AND = [...((where.AND as Prisma.ImageModelWhereInput[]) ?? []), { OR: [{ displayName: { contains: query.q, mode: 'insensitive' } }, { endpointId: { contains: query.q, mode: 'insensitive' } }, { family: { contains: query.q, mode: 'insensitive' } }] }];
  const models = await prisma.imageModel.findMany({ where, include: { prices: { where: { isCurrent: true } } }, orderBy: { displayName: 'asc' } });
  const settings = { widthPx: query.widthPx ?? 1024, heightPx: query.heightPx ?? 1024, numImages: query.numImages, resolution: query.resolution, dimensionsAreAssumed: !query.widthPx };
  let rows = models.map((m) => modelDto(m, estimateFor(m, settings)));
  const perImage = (e: CostEstimate) => (e.status === 'OK' || e.status === 'STALE' ? (e.perImage ?? Infinity) : Infinity);
  if (query.filter === 'cheapest') rows = rows.filter((r) => r.provider !== 'mock' && Number.isFinite(perImage(r.estimate)));
  const rank = (r: (typeof rows)[number]) => (r.usable ? 0 : r.availability === 'CANDIDATE_UNVERIFIED' ? 2 : 1);
  rows.sort((a, b) => {
    if (query.sort === 'name') return a.displayName.localeCompare(b.displayName);
    if (query.sort === 'price' || query.filter === 'cheapest') return perImage(a.estimate) - perImage(b.estimate) || a.displayName.localeCompare(b.displayName);
    if (query.sort === 'verified') return String(b.capabilitiesVerifiedAt ?? '').localeCompare(String(a.capabilitiesVerifiedAt ?? ''));
    return rank(a) - rank(b) || (a.provider === 'mock' ? 1 : 0) - (b.provider === 'mock' ? 1 : 0) || a.displayName.localeCompare(b.displayName);
  });
  const [ws, sync] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: auth.workspaceId }, select: { preferredImageModelId: true } }),
    prisma.systemState.findUnique({ where: { key: 'imageCatalogSync' } }),
  ]);
  return {
    models: rows,
    preferredModelId: ws?.preferredImageModelId ?? null,
    lastSync: sync?.value ?? null,
    falConfigured: !!config().FAL_KEY,
    canAdmin: await isPlatformAdmin(auth.user.id, auth.user.email),
    filters: FILTERS,
  };
});

defineRoute(imageModelRouter, { method: 'get', path: '/image-models/:id', summary: 'Model detail incl. schema, capabilities, price history', tag: 'Image models', params: IdParams }, async ({ params }) => {
  const m = await prisma.imageModel.findFirst({ where: { OR: [{ id: params.id }, { endpointId: params.id }] }, include: { prices: { orderBy: { retrievedAt: 'desc' }, take: 20 } } });
  if (!m) throw notFound('Model');
  return { ...modelDto({ ...m, prices: m.prices.filter((p) => p.isCurrent) }), inputSchema: m.inputSchema, priceHistory: m.prices };
});

const EstimateBody = z.object({ modelId: z.string().max(64), request: NormalizedRequestSchema });

defineRoute(imageModelRouter, { method: 'post', path: '/image-models/estimate', summary: 'Validate settings against the model schema and estimate cost (no provider call)', tag: 'Image models', minRole: 'VIEWER', body: EstimateBody }, async ({ ws, body }) => {
  const p = await prepareGeneration(ws.workspaceId, body.modelId, body.request, { resolveAssets: false });
  return { model: modelDto(p.model, p.estimate), estimate: p.estimate, errors: p.errors, input: p.input };
});

/* ------------------------------- Generation ------------------------------- */

const Confirm = z.object({ acceptedEstimateUsd: z.number().min(0).nullable(), acceptUnverifiedCost: z.boolean().default(false) });

const GenerateBody = z.object({
  modelId: z.string().max(64),
  projectId: z.string().max(64).nullable().optional(),
  purpose: z.enum(['COVER_ART', 'TEST']).default('COVER_ART'),
  request: NormalizedRequestSchema,
  confirmation: Confirm.optional(),
});

async function assertProject(workspaceId: string, projectId?: string | null) {
  if (!projectId) return;
  const p = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } });
  if (!p) throw notFound('Project');
}

defineRoute(imageModelRouter, { method: 'post', path: '/image-generations', summary: 'Generate image(s) with a model after confirming the estimate (runs as a job)', tag: 'Image models', body: GenerateBody, status: 202 }, async ({ ws, body, req }) => {
  await assertProject(ws.workspaceId, body.projectId);
  const p = await prepareGeneration(ws.workspaceId, body.modelId, body.request);
  if (p.errors.length) throw badRequest(`Settings are not valid for ${p.model.displayName}`, { errors: p.errors });
  if (!(p.model.enabled && (p.model.availability === 'VERIFIED' || p.model.availability === 'OFFLINE_MOCK'))) throw new HttpError(409, 'MODEL_NOT_AVAILABLE', `${p.model.displayName} is not verified/enabled for generation.`);
  checkConfirmation(p.estimate, body.confirmation);
  const job = await createJob({
    workspaceId: ws.workspaceId,
    projectId: body.projectId ?? null,
    exclusive: false, // image jobs never block a project's other jobs
    type: 'IMAGE_GENERATE',
    userId: ws.user.id,
    usesAi: p.model.provider !== 'mock',
    input: { purpose: body.purpose, userId: ws.user.id, items: [{ key: 'main', modelId: p.model.id, request: body.request, confirmation: body.confirmation! }] } as Prisma.InputJsonValue,
  });
  await audit(req, 'image.generate', 'GenerationJob', job.id, { model: p.model.endpointId, estimate: p.estimate.total, status: p.estimate.status });
  return { jobId: job.id, estimate: p.estimate };
});

defineRoute(imageModelRouter, { method: 'get', path: '/image-generations', summary: 'Generation log (cost, settings, status)', tag: 'Image models', query: z.object({ projectId: z.string().optional(), jobId: z.string().optional(), take: z.coerce.number().int().min(1).max(200).default(50) }) }, async ({ ws, query }) => {
  const rows = await prisma.imageGeneration.findMany({ where: { workspaceId: ws.workspaceId, projectId: query.projectId, jobId: query.jobId }, orderBy: { createdAt: 'desc' }, take: query.take, include: { model: { select: { displayName: true } } } });
  const totals = await prisma.imageGeneration.aggregate({ where: { workspaceId: ws.workspaceId, projectId: query.projectId }, _sum: { estimatedCostUsd: true, actualCostUsd: true }, _count: true });
  return { generations: rows, totals: { count: totals._count, estimatedUsd: Number(totals._sum.estimatedCostUsd ?? 0), actualUsd: Number(totals._sum.actualCostUsd ?? 0) } };
});

defineRoute(imageModelRouter, { method: 'get', path: '/image-generations/:id', summary: 'One generation', tag: 'Image models', params: IdParams }, async ({ ws, params }) => {
  const g = await prisma.imageGeneration.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId }, include: { model: { select: { displayName: true, endpointId: true } } } });
  if (!g) throw notFound('Generation');
  return g;
});

/* -------------------------------- Compare --------------------------------- */

const CompareEstimateBody = z.object({ modelIds: z.array(z.string().max(64)).min(1).max(8), request: NormalizedRequestSchema.extend({ numImages: z.number().int().min(1).max(4).default(1) }) });

async function compareEstimates(workspaceId: string, body: z.infer<typeof CompareEstimateBody>) {
  const items = [];
  for (const id of [...new Set(body.modelIds)]) {
    const p = await prepareGeneration(workspaceId, id, body.request);
    const usable = p.model.enabled && (p.model.availability === 'VERIFIED' || p.model.availability === 'OFFLINE_MOCK');
    items.push({ modelId: p.model.id, displayName: p.model.displayName, endpointId: p.model.endpointId, provider: p.model.provider, usable, errors: p.errors, estimate: p.estimate });
  }
  const priced = items.filter((i) => i.estimate.status === 'OK');
  const unverified = items.filter((i) => i.estimate.status !== 'OK');
  return { items, knownTotalUsd: Number(priced.reduce((s, i) => s + (i.estimate.total ?? 0), 0).toFixed(6)), unverifiedCount: unverified.length };
}

defineRoute(imageModelRouter, { method: 'post', path: '/image-compare/estimate', summary: 'Estimate a side-by-side comparison (one image per model by default)', tag: 'Image models', minRole: 'VIEWER', body: CompareEstimateBody }, async ({ ws, body }) => compareEstimates(ws.workspaceId, body));

const CompareBody = CompareEstimateBody.extend({
  name: z.string().max(120).default('Comparison'),
  projectId: z.string().max(64).nullable().optional(),
  confirmation: z.object({ acceptedTotalUsd: z.number().min(0), acceptUnverifiedCost: z.boolean().default(false) }),
});

defineRoute(imageModelRouter, { method: 'post', path: '/image-compare', summary: 'Run a confirmed comparison with the same brief across models', tag: 'Image models', body: CompareBody, status: 202 }, async ({ ws, body, req }) => {
  await assertProject(ws.workspaceId, body.projectId);
  const est = await compareEstimates(ws.workspaceId, body);
  const bad = est.items.filter((i) => !i.usable || i.errors.length);
  if (bad.length) throw badRequest('Some models cannot run with these settings.', { models: bad.map((b) => ({ model: b.displayName, usable: b.usable, errors: b.errors })) });
  if (body.confirmation.acceptedTotalUsd + 1e-9 < est.knownTotalUsd) throw new HttpError(409, 'CONFIRMATION_REQUIRED', `The estimated total is $${est.knownTotalUsd}; confirm that amount.`, est);
  if (est.unverifiedCount && !body.confirmation.acceptUnverifiedCost) throw new HttpError(409, 'CONFIRMATION_REQUIRED', `${est.unverifiedCount} model(s) have no verified price. Confirm that you accept an unverified cost.`, est);
  const cmp = await prisma.modelComparison.create({ data: { workspaceId: ws.workspaceId, projectId: body.projectId ?? null, name: body.name, request: body.request as Prisma.InputJsonValue, modelIds: est.items.map((i) => i.modelId), status: 'RUNNING', createdById: ws.user.id } });
  const job = await createJob({
    workspaceId: ws.workspaceId,
    projectId: body.projectId ?? null,
    exclusive: false,
    type: 'MODEL_COMPARE',
    userId: ws.user.id,
    usesAi: est.items.some((i) => i.provider !== 'mock'),
    input: {
      purpose: 'COMPARISON',
      userId: ws.user.id,
      comparisonId: cmp.id,
      items: est.items.map((i) => ({ key: i.modelId, modelId: i.modelId, request: body.request, confirmation: { acceptedEstimateUsd: i.estimate.total, acceptUnverifiedCost: i.estimate.status !== 'OK' } })),
    } as Prisma.InputJsonValue,
  });
  await audit(req, 'image.compare', 'ModelComparison', cmp.id, { models: est.items.map((i) => i.endpointId), knownTotalUsd: est.knownTotalUsd });
  return { comparisonId: cmp.id, jobId: job.id, estimate: est };
});

defineRoute(imageModelRouter, { method: 'get', path: '/image-compare', summary: 'List comparisons', tag: 'Image models' }, async ({ ws }) =>
  prisma.modelComparison.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { createdAt: 'desc' }, take: 50 }),
);

defineRoute(imageModelRouter, { method: 'get', path: '/image-compare/:id', summary: 'Comparison results with actual cost per model', tag: 'Image models', params: IdParams }, async ({ ws, params }) => {
  const c = await prisma.modelComparison.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId }, include: { generations: { include: { model: { select: { displayName: true, endpointId: true } } }, orderBy: { createdAt: 'asc' } } } });
  if (!c) throw notFound('Comparison');
  return c;
});

defineRoute(imageModelRouter, { method: 'post', path: '/image-compare/:id/rate', summary: 'Record a rating/notes for a model in a comparison', tag: 'Image models', params: IdParams, body: z.object({ modelId: z.string().max(64), rating: z.number().int().min(1).max(5), notes: z.string().max(1000).default('') }) }, async ({ ws, params, body }) => {
  const c = await prisma.modelComparison.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } });
  if (!c) throw notFound('Comparison');
  if (!c.modelIds.includes(body.modelId)) throw badRequest('Model is not part of this comparison.');
  const ratings = { ...((c.ratings as Record<string, unknown>) ?? {}), [body.modelId]: { rating: body.rating, notes: body.notes, by: ws.user.id, at: new Date().toISOString() } };
  return prisma.modelComparison.update({ where: { id: c.id }, data: { ratings: ratings as Prisma.InputJsonValue } });
});

defineRoute(imageModelRouter, { method: 'post', path: '/image-models/preferred', summary: 'Set the preferred image model for the workspace or a project', tag: 'Image models', minRole: 'EDITOR', body: z.object({ modelId: z.string().max(64).nullable(), projectId: z.string().max(64).nullable().optional() }) }, async ({ ws, body, req }) => {
  if (body.modelId) {
    const m = await getModel(body.modelId);
    if (!m) throw notFound('Model');
    body.modelId = m.id;
  }
  if (body.projectId) {
    await assertProject(ws.workspaceId, body.projectId);
    await prisma.project.update({ where: { id: body.projectId }, data: { preferredImageModelId: body.modelId } });
  } else {
    if (ws.role !== 'OWNER' && ws.role !== 'ADMIN') throw forbidden('Only workspace admins can set the workspace default model.');
    await prisma.workspace.update({ where: { id: ws.workspaceId }, data: { preferredImageModelId: body.modelId } });
  }
  await audit(req, 'image.preferred', body.projectId ? 'Project' : 'Workspace', body.projectId ?? ws.workspaceId, { modelId: body.modelId });
  return { ok: true };
});

/* ------------------------------ Platform admin ---------------------------- */

defineRoute(imageModelRouter, { method: 'post', path: '/admin/image-models/sync', summary: 'Sync catalog (fal Platform API) and prices now', tag: 'Image models admin', auth: 'user', body: z.object({ discover: z.boolean().default(false), pricing: z.boolean().default(true) }) }, async ({ req, body }) => {
  await requirePlatformAdmin(req);
  const r = await syncCatalog(body);
  await audit(req, 'imageCatalog.sync', 'ImageModel', null, { verified: r.verified.length, errors: r.errors.length });
  return r;
});

defineRoute(imageModelRouter, { method: 'post', path: '/admin/image-models/usage-sync', summary: 'Pull provider-reported usage/cost (requires FAL_ADMIN_KEY)', tag: 'Image models admin', auth: 'user', body: z.object({ days: z.number().int().min(1).max(90).default(7) }) }, async ({ req, body }) => {
  await requirePlatformAdmin(req);
  return syncProviderUsage(body.days);
});

const AdminPatch = z.object({
  enabled: z.boolean().optional(),
  editorialTags: z.array(z.enum(EDITORIAL_TAGS)).optional(),
  knownLimitations: z.string().max(2000).optional(),
  adminNotes: z.string().max(2000).optional(),
  commercialUseUrl: z.string().url().startsWith('https://').or(z.literal('')).optional(),
  commercialUseNote: z.string().max(1000).optional(),
  thumbnailUrl: z.string().url().startsWith('https://').or(z.literal('')).optional(),
  displayName: z.string().min(1).max(120).optional(),
});

defineRoute(imageModelRouter, { method: 'patch', path: '/admin/image-models/:id', summary: 'Edit catalog entry (enable, tags, limitations, commercial-use link)', tag: 'Image models admin', auth: 'user', params: IdParams, body: AdminPatch }, async ({ req, params, body }) => {
  await requirePlatformAdmin(req);
  const m = await getModel(params.id);
  if (!m) throw notFound('Model');
  if (body.enabled && !(m.availability === 'VERIFIED' || m.availability === 'OFFLINE_MOCK')) throw new HttpError(409, 'MODEL_NOT_VERIFIED', 'Only models verified against the provider catalog (with an input schema) can be enabled. Run a catalog sync.');
  if (body.enabled && !m.capabilities) throw new HttpError(409, 'MODEL_NOT_VERIFIED', 'This model has no input schema yet; it cannot be enabled.');
  const u = await prisma.imageModel.update({ where: { id: m.id }, data: body, include: { prices: { where: { isCurrent: true } } } });
  await audit(req, 'imageModel.update', 'ImageModel', m.id, body as Prisma.InputJsonValue);
  return modelDto(u);
});

const ManualPrice = z.object({
  unitPrice: z.number().min(0).max(1000),
  unitRaw: z.string().min(1).max(60),
  currency: z.string().length(3).default('USD'),
  sourceUrl: z.string().url().startsWith('https://'),
  assumptions: PricingAssumptions.partial().default({}),
});

defineRoute(imageModelRouter, { method: 'post', path: '/admin/image-models/:id/price', summary: 'Record an admin-verified price (source URL required); keeps history', tag: 'Image models admin', auth: 'user', params: IdParams, body: ManualPrice }, async ({ req, params, body, auth }) => {
  await requirePlatformAdmin(req);
  const m = await getModel(params.id);
  if (!m) throw notFound('Model');
  if (m.provider === 'mock') throw badRequest('Built-in mock models are free and cannot be priced.');
  const n = normalizeUnit(body.unitRaw);
  const assumptions = PricingAssumptions.parse({ unitScale: n.unitScale, ...body.assumptions });
  await prisma.$transaction([
    prisma.imageModelPrice.updateMany({ where: { modelId: m.id, isCurrent: true }, data: { isCurrent: false } }),
    prisma.imageModelPrice.create({ data: { modelId: m.id, unitPrice: new Prisma.Decimal(body.unitPrice), unitRaw: body.unitRaw, billingUnit: n.billingUnit, currency: body.currency.toUpperCase(), source: 'ADMIN_MANUAL', sourceUrl: body.sourceUrl, retrievedAt: new Date(), assumptions: assumptions as Prisma.InputJsonValue, createdById: auth.user.id } }),
  ]);
  await audit(req, 'imageModel.price', 'ImageModel', m.id, body as unknown as Prisma.InputJsonValue);
  return modelDto((await getModel(m.id))!);
});

defineRoute(imageModelRouter, { method: 'patch', path: '/admin/image-models/:id/assumptions', summary: 'Edit pricing assumptions on the current price (e.g. tokens per image, surcharges)', tag: 'Image models admin', auth: 'user', params: IdParams, body: PricingAssumptions.partial() }, async ({ req, params, body }) => {
  await requirePlatformAdmin(req);
  const m = await getModel(params.id);
  const cur = m?.prices.find((p) => p.isCurrent);
  if (!m || !cur) throw notFound('Current price');
  const assumptions = PricingAssumptions.parse({ ...(cur.assumptions as object), ...body });
  await prisma.imageModelPrice.update({ where: { id: cur.id }, data: { assumptions: assumptions as Prisma.InputJsonValue } });
  await audit(req, 'imageModel.assumptions', 'ImageModel', m.id, body as Prisma.InputJsonValue);
  return modelDto((await getModel(m.id))!);
});
