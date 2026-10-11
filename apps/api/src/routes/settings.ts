import { defaultSpecSource, FONT_FILES, fontsDir } from '@kdp/core';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { encryptSecret } from '../lib/crypto';
import { notFound } from '../lib/errors';
import { defineRoute, IdParams } from '../lib/route';
import { generateText, IMAGE_PROVIDERS, TEXT_PROVIDERS, usageTotals } from '../providers/gateway';
import { DEFAULT_PRICING } from '../providers/types';

export const settingsRouter = Router();

const Pricing = z.object({ inputPer1MTokensUsd: z.number().min(0).max(10000), outputPer1MTokensUsd: z.number().min(0).max(10000), perImageUsd: z.number().min(0).max(1000), note: z.string().max(300).optional() });
const ProviderBody = z.object({
  kind: z.enum(['TEXT', 'IMAGE']),
  provider: z.enum([...TEXT_PROVIDERS, ...IMAGE_PROVIDERS]),
  model: z.string().trim().min(1).max(120),
  baseUrl: z.string().url().max(300).optional().nullable(),
  apiKey: z.string().min(8).max(500).optional(),
  isDefault: z.boolean().default(true),
  pricing: Pricing.optional(),
  maxRequestsPerMinute: z.number().int().min(1).max(10000).default(30),
});

/** API keys are encrypted at rest and never returned — only the last 4 characters. */
const publicProvider = (p: { encryptedApiKey: string | null } & Record<string, unknown>) => {
  const { encryptedApiKey, ...rest } = p;
  return { ...rest, hasApiKey: !!encryptedApiKey };
};

defineRoute(settingsRouter, { method: 'get', path: '/providers', summary: 'Provider configurations (keys redacted)', tag: 'Providers' }, async ({ ws }) => ({
  configs: (await prisma.providerConfig.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { createdAt: 'asc' } })).map(publicProvider),
  available: { text: TEXT_PROVIDERS, image: IMAGE_PROVIDERS },
  defaultPricing: DEFAULT_PRICING,
}));

defineRoute(settingsRouter, { method: 'post', path: '/providers', summary: 'Add a provider configuration', tag: 'Providers', minRole: 'ADMIN', body: ProviderBody, status: 201 }, async ({ ws, body, req }) => {
  if (body.kind === 'TEXT' !== (TEXT_PROVIDERS as readonly string[]).includes(body.provider)) throw new (await import('../lib/errors')).HttpError(400, 'BAD_REQUEST', 'Provider does not match kind.');
  if (body.isDefault) await prisma.providerConfig.updateMany({ where: { workspaceId: ws.workspaceId, kind: body.kind }, data: { isDefault: false } });
  const p = await prisma.providerConfig.create({
    data: {
      workspaceId: ws.workspaceId,
      kind: body.kind,
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl ?? null,
      encryptedApiKey: body.apiKey ? encryptSecret(body.apiKey) : null,
      apiKeyLast4: body.apiKey ? body.apiKey.slice(-4) : null,
      isDefault: body.isDefault,
      pricing: (body.pricing ?? DEFAULT_PRICING[body.provider] ?? DEFAULT_PRICING.mock) as unknown as Prisma.InputJsonValue,
      maxRequestsPerMinute: body.maxRequestsPerMinute,
    },
  });
  await audit(req, 'provider.create', 'ProviderConfig', p.id, { provider: body.provider, model: body.model, keySet: !!body.apiKey });
  return publicProvider(p);
});

defineRoute(settingsRouter, { method: 'patch', path: '/providers/:id', summary: 'Update a provider configuration', tag: 'Providers', minRole: 'ADMIN', params: IdParams, body: ProviderBody.partial().omit({ kind: true, provider: true }) }, async ({ ws, params, body, req }) => {
  const cur = await prisma.providerConfig.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } });
  if (!cur) throw notFound('Provider');
  if (body.isDefault) await prisma.providerConfig.updateMany({ where: { workspaceId: ws.workspaceId, kind: cur.kind }, data: { isDefault: false } });
  const p = await prisma.providerConfig.update({
    where: { id: cur.id },
    data: { model: body.model, baseUrl: body.baseUrl, isDefault: body.isDefault, maxRequestsPerMinute: body.maxRequestsPerMinute, pricing: body.pricing as Prisma.InputJsonValue | undefined, ...(body.apiKey ? { encryptedApiKey: encryptSecret(body.apiKey), apiKeyLast4: body.apiKey.slice(-4) } : {}) },
  });
  await audit(req, 'provider.update', 'ProviderConfig', p.id, { keyChanged: !!body.apiKey });
  return publicProvider(p);
});

defineRoute(settingsRouter, { method: 'delete', path: '/providers/:id', summary: 'Remove a provider configuration', tag: 'Providers', minRole: 'ADMIN', params: IdParams }, async ({ ws, params, req }) => {
  const cur = await prisma.providerConfig.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } });
  if (!cur) throw notFound('Provider');
  await prisma.providerConfig.delete({ where: { id: cur.id } });
  await audit(req, 'provider.delete', 'ProviderConfig', cur.id);
  return { ok: true };
});

defineRoute(settingsRouter, { method: 'post', path: '/providers/test', summary: 'Send a tiny request to the default text provider', tag: 'Providers', minRole: 'ADMIN' }, async ({ ws }) => {
  const started = Date.now();
  const r = await generateText({ workspaceId: ws.workspaceId, operation: 'provider-test' }, { system: 'Reply with JSON.', prompt: 'Return {"ok": true}.', json: true, maxOutputTokens: 20, task: { name: 'freeform', input: {} } }, 30_000);
  return { ok: true, model: r.model, latencyMs: Date.now() - started, sample: r.text.slice(0, 200) };
});

defineRoute(settingsRouter, { method: 'get', path: '/usage', summary: 'AI usage and estimated cost (day, month, by provider and project)', tag: 'Usage' }, async ({ ws }) => {
  const w = await prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } });
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [totals, byProvider, byProject, recent] = await Promise.all([
    usageTotals(ws.workspaceId),
    prisma.usageRecord.groupBy({ by: ['provider', 'model', 'kind'], where: { workspaceId: ws.workspaceId, createdAt: { gte: monthStart } }, _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, images: true }, _count: true }),
    prisma.usageRecord.groupBy({ by: ['projectId'], where: { workspaceId: ws.workspaceId, createdAt: { gte: monthStart } }, _sum: { estimatedCostUsd: true }, _count: true }),
    prisma.usageRecord.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  const titles = await prisma.project.findMany({ where: { id: { in: byProject.map((b) => b.projectId).filter(Boolean) as string[] } }, select: { id: true, title: true } });
  const jobsToday = await prisma.generationJob.count({ where: { workspaceId: ws.workspaceId, createdAt: { gte: new Date(Date.now() - 86400_000) } } });
  return {
    totals,
    limits: { dailyCostLimitUsd: Number(w.dailyCostLimitUsd), monthlyCostLimitUsd: Number(w.monthlyCostLimitUsd), dailyJobLimit: w.dailyJobLimit, jobsLast24h: jobsToday },
    byProvider: byProvider.map((b) => ({ provider: b.provider, model: b.model, kind: b.kind, calls: b._count, costUsd: Number(b._sum.estimatedCostUsd ?? 0), inputTokens: b._sum.inputTokens ?? 0, outputTokens: b._sum.outputTokens ?? 0, images: b._sum.images ?? 0 })),
    byProject: byProject.map((b) => ({ projectId: b.projectId, title: titles.find((t) => t.id === b.projectId)?.title ?? '—', calls: b._count, costUsd: Number(b._sum.estimatedCostUsd ?? 0) })),
    recent: recent.map((r) => ({ ...r, estimatedCostUsd: Number(r.estimatedCostUsd) })),
    note: 'Costs are estimates from configured pricing. Check your provider dashboard for actual charges.',
  };
});

defineRoute(settingsRouter, { method: 'get', path: '/specs', summary: 'Print/eBook specification library (versioned, with verification status)', tag: 'Specifications', auth: 'user' }, async () => {
  const lib = defaultSpecSource.getLibrary();
  return { versions: defaultSpecSource.listVersions(), library: lib };
});

// Presets
defineRoute(settingsRouter, { method: 'get', path: '/presets', summary: 'Saved wizard presets', tag: 'Presets' }, async ({ ws }) => prisma.preset.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { createdAt: 'desc' } }));
defineRoute(settingsRouter, { method: 'post', path: '/presets', summary: 'Save a wizard preset', tag: 'Presets', body: z.object({ name: z.string().trim().min(1).max(100), data: z.record(z.unknown()) }), status: 201 }, async ({ ws, body }) =>
  prisma.preset.create({ data: { workspaceId: ws.workspaceId, name: body.name, data: body.data as Prisma.InputJsonValue } }),
);
defineRoute(settingsRouter, { method: 'delete', path: '/presets/:id', summary: 'Delete a preset', tag: 'Presets', params: IdParams }, async ({ ws, params }) => {
  const p = await prisma.preset.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } });
  if (!p) throw notFound('Preset');
  await prisma.preset.delete({ where: { id: p.id } });
  return { ok: true };
});

// Bundled webfonts for previews (allow-listed filenames only).
const fontFiles = new Set(Object.values(FONT_FILES));
settingsRouter.get('/fonts/:file', (req, res) => {
  if (!fontFiles.has(req.params.file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('font/ttf').sendFile(fontsDir() + req.params.file);
});
