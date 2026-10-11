import {
  aspectFor,
  AUDIENCE_PRESETS,
  Audience,
  buildColoringDocument,
  buildColoringPrompt,
  COLORING_METADATA_CHECKLIST,
  ColoringInteriorSettings,
  defaultSpecSource,
  findRepeatedConcepts,
  findTrim,
  imageSize,
  MetadataDraft,
  qcThresholdsFor,
  QcThresholds,
  sha256,
  STYLE_PRESETS,
  StyleProfile,
  THEME_PRESETS,
  type CostEstimate,
  type ModelCapabilities,
  type PreflightReport,
} from '@kdp/core';
import { Prisma, type ColoringBook, type ColoringPage, type ColoringPageVersion, type GenerationJob, type Project } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { getStorage } from '../lib/storage';
import { ProviderError } from '../providers/types';
import { buildAndValidate, currentMetadata } from './build';
import { analyzeColoringImage, hamming, processColoringImage, ProcessingOptions, type Placement, type QcResult } from './coloring-image';
import { Confirmation, prepareGeneration, runGeneration, type NormalizedRequestInput } from './image-generation';
import { saveDocument } from './interior';
import { createProject } from './projects';

/* ------------------------------------------- Inputs ---------------------------------------- */

export const CreateColoringBookInput = z.object({
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().max(200).default(''),
  author: z.string().trim().min(1).max(200),
  audience: Audience,
  theme: z.string().max(60).default(''),
  description: z.string().max(2000).default(''),
  language: z.string().max(40).default('English'),
  ageRange: z.string().max(20).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  illustrationTarget: z.number().int().min(1).max(300),
  pageTarget: z.number().int().min(24).max(828).optional(),
  seriesName: z.string().max(120).default(''),
  seriesNumber: z.number().int().min(1).max(999).nullable().default(null),
  trimId: z.string().max(20).default('8.5x11'),
  interior: ColoringInteriorSettings.partial().default({}),
  style: StyleProfile.partial().optional(),
  styleProfileId: z.string().max(64).nullable().optional(),
  modelId: z.string().max(64).nullable().optional(),
  budgetCapUsd: z.number().min(0).max(100000).nullable().optional(),
  concepts: z.array(z.string().trim().min(2).max(300)).max(300).optional(),
});
export type CreateColoringBookInput = z.infer<typeof CreateColoringBookInput>;

export type BookWithProject = ColoringBook & { project: Project & { format: { trimId: string; bleed: boolean } | null } };

export async function getBook(workspaceId: string, id: string): Promise<BookWithProject> {
  const b = await prisma.coloringBook.findFirst({ where: { OR: [{ id }, { projectId: id }], workspaceId }, include: { project: { include: { format: { select: { trimId: true, bleed: true } } } } } });
  if (!b) throw notFound('Coloring book');
  return b as BookWithProject;
}

export const styleOf = (b: ColoringBook) => StyleProfile.parse(b.styleProfile);
export const interiorOf = (b: ColoringBook) => ColoringInteriorSettings.parse(b.interiorSettings);
export const thresholdsOf = (b: ColoringBook) => QcThresholds.parse(b.qcThresholds);

/** The box an illustration is fitted into (live area × scale) — basis for DPI and line math. */
export function placementFor(b: BookWithProject): Placement {
  const trim = findTrim(defaultSpecSource.getLibrary(), b.project.format?.trimId ?? '8.5x11');
  const s = interiorOf(b);
  const w = s.fullBleed ? trim.widthIn + 0.125 : trim.widthIn - s.marginsIn.inside - s.marginsIn.outside;
  const h = s.fullBleed ? trim.heightIn + 0.25 : trim.heightIn - s.marginsIn.top - s.marginsIn.bottom;
  return { widthIn: w * s.scale, heightIn: h };
}

export async function createColoringBook(workspaceId: string, userId: string, input: CreateColoringBookInput) {
  const preset = AUDIENCE_PRESETS[input.audience];
  let style = StyleProfile.parse({ ...preset.style, ...(input.style ?? {}) });
  if (input.styleProfileId) {
    const saved = await prisma.coloringStyleProfile.findFirst({ where: { id: input.styleProfileId, workspaceId } });
    if (!saved) throw notFound('Style profile');
    style = StyleProfile.parse({ ...(saved.profile as object), ...(input.style ?? {}) });
  }
  const interior = ColoringInteriorSettings.parse(input.interior);
  const themeLabel = THEME_PRESETS[input.theme]?.label ?? input.theme;
  const styleLabel = STYLE_PRESETS[style.styleId]?.label ?? style.styleId;
  const project = await createProject(workspaceId, userId, {
    brief: {
      workingTitle: input.title,
      category: 'COLORING_BOOK',
      targetReader: `${preset.label} (ages ${input.ageRange || preset.ageRange})`,
      readerProblem: input.description || `A ${themeLabel || 'themed'} coloring book for ${preset.label.toLowerCase()}`,
      niche: themeLabel || 'coloring',
      differentiation: (input.description.length >= 20 ? input.description : `Original ${styleLabel.toLowerCase()} illustrations for ${preset.label.toLowerCase()}, ${input.illustrationTarget} pages${interior.singleSided ? ', printed single-sided' : ''}.`).slice(0, 2000),
      language: input.language,
      marketplace: 'Amazon.com',
      authorName: input.author,
      contentStyle: styleLabel,
      designTheme: 'midnight',
      contentType: 'COLORING',
    },
    format: { format: 'PAPERBACK', trimId: input.trimId, ink: 'BLACK_WHITE', paper: 'WHITE', bleed: interior.fullBleed, coverFinish: 'MATTE', direction: 'LTR', targetPageCount: input.pageTarget ?? null },
    generation: { outline: false, content: false, interior: false, coverConcept: false, titleSuggestions: false, metadata: false, similarity: true, validate: true },
  });
  const { row, data } = await currentMetadata(project.id);
  if (row) await prisma.metadataDraft.update({ where: { id: row.id }, data: { data: MetadataDraft.parse({ ...data, subtitle: input.subtitle, description: data.description || input.description, seriesName: input.seriesName, seriesNumber: input.seriesName ? input.seriesNumber : null }) as unknown as Prisma.InputJsonValue } });
  if (input.budgetCapUsd != null) await prisma.project.update({ where: { id: project.id }, data: { aiSpendLimitUsd: new Prisma.Decimal(input.budgetCapUsd) } });
  const book = await prisma.coloringBook.create({
    data: {
      workspaceId,
      projectId: project.id,
      audience: input.audience,
      theme: input.theme,
      description: input.description,
      ageRange: input.ageRange || preset.ageRange,
      difficulty: input.difficulty ?? preset.difficulty,
      illustrationTarget: input.illustrationTarget,
      seriesName: input.seriesName,
      seriesNumber: input.seriesNumber,
      styleProfile: style as unknown as Prisma.InputJsonValue,
      styleProfileId: input.styleProfileId ?? null,
      modelId: input.modelId ?? null,
      interiorSettings: interior as unknown as Prisma.InputJsonValue,
      qcThresholds: qcThresholdsFor(style) as unknown as Prisma.InputJsonValue,
      budgetCapUsd: input.budgetCapUsd != null ? new Prisma.Decimal(input.budgetCapUsd) : null,
      createdById: userId,
    },
  });
  if (input.concepts?.length) await addPages(book, input.concepts);
  return book;
}

/* --------------------------------------- Page plan ----------------------------------------- */

export async function addPages(book: ColoringBook, concepts: string[]) {
  const style = styleOf(book);
  const last = await prisma.coloringPage.aggregate({ where: { bookId: book.id }, _max: { position: true } });
  let pos = (last._max.position ?? -1) + 1;
  const rows = concepts.map((c) => {
    const p = buildColoringPrompt(c, style, { audience: book.audience as Audience });
    return { bookId: book.id, position: pos++, concept: c, prompt: p.prompt, negativePrompt: p.negativePrompt, promptVersion: p.version, referenceAssetIds: style.referenceAssetIds };
  });
  if (rows.length) await prisma.coloringPage.createMany({ data: rows });
  await prisma.coloringBook.update({ where: { id: book.id }, data: { stage: book.stage === 'SETUP' ? 'PLANNING' : book.stage } });
  return rows.length;
}

/** Concepts from a theme preset (deterministic, cycling with numbered variations when needed). */
export function themeConcepts(theme: string, n: number, exclude: string[] = []): string[] {
  const list = THEME_PRESETS[theme]?.concepts ?? [];
  if (!list.length) return [];
  const out: string[] = [];
  const used = new Set(exclude.map((x) => x.toLowerCase()));
  for (let i = 0; out.length < n && i < n * 4; i++) {
    const base = list[i % list.length];
    const round = Math.floor(i / list.length);
    const c = round === 0 ? base : `${base} (variation ${round + 1})`;
    if (!used.has(c.toLowerCase())) {
      used.add(c.toLowerCase());
      out.push(c);
    }
  }
  return out;
}

/** Rebuild prompts for pages whose prompt was not hand-edited (after a style change). */
export async function rebuildPrompts(book: ColoringBook) {
  const style = styleOf(book);
  const pages = await prisma.coloringPage.findMany({ where: { bookId: book.id, promptEdited: false } });
  for (const p of pages) {
    const b = buildColoringPrompt(p.concept, style, { audience: book.audience as Audience });
    await prisma.coloringPage.update({ where: { id: p.id }, data: { prompt: b.prompt, negativePrompt: b.negativePrompt, promptVersion: b.version, referenceAssetIds: style.referenceAssetIds } });
  }
  return pages.length;
}

/* ------------------------------------ Generation requests ---------------------------------- */

export type GenMode = 'NEW' | 'VARIATION' | 'EDIT';

async function currentVersion(page: ColoringPage) {
  return page.currentVersionId ? prisma.coloringPageVersion.findUnique({ where: { id: page.currentVersionId } }) : null;
}

/** Translate a page into a model request that the model's own schema accepts. */
export async function requestForPage(book: BookWithProject, page: ColoringPage, modelId: string, mode: GenMode, variation = 0): Promise<NormalizedRequestInput> {
  const model = await prisma.imageModel.findFirst({ where: { OR: [{ id: modelId }, { endpointId: modelId }] } });
  if (!model) throw badRequest('Unknown image model.');
  const caps = model.capabilities as unknown as ModelCapabilities | null;
  if (!caps) throw conflict(`${model.displayName} has not been verified (no input schema).`);
  const style = styleOf(book);
  const trim = findTrim(defaultSpecSource.getLibrary(), book.project.format?.trimId ?? '8.5x11');
  const aspect = aspectFor(style, trim);
  const long = Math.min(2048, caps.imageSize?.maxDimension ?? 2048);
  const widthPx = Math.round((aspect >= 1 ? long : long * aspect) / 16) * 16;
  const heightPx = Math.round((aspect >= 1 ? long / aspect : long) / 16) * 16;
  const built = page.promptEdited || mode === 'NEW' ? { prompt: page.prompt, negativePrompt: page.negativePrompt } : buildColoringPrompt(page.concept, style, { audience: book.audience as Audience, variation: variation || undefined, edit: mode === 'EDIT' });
  const prompt = mode === 'VARIATION' && page.promptEdited ? `${page.prompt}, variation ${variation}, different pose and arrangement` : built.prompt;
  const req: NormalizedRequestInput = { prompt, aspect, widthPx: caps.imageSize ? widthPx : null, heightPx: caps.imageSize ? heightPx : null, numImages: 1, seed: mode === 'VARIATION' ? (Date.now() % 2 ** 30) : null };
  if (caps.negativePromptParam) req.negativePrompt = built.negativePrompt;
  if (caps.seedParam === null) req.seed = null;
  if (mode === 'EDIT') {
    const v = await currentVersion(page);
    if (!v) throw badRequest('This page has no image to edit yet.');
    if (caps.imageUrlParam) req.sourceAssetId = v.originalAssetId;
    else if (caps.imageUrlsParam) req.referenceAssetIds = [v.originalAssetId];
    else throw badRequest(`${model.displayName} does not accept a source image; choose an editing / image-to-image model.`);
  } else if (page.referenceAssetIds.length && caps.imageUrlsParam && caps.tasks.includes('reference')) {
    req.referenceAssetIds = page.referenceAssetIds.slice(0, caps.imageUrlsParam.maxItems ?? 4);
  }
  return req;
}

export interface BatchEstimate {
  modelId: string;
  pages: { pageId: string; position: number; estimate: CostEstimate; errors: string[] }[];
  knownTotalUsd: number;
  unverifiedCount: number;
  perImageUsd: number | null;
  table: { quantity: number; total: number | null }[];
  budget: { capUsd: number | null; spentUsd: number; remainingUsd: number | null; exceeds: boolean };
}

export async function spentOnBook(book: ColoringBook) {
  const agg = await prisma.coloringPageVersion.aggregate({ where: { page: { bookId: book.id } }, _sum: { estimatedCostUsd: true, actualCostUsd: true } });
  return { estimatedUsd: Number(agg._sum.estimatedCostUsd ?? 0), actualUsd: Number(agg._sum.actualCostUsd ?? 0) };
}

export async function estimateBatch(book: BookWithProject, pageIds: string[], modelId: string, mode: GenMode): Promise<BatchEstimate> {
  const pages = await prisma.coloringPage.findMany({ where: { bookId: book.id, id: { in: pageIds } }, orderBy: { position: 'asc' } });
  if (pages.length !== new Set(pageIds).size) throw badRequest('Some pages do not belong to this book.');
  const out: BatchEstimate['pages'] = [];
  for (const p of pages) {
    const req = await requestForPage(book, p, modelId, mode, 1);
    const prep = await prepareGeneration(book.workspaceId, modelId, req, { resolveAssets: false });
    out.push({ pageId: p.id, position: p.position, estimate: prep.estimate, errors: prep.errors });
  }
  const known = out.filter((x) => x.estimate.status === 'OK').reduce((s, x) => s + (x.estimate.total ?? 0), 0);
  const per = out.find((x) => x.estimate.perImage !== null)?.estimate.perImage ?? null;
  const spent = await spentOnBook(book);
  const cap = book.budgetCapUsd !== null ? Number(book.budgetCapUsd) : null;
  return {
    modelId,
    pages: out,
    knownTotalUsd: Math.round(known * 1e6) / 1e6,
    unverifiedCount: out.filter((x) => x.estimate.status !== 'OK').length,
    perImageUsd: per,
    table: [1, 4, 10, 50, 100].map((q) => ({ quantity: q, total: per === null ? null : Math.round(per * q * 1e6) / 1e6 })),
    budget: { capUsd: cap, spentUsd: Math.max(spent.actualUsd, spent.estimatedUsd), remainingUsd: cap === null ? null : Math.max(0, cap - Math.max(spent.actualUsd, spent.estimatedUsd)), exceeds: cap !== null && Math.max(spent.actualUsd, spent.estimatedUsd) + known > cap + 1e-9 },
  };
}

/* -------------------------------------- Versions & QC -------------------------------------- */

async function storeAsset(book: ColoringBook, bytes: Uint8Array, name: string, source: 'AI' | 'SYSTEM' | 'UPLOAD', licenseNote: string, meta: Record<string, unknown>) {
  const size = imageSize(bytes);
  if (!size) throw badRequest('Only PNG or JPEG images are supported.');
  const key = `ws/${book.workspaceId}/projects/${book.projectId}/coloring/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${name}.${size.mimeType === 'image/png' ? 'png' : 'jpg'}`;
  await getStorage().put(key, bytes, size.mimeType);
  return prisma.asset.create({ data: { workspaceId: book.workspaceId, projectId: book.projectId, kind: 'IMAGE', filename: `${name}.${size.mimeType === 'image/png' ? 'png' : 'jpg'}`, mimeType: size.mimeType, sizeBytes: bytes.byteLength, storageKey: key, sha256: sha256(bytes), widthPx: size.widthPx, heightPx: size.heightPx, source, licenseNote, meta: meta as Prisma.InputJsonValue } });
}

/** Process (preserving the original) and run QC; returns the updated version. */
export async function processVersion(book: BookWithProject, version: ColoringPageVersion, opts: Partial<ProcessingOptions> = {}): Promise<ColoringPageVersion> {
  const o = ProcessingOptions.parse(opts);
  const original = await prisma.asset.findUniqueOrThrow({ where: { id: version.originalAssetId } });
  const bytes = await getStorage().get(original.storageKey);
  const placement = placementFor(book);
  const t = thresholdsOf(book);
  let processedId: string | null = null;
  let steps: string[] = [];
  let qc: QcResult;
  try {
    const p = await processColoringImage(bytes, placement, o);
    steps = p.steps;
    const a = await storeAsset(book, p.bytes, `page-${version.pageId.slice(-6)}-v${version.version}-processed`, 'SYSTEM', `Processed from asset ${original.id}: ${steps.join('; ')}.`, { coloringVersionId: version.id, processedFrom: original.id });
    processedId = a.id;
    qc = await analyzeColoringImage(p.bytes, placement, t);
  } catch (e) {
    // Corrupt input: record the failed decode instead of throwing away the version.
    qc = await analyzeColoringImage(bytes, placement, t);
    steps = [`processing failed: ${(e as Error).message}`];
  }
  return prisma.coloringPageVersion.update({ where: { id: version.id }, data: { processedAssetId: processedId, processing: { options: o, steps, at: new Date().toISOString() } as Prisma.InputJsonValue, qc: qc as unknown as Prisma.InputJsonValue, dhash: qc.dhash } });
}

export async function addVersion(book: BookWithProject, page: ColoringPage, data: { source: 'AI' | 'UPLOAD' | 'MOCK'; originalAssetId: string; generationId?: string | null; prompt?: string; negativePrompt?: string; modelId?: string | null; params?: unknown; estimatedCostUsd?: number | null; actualCostUsd?: number | null; userId?: string | null }, processing?: Partial<ProcessingOptions>) {
  const last = await prisma.coloringPageVersion.aggregate({ where: { pageId: page.id }, _max: { version: true } });
  const v = await prisma.coloringPageVersion.create({
    data: {
      pageId: page.id,
      version: (last._max.version ?? 0) + 1,
      source: data.source,
      generationId: data.generationId ?? null,
      prompt: data.prompt ?? page.prompt,
      negativePrompt: data.negativePrompt ?? page.negativePrompt,
      modelId: data.modelId ?? null,
      params: (data.params ?? {}) as Prisma.InputJsonValue,
      originalAssetId: data.originalAssetId,
      estimatedCostUsd: data.estimatedCostUsd != null ? new Prisma.Decimal(data.estimatedCostUsd.toFixed(6)) : null,
      actualCostUsd: data.actualCostUsd != null ? new Prisma.Decimal(data.actualCostUsd.toFixed(6)) : null,
      createdById: data.userId ?? null,
    },
  });
  const processed = await processVersion(book, v, processing ?? defaultProcessing(book));
  await prisma.coloringPage.update({ where: { id: page.id }, data: { currentVersionId: v.id, status: 'NEEDS_REVIEW', error: null, qcOverride: Prisma.DbNull } });
  return processed;
}

export function defaultProcessing(book: ColoringBook): Partial<ProcessingOptions> {
  const p = (book.metadataExtras as { processing?: Partial<ProcessingOptions> } | null)?.processing;
  return p ?? {};
}

/* ---------------------------------------- Generation job ----------------------------------- */

export const ColoringJobInput = z.object({
  bookId: z.string(),
  modelId: z.string(),
  mode: z.enum(['NEW', 'VARIATION', 'EDIT']),
  userId: z.string().nullable().optional(),
  items: z.array(z.object({ pageId: z.string(), request: z.record(z.unknown()), confirmation: Confirmation })).min(1).max(300),
});

/**
 * Generates one image per page. Finished pages are recorded in the job result and skipped on
 * retry; a stored provider request id is resumed rather than re-submitted. The book's budget cap
 * is checked before every page, using estimated cost (actual when reported).
 */
export async function runColoringJob(job: GenerationJob, isCancelled: () => Promise<boolean>, log: (m: string) => void, signal: AbortSignal) {
  const input = ColoringJobInput.parse(job.input);
  const book = await getBook(job.workspaceId, input.bookId);
  const result = ((job.result as Record<string, unknown>) ?? {}) as { pages?: Record<string, { status: string; versionId?: string; error?: string; retryable?: boolean }> };
  const done = result.pages ?? {};
  let retryable: Error | null = null;
  const cap = book.budgetCapUsd !== null ? Number(book.budgetCapUsd) : null;
  for (const [i, it] of input.items.entries()) {
    const prev = done[it.pageId];
    if (prev?.status === 'SUCCEEDED' || (prev?.status === 'FAILED' && !prev.retryable) || prev?.status === 'SKIPPED_BUDGET') continue;
    if (await isCancelled()) break;
    const page = await prisma.coloringPage.findFirst({ where: { id: it.pageId, bookId: book.id } });
    if (!page) continue;
    const est = it.confirmation.acceptedEstimateUsd ?? 0;
    const existingGen = await prisma.imageGeneration.findFirst({ where: { jobId: job.id, settings: { path: ['__key'], equals: it.pageId } }, select: { id: true, requestId: true } });
    if (cap !== null && !existingGen?.requestId) {
      const spent = await spentOnBook(book);
      if (Math.max(spent.estimatedUsd, spent.actualUsd) + est > cap + 1e-9) {
        done[it.pageId] = { status: 'SKIPPED_BUDGET', error: `Budget cap $${cap} reached.` };
        await prisma.coloringPage.update({ where: { id: page.id }, data: { status: page.currentVersionId ? page.status : 'PLANNED', error: `Not generated: budget cap $${cap} reached.` } });
        log(`Page ${page.position + 1}: skipped — budget cap $${cap} would be exceeded.`);
        continue;
      }
    }
    await prisma.coloringPage.update({ where: { id: page.id }, data: { status: 'GENERATING', error: null } });
    try {
      const gen = await runGeneration({ workspaceId: job.workspaceId, projectId: book.projectId, userId: input.userId ?? job.createdById, jobId: job.id, purpose: 'COLORING_PAGE', modelId: input.modelId, request: it.request as NormalizedRequestInput, confirmation: it.confirmation, generationId: existingGen?.id ?? null, generationKey: it.pageId, signal, log, assetKind: 'IMAGE' });
      const model = await prisma.imageModel.findUnique({ where: { id: gen.modelId ?? "" }, select: { provider: true } });
      const fresh = await prisma.coloringPage.findUniqueOrThrow({ where: { id: page.id } });
      const v = await addVersion(book, fresh, {
        source: model?.provider === 'mock' ? 'MOCK' : 'AI',
        originalAssetId: gen.assetIds[0],
        generationId: gen.id,
        prompt: String((it.request as { prompt?: string }).prompt ?? page.prompt),
        negativePrompt: String((it.request as { negativePrompt?: string }).negativePrompt ?? ''),
        modelId: gen.modelId,
        params: { mode: input.mode, request: { ...it.request, sourceAssetId: undefined } },
        estimatedCostUsd: gen.estimatedCostUsd !== null ? Number(gen.estimatedCostUsd) : null,
        actualCostUsd: gen.actualCostUsd !== null ? Number(gen.actualCostUsd) : null,
        userId: input.userId,
      });
      done[it.pageId] = { status: 'SUCCEEDED', versionId: v.id };
      log(`Page ${page.position + 1}: version ${v.version} ready (QC: ${(v.qc as unknown as QcResult)?.summary.warn ?? 0} warning(s)).`);
    } catch (e) {
      const err = e as Error;
      const isRetry = err instanceof ProviderError && err.retryable;
      done[it.pageId] = { status: 'FAILED', error: err.message.slice(0, 500), retryable: isRetry };
      await prisma.coloringPage.update({ where: { id: page.id }, data: { status: page.currentVersionId ? 'NEEDS_REVIEW' : 'FAILED', error: err.message.slice(0, 500) } });
      log(`Page ${page.position + 1} failed: ${err.message}`);
      if (isRetry) retryable = err;
      if (err instanceof HttpError && err.status === 429) {
        log('Spending limit reached; stopping the batch.');
        break;
      }
    }
    await prisma.generationJob.update({ where: { id: job.id }, data: { result: { ...result, pages: done } as Prisma.InputJsonValue, progress: Math.round(((i + 1) / input.items.length) * 100) } });
  }
  await prisma.coloringPage.updateMany({ where: { bookId: book.id, status: { in: ['QUEUED', 'GENERATING'] }, id: { in: input.items.map((x) => x.pageId) } }, data: { status: 'PLANNED' } });
  await prisma.coloringBook.update({ where: { id: book.id }, data: { stage: 'REVIEW' } });
  if (retryable) throw retryable;
  const states = Object.values(done);
  if (states.length && states.every((s) => s.status === 'FAILED')) throw new Error(`All ${states.length} page(s) failed: ${states[0].error}`);
}

/* ------------------------------------------ DTOs ------------------------------------------- */

export async function bookDetail(book: BookWithProject) {
  const pages = await prisma.coloringPage.findMany({ where: { bookId: book.id }, orderBy: { position: 'asc' }, include: { versions: { orderBy: { version: 'desc' } } } });
  const t = thresholdsOf(book);
  const current = pages.map((p) => ({ p, v: p.versions.find((v) => v.id === p.currentVersionId) ?? null }));
  const similar: Record<string, { pageId: string; position: number; distance: number }[]> = {};
  for (const a of current)
    for (const b of current) {
      if (a.p.id >= b.p.id || !a.v?.dhash || !b.v?.dhash) continue;
      const d = hamming(a.v.dhash, b.v.dhash);
      if (d <= t.duplicateHamming) {
        (similar[a.p.id] ??= []).push({ pageId: b.p.id, position: b.p.position, distance: d });
        (similar[b.p.id] ??= []).push({ pageId: a.p.id, position: a.p.position, distance: d });
      }
    }
  const repeated = findRepeatedConcepts(pages.map((p) => ({ id: p.id, concept: p.concept })));
  const spent = await spentOnBook(book);
  const counts = pages.reduce<Record<string, number>>((m, p) => ((m[p.status] = (m[p.status] ?? 0) + 1), m), {});
  const jobs = await prisma.generationJob.findMany({ where: { projectId: book.projectId, type: 'COLORING_GENERATE' }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, progress: true, stage: true, error: true, createdAt: true, cancelRequested: true, type: true, attempts: true, maxAttempts: true } });
  return {
    ...book,
    style: styleOf(book),
    interior: interiorOf(book),
    thresholds: t,
    placement: placementFor(book),
    counts,
    approvedCount: counts.APPROVED ?? 0,
    cost: { ...spent, capUsd: book.budgetCapUsd !== null ? Number(book.budgetCapUsd) : null },
    repeatedConcepts: repeated,
    metadataChecklist: COLORING_METADATA_CHECKLIST,
    jobs,
    pages: pages.map((p) => ({ ...p, current: p.versions.find((v) => v.id === p.currentVersionId) ?? null, similarTo: similar[p.id] ?? [] })),
  };
}

/* ---------------------------------------- Interior ----------------------------------------- */

export async function buildInterior(book: BookWithProject) {
  const pages = await prisma.coloringPage.findMany({ where: { bookId: book.id, status: 'APPROVED' }, orderBy: { position: 'asc' } });
  if (!pages.length) throw conflict('Approve at least one page before building the interior.');
  const versions = await prisma.coloringPageVersion.findMany({ where: { id: { in: pages.map((p) => p.currentVersionId!).filter(Boolean) } } });
  const byId = new Map(versions.map((v) => [v.id, v]));
  const items = pages.map((p) => {
    const v = byId.get(p.currentVersionId ?? '');
    if (!v) throw conflict(`Page ${p.position + 1} is approved but has no image.`);
    return { id: p.id, assetId: v.processedAssetId ?? v.originalAssetId, concept: p.concept };
  });
  const { data: md } = await currentMetadata(book.projectId);
  const doc = buildColoringDocument(items, interiorOf(book), { title: md.title || book.project.title, subtitle: md.subtitle ?? '', author: md.author });
  await saveDocument(book.projectId, doc, null);
  await prisma.coloringBook.update({ where: { id: book.id }, data: { stage: 'INTERIOR' } });
  return { illustrations: items.length };
}

/* ------------------------------------ Unified preflight ------------------------------------ */

export async function coloringPreflight(book: BookWithProject) {
  const { build, reportId } = await buildAndValidate(book.project);
  const pf: PreflightReport = { ...build.preflight, results: build.preflight.results.filter((r) => r.status !== 'NOT_APPLICABLE') };
  if (interiorOf(book).singleSided)
    pf.results = pf.results.map((r) => (r.ruleId === 'INT-BLANK-001' && r.status !== 'PASS' ? { ...r, evidence: `${r.evidence} Expected for a single-sided coloring book: each illustration is followed by an intentionally blank reverse page.` } : r));
  const pages = await prisma.coloringPage.findMany({ where: { bookId: book.id, status: 'APPROVED' }, orderBy: { position: 'asc' } });
  const versions = await prisma.coloringPageVersion.findMany({ where: { id: { in: pages.map((p) => p.currentVersionId!).filter(Boolean) } } });
  const visual: { pageId: string; position: number; check: string; message: string; overridden: boolean }[] = [];
  for (const p of pages) {
    const v = versions.find((x) => x.id === p.currentVersionId);
    const qc = v?.qc as unknown as QcResult | null;
    const overridden = new Set(((p.qcOverride as { checks?: string[] } | null)?.checks) ?? []);
    for (const c of qc?.checks ?? []) if (c.status === 'WARN' || c.status === 'FAIL') visual.push({ pageId: p.id, position: p.position, check: c.label, message: c.message, overridden: overridden.has(c.id) });
  }
  const layoutPages = build.layout?.pageCount ?? 0;
  const illustrations = pages.length;
  const automated = pf.results.filter((r) => r.category === 'TECHNICAL' && r.status !== 'NEEDS_HUMAN_REVIEW' && r.sourceVerification !== 'UNVERIFIED');
  const unverified = pf.results.filter((r) => r.sourceVerification === 'UNVERIFIED');
  const manual = [
    ...pf.results.filter((r) => r.status === 'NEEDS_HUMAN_REVIEW' && r.sourceVerification !== 'UNVERIFIED'),
  ];
  const coloringManual = [
    `Inspect every approved page at 100% for stray text, signatures and watermarks (${illustrations} page(s); not automatically detectable).`,
    'Confirm no trademarked or copyrighted characters appear in any illustration or on the cover.',
    'Order a printed proof: line weight and gray levels can look different on KDP paper.',
    'Disclose AI-generated images when KDP asks during publishing.',
  ];
  await prisma.coloringBook.update({ where: { id: book.id }, data: { stage: pf.blocked ? 'PREFLIGHT' : 'READY' } });
  return {
    reportId,
    disclaimer: 'Preflight reduces risk; it is not an approval. Amazon KDP reviews every title and may still reject or request changes.',
    counts: { illustrations, interiorPages: layoutPages, blankReverse: interiorOf(book).singleSided },
    blocked: pf.blocked,
    blockingRuleIds: pf.blockingRuleIds,
    automated,
    visualWarnings: visual,
    manualReview: { rules: manual, coloring: coloringManual },
    officialNeedsVerification: unverified,
    content: pf.results.filter((r) => r.category !== 'TECHNICAL' && r.status !== 'PASS' && r.status !== 'NOT_APPLICABLE' && r.sourceVerification !== 'UNVERIFIED' && r.status !== 'NEEDS_HUMAN_REVIEW'),
  };
}

/* --------------------------------------- Export extras ------------------------------------- */

const csv = (rows: (string | number | null)[][]) => rows.map((r) => r.map((c) => (c === null ? '' : /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n') + '\n';

export async function coloringExportFiles(projectId: string): Promise<{ pagesZip: Uint8Array; promptLog: string; qcJson: string; qcHtml: string } | null> {
  const book = await prisma.coloringBook.findUnique({ where: { projectId } });
  if (!book) return null;
  const pages = await prisma.coloringPage.findMany({ where: { bookId: book.id }, orderBy: { position: 'asc' }, include: { versions: { orderBy: { version: 'asc' } } } });
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const storage = getStorage();
  const log: (string | number | null)[][] = [['page', 'status', 'concept', 'version', 'source', 'model', 'prompt', 'negative_prompt', 'estimated_cost_usd', 'actual_cost_usd', 'created_at', 'original_asset', 'processed_asset']];
  const models = new Map((await prisma.imageModel.findMany({ select: { id: true, endpointId: true } })).map((m) => [m.id, m.endpointId]));
  const qcRows: unknown[] = [];
  for (const p of pages) {
    for (const v of p.versions) {
      log.push([p.position + 1, p.status, p.concept, v.version, v.source, v.modelId ? (models.get(v.modelId) ?? v.modelId) : null, v.prompt, v.negativePrompt, v.estimatedCostUsd !== null ? Number(v.estimatedCostUsd) : null, v.actualCostUsd !== null ? Number(v.actualCostUsd) : null, v.createdAt.toISOString(), v.originalAssetId, v.processedAssetId]);
    }
    const cur = p.versions.find((v) => v.id === p.currentVersionId);
    if (p.status === 'APPROVED' && cur) {
      const n = String(p.position + 1).padStart(3, '0');
      const orig = await prisma.asset.findUnique({ where: { id: cur.originalAssetId } });
      if (orig) zip.file(`original/page-${n}.${orig.mimeType === 'image/png' ? 'png' : 'jpg'}`, await storage.get(orig.storageKey), { date: new Date('2020-01-01') });
      if (cur.processedAssetId) {
        const pr = await prisma.asset.findUnique({ where: { id: cur.processedAssetId } });
        if (pr) zip.file(`print/page-${n}.png`, await storage.get(pr.storageKey), { date: new Date('2020-01-01') });
      }
      qcRows.push({ page: p.position + 1, concept: p.concept, version: cur.version, qc: cur.qc, override: p.qcOverride });
    }
  }
  const qcJson = JSON.stringify({ kind: 'kdp-factory-coloring-qc', note: 'HEURISTIC checks are pixel statistics, not definitive judgements. MANUAL items require human inspection.', pages: qcRows }, null, 2);
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const qcHtml = `<!doctype html><meta charset="utf-8"><title>Coloring QC report</title><style>body{font:14px system-ui;margin:2rem}td,th{border:1px solid #ccc;padding:4px 6px;vertical-align:top}table{border-collapse:collapse}.WARN{background:#fff3cd}.FAIL{background:#f8d7da}.MANUAL{background:#e2e3f5}</style><h1>Coloring page QC</h1><p>Heuristic checks are pixel statistics, not definitive judgements. Manual items must be inspected by a person. This report does not guarantee KDP acceptance.</p>${(qcRows as { page: number; concept: string; version: number; qc: QcResult | null; override: unknown }[]).map((r) => `<h2>Page ${r.page}: ${esc(r.concept)} (v${r.version})</h2><table><tr><th>Check</th><th>Kind</th><th>Status</th><th>Detail</th></tr>${(r.qc?.checks ?? []).map((c) => `<tr class="${c.status}"><td>${esc(c.label)}</td><td>${c.kind}</td><td>${c.status}</td><td>${esc(c.message)}</td></tr>`).join('')}</table>${r.override ? `<p><em>Override recorded: ${esc(JSON.stringify(r.override))}</em></p>` : ''}`).join('')}`;
  return { pagesZip: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), promptLog: csv(log), qcJson, qcHtml };
}
