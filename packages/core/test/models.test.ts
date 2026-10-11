import { describe, expect, it } from 'vitest';
import { buildModelInput, deriveCapabilities, describePrice, estimateCost, extractIoSchemas, ModelPrice, normalizeUnit, type ModelPrice as MP } from '../src/index';
import { BANANA_EDIT_LIKE, FILL_LIKE, SCHNELL_LIKE } from './fixtures/fal-openapi';

const price = (o: Partial<MP> & { unitRaw: string; unitPrice: number | null }): MP => {
  const n = normalizeUnit(o.unitRaw);
  return ModelPrice.parse({ billingUnit: n.billingUnit, source: 'FAL_PRICING_API', retrievedAt: new Date().toISOString(), ...o, assumptions: { unitScale: n.unitScale, ...(o.assumptions ?? {}) } });
};

describe('pricing units', () => {
  it.each([
    ['image', 'IMAGE', 1],
    ['images', 'IMAGE', 1],
    ['megapixels', 'MEGAPIXEL', 1],
    ['MP', 'MEGAPIXEL', 1],
    ['1M tokens', 'TOKEN', 1e6],
    ['1k tokens', 'TOKEN', 1e3],
    ['second', 'SECOND', 1],
    ['request', 'REQUEST', 1],
    ['video', 'UNKNOWN', 1],
    ['', 'UNKNOWN', 1],
  ])('"%s" → %s ×%d', (raw, unit, scale) => {
    expect(normalizeUnit(raw)).toEqual({ billingUnit: unit, unitScale: scale });
  });

  it('never labels a megapixel price as per-image', () => {
    expect(describePrice(price({ unitRaw: 'megapixels', unitPrice: 0.012 }))).toBe('$0.012 per megapixel');
    expect(describePrice(price({ unitRaw: 'image', unitPrice: 0.04 }))).toBe('$0.04 per image');
    expect(describePrice(null)).toBe('Price unavailable');
  });
});

describe('cost estimation', () => {
  it('per-image pricing scales with quantity', () => {
    const e = estimateCost(price({ unitRaw: 'image', unitPrice: 0.04 }), { numImages: 4 });
    expect(e.status).toBe('OK');
    expect(e.perImage).toBe(0.04);
    expect(e.total).toBe(0.16);
    expect(e.table.map((r) => r.total)).toEqual([0.04, 0.16, 0.4, 2, 4]);
  });

  it('megapixel pricing needs dimensions and rounds up (documented assumption)', () => {
    const p = price({ unitRaw: 'megapixels', unitPrice: 0.012 });
    expect(estimateCost(p, { numImages: 1 }).status).toBe('UNKNOWN_DIMENSIONS');
    const e = estimateCost(p, { numImages: 10, widthPx: 1024, heightPx: 1024 });
    expect(e.perImage).toBeCloseTo(0.024, 6); // 1.05 MP → 2 MP
    expect(e.total).toBeCloseTo(0.24, 6);
    expect(e.assumptions.join(' ')).toMatch(/rounded up/);
    const exact = estimateCost({ ...p, assumptions: { ...p.assumptions, megapixelRounding: 'EXACT' } }, { numImages: 1, widthPx: 2000, heightPx: 1500 });
    expect(exact.perImage).toBeCloseTo(0.036, 6);
  });

  it('token pricing is only estimated with an explicit assumption', () => {
    const p = price({ unitRaw: '1M tokens', unitPrice: 40 });
    const e = estimateCost(p, { numImages: 1 });
    expect(e.status).toBe('NEEDS_ASSUMPTIONS');
    expect(e.total).toBeNull();
    const withA = estimateCost({ ...p, assumptions: { ...p.assumptions, tokensPerImage: 1500 } }, { numImages: 2 });
    expect(withA.perImage).toBeCloseTo(0.06, 6);
    expect(withA.assumptions.join(' ')).toMatch(/can differ/);
  });

  it('applies matching surcharges and minimum charges only', () => {
    const p = price({
      unitRaw: 'image',
      unitPrice: 0.08,
      assumptions: {
        minimumChargeUsd: 0.1,
        surcharges: [
          { id: '4k', label: '4K output', kind: 'MULTIPLIER', value: 2, when: { resolution: '4K' } },
          { id: 'ref', label: 'Reference image', kind: 'ADD_PER_REFERENCE_IMAGE', value: 0.01, when: { feature: 'reference' } },
        ],
      } as never,
    });
    expect(estimateCost(p, { numImages: 1 }).total).toBe(0.1); // minimum
    expect(estimateCost(p, { numImages: 2, resolution: '4K' }).perImage).toBe(0.16);
    expect(estimateCost(p, { numImages: 1, resolution: '1K', referenceImages: 2 }).perImage).toBe(0.1);
  });

  it('missing, unknown, or stale prices are never presented as verified', () => {
    expect(estimateCost(null, { numImages: 1 }).status).toBe('UNAVAILABLE');
    expect(estimateCost(price({ unitRaw: 'image', unitPrice: null }), { numImages: 1 }).explanation).toMatch(/Price unavailable/);
    expect(estimateCost(price({ unitRaw: 'per video', unitPrice: 0.5 }), { numImages: 1 }).status).toBe('UNAVAILABLE');
    const old = price({ unitRaw: 'image', unitPrice: 0.04, retrievedAt: new Date(Date.now() - 30 * 86400_000).toISOString() });
    expect(estimateCost(old, { numImages: 1 }).status).toBe('STALE');
  });
});

describe('capabilities from fal OpenAPI schemas', () => {
  it('extracts the input schema through $refs and derives text-to-image settings', () => {
    const { input, output } = extractIoSchemas(SCHNELL_LIKE);
    expect(input?.properties?.prompt).toBeTruthy();
    expect(output?.properties?.images).toBeTruthy();
    const caps = deriveCapabilities(input, { endpointId: 'fal-ai/flux/schnell', category: 'text-to-image' });
    expect(caps.tasks).toEqual(['text-to-image', 'high-resolution']); // custom sizes up to 14142px
    expect(caps.imageSize?.presets.map((p) => p.value)).toContain('portrait_4_3');
    expect(caps.imageSize?.allowsCustom).toBe(true);
    expect(caps.imageSize?.maxDimension).toBe(14142);
    expect(caps.numImages).toEqual({ param: 'num_images', min: 1, max: 4 });
    expect(caps.negativePromptParam).toBeNull();
    expect(caps.aspectRatio).toBeNull();
  });

  it('derives editing/reference/high-resolution and inpaint capabilities with evidence', () => {
    const edit = deriveCapabilities(extractIoSchemas(BANANA_EDIT_LIKE).input, { endpointId: 'fal-ai/nano-banana-2/edit', category: 'image-to-image' });
    expect(edit.tasks).toEqual(expect.arrayContaining(['image-to-image', 'edit', 'reference', 'high-resolution']));
    expect(edit.taskEvidence.reference).toMatch(/image_urls/);
    expect(edit.imageUrlsParam).toEqual({ param: 'image_urls', maxItems: 4 });
    const fill = deriveCapabilities(extractIoSchemas(FILL_LIKE).input, { endpointId: 'fal-ai/flux-pro/v1/fill', category: 'image-to-image' });
    expect(fill.tasks).toContain('inpaint');
  });

  it('builds model-specific input and rejects undeclared settings', () => {
    const { input } = extractIoSchemas(SCHNELL_LIKE);
    const caps = deriveCapabilities(input, { endpointId: 'fal-ai/flux/schnell', category: 'text-to-image' });
    const ok = buildModelInput(caps, input, { prompt: 'A fox', numImages: 2, aspect: 0.77, seed: 7 });
    expect(ok.errors).toEqual([]);
    expect(ok.input).toEqual({ prompt: 'A fox', image_size: 'portrait_4_3', num_images: 2, seed: 7 });
    expect(ok.expectedWidthPx).toBe(768);
    expect(ok.dimensionsAreAssumed).toBe(true);
    const custom = buildModelInput(caps, input, { prompt: 'A fox', numImages: 1, widthPx: 2048, heightPx: 2560 });
    expect(custom.input.image_size).toEqual({ width: 2048, height: 2560 });
    expect(custom.dimensionsAreAssumed).toBe(false);
    const bad = buildModelInput(caps, input, { prompt: 'A fox', numImages: 1, negativePrompt: 'blur', aspectRatio: '3:4', imageUrls: ['https://x/a.png'], extra: { steps: 4 } });
    expect(bad.errors).toEqual(expect.arrayContaining([expect.stringMatching(/negative prompt/), expect.stringMatching(/aspect ratio/), expect.stringMatching(/reference images/), expect.stringMatching(/Unknown parameter "steps"/)]));
  });

  it('validates values against the schema (enums, limits) and maps aspect ratios', () => {
    const { input } = extractIoSchemas(BANANA_EDIT_LIKE);
    const caps = deriveCapabilities(input, { endpointId: 'fal-ai/nano-banana-2/edit', category: 'image-to-image' });
    const r = buildModelInput(caps, input, { prompt: 'Recolor', numImages: 1, aspect: 8.5 / 11, resolution: '2K', imageUrls: ['data:image/png;base64,AA=='] });
    expect(r.errors).toEqual([]);
    expect(r.input.aspect_ratio).toBe('3:4');
    expect(r.expectedHeightPx).toBe(2048);
    expect(r.dimensionsAreAssumed).toBe(true);
    const missing = buildModelInput(caps, input, { prompt: 'Recolor', numImages: 1 });
    expect(missing.errors.join(' ')).toMatch(/image_urls/);
    const tooMany = buildModelInput(caps, input, { prompt: 'x', numImages: 1, imageUrls: ['a', 'b', 'c', 'd', 'e'] });
    expect(tooMany.errors.join(' ')).toMatch(/At most 4/);
    const badRes = buildModelInput(caps, input, { prompt: 'x', numImages: 1, resolution: '8K', imageUrls: ['a'] });
    expect(badRes.errors.join(' ')).toMatch(/8K/);
  });
});
