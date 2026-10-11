import { z } from 'zod';

/**
 * Image-model pricing engine. Prices come from fal.ai's Platform API (`/v1/models/pricing`) or
 * an administrator entry with a source URL. Nothing here invents prices: when a value or an
 * assumption is missing the estimate is explicitly UNAVAILABLE / NEEDS_ASSUMPTIONS.
 */

export const BillingUnit = z.enum(['IMAGE', 'MEGAPIXEL', 'TOKEN', 'SECOND', 'REQUEST', 'UNKNOWN']);
export type BillingUnit = z.infer<typeof BillingUnit>;

export const Surcharge = z.object({
  id: z.string().max(60),
  label: z.string().max(200),
  kind: z.enum(['MULTIPLIER', 'ADD_PER_IMAGE', 'ADD_PER_REFERENCE_IMAGE', 'ADD_PER_REQUEST']),
  value: z.number().min(0).max(1000),
  /** Applies only when all given conditions match. */
  when: z
    .object({
      resolution: z.string().max(20).optional(),
      quality: z.string().max(40).optional(),
      feature: z.enum(['reference', 'edit', 'mask', 'web_search']).optional(),
    })
    .default({}),
  sourceUrl: z.string().max(500).default(''),
});
export type Surcharge = z.infer<typeof Surcharge>;

export const PricingAssumptions = z.object({
  /** How megapixels are counted per image. fal's billing docs describe rounding up; stored as an explicit assumption. */
  megapixelRounding: z.enum(['CEIL', 'EXACT']).default('CEIL'),
  /** Token-priced models: tokens per output image (only estimated when provided). */
  tokensPerImage: z.number().positive().nullable().default(null),
  /** Second-priced models: compute seconds per image (only estimated when provided). */
  secondsPerImage: z.number().positive().nullable().default(null),
  /** Unit size multiplier parsed from the raw unit (e.g. "1M tokens" → 1,000,000). */
  unitScale: z.number().positive().default(1),
  minimumChargeUsd: z.number().min(0).nullable().default(null),
  surcharges: z.array(Surcharge).max(30).default([]),
  notes: z.string().max(2000).default(''),
});
export type PricingAssumptions = z.infer<typeof PricingAssumptions>;

export const ModelPrice = z.object({
  unitPrice: z.number().min(0).nullable(),
  unitRaw: z.string().max(80).nullable(),
  billingUnit: BillingUnit,
  currency: z.string().max(8).default('USD'),
  source: z.enum(['FAL_PRICING_API', 'ADMIN_MANUAL']),
  sourceUrl: z.string().max(500).default(''),
  retrievedAt: z.string(),
  assumptions: PricingAssumptions.default({}),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/** Normalise fal's free-form `unit` strings. Unknown units stay UNKNOWN — never guessed. */
export function normalizeUnit(raw: string | null | undefined): { billingUnit: BillingUnit; unitScale: number } {
  if (!raw) return { billingUnit: 'UNKNOWN', unitScale: 1 };
  const u = raw.trim().toLowerCase();
  const scaleMatch = u.match(/^(?:per\s+)?(\d+(?:\.\d+)?)\s*([km])?\s*(.*)$/);
  let scale = 1;
  let rest = u.replace(/^per\s+/, '');
  if (scaleMatch && (scaleMatch[1] || scaleMatch[2])) {
    scale = Number(scaleMatch[1]) * (scaleMatch[2] === 'k' ? 1e3 : scaleMatch[2] === 'm' ? 1e6 : 1);
    rest = scaleMatch[3];
  }
  rest = rest.trim();
  if (/^(images?|outputs?|generations?)$/.test(rest)) return { billingUnit: 'IMAGE', unitScale: scale };
  if (/^(megapixels?|mp|mpx)$/.test(rest)) return { billingUnit: 'MEGAPIXEL', unitScale: scale };
  if (/^(tokens?|output tokens?)$/.test(rest)) return { billingUnit: 'TOKEN', unitScale: scale };
  if (/^(seconds?|secs?|gpu seconds?|compute seconds?)$/.test(rest)) return { billingUnit: 'SECOND', unitScale: scale };
  if (/^(requests?|calls?|runs?)$/.test(rest)) return { billingUnit: 'REQUEST', unitScale: scale };
  return { billingUnit: 'UNKNOWN', unitScale: scale };
}

export const UNIT_LABEL: Record<BillingUnit, string> = {
  IMAGE: 'per image',
  MEGAPIXEL: 'per megapixel',
  TOKEN: 'per token',
  SECOND: 'per second of compute',
  REQUEST: 'per request',
  UNKNOWN: 'unit not recognised',
};

export function describePrice(p: ModelPrice | null): string {
  if (!p || p.unitPrice === null) return 'Price unavailable';
  const scale = p.assumptions.unitScale !== 1 ? `${p.assumptions.unitScale.toLocaleString('en-US')} ` : '';
  const unit = p.billingUnit === 'UNKNOWN' ? `per ${p.unitRaw}` : `per ${scale}${UNIT_LABEL[p.billingUnit].replace(/^per /, '')}${scale && !/s$/.test(UNIT_LABEL[p.billingUnit]) ? 's' : ''}`;
  return `${p.currency === 'USD' ? '$' : p.currency + ' '}${p.unitPrice} ${unit}`;
}

export interface EstimateSettings {
  /** Expected output size; required for megapixel pricing. */
  widthPx?: number | null;
  heightPx?: number | null;
  /** True when the output size is a documented preset or user-specified (not guessed). */
  dimensionsAreAssumed?: boolean;
  numImages: number;
  /** Images returned per request (affects per-request pricing). */
  imagesPerRequest?: number;
  resolution?: string | null;
  quality?: string | null;
  referenceImages?: number;
  isEdit?: boolean;
  hasMask?: boolean;
}

export type EstimateStatus = 'OK' | 'STALE' | 'UNAVAILABLE' | 'NEEDS_ASSUMPTIONS' | 'UNKNOWN_DIMENSIONS';

export interface CostEstimate {
  status: EstimateStatus;
  currency: string;
  /** Cost for one output image under the given settings (null when not computable). */
  perImage: number | null;
  /** Total for `settings.numImages`. */
  total: number | null;
  /** Standard quantities shown in the UI. */
  table: { quantity: number; total: number | null }[];
  minimumKnownCost: number | null;
  breakdown: string[];
  assumptions: string[];
  explanation: string;
  /** Pricing used, for audit. */
  billingUnit: BillingUnit | null;
  priceRetrievedAt: string | null;
}

const QUANTITIES = [1, 4, 10, 50, 100];
export const PRICE_STALE_AFTER_DAYS = 7;

const roundMoney = (v: number) => Math.round(v * 1e6) / 1e6;

export function estimateCost(price: ModelPrice | null, s: EstimateSettings, now = new Date(), staleAfterDays = PRICE_STALE_AFTER_DAYS): CostEstimate {
  const base: CostEstimate = {
    status: 'UNAVAILABLE',
    currency: price?.currency ?? 'USD',
    perImage: null,
    total: null,
    table: QUANTITIES.map((q) => ({ quantity: q, total: null })),
    minimumKnownCost: null,
    breakdown: [],
    assumptions: [],
    explanation: 'Price unavailable — no verified price is stored for this model. Generation requires explicit confirmation.',
    billingUnit: price?.billingUnit ?? null,
    priceRetrievedAt: price?.retrievedAt ?? null,
  };
  if (!price || price.unitPrice === null) return base;
  if (price.billingUnit === 'UNKNOWN') return { ...base, explanation: `Price unavailable — the billing unit "${price.unitRaw}" is not recognised, so no estimate is made.` };

  const a = price.assumptions;
  const unitPrice = price.unitPrice / a.unitScale;
  const assumptions: string[] = [];
  const breakdown: string[] = [];
  let perImage: number;

  switch (price.billingUnit) {
    case 'IMAGE':
      perImage = unitPrice;
      breakdown.push(`${describePrice(price)} × 1 image`);
      break;
    case 'MEGAPIXEL': {
      if (!s.widthPx || !s.heightPx) return { ...base, status: 'UNKNOWN_DIMENSIONS', explanation: 'This model is billed per megapixel; the output size must be known to estimate cost.' };
      const mpExact = (s.widthPx * s.heightPx) / 1e6;
      const mp = a.megapixelRounding === 'CEIL' ? Math.max(1, Math.ceil(mpExact - 1e-9)) : mpExact;
      perImage = mp * unitPrice;
      breakdown.push(`${s.widthPx}×${s.heightPx}px = ${mpExact.toFixed(2)} MP → billed as ${mp.toFixed(2)} MP × ${describePrice(price)}`);
      if (a.megapixelRounding === 'CEIL') assumptions.push('Megapixels are rounded up to the next whole megapixel (per fal billing documentation; verify for this model).');
      if (s.dimensionsAreAssumed) assumptions.push('Output dimensions are taken from the model’s documented size preset; the provider may return a different size.');
      break;
    }
    case 'TOKEN':
      if (!a.tokensPerImage) return { ...base, status: 'NEEDS_ASSUMPTIONS', explanation: 'This model is billed per token. No tokens-per-image assumption is stored, so no estimate is made; the final charge can vary.' };
      perImage = a.tokensPerImage * unitPrice;
      breakdown.push(`${a.tokensPerImage.toLocaleString('en-US')} tokens/image (assumption) × ${describePrice(price)}`);
      assumptions.push(`Assumes ${a.tokensPerImage} tokens per image. Token-billed charges vary with prompt and output; the final charge can differ.`);
      break;
    case 'SECOND':
      if (!a.secondsPerImage) return { ...base, status: 'NEEDS_ASSUMPTIONS', explanation: 'This model is billed per second of compute. No seconds-per-image assumption is stored, so no estimate is made.' };
      perImage = a.secondsPerImage * unitPrice;
      breakdown.push(`${a.secondsPerImage}s/image (assumption) × ${describePrice(price)}`);
      assumptions.push(`Assumes ${a.secondsPerImage} compute seconds per image; actual time varies.`);
      break;
    case 'REQUEST': {
      const per = Math.max(1, s.imagesPerRequest ?? 1);
      perImage = unitPrice / per;
      breakdown.push(`${describePrice(price)} ÷ ${per} image(s) per request`);
      break;
    }
  }

  // Surcharges / multipliers that match the settings.
  let addPerRequest = 0;
  for (const sc of a.surcharges) {
    const w = sc.when;
    const matches =
      (!w.resolution || w.resolution === s.resolution) &&
      (!w.quality || w.quality === s.quality) &&
      (!w.feature || (w.feature === 'reference' && (s.referenceImages ?? 0) > 0) || (w.feature === 'edit' && !!s.isEdit) || (w.feature === 'mask' && !!s.hasMask));
    if (!matches) continue;
    if (sc.kind === 'MULTIPLIER') {
      perImage *= sc.value;
      breakdown.push(`× ${sc.value} (${sc.label})`);
    } else if (sc.kind === 'ADD_PER_IMAGE') {
      perImage += sc.value;
      breakdown.push(`+ ${sc.value} per image (${sc.label})`);
    } else if (sc.kind === 'ADD_PER_REFERENCE_IMAGE') {
      perImage += sc.value * (s.referenceImages ?? 0);
      breakdown.push(`+ ${sc.value} × ${s.referenceImages ?? 0} reference image(s) (${sc.label})`);
    } else {
      addPerRequest += sc.value;
      breakdown.push(`+ ${sc.value} per request (${sc.label})`);
    }
  }

  const requestsFor = (n: number) => Math.ceil(n / Math.max(1, s.imagesPerRequest ?? 1));
  const totalFor = (n: number) => roundMoney(Math.max(a.minimumChargeUsd ?? 0, perImage * n + addPerRequest * requestsFor(n)));
  const ageDays = (now.getTime() - new Date(price.retrievedAt).getTime()) / 86400_000;
  const stale = !(ageDays <= staleAfterDays);
  return {
    status: stale ? 'STALE' : 'OK',
    currency: price.currency,
    perImage: roundMoney(perImage),
    total: totalFor(Math.max(1, s.numImages)),
    table: QUANTITIES.map((q) => ({ quantity: q, total: totalFor(q) })),
    minimumKnownCost: a.minimumChargeUsd,
    breakdown,
    assumptions,
    explanation: stale
      ? `Estimate uses a price retrieved ${Math.floor(ageDays)} day(s) ago — refresh pricing or confirm before generating.`
      : 'Estimate from the stored price. Actual billing is determined by the provider.',
    billingUnit: price.billingUnit,
    priceRetrievedAt: price.retrievedAt,
  };
}

/** Whether a generation may start without an explicit "I accept unverified cost" confirmation. */
export const estimateNeedsConfirmation = (e: CostEstimate) => e.status !== 'OK';
