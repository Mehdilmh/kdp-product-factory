import {
  deriveCapabilities,
  estimateCost,
  extractIoSchemas,
  ModelPrice,
  normalizeUnit,
  SEED_MODELS,
  SYNC_CATEGORIES,
  type CostEstimate,
  type EstimateSettings,
  type JsonSchema,
  type ModelCapabilities,
} from '@kdp/core';
import { Prisma, type ImageModel, type ImageModelPrice } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { falFindModels, falPricing, falSearchModels, falUsage, type FalCatalogModel } from '../providers/fal-platform';

/* ------------------------------------------------------------------------------------------ */
/* Built-in offline mock models (no network, $0, clearly labelled)                              */
/* ------------------------------------------------------------------------------------------ */

const MOCK_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['prompt'],
  properties: {
    prompt: { type: 'string' },
    image_size: {
      anyOf: [
        { type: 'object', properties: { width: { type: 'integer', minimum: 64, maximum: 4096 }, height: { type: 'integer', minimum: 64, maximum: 4096 } } },
        { type: 'string', enum: ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'] },
      ],
    },
    num_images: { type: 'integer', minimum: 1, maximum: 4 },
    seed: { type: 'integer' },
    image_url: { type: 'string' },
  },
};

export const MOCK_MODELS = [
  { endpointId: 'mock/line-art', displayName: 'Offline mock — line art', tasks: ['text-to-image'], tags: ['line-art', 'concept-drafts'], description: 'Procedural black-and-white line art drawn locally. Not AI and not related to your prompt — for testing the workflow without API costs.' },
  { endpointId: 'mock/cover-art', displayName: 'Offline mock — cover art', tasks: ['text-to-image', 'image-to-image'], tags: ['concept-drafts'], description: 'Procedural abstract artwork drawn locally. Not AI — for testing the workflow without API costs.' },
];

export async function ensureCatalog() {
  for (const m of MOCK_MODELS) {
    const caps = deriveCapabilities(MOCK_INPUT_SCHEMA, { endpointId: m.endpointId, category: 'text-to-image', displayName: m.displayName });
    caps.tasks = m.tasks as ModelCapabilities['tasks'];
    const row = await prisma.imageModel.upsert({
      where: { endpointId: m.endpointId },
      create: { provider: 'mock', endpointId: m.endpointId, displayName: m.displayName, family: 'Offline mock', description: m.description, availability: 'OFFLINE_MOCK', source: 'BUILT_IN', enabled: true, tasks: m.tasks, capabilities: caps as unknown as Prisma.InputJsonValue, inputSchema: MOCK_INPUT_SCHEMA as Prisma.InputJsonValue, editorialTags: m.tags, knownLimitations: 'Not a real image model. Output is procedural and ignores the prompt.', capabilitiesVerifiedAt: new Date() },
      update: { capabilities: caps as unknown as Prisma.InputJsonValue, inputSchema: MOCK_INPUT_SCHEMA as Prisma.InputJsonValue, description: m.description },
    });
    if (!(await prisma.imageModelPrice.findFirst({ where: { modelId: row.id, isCurrent: true } }))) {
      await prisma.imageModelPrice.create({ data: { modelId: row.id, unitPrice: new Prisma.Decimal(0), unitRaw: 'image', billingUnit: 'IMAGE', currency: 'USD', source: 'BUILT_IN', sourceUrl: '', retrievedAt: new Date('2100-01-01'), assumptions: { notes: 'Offline mock: no provider call, no charge.' } } });
    }
  }
  for (const s of SEED_MODELS) {
    await prisma.imageModel.upsert({
      where: { endpointId: s.endpointId },
      create: { provider: 'fal', endpointId: s.endpointId, displayName: s.displayName, family: s.family, availability: 'CANDIDATE_UNVERIFIED', source: 'SEED', enabled: false, tasks: s.expectedTasks, editorialTags: s.editorialTags, adminNotes: `Seed candidate — not verified against fal's catalog yet. ${s.notes}`.trim(), modelUrl: `https://fal.ai/models/${s.endpointId}` },
      update: {},
    });
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Sync                                                                                         */
/* ------------------------------------------------------------------------------------------ */

function upsertDataFromCatalog(m: FalCatalogModel) {
  const md = m.metadata ?? {};
  const schemas = m.openapi ? extractIoSchemas(m.openapi) : { input: null, output: null };
  const caps = schemas.input ? deriveCapabilities(schemas.input, { endpointId: m.endpoint_id, category: md.category ?? null, displayName: md.display_name ?? null }) : null;
  const status = String(md.status ?? '').toLowerCase();
  const license = typeof md.license_type === 'string' ? md.license_type : null;
  return {
    displayName: String(md.display_name ?? m.endpoint_id).slice(0, 200),
    category: md.category ?? null,
    description: String(md.description ?? '').slice(0, 4000),
    falStatus: md.status ?? null,
    availability: status === 'deprecated' ? 'DEPRECATED' : 'VERIFIED',
    tasks: caps?.tasks ?? (md.category ? [md.category] : []),
    capabilities: (caps ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
    inputSchema: (schemas.input ?? undefined) as Prisma.InputJsonValue | undefined,
    outputSchema: (schemas.output ?? undefined) as Prisma.InputJsonValue | undefined,
    catalogMetadata: md as Prisma.InputJsonValue,
    thumbnailUrl: typeof md.thumbnail_url === 'string' && /^https:\/\//.test(md.thumbnail_url) ? md.thumbnail_url : null,
    modelUrl: typeof md.model_url === 'string' ? md.model_url : `https://fal.ai/models/${m.endpoint_id}`,
    commercialUseNote: license ? `fal catalog license type: ${license}` : '',
    capabilitiesVerifiedAt: caps ? new Date() : null,
    lastSyncedAt: new Date(),
    lastSyncError: caps ? null : 'Catalog entry found but no OpenAPI input schema was returned; model stays disabled.',
  };
}

export interface SyncReport {
  startedAt: string;
  verified: string[];
  notFound: string[];
  discovered: string[];
  priced: string[];
  priceMissing: string[];
  errors: string[];
}

export async function syncCatalog(opts: { discover?: boolean; pricing?: boolean } = {}): Promise<SyncReport> {
  await ensureCatalog();
  const report: SyncReport = { startedAt: new Date().toISOString(), verified: [], notFound: [], discovered: [], priced: [], priceMissing: [], errors: [] };
  const known = await prisma.imageModel.findMany({ where: { provider: 'fal' } });
  try {
    const found = await falFindModels(known.map((k) => k.endpointId));
    const byId = new Map(found.map((f) => [f.endpoint_id, f]));
    for (const k of known) {
      const f = byId.get(k.endpointId);
      if (!f) {
        await prisma.imageModel.update({ where: { id: k.id }, data: { availability: 'NOT_FOUND', enabled: false, lastSyncedAt: new Date(), lastSyncError: 'Endpoint ID not found in fal catalog.' } });
        report.notFound.push(k.endpointId);
        continue;
      }
      const data = upsertDataFromCatalog(f);
      const wasEnabledByAdmin = k.availability === 'VERIFIED' ? k.enabled : true;
      await prisma.imageModel.update({ where: { id: k.id }, data: { ...data, enabled: data.availability === 'VERIFIED' && !!data.capabilities && wasEnabledByAdmin } });
      report.verified.push(k.endpointId);
    }
    if (opts.discover) {
      for (const category of SYNC_CATEGORIES) {
        const models = await falSearchModels({ category, status: 'active', expandOpenApi: true });
        for (const f of models) {
          if (byId.has(f.endpoint_id) || known.some((k) => k.endpointId === f.endpoint_id)) continue;
          const data = upsertDataFromCatalog(f);
          await prisma.imageModel.upsert({
            where: { endpointId: f.endpoint_id },
            create: { provider: 'fal', endpointId: f.endpoint_id, source: 'CATALOG_SYNC', family: '', editorialTags: [], enabled: data.availability === 'VERIFIED' && !!data.capabilities, ...data },
            update: data,
          });
          byId.set(f.endpoint_id, f);
          report.discovered.push(f.endpoint_id);
        }
      }
    }
  } catch (e) {
    report.errors.push(`Catalog: ${(e as Error).message}`);
  }
  if (opts.pricing !== false) {
    const r = await syncPricing();
    report.priced = r.priced;
    report.priceMissing = r.missing;
    report.errors.push(...r.errors);
  }
  await prisma.systemState.upsert({ where: { key: 'imageCatalogSync' }, create: { key: 'imageCatalogSync', value: report as unknown as Prisma.InputJsonValue }, update: { value: report as unknown as Prisma.InputJsonValue } });
  return report;
}

export async function syncPricing(): Promise<{ priced: string[]; missing: string[]; errors: string[] }> {
  const models = await prisma.imageModel.findMany({ where: { provider: 'fal', availability: { in: ['VERIFIED', 'DEPRECATED'] } } });
  const out = { priced: [] as string[], missing: [] as string[], errors: [] as string[] };
  if (!models.length) return out;
  try {
    const prices = await falPricing(models.map((m) => m.endpointId));
    const byId = new Map(prices.map((p) => [p.endpoint_id, p]));
    for (const m of models) {
      const p = byId.get(m.endpointId);
      if (!p) {
        await prisma.imageModel.update({ where: { id: m.id }, data: { lastPriceError: 'No price returned by fal pricing API.' } });
        out.missing.push(m.endpointId);
        continue;
      }
      const unit = normalizeUnit(p.unit);
      const prev = await prisma.imageModelPrice.findFirst({ where: { modelId: m.id, isCurrent: true } });
      const prevAssumptions = (prev?.assumptions as Record<string, unknown> | undefined) ?? {};
      await prisma.$transaction([
        prisma.imageModelPrice.updateMany({ where: { modelId: m.id, isCurrent: true }, data: { isCurrent: false } }),
        prisma.imageModelPrice.create({
          data: {
            modelId: m.id,
            unitPrice: new Prisma.Decimal(p.unit_price),
            unitRaw: p.unit,
            billingUnit: unit.billingUnit,
            currency: p.currency,
            source: 'FAL_PRICING_API',
            sourceUrl: `${config().FAL_PLATFORM_API_URL}/models/pricing?endpoint_id=${encodeURIComponent(m.endpointId)}`,
            retrievedAt: new Date(),
            // Keep admin-entered assumptions (surcharges, token/second assumptions) across refreshes.
            assumptions: { ...prevAssumptions, unitScale: unit.unitScale } as Prisma.InputJsonValue,
          },
        }),
        prisma.imageModel.update({ where: { id: m.id }, data: { lastPriceError: null } }),
      ]);
      out.priced.push(m.endpointId);
    }
  } catch (e) {
    out.errors.push(`Pricing: ${(e as Error).message}`);
  }
  return out;
}

/** Pull provider-reported spend (Admin key) for the last N days. */
export async function syncProviderUsage(days = 7) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const lines = await falUsage(start.toISOString(), end.toISOString());
  for (const l of lines) {
    const ps = new Date(l.periodStart);
    const pe = new Date(l.periodEnd);
    if (Number.isNaN(ps.getTime()) || Number.isNaN(pe.getTime())) continue;
    await prisma.providerUsageReport.upsert({
      where: { provider_endpointId_periodStart_periodEnd: { provider: 'fal', endpointId: l.endpointId, periodStart: ps, periodEnd: pe } },
      create: { provider: 'fal', endpointId: l.endpointId, periodStart: ps, periodEnd: pe, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, costTotal: l.costTotal, currency: l.currency, raw: l.raw as Prisma.InputJsonValue },
      update: { quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, costTotal: l.costTotal, currency: l.currency, raw: l.raw as Prisma.InputJsonValue, retrievedAt: new Date() },
    });
  }
  return lines.length;
}

/* ------------------------------------------------------------------------------------------ */
/* Read models                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export function toModelPrice(p: ImageModelPrice | null | undefined): ModelPrice | null {
  if (!p) return null;
  const a = (p.assumptions as Record<string, unknown>) ?? {};
  return ModelPrice.parse({
    unitPrice: p.unitPrice === null ? null : Number(p.unitPrice),
    unitRaw: p.unitRaw,
    billingUnit: p.billingUnit,
    currency: p.currency,
    source: p.source === 'BUILT_IN' ? 'ADMIN_MANUAL' : p.source,
    sourceUrl: p.sourceUrl,
    retrievedAt: p.retrievedAt.toISOString(),
    assumptions: a,
  });
}

export type ModelWithPrice = ImageModel & { prices: ImageModelPrice[] };

export function modelDto(m: ModelWithPrice, estimate?: CostEstimate) {
  const price = m.prices.find((p) => p.isCurrent) ?? null;
  const mp = toModelPrice(price);
  return {
    id: m.id,
    provider: m.provider,
    endpointId: m.endpointId,
    displayName: m.displayName,
    family: m.family,
    category: m.category,
    description: m.description,
    availability: m.availability,
    falStatus: m.falStatus,
    source: m.source,
    enabled: m.enabled,
    usable: m.enabled && (m.availability === 'VERIFIED' || m.availability === 'OFFLINE_MOCK') && !!m.capabilities,
    tasks: m.tasks,
    capabilities: m.capabilities as unknown as ModelCapabilities | null,
    thumbnailUrl: m.thumbnailUrl,
    modelUrl: m.modelUrl,
    commercialUseUrl: m.commercialUseUrl,
    commercialUseNote: m.commercialUseNote,
    commercialInfoAvailable: !!(m.commercialUseUrl || m.commercialUseNote),
    editorialTags: m.editorialTags,
    knownLimitations: m.knownLimitations,
    adminNotes: m.adminNotes,
    capabilitiesVerifiedAt: m.capabilitiesVerifiedAt,
    lastSyncedAt: m.lastSyncedAt,
    lastSyncError: m.lastSyncError,
    lastPriceError: m.lastPriceError,
    price: price ? { ...mp!, isBuiltIn: price.source === 'BUILT_IN', id: price.id } : null,
    estimate: estimate ?? (mp ? estimateCost(mp, { numImages: 1 }) : estimateCost(null, { numImages: 1 })),
  };
}

export async function getModel(id: string): Promise<ModelWithPrice | null> {
  return prisma.imageModel.findFirst({ where: { OR: [{ id }, { endpointId: id }] }, include: { prices: { where: { isCurrent: true } } } });
}

export const estimateFor = (m: ModelWithPrice, s: EstimateSettings) => estimateCost(toModelPrice(m.prices.find((p) => p.isCurrent)), s);

/**
 * Periodic catalog + price refresh (only when FAL_KEY is configured). Runs in the worker
 * process (or the API process when JOB_RUNNER=inline). Skips if a sync ran recently, so
 * several processes do not hammer the provider.
 */
export function startCatalogRefresh(log: (m: string) => void = console.log) {
  const hours = config().CATALOG_REFRESH_HOURS;
  if (!config().FAL_KEY || hours <= 0) {
    log('Image catalog refresh disabled (no FAL_KEY or CATALOG_REFRESH_HOURS=0).');
    return () => {};
  }
  const tick = async () => {
    try {
      const last = await prisma.systemState.findUnique({ where: { key: 'imageCatalogSync' } });
      const at = (last?.value as { startedAt?: string } | null)?.startedAt;
      if (at && Date.now() - Date.parse(at) < hours * 3600_000 * 0.9) return;
      const r = await syncCatalog({ discover: true, pricing: true });
      log(`Image catalog refreshed: ${r.verified.length} verified, ${r.discovered.length} discovered, ${r.priced.length} priced, ${r.errors.length} error(s).`);
    } catch (e) {
      log(`Image catalog refresh failed: ${(e as Error).message}`);
    }
  };
  const first = setTimeout(tick, 15_000);
  const timer = setInterval(tick, Math.min(hours, 24) * 3600_000);
  timer.unref();
  first.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
