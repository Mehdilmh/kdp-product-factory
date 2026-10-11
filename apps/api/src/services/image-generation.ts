import { buildModelInput, imageSize, sha256, type CostEstimate, type JsonSchema, type ModelCapabilities, type NormalizedImageRequest } from '@kdp/core';
import { Prisma, type ImageGeneration } from '@prisma/client';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { decryptSecret } from '../lib/crypto';
import { badRequest, conflict, HttpError } from '../lib/errors';
import { getStorage } from '../lib/storage';
import { falCancel, falClient, falSdkOverrides, falSubmit, falWait } from '../providers/fal-sdk';
import { assertWithinQuota, providerOverrides } from '../providers/gateway';
import { mockImage } from '../providers/mock';
import { withRetry, withTimeout } from '../providers/retry';
import { ProviderError } from '../providers/types';
import { estimateFor, getModel, toModelPrice, type ModelWithPrice } from './image-catalog';

export const NormalizedRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  negativePrompt: z.string().max(4000).nullable().optional(),
  aspect: z.number().positive().max(10).nullable().optional(),
  widthPx: z.number().int().min(64).max(16384).nullable().optional(),
  heightPx: z.number().int().min(64).max(16384).nullable().optional(),
  imageSizePreset: z.string().max(40).nullable().optional(),
  aspectRatio: z.string().max(10).nullable().optional(),
  resolution: z.string().max(10).nullable().optional(),
  quality: z.string().max(40).nullable().optional(),
  numImages: z.number().int().min(1).max(8).default(1),
  seed: z.number().int().min(0).max(2 ** 31).nullable().optional(),
  outputFormat: z.string().max(10).nullable().optional(),
  /** Workspace asset ids used as source/reference images (never raw URLs from the client). */
  sourceAssetId: z.string().max(64).nullable().optional(),
  referenceAssetIds: z.array(z.string().max(64)).max(10).optional(),
  maskAssetId: z.string().max(64).nullable().optional(),
  extra: z.record(z.unknown()).optional(),
});
export type NormalizedRequestInput = z.infer<typeof NormalizedRequestSchema>;

export const Confirmation = z.object({
  /** The total the user saw and accepted (must cover the server's estimate). */
  acceptedEstimateUsd: z.number().min(0).nullable(),
  /** Required when no verified, current price exists ("Price unavailable" / stale / needs assumptions). */
  acceptUnverifiedCost: z.boolean().default(false),
});
export type Confirmation = z.infer<typeof Confirmation>;

async function assetDataUri(workspaceId: string, assetId: string) {
  const a = await prisma.asset.findFirst({ where: { id: assetId, workspaceId } });
  if (!a || !a.mimeType.startsWith('image/')) throw badRequest(`Image asset ${assetId} not found.`);
  return `data:${a.mimeType};base64,${Buffer.from(await getStorage().get(a.storageKey)).toString('base64')}`;
}

export interface Prepared {
  model: ModelWithPrice;
  caps: ModelCapabilities;
  input: Record<string, unknown>;
  estimate: CostEstimate;
  errors: string[];
  normalized: NormalizedImageRequest;
}

/** Validate settings against the model's own schema and estimate the cost — no provider call. */
export async function prepareGeneration(workspaceId: string, modelId: string, req: NormalizedRequestInput, opts: { resolveAssets?: boolean } = {}): Promise<Prepared> {
  const model = await getModel(modelId);
  if (!model) throw badRequest('Unknown image model.');
  if (!model.capabilities) throw conflict(`${model.displayName} has not been verified against the provider catalog yet (no input schema). Run a catalog sync first.`);
  const caps = model.capabilities as unknown as ModelCapabilities;
  const resolve = opts.resolveAssets !== false;
  const normalized: NormalizedImageRequest = {
    ...req,
    numImages: req.numImages ?? 1,
    imageUrl: req.sourceAssetId ? (resolve ? await assetDataUri(workspaceId, req.sourceAssetId) : `asset:${req.sourceAssetId}`) : null,
    imageUrls: req.referenceAssetIds?.length ? await Promise.all(req.referenceAssetIds.map((id) => (resolve ? assetDataUri(workspaceId, id) : Promise.resolve(`asset:${id}`)))) : undefined,
    maskUrl: req.maskAssetId ? (resolve ? await assetDataUri(workspaceId, req.maskAssetId) : `asset:${req.maskAssetId}`) : null,
  };
  const built = buildModelInput(caps, (model.inputSchema as JsonSchema | null) ?? null, normalized);
  const estimate = estimateFor(model, {
    widthPx: built.expectedWidthPx,
    heightPx: built.expectedHeightPx,
    dimensionsAreAssumed: built.dimensionsAreAssumed,
    numImages: normalized.numImages,
    imagesPerRequest: built.imagesPerRequest,
    resolution: normalized.resolution,
    quality: normalized.quality,
    referenceImages: (normalized.imageUrls?.length ?? 0) + (normalized.imageUrl ? 1 : 0),
    isEdit: !!normalized.imageUrl || !!normalized.imageUrls?.length,
    hasMask: !!normalized.maskUrl,
  });
  return { model, caps, input: built.input, estimate, errors: built.errors, normalized };
}

/** Never start a paid generation without an explicit, sufficient confirmation. */
export function checkConfirmation(estimate: CostEstimate, c: Confirmation | undefined) {
  if (!c) throw new HttpError(409, 'CONFIRMATION_REQUIRED', 'Review the estimated cost and confirm before generating.', { estimate });
  if (estimate.status !== 'OK') {
    if (!c.acceptUnverifiedCost) throw new HttpError(409, 'CONFIRMATION_REQUIRED', `${estimate.explanation} Confirm that you accept an unverified cost.`, { estimate });
    return;
  }
  if (c.acceptedEstimateUsd === null || c.acceptedEstimateUsd + 1e-9 < (estimate.total ?? 0)) {
    throw new HttpError(409, 'CONFIRMATION_REQUIRED', `The estimate is ${estimate.total} ${estimate.currency}; confirm that amount to continue.`, { estimate });
  }
}

/** Workspace (daily/monthly), project, and per-user spending limits — checked before each call. */
export async function assertSpendingLimits(workspaceId: string, projectId: string | null, userId: string | null, projectedUsd: number) {
  await assertWithinQuota(workspaceId, projectedUsd);
  if (projectId) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { aiSpendLimitUsd: true } });
    if (p?.aiSpendLimitUsd !== null && p?.aiSpendLimitUsd !== undefined) {
      const used = await prisma.usageRecord.aggregate({ where: { projectId }, _sum: { estimatedCostUsd: true } });
      if (Number(used._sum.estimatedCostUsd ?? 0) + projectedUsd > Number(p.aiSpendLimitUsd)) throw new HttpError(429, 'QUOTA_PROJECT', `Project AI budget of $${p.aiSpendLimitUsd} would be exceeded.`);
    }
  }
  if (userId) {
    const m = await prisma.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
    if (m?.monthlySpendLimitUsd !== null && m?.monthlySpendLimitUsd !== undefined) {
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const used = await prisma.usageRecord.aggregate({ where: { workspaceId, userId, createdAt: { gte: monthStart } }, _sum: { estimatedCostUsd: true } });
      if (Number(used._sum.estimatedCostUsd ?? 0) + projectedUsd > Number(m.monthlySpendLimitUsd)) throw new HttpError(429, 'QUOTA_USER', `Your monthly AI budget of $${m.monthlySpendLimitUsd} would be exceeded.`);
    }
  }
}

async function falKeyFor(workspaceId: string): Promise<string> {
  const cfg = await prisma.providerConfig.findFirst({ where: { workspaceId, provider: 'fal', encryptedApiKey: { not: null } }, orderBy: { updatedAt: 'desc' } });
  if (cfg?.encryptedApiKey) return decryptSecret(cfg.encryptedApiKey);
  if (config().FAL_KEY) return config().FAL_KEY!;
  throw new HttpError(400, 'PROVIDER_NOT_CONFIGURED', 'No fal.ai API key is configured. Set FAL_KEY on the server or add a fal provider key in Settings → Providers.');
}

const ALLOWED_OUTPUT = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Download a provider result image (https only, size-limited) and normalise it to PNG/JPEG. */
async function downloadImage(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' }> {
  let raw: Uint8Array;
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)(;base64)?,(.*)$/);
    if (!m) throw new ProviderError('Malformed data URI in provider output', 'fal', false);
    raw = new Uint8Array(Buffer.from(m[3], m[2] ? 'base64' : 'utf8'));
  } else {
    if (!/^https:\/\//.test(url)) throw new ProviderError('Provider returned a non-HTTPS image URL', 'fal', false);
    const res = await (falSdkOverrides.fetch ?? fetch)(url, { signal });
    if (!res.ok) throw new ProviderError(`Could not download generated image (HTTP ${res.status})`, 'fal', res.status >= 500);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > config().IMAGE_DOWNLOAD_MAX_MB * 1048576) throw new ProviderError('Generated image is larger than the download limit', 'fal', false);
    raw = new Uint8Array(await res.arrayBuffer());
  }
  if (raw.byteLength > config().IMAGE_DOWNLOAD_MAX_MB * 1048576) throw new ProviderError('Generated image is larger than the download limit', 'fal', false);
  const native = imageSize(raw);
  if (native) return { bytes: raw, mimeType: native.mimeType };
  // WebP or other formats: convert to PNG (lossless) for print workflows.
  const meta = await sharp(raw).metadata().catch(() => null);
  if (!meta?.format || !ALLOWED_OUTPUT.has(`image/${meta.format}`)) throw new ProviderError(`Unsupported image format from provider (${meta?.format ?? 'unknown'})`, 'fal', false);
  return { bytes: new Uint8Array(await sharp(raw).png().toBuffer()), mimeType: 'image/png' };
}

export interface RunOptions {
  workspaceId: string;
  projectId?: string | null;
  userId?: string | null;
  jobId?: string | null;
  comparisonId?: string | null;
  purpose: 'COVER_ART' | 'COMPARISON' | 'COLORING_PAGE' | 'UPSCALE' | 'TEST';
  modelId: string;
  request: NormalizedRequestInput;
  confirmation: Confirmation;
  /** Resume an existing generation record (job retry) instead of submitting again. */
  generationId?: string | null;
  signal?: AbortSignal;
  log?: (m: string) => void;
  timeoutMs?: number;
  assetKind?: string;
  licenseNote?: string;
  /** Stable key of the item inside a job (stored with the generation so retries find it). */
  generationKey?: string;
}

/**
 * Runs one generation end to end. The provider request id is stored before waiting, so a retry
 * of the same generation fetches the existing result rather than paying for a new one.
 */
export async function runGeneration(o: RunOptions): Promise<ImageGeneration> {
  const prep = await prepareGeneration(o.workspaceId, o.modelId, o.request);
  if (prep.errors.length) throw badRequest(`Settings are not valid for ${prep.model.displayName}: ${prep.errors.join('; ')}`);
  if (!(prep.model.enabled && (prep.model.availability === 'VERIFIED' || prep.model.availability === 'OFFLINE_MOCK'))) throw conflict(`${prep.model.displayName} is not enabled/verified for generation.`);
  checkConfirmation(prep.estimate, o.confirmation);
  const projected = prep.estimate.total ?? 0;

  let gen = o.generationId ? await prisma.imageGeneration.findUnique({ where: { id: o.generationId } }) : null;
  if (gen?.status === 'SUCCEEDED') return gen;
  if (!gen?.requestId) await assertSpendingLimits(o.workspaceId, o.projectId ?? null, o.userId ?? null, projected);
  const sanitizedInput = JSON.parse(JSON.stringify(prep.input, (_k, v) => (typeof v === 'string' && v.startsWith('data:') ? `[inline image ${Math.round(v.length / 1024)} KB]` : v)));
  if (!gen) {
    gen = await prisma.imageGeneration.create({
      data: {
        workspaceId: o.workspaceId,
        projectId: o.projectId ?? null,
        userId: o.userId ?? null,
        jobId: o.jobId ?? null,
        comparisonId: o.comparisonId ?? null,
        modelId: prep.model.id,
        endpointId: prep.model.endpointId,
        provider: prep.model.provider,
        purpose: o.purpose,
        status: 'RUNNING',
        input: sanitizedInput,
        settings: { ...o.request, __key: o.generationKey ?? null } as Prisma.InputJsonValue,
        estimate: prep.estimate as unknown as Prisma.InputJsonValue,
        estimateStatus: prep.estimate.status,
        estimatedCostUsd: prep.estimate.total !== null ? new Prisma.Decimal(prep.estimate.total) : null,
        confirmedByUser: true,
      },
    });
  } else await prisma.imageGeneration.update({ where: { id: gen.id }, data: { status: 'RUNNING', error: null } });

  const started = Date.now();
  const timeoutMs = o.timeoutMs ?? 300_000;
  try {
    let images: { url: string; width?: number; height?: number }[] = [];
    let outputMeta: Record<string, unknown> = {};
    let billableUnits: number | null = null;
    let requestId: string | null = gen.requestId;

    if (prep.model.provider === 'mock') {
      const n = Math.max(1, Math.min(4, Number(prep.input.num_images ?? 1)));
      const w = typeof prep.input.image_size === 'object' ? (prep.input.image_size as { width: number }).width : 1024;
      const h = typeof prep.input.image_size === 'object' ? (prep.input.image_size as { height: number }).height : 1024;
      for (let i = 0; i < n; i++) {
        const bytes = await mockImage(prep.model.endpointId, `${o.request.prompt}:${o.request.seed ?? 0}:${i}:${gen.id}`, w, h);
        images.push({ url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`, width: w, height: h });
      }
      outputMeta = { mock: true };
    } else {
      const key = await falKeyFor(o.workspaceId);
      const h = falClient(key);
      if (!requestId) {
        requestId = await withRetry(() => falSubmit(h, prep.model.endpointId, prep.input, o.signal), providerOverrides.retry ?? { attempts: 3, baseDelayMs: 1500, maxDelayMs: 10_000 }, (e, a, d) => o.log?.(`fal submit failed (attempt ${a}): ${e.message}; retrying in ${Math.round(d)}ms`), o.signal);
        await prisma.imageGeneration.update({ where: { id: gen.id }, data: { requestId } });
        o.log?.(`Submitted to ${prep.model.endpointId} (request ${requestId}).`);
      } else o.log?.(`Resuming existing fal request ${requestId} (no new charge).`);
      const rid = requestId;
      const onAbort = () => void falCancel(h, prep.model.endpointId, rid);
      o.signal?.addEventListener('abort', onAbort);
      try {
        const r = await withRetry(
          () => withTimeout((signal) => falWait(h, prep.model.endpointId, rid, timeoutMs, signal), timeoutMs + 10_000, prep.model.endpointId, o.signal),
          providerOverrides.retry ?? { attempts: 3, baseDelayMs: 2000, maxDelayMs: 15_000 },
          (e, a) => o.log?.(`Waiting for result failed (attempt ${a}): ${e.message}`),
          o.signal,
        );
        billableUnits = r.billableUnits;
        const data = r.data;
        const raw = (data.images as unknown[]) ?? (data.image ? [data.image] : []);
        images = (raw as { url?: string; width?: number; height?: number }[]).filter((x) => typeof x?.url === 'string') as { url: string; width?: number; height?: number }[];
        outputMeta = { seed: data.seed ?? null, has_nsfw_concepts: data.has_nsfw_concepts ?? null, description: typeof data.description === 'string' ? data.description.slice(0, 500) : null };
        if (!images.length) throw new ProviderError('The model returned no images (possibly filtered by the provider safety checker).', 'fal', false);
      } finally {
        o.signal?.removeEventListener('abort', onAbort);
      }
    }

    const assetIds: string[] = [];
    for (const [i, im] of images.entries()) {
      const { bytes, mimeType } = await downloadImage(im.url, o.signal);
      const size = imageSize(bytes)!;
      const key = `ws/${o.workspaceId}/${o.projectId ? `projects/${o.projectId}/` : ''}generated/${gen.id}-${i}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;
      await getStorage().put(key, bytes, mimeType);
      const a = await prisma.asset.create({
        data: {
          workspaceId: o.workspaceId,
          projectId: o.projectId ?? null,
          kind: o.assetKind ?? 'IMAGE',
          filename: `${prep.model.endpointId.replace(/[^\w-]+/g, '_')}-${gen.id.slice(-6)}-${i + 1}.${mimeType === 'image/png' ? 'png' : 'jpg'}`,
          mimeType,
          sizeBytes: bytes.byteLength,
          storageKey: key,
          sha256: sha256(bytes),
          widthPx: size.widthPx,
          heightPx: size.heightPx,
          source: prep.model.provider === 'mock' ? 'SYSTEM' : 'AI',
          licenseNote: o.licenseNote ?? (prep.model.provider === 'mock' ? 'Procedural offline mock output.' : `AI-generated with ${prep.model.endpointId} via fal.ai. ${prep.model.commercialUseNote || 'Check the model’s commercial-use terms.'}`),
          meta: { generationId: gen.id, prompt: o.request.prompt.slice(0, 2000) },
        },
      });
      assetIds.push(a.id);
    }

    // Actual cost: only when the provider reported billable units for this request.
    const price = toModelPrice(prep.model.prices.find((p) => p.isCurrent));
    let actual: number | null = null;
    let actualSource: string | null = null;
    if (prep.model.provider === 'mock') {
      actual = 0;
      actualSource = 'MOCK';
    } else if (billableUnits !== null && price?.unitPrice !== null && price) {
      actual = (billableUnits * price.unitPrice!) / price.assumptions.unitScale;
      actualSource = 'FAL_BILLABLE_UNITS_HEADER';
    }
    const done = await prisma.imageGeneration.update({
      where: { id: gen.id },
      data: { status: 'SUCCEEDED', assetIds, outputMeta: outputMeta as Prisma.InputJsonValue, billableUnits, actualCostUsd: actual !== null ? new Prisma.Decimal(actual.toFixed(6)) : null, actualCostSource: actualSource, durationMs: Date.now() - started, finishedAt: new Date() },
    });
    await prisma.usageRecord.create({
      data: { workspaceId: o.workspaceId, projectId: o.projectId ?? null, jobId: o.jobId ?? null, userId: o.userId ?? null, provider: prep.model.provider, model: prep.model.endpointId, kind: 'IMAGE', operation: o.purpose.toLowerCase(), images: assetIds.length, estimatedCostUsd: new Prisma.Decimal((actual ?? prep.estimate.total ?? 0).toFixed(6)), success: true },
    });
    if (prep.model.provider !== 'mock' && o.projectId) await prisma.project.update({ where: { id: o.projectId }, data: { aiImagesGenerated: true } });
    return done;
  } catch (e) {
    const err = e as Error;
    await prisma.imageGeneration.update({ where: { id: gen.id }, data: { status: 'FAILED', error: err.message.slice(0, 2000), durationMs: Date.now() - started, finishedAt: new Date() } });
    // Server errors are not billed by fal; record the failed attempt without cost.
    await prisma.usageRecord.create({ data: { workspaceId: o.workspaceId, projectId: o.projectId ?? null, jobId: o.jobId ?? null, userId: o.userId ?? null, provider: prep.model.provider, model: prep.model.endpointId, kind: 'IMAGE', operation: o.purpose.toLowerCase(), success: false } });
    throw e;
  }
}
