import { Prisma, type ProviderConfig } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { decryptSecret } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { FalImageProvider } from './fal';
import { GeminiTextProvider } from './gemini';
import { MockImageProvider, MockTextProvider } from './mock';
import { OpenAICompatibleTextProvider } from './openai-compatible';
import { DEFAULT_RETRY, withRetry, withTimeout, type RetryPolicy } from './retry';
import { DEFAULT_PRICING, estimateCost, ProviderError, type FetchLike, type ImageProvider, type ImageRequest, type ImageResult, type Pricing, type TextProvider, type TextRequest, type TextResult } from './types';

export const TEXT_PROVIDERS = ['mock', 'gemini', 'openai-compatible'] as const;
export const IMAGE_PROVIDERS = ['mock-image', 'fal'] as const;

export interface CallContext {
  workspaceId: string;
  projectId?: string | null;
  jobId?: string | null;
  operation: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

/** Overridable factories (tests inject failing providers / fake fetch). */
export const providerOverrides: { text?: () => TextProvider; image?: () => ImageProvider; fetch?: FetchLike; retry?: RetryPolicy } = {};

function apiKeyFor(cfg: ProviderConfig | null, envKey: string | undefined): string {
  if (cfg?.encryptedApiKey) return decryptSecret(cfg.encryptedApiKey);
  if (envKey) return envKey;
  throw new HttpError(400, 'PROVIDER_NOT_CONFIGURED', `No API key configured for ${cfg?.provider ?? 'provider'}. Add one in Settings → Providers or use the mock provider.`);
}

export function buildTextProvider(cfg: ProviderConfig | null): TextProvider {
  if (providerOverrides.text) return providerOverrides.text();
  const f = providerOverrides.fetch ?? fetch;
  switch (cfg?.provider ?? 'mock') {
    case 'gemini':
      return new GeminiTextProvider(apiKeyFor(cfg, config().GEMINI_API_KEY), cfg!.model, f);
    case 'openai-compatible':
      return new OpenAICompatibleTextProvider(apiKeyFor(cfg, config().OPENAI_COMPATIBLE_API_KEY), cfg!.model, cfg!.baseUrl ?? config().OPENAI_COMPATIBLE_BASE_URL, f);
    default:
      return new MockTextProvider();
  }
}

export function buildImageProvider(cfg: ProviderConfig | null): ImageProvider {
  if (providerOverrides.image) return providerOverrides.image();
  const f = providerOverrides.fetch ?? fetch;
  switch (cfg?.provider ?? 'mock-image') {
    case 'fal':
      return new FalImageProvider(apiKeyFor(cfg, config().FAL_KEY), cfg!.model, f);
    default:
      return new MockImageProvider();
  }
}

/* Simple per-process rate limiter (requests per minute per provider config). */
const windows = new Map<string, number[]>();
async function rateLimit(key: string, perMinute: number, signal?: AbortSignal) {
  for (;;) {
    const now = Date.now();
    const w = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
    if (w.length < perMinute) {
      w.push(now);
      windows.set(key, w);
      return;
    }
    const wait = 60_000 - (now - w[0]) + 5;
    await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
    if (signal?.aborted) throw new ProviderError('Cancelled while rate limited', key, false);
  }
}

export async function usageTotals(workspaceId: string) {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [day, month] = await Promise.all([
    prisma.usageRecord.aggregate({ where: { workspaceId, createdAt: { gte: dayStart } }, _sum: { estimatedCostUsd: true } }),
    prisma.usageRecord.aggregate({ where: { workspaceId, createdAt: { gte: monthStart } }, _sum: { estimatedCostUsd: true } }),
  ]);
  return { dayUsd: Number(day._sum.estimatedCostUsd ?? 0), monthUsd: Number(month._sum.estimatedCostUsd ?? 0) };
}

export async function assertWithinQuota(workspaceId: string, projectedUsd = 0) {
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const t = await usageTotals(workspaceId);
  if (t.dayUsd + projectedUsd > Number(ws.dailyCostLimitUsd)) throw new HttpError(429, 'QUOTA_DAILY', `Daily AI budget of $${ws.dailyCostLimitUsd} would be exceeded (used $${t.dayUsd.toFixed(4)}).`);
  if (t.monthUsd + projectedUsd > Number(ws.monthlyCostLimitUsd)) throw new HttpError(429, 'QUOTA_MONTHLY', `Monthly AI budget of $${ws.monthlyCostLimitUsd} would be exceeded (used $${t.monthUsd.toFixed(4)}).`);
}

async function defaultConfig(workspaceId: string, kind: 'TEXT' | 'IMAGE') {
  return prisma.providerConfig.findFirst({ where: { workspaceId, kind, isDefault: true } });
}

function pricingOf(cfg: ProviderConfig | null, providerId: string): Pricing {
  const p = cfg?.pricing as Pricing | undefined;
  return p && typeof p.inputPer1MTokensUsd === 'number' ? p : (DEFAULT_PRICING[providerId] ?? DEFAULT_PRICING.mock);
}

async function record(ctx: CallContext, provider: string, model: string, kind: string, usage: { inputTokens?: number; outputTokens?: number; images?: number }, cost: number, success: boolean) {
  await prisma.usageRecord.create({
    data: {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId ?? null,
      jobId: ctx.jobId ?? null,
      provider,
      model,
      kind,
      operation: ctx.operation,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      images: usage.images ?? 0,
      estimatedCostUsd: new Prisma.Decimal(cost.toFixed(6)),
      success,
    },
  });
}

/** Text generation with quota checks, rate limiting, retries, timeouts, and usage recording. */
export async function generateText(ctx: CallContext, req: TextRequest, timeoutMs = 120_000): Promise<TextResult> {
  const cfg = await defaultConfig(ctx.workspaceId, 'TEXT');
  const provider = buildTextProvider(cfg);
  const pricing = pricingOf(cfg, provider.id);
  await assertWithinQuota(ctx.workspaceId, estimateCost(pricing, { inputTokens: (req.system.length + req.prompt.length) / 3, outputTokens: req.maxOutputTokens ?? 8192 }));
  if (cfg) await rateLimit(cfg.id, cfg.maxRequestsPerMinute, ctx.signal);
  try {
    const res = await withRetry(
      () => withTimeout((signal) => provider.generate({ ...req, signal }), timeoutMs, provider.id, ctx.signal),
      providerOverrides.retry ?? DEFAULT_RETRY,
      (e, attempt, delay) => ctx.log?.(`Provider ${provider.id} failed (attempt ${attempt}): ${e.message}. Retrying in ${Math.round(delay)} ms.`),
      ctx.signal,
    );
    await record(ctx, provider.id, res.model, 'TEXT', res, estimateCost(pricing, res), true);
    return res;
  } catch (e) {
    await record(ctx, provider.id, provider.model, 'TEXT', {}, 0, false);
    throw e;
  }
}

export async function generateImage(ctx: CallContext, req: ImageRequest, timeoutMs = 180_000): Promise<ImageResult> {
  const cfg = await defaultConfig(ctx.workspaceId, 'IMAGE');
  const provider = buildImageProvider(cfg);
  const pricing = pricingOf(cfg, provider.id);
  await assertWithinQuota(ctx.workspaceId, estimateCost(pricing, { images: 1 }));
  if (cfg) await rateLimit(cfg.id, cfg.maxRequestsPerMinute, ctx.signal);
  try {
    const res = await withRetry(
      () => withTimeout((signal) => provider.generate({ ...req, signal }), timeoutMs, provider.id, ctx.signal),
      providerOverrides.retry ?? DEFAULT_RETRY,
      (e, attempt, delay) => ctx.log?.(`Image provider ${provider.id} failed (attempt ${attempt}): ${e.message}. Retrying in ${Math.round(delay)} ms.`),
      ctx.signal,
    );
    await record(ctx, provider.id, res.model, 'IMAGE', { images: 1 }, estimateCost(pricing, { images: 1 }), true);
    return res;
  } catch (e) {
    await record(ctx, provider.id, provider.model, 'IMAGE', {}, 0, false);
    throw e;
  }
}

/** Rough per-product cost estimate for batch planning (uses configured pricing). */
export async function estimateProductCost(workspaceId: string, opts: { chapters: number; images: number }) {
  const [t, i] = await Promise.all([defaultConfig(workspaceId, 'TEXT'), defaultConfig(workspaceId, 'IMAGE')]);
  const tp = pricingOf(t, t?.provider ?? 'mock');
  const ip = pricingOf(i, i?.provider ?? 'mock-image');
  const calls = 3 + opts.chapters;
  return estimateCost(tp, { inputTokens: calls * 1500, outputTokens: calls * 2500 }) + estimateCost(ip, { images: opts.images });
}
