import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BANANA_EDIT_LIKE, SCHNELL_LIKE } from '../../../packages/core/test/fixtures/fal-openapi';
import { loadConfig } from '../src/config';
import { falPlatform } from '../src/providers/fal-platform';
import { falSdkOverrides } from '../src/providers/fal-sdk';
import { briefBody, H, prisma, signUp, waitForJob, type Agent } from './helpers';

/**
 * fal.ai is simulated at the HTTP layer (official Platform API shapes + the queue protocol used
 * by @fal-ai/client). These tests prove our handling; they do not prove live fal behaviour.
 */
const KEY = 'fal-test-key-DO-NOT-LEAK';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface FakeFal {
  catalog: Record<string, unknown>[];
  prices: Record<string, unknown>[];
  submits: { url: string; body: Record<string, unknown>; auth: string | null }[];
  resultFailures: number;
  submitStatus: number;
  billableUnits: string | null;
  authHeaders: string[];
}
let fake: FakeFal;
let png: Buffer;

function installFake() {
  falPlatform.fetch = async (url, init) => {
    const u = new URL(url);
    fake.authHeaders.push(String((init?.headers as Record<string, string>)?.authorization ?? ''));
    if (u.pathname === '/v1/models') {
      const ids = u.searchParams.getAll('endpoint_id');
      if (ids.length) return json(200, { models: fake.catalog.filter((m) => ids.includes(m.endpoint_id as string)), next_cursor: null, has_more: false });
      return json(200, { models: fake.catalog.filter((m) => (m.metadata as { category: string }).category === u.searchParams.get('category')), next_cursor: null, has_more: false });
    }
    if (u.pathname === '/v1/models/pricing') {
      const ids = u.searchParams.getAll('endpoint_id');
      return json(200, { prices: fake.prices.filter((p) => ids.includes(p.endpoint_id as string)), next_cursor: null, has_more: false });
    }
    return json(404, { detail: 'not found' });
  };
  falSdkOverrides.pollIntervalMs = 5;
  falSdkOverrides.fetch = async (url, init) => {
    const u = new URL(url);
    const auth = new Headers(init?.headers).get('authorization');
    if (u.hostname === 'queue.fal.run') {
      if ((init?.method ?? 'GET') === 'POST' && !u.pathname.includes('/requests/')) {
        fake.submits.push({ url, body: JSON.parse(String(init?.body ?? '{}')), auth });
        if (fake.submitStatus !== 200) return json(fake.submitStatus, { detail: [{ loc: ['body', 'prompt'], msg: 'rejected by model', type: 'value_error' }] });
        const id = `req-${fake.submits.length}`;
        return json(200, { request_id: id, status_url: `${u.origin}/x/requests/${id}/status`, response_url: `${u.origin}/x/requests/${id}` });
      }
      if (u.pathname.endsWith('/status')) return json(200, { status: 'COMPLETED', logs: [] });
      if (u.pathname.endsWith('/cancel')) return json(200, { status: 'CANCELLATION_REQUESTED' });
      if (fake.resultFailures > 0) {
        fake.resultFailures--;
        return json(503, { detail: 'temporarily unavailable' });
      }
      return json(200, { images: [{ url: 'https://v3.fal.media/files/out.png', width: 1024, height: 1024 }], seed: 42 }, fake.billableUnits ? { 'x-fal-billable-units': fake.billableUnits } : {});
    }
    if (u.hostname === 'v3.fal.media') return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    return json(404, {});
  };
}

const catalogEntry = (endpoint_id: string, openapi: unknown, category = 'text-to-image') => ({ endpoint_id, metadata: { display_name: endpoint_id.split('/').slice(1).join(' '), category, status: 'active', description: 'fixture', model_url: `https://fal.ai/models/${endpoint_id}` }, openapi });

let admin: { agent: Agent; userId: string; workspaceId: string };
let schnellId: string;
let bananaEditId: string;

beforeAll(async () => {
  loadConfig({ FAL_KEY: KEY, FAL_PLATFORM_API_URL: 'https://api.fal.ai/v1' });
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer();
  fake = { catalog: [], prices: [], submits: [], resultFailures: 0, submitStatus: 200, billableUnits: null, authHeaders: [] };
  installFake();
  await prisma.imageModelPrice.deleteMany({});
  await prisma.imageGeneration.deleteMany({});
  await prisma.imageModel.deleteMany({});
  admin = await signUp('Platform Admin');
  await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
});

afterAll(() => {
  loadConfig();
  falSdkOverrides.fetch = undefined;
  falPlatform.fetch = fetch;
});

beforeEach(() => {
  fake.submits = [];
  fake.resultFailures = 0;
  fake.submitStatus = 200;
  fake.billableUnits = null;
});

describe('image model catalog', () => {
  it('starts with unverified, disabled seed candidates (no invented prices) plus labelled offline mocks', async () => {
    const r = await admin.agent.get('/api/image-models');
    expect(r.status).toBe(200);
    const seed = r.body.models.find((m: { endpointId: string }) => m.endpointId === 'fal-ai/flux/schnell');
    expect(seed).toMatchObject({ availability: 'CANDIDATE_UNVERIFIED', enabled: false, usable: false, price: null });
    expect(seed.estimate.status).toBe('UNAVAILABLE');
    const mock = r.body.models.find((m: { endpointId: string }) => m.endpointId === 'mock/line-art');
    expect(mock).toMatchObject({ availability: 'OFFLINE_MOCK', usable: true });
    expect(mock.description + mock.knownLimitations).toMatch(/not ai/i);
  });

  it('boolean query flags parse "false" as false', async () => {
    const r = await admin.agent.get('/api/image-models?includeMock=false&includeUnavailable=false');
    expect(r.body.models.some((m: { provider: string }) => m.provider === 'mock')).toBe(false);
  });

  it('only platform admins can sync or price the catalog', async () => {
    const other = await signUp('Workspace Owner');
    expect((await other.agent.post('/api/admin/image-models/sync').set(H).send({})).status).toBe(403);
    expect((await other.agent.post('/api/admin/image-models/fal-ai%2Fflux%2Fschnell/price').set(H).send({ unitPrice: 0.01, unitRaw: 'image', sourceUrl: 'https://fal.ai/pricing' })).status).toBe(403);
  });

  it('verifies endpoints via the Platform API, derives capabilities from OpenAPI, stores prices with source/unit/time', async () => {
    fake.catalog = [catalogEntry('fal-ai/flux/schnell', SCHNELL_LIKE), catalogEntry('fal-ai/nano-banana-2/edit', BANANA_EDIT_LIKE, 'image-to-image'), catalogEntry('fal-ai/brand-new-model', SCHNELL_LIKE)];
    fake.prices = [{ endpoint_id: 'fal-ai/flux/schnell', unit_price: 0.003, unit: 'megapixels', currency: 'USD' }];
    const r = await admin.agent.post('/api/admin/image-models/sync').set(H).send({ discover: true });
    expect(r.status).toBe(200);
    expect(r.body.verified).toEqual(expect.arrayContaining(['fal-ai/flux/schnell', 'fal-ai/nano-banana-2/edit']));
    expect(r.body.notFound).toContain('fal-ai/nano-banana-pro');
    expect(r.body.discovered).toContain('fal-ai/brand-new-model');
    expect(r.body.priced).toEqual(['fal-ai/flux/schnell']);
    expect(r.body.priceMissing).toContain('fal-ai/nano-banana-2/edit');
    expect(fake.authHeaders.every((h) => h === `Key ${KEY}`)).toBe(true);

    const list = await admin.agent.get('/api/image-models?widthPx=2048&heightPx=2048&numImages=4');
    const schnell = list.body.models.find((m: { endpointId: string }) => m.endpointId === 'fal-ai/flux/schnell');
    schnellId = schnell.id;
    expect(schnell).toMatchObject({ availability: 'VERIFIED', usable: true });
    expect(schnell.tasks).toContain('text-to-image');
    expect(schnell.price).toMatchObject({ billingUnit: 'MEGAPIXEL', unitPrice: 0.003, currency: 'USD', source: 'FAL_PRICING_API' });
    expect(schnell.price.retrievedAt).toBeTruthy();
    // 2048×2048 = 4.19 MP → rounded up to 5 MP × $0.003 = $0.015/image; ×4 = $0.06.
    expect(schnell.estimate.status).toBe('OK');
    expect(schnell.estimate.perImage).toBeCloseTo(0.015, 6);
    expect(schnell.estimate.total).toBeCloseTo(0.06, 6);
    expect(schnell.estimate.explanation).not.toMatch(/per image price/i);
    const banana = list.body.models.find((m: { endpointId: string }) => m.endpointId === 'fal-ai/nano-banana-2/edit');
    bananaEditId = banana.id;
    expect(banana.price).toBeNull();
    expect(banana.estimate.status).toBe('UNAVAILABLE');
    expect(banana.tasks).toEqual(expect.arrayContaining(['edit', 'reference']));
    const missing = await prisma.imageModel.findUnique({ where: { endpointId: 'fal-ai/nano-banana-pro' } });
    expect(missing).toMatchObject({ availability: 'NOT_FOUND', enabled: false });
    // The API key never appears in a response.
    expect(JSON.stringify(list.body)).not.toContain(KEY);
  });

  it('keeps price history on re-sync and accepts admin prices only with an https source', async () => {
    fake.prices = [{ endpoint_id: 'fal-ai/flux/schnell', unit_price: 0.0035, unit: 'megapixels', currency: 'USD' }];
    await admin.agent.post('/api/admin/image-models/sync').set(H).send({});
    const d = await admin.agent.get(`/api/image-models/${schnellId}`);
    expect(d.body.priceHistory.length).toBeGreaterThanOrEqual(2);
    expect(d.body.priceHistory.filter((p: { isCurrent: boolean }) => p.isCurrent)).toHaveLength(1);
    expect(d.body.price.unitPrice).toBe(0.0035);
    expect((await admin.agent.post(`/api/admin/image-models/${bananaEditId}/price`).set(H).send({ unitPrice: 0.08, unitRaw: 'image', sourceUrl: 'http://insecure' })).status).toBe(400);
    const ok = await admin.agent.post(`/api/admin/image-models/${bananaEditId}/price`).set(H).send({ unitPrice: 0.08, unitRaw: 'image', sourceUrl: 'https://fal.ai/models/fal-ai/nano-banana-2/edit' });
    expect(ok.status).toBe(200);
    expect(ok.body.price).toMatchObject({ billingUnit: 'IMAGE', source: 'ADMIN_MANUAL' });
  });

  it('cannot enable an unverified candidate', async () => {
    const r = await admin.agent.patch('/api/admin/image-models/fal-ai%2Fflux-2-max').set(H).send({ enabled: true });
    expect(r.status).toBe(409);
  });

  it('validates settings against the model schema (unsupported options are rejected, not silently dropped)', async () => {
    const r = await admin.agent.post('/api/image-models/estimate').set(H).send({ modelId: schnellId, request: { prompt: 'a fox', negativePrompt: 'blurry', widthPx: 1024, heightPx: 1024 } });
    expect(r.status).toBe(200);
    expect(r.body.errors.join(' ')).toMatch(/negative/i);
  });
});

describe('generation through the fal queue', () => {
  it('requires confirmation of the estimate before any provider call', async () => {
    const body = { modelId: schnellId, request: { prompt: 'a lighthouse, line art', widthPx: 1024, heightPx: 1024 } };
    const none = await admin.agent.post('/api/image-generations').set(H).send(body);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('CONFIRMATION_REQUIRED');
    const low = await admin.agent.post('/api/image-generations').set(H).send({ ...body, confirmation: { acceptedEstimateUsd: 0.0001 } });
    expect(low.status).toBe(409);
    expect(fake.submits).toHaveLength(0);
  });

  it('submits once, stores the request id, downloads the output and records actual cost from billable units', async () => {
    fake.billableUnits = '2';
    const est = await admin.agent.post('/api/image-models/estimate').set(H).send({ modelId: schnellId, request: { prompt: 'a lighthouse', widthPx: 1024, heightPx: 1024 } });
    const r = await admin.agent.post('/api/image-generations').set(H).send({ modelId: schnellId, request: { prompt: 'a lighthouse', widthPx: 1024, heightPx: 1024 }, confirmation: { acceptedEstimateUsd: est.body.estimate.total } });
    expect(r.status).toBe(202);
    const job = await waitForJob(admin.agent, r.body.jobId);
    expect(job.status).toBe('SUCCEEDED');
    expect(fake.submits).toHaveLength(1);
    expect(fake.submits[0].auth).toBe(`Key ${KEY}`);
    expect(fake.submits[0].body).toMatchObject({ prompt: 'a lighthouse', image_size: { width: 1024, height: 1024 } });
    const gens = await admin.agent.get(`/api/image-generations?jobId=${r.body.jobId}`);
    const g = gens.body.generations[0];
    expect(g).toMatchObject({ status: 'SUCCEEDED', requestId: 'req-1', billableUnits: 2, actualCostSource: 'FAL_BILLABLE_UNITS_HEADER', confirmedByUser: true });
    expect(Number(g.actualCostUsd)).toBeCloseTo(0.007, 6);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: g.assetIds[0] } });
    expect(asset).toMatchObject({ source: 'AI', mimeType: 'image/png', widthPx: 64 });
    expect(JSON.stringify(job.logs)).not.toContain(KEY);
  });

  it('without the billable-units header, actual cost stays unknown (never guessed)', async () => {
    const est = await admin.agent.post('/api/image-models/estimate').set(H).send({ modelId: schnellId, request: { prompt: 'x', widthPx: 512, heightPx: 512 } });
    const r = await admin.agent.post('/api/image-generations').set(H).send({ modelId: schnellId, request: { prompt: 'x', widthPx: 512, heightPx: 512 }, confirmation: { acceptedEstimateUsd: est.body.estimate.total } });
    await waitForJob(admin.agent, r.body.jobId);
    const g = (await admin.agent.get(`/api/image-generations?jobId=${r.body.jobId}`)).body.generations[0];
    expect(g.status).toBe('SUCCEEDED');
    expect(g.actualCostUsd).toBeNull();
    expect(g.estimatedCostUsd).not.toBeNull();
  });

  it('a transient failure while fetching the result resumes the same request (no second charge)', async () => {
    fake.resultFailures = 1;
    const est = await admin.agent.post('/api/image-models/estimate').set(H).send({ modelId: schnellId, request: { prompt: 'retry me', widthPx: 512, heightPx: 512 } });
    const r = await admin.agent.post('/api/image-generations').set(H).send({ modelId: schnellId, request: { prompt: 'retry me', widthPx: 512, heightPx: 512 }, confirmation: { acceptedEstimateUsd: est.body.estimate.total } });
    const job = await waitForJob(admin.agent, r.body.jobId);
    expect(job.status).toBe('SUCCEEDED');
    expect(fake.submits).toHaveLength(1);
  });

  it('a provider validation error (422) fails permanently without retrying the submit', async () => {
    fake.submitStatus = 422;
    const est = await admin.agent.post('/api/image-models/estimate').set(H).send({ modelId: schnellId, request: { prompt: 'bad', widthPx: 512, heightPx: 512 } });
    const r = await admin.agent.post('/api/image-generations').set(H).send({ modelId: schnellId, request: { prompt: 'bad', widthPx: 512, heightPx: 512 }, confirmation: { acceptedEstimateUsd: est.body.estimate.total } });
    const job = await waitForJob(admin.agent, r.body.jobId);
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/rejected/);
    expect(fake.submits).toHaveLength(1);
  });

  it('a model without a current price needs explicit acceptance of an unverified cost', async () => {
    await prisma.imageModelPrice.updateMany({ where: { modelId: bananaEditId }, data: { isCurrent: false } });
    await prisma.imageModel.update({ where: { id: bananaEditId }, data: { enabled: true } });
    const ws = admin.workspaceId;
    const a = await prisma.asset.create({ data: { workspaceId: ws, kind: 'IMAGE', filename: 'src.png', mimeType: 'image/png', sizeBytes: png.length, storageKey: `ws/${ws}/src-${Date.now()}.png`, sha256: 'x', widthPx: 64, heightPx: 64, source: 'UPLOAD' } });
    const { getStorage } = await import('../src/lib/storage');
    await getStorage().put(a.storageKey, png, 'image/png');
    const body = { modelId: bananaEditId, request: { prompt: 'make it line art', referenceAssetIds: [a.id], aspectRatio: '1:1' } };
    const r1 = await admin.agent.post('/api/image-generations').set(H).send({ ...body, confirmation: { acceptedEstimateUsd: null } });
    expect(r1.status).toBe(409);
    expect(r1.body.error.message).toMatch(/unavailable|unverified/i);
    const r2 = await admin.agent.post('/api/image-generations').set(H).send({ ...body, confirmation: { acceptedEstimateUsd: null, acceptUnverifiedCost: true } });
    expect(r2.status).toBe(202);
    const job = await waitForJob(admin.agent, r2.body.jobId);
    expect(job.status).toBe('SUCCEEDED');
    expect(String(fake.submits[0].body.image_urls)).toMatch(/^data:image\/png;base64,/);
    const g = (await admin.agent.get(`/api/image-generations?jobId=${r2.body.jobId}`)).body.generations[0];
    expect(g.estimateStatus).toBe('UNAVAILABLE');
    // Inline image data is not persisted in the generation log.
    expect(JSON.stringify(g.input)).toContain('[inline image');
  });

  it('enforces the project AI budget before submitting', async () => {
    const p = await admin.agent.post('/api/projects').set(H).send(briefBody());
    const projectId = p.body.id ?? p.body.project?.id;
    expect(projectId).toBeTruthy();
    await prisma.project.update({ where: { id: projectId }, data: { aiSpendLimitUsd: 0.0001 } });
    const est = await admin.agent.post('/api/image-models/estimate').set(H).send({ modelId: schnellId, request: { prompt: 'x', widthPx: 1024, heightPx: 1024 } });
    const r = await admin.agent.post('/api/image-generations').set(H).send({ modelId: schnellId, projectId, request: { prompt: 'x', widthPx: 1024, heightPx: 1024 }, confirmation: { acceptedEstimateUsd: est.body.estimate.total } });
    const job = await waitForJob(admin.agent, r.body.jobId);
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/budget/i);
    expect(fake.submits).toHaveLength(0);
  });
});

describe('model comparison', () => {
  it('estimates, requires confirmation of the total, runs one image per model and records ratings + preference', async () => {
    const mock = await prisma.imageModel.findUniqueOrThrow({ where: { endpointId: 'mock/line-art' } });
    const req = { prompt: 'a cat, coloring page', widthPx: 1024, heightPx: 1024 };
    const est = await admin.agent.post('/api/image-compare/estimate').set(H).send({ modelIds: [schnellId, mock.id], request: req });
    expect(est.status).toBe(200);
    expect(est.body.items).toHaveLength(2);
    expect(est.body.knownTotalUsd).toBeGreaterThan(0);
    const unconfirmed = await admin.agent.post('/api/image-compare').set(H).send({ modelIds: [schnellId, mock.id], request: req, confirmation: { acceptedTotalUsd: 0 } });
    expect(unconfirmed.status).toBe(409);
    const r = await admin.agent.post('/api/image-compare').set(H).send({ name: 'Cats', modelIds: [schnellId, mock.id], request: req, confirmation: { acceptedTotalUsd: est.body.knownTotalUsd } });
    expect(r.status).toBe(202);
    const job = await waitForJob(admin.agent, r.body.jobId);
    expect(job.status).toBe('SUCCEEDED');
    const c = await admin.agent.get(`/api/image-compare/${r.body.comparisonId}`);
    expect(c.body.status).toBe('COMPLETED');
    expect(c.body.generations).toHaveLength(2);
    expect(c.body.generations.every((g: { assetIds: string[]; settings: { prompt: string } }) => g.assetIds.length === 1 && g.settings.prompt === req.prompt)).toBe(true);
    expect((await admin.agent.post(`/api/image-compare/${r.body.comparisonId}/rate`).set(H).send({ modelId: schnellId, rating: 4, notes: 'clean lines' })).status).toBe(200);
    expect((await admin.agent.post('/api/image-models/preferred').set(H).send({ modelId: schnellId })).status).toBe(200);
    expect((await admin.agent.get('/api/image-models')).body.preferredModelId).toBe(schnellId);
  });

  it('comparisons and generations are workspace-scoped', async () => {
    const other = await signUp('Outsider');
    const list = await admin.agent.get('/api/image-compare');
    expect((await other.agent.get(`/api/image-compare/${list.body[0].id}`)).status).toBe(404);
    const gens = await admin.agent.get('/api/image-generations');
    expect((await other.agent.get(`/api/image-generations/${gens.body.generations[0].id}`)).status).toBe(404);
  });
});

describe('cover art from the model library', () => {
  it('uses verified cover geometry for the art area, requires confirmation, and applies art under live text', async () => {
    const p = await admin.agent.post('/api/projects').set(H).send(briefBody());
    const projectId = p.body.id ?? p.body.project?.id;
    const t = await admin.agent.get(`/api/projects/${projectId}/cover-art/target`);
    expect(t.status).toBe(200);
    // 6×9 front panel + 0.125" bleed on the outer edge and top/bottom.
    expect(t.body.widthIn).toBeCloseTo(6.125, 3);
    expect(t.body.heightIn).toBeCloseTo(9.25, 3);
    const mock = await prisma.imageModel.findUniqueOrThrow({ where: { endpointId: 'mock/cover-art' } });
    expect((await admin.agent.post(`/api/projects/${projectId}/cover-art`).set(H).send({ modelId: mock.id, request: { prompt: 'misty forest' } })).status).toBe(409);
    const r = await admin.agent.post(`/api/projects/${projectId}/cover-art`).set(H).send({ modelId: mock.id, request: { prompt: 'misty forest' }, confirmation: { acceptedEstimateUsd: 0 } });
    expect(r.status).toBe(202);
    const job = await waitForJob(admin.agent, r.body.jobId);
    expect(job.status).toBe('SUCCEEDED');
    const g = (await admin.agent.get(`/api/image-generations?jobId=${r.body.jobId}`)).body.generations[0];
    expect(g.settings.prompt).toMatch(/no text/i);
    const cover = await admin.agent.post(`/api/projects/${projectId}/covers`).set(H).send({});
    const applied = await admin.agent.post(`/api/projects/${projectId}/covers/${cover.body.id}/apply-art`).set(H).send({ assetId: g.assetIds[0], revision: cover.body.revision });
    expect(applied.status).toBe(200);
    const layers = applied.body.cover.design.layers as { id: string; type: string }[];
    expect(layers[0]).toMatchObject({ id: 'cover-art', type: 'image' });
    expect(layers.some((l) => l.type === 'text')).toBe(true);
    // Stale revision is rejected.
    expect((await admin.agent.post(`/api/projects/${projectId}/covers/${cover.body.id}/apply-art`).set(H).send({ assetId: g.assetIds[0], revision: cover.body.revision })).status).toBe(409);
  });
});
