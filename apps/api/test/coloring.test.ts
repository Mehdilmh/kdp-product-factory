import { QcThresholds, rasterizeSvg } from '@kdp/core';
import { Prisma } from '@prisma/client';
import JSZip from 'jszip';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeColoringImage, processColoringImage, ProcessingOptions } from '../src/services/coloring-image';
import { ensureCatalog } from '../src/services/image-catalog';
import { H, prisma, signUp, waitForJob, type Agent } from './helpers';

const placement = { widthIn: 7.25, heightIn: 10 };
const T = QcThresholds.parse({});
const svgPng = (body: string, w = 2175, h = 3000) => Buffer.from(rasterizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`, w));

describe('coloring QC heuristics', () => {
  it('passes clean black line art and flags nothing but manual items', async () => {
    const r = await analyzeColoringImage(svgPng('<circle cx="1087" cy="1500" r="700" fill="none" stroke="#000" stroke-width="18"/><rect x="600" y="600" width="900" height="500" fill="none" stroke="#000" stroke-width="18"/>'), placement, T);
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(by).toMatchObject({ decode: 'PASS', dpi: 'PASS', background: 'PASS', color: 'PASS', gray: 'PASS', contrast: 'PASS', crop: 'PASS', text: 'MANUAL' });
    expect(r.dhash).toMatch(/^[0-9a-f]{16}$/);
    // Text/watermarks are never auto-passed.
    expect(r.checks.find((c) => c.id === 'text')!.kind).toBe('MANUAL');
  });

  it('flags color, gray shading, thin lines, cropping, low DPI, alpha and corrupt files', async () => {
    const color = await analyzeColoringImage(svgPng('<circle cx="1000" cy="1500" r="700" fill="#e33"/>'), placement, T);
    expect(color.checks.find((c) => c.id === 'color')!.status).toBe('WARN');
    const gray = await analyzeColoringImage(svgPng('<rect x="200" y="200" width="1700" height="2500" fill="#999"/>'), placement, T);
    expect(gray.checks.find((c) => c.id === 'gray')!.status).toBe('WARN');
    const thin = await analyzeColoringImage(svgPng('<circle cx="1087" cy="1500" r="700" fill="none" stroke="#000" stroke-width="3"/>'), placement, { ...T, minLineWeightPt: 1.25 });
    expect(thin.checks.find((c) => c.id === 'lines')!.status).toBe('WARN');
    const crop = await analyzeColoringImage(svgPng('<circle cx="0" cy="1500" r="900" fill="none" stroke="#000" stroke-width="40"/><rect x="0" y="0" width="2175" height="3000" fill="none" stroke="#000" stroke-width="60"/>'), placement, T);
    expect(crop.checks.find((c) => c.id === 'crop')!.status).toBe('WARN');
    const small = await analyzeColoringImage(svgPng('<circle cx="100" cy="150" r="60" fill="none" stroke="#000" stroke-width="4"/>', 218, 300), placement, T);
    expect(small.checks.find((c) => c.id === 'dpi')!.status).toBe('FAIL');
    const alpha = await sharp({ create: { width: 800, height: 1100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    expect((await analyzeColoringImage(alpha, placement, T)).checks.find((c) => c.id === 'alpha')!.status).toBe('WARN');
    const corrupt = (await analyzeColoringImage(svgPng('').subarray(0, 400), placement, T)).checks[0];
    expect(corrupt).toMatchObject({ id: 'decode', status: 'FAIL' });
  });

  it('processing preserves art, outputs pure black/white, and resamples toward 300 DPI', async () => {
    const src = svgPng('<circle cx="500" cy="700" r="300" fill="none" stroke="#333" stroke-width="10"/><circle cx="500" cy="700" r="100" fill="#bbb"/>', 1000, 1380);
    const out = await processColoringImage(src, placement, ProcessingOptions.parse({ threshold: 128 }));
    expect(out.widthPx).toBeGreaterThan(1000);
    const st = await sharp(Buffer.from(out.bytes)).raw().toBuffer({ resolveWithObject: true });
    const values = new Set(st.data);
    expect([...values].every((v) => v === 0 || v === 255)).toBe(true);
    expect(out.steps.join(' ')).toMatch(/threshold/);
  });
});

describe('Coloring Studio workflow', () => {
  let a: { agent: Agent; userId: string; workspaceId: string };
  let mockId: string;
  let pricedId: string;
  beforeAll(async () => {
    await ensureCatalog();
    a = await signUp('Colorist');
    const mock = await prisma.imageModel.findUniqueOrThrow({ where: { endpointId: 'mock/line-art' } });
    mockId = mock.id;
    // A priced offline model so confirmation + budget logic can be exercised without network.
    const priced = await prisma.imageModel.upsert({
      where: { endpointId: 'mock/line-art-priced' },
      update: {},
      create: { provider: 'mock', endpointId: 'mock/line-art-priced', displayName: 'Priced test mock', family: 'mock', category: 'text-to-image', availability: 'OFFLINE_MOCK', source: 'BUILT_IN', enabled: true, tasks: mock.tasks, capabilities: mock.capabilities as Prisma.InputJsonValue, inputSchema: mock.inputSchema as Prisma.InputJsonValue, editorialTags: [] },
    });
    pricedId = priced.id;
    await prisma.imageModelPrice.deleteMany({ where: { modelId: priced.id } });
    await prisma.imageModelPrice.create({ data: { modelId: priced.id, unitPrice: new Prisma.Decimal(0.01), unitRaw: 'image', billingUnit: 'IMAGE', currency: 'USD', source: 'ADMIN_MANUAL', sourceUrl: 'https://example.test/pricing', retrievedAt: new Date(), assumptions: { unitScale: 1 }, isCurrent: true } });
  });

  it('runs the full flow: create → plan → estimate → confirm → generate → QC → review → interior → preflight → export', async () => {
    const presets = await a.agent.get('/api/coloring/presets');
    expect(presets.body.trims.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(['8.5x11', '8x10', '8.5x8.5', '8.25x8.25']));

    const create = await a.agent.post('/api/coloring').set(H).send({ title: 'Barnyard Buddies', subtitle: 'Big, easy farm pictures', author: 'Sam Lee', audience: 'PRESCHOOL', theme: 'farm', illustrationTarget: 4, trimId: '8.5x11', concepts: ['cow in a meadow', 'cows in a meadow'] });
    expect(create.status).toBe(201);
    const id = create.body.id as string;
    expect(create.body.repeatedConcepts).toHaveLength(1);
    expect(create.body.style.outlineThickness).toBe('THICK');
    expect((await a.agent.post(`/api/coloring/${id}/pages`).set(H).send({ fromTheme: { theme: 'farm', count: 2 } })).body.added).toBe(2);
    let book = (await a.agent.get(`/api/coloring/${id}`)).body;
    expect(book.pages).toHaveLength(4);
    expect(book.pages[0].prompt).toMatch(/no text/);
    const pageIds = book.pages.map((p: { id: string }) => p.id);

    // Priced model: estimate must be confirmed.
    const est = await a.agent.post(`/api/coloring/${id}/estimate`).set(H).send({ pageIds, modelId: pricedId });
    expect(est.body.knownTotalUsd).toBeCloseTo(0.04, 6);
    expect(est.body.table.find((r: { quantity: number }) => r.quantity === 50).total).toBeCloseTo(0.5, 6);
    expect((await a.agent.post(`/api/coloring/${id}/generate`).set(H).send({ pageIds, modelId: pricedId, confirmation: { acceptedTotalUsd: 0.01 } })).status).toBe(409);
    // Budget cap below the batch total is enforced before anything runs.
    await a.agent.patch(`/api/coloring/${id}`).set(H).send({ budgetCapUsd: 0.025 });
    const over = await a.agent.post(`/api/coloring/${id}/generate`).set(H).send({ pageIds, modelId: pricedId, confirmation: { acceptedTotalUsd: 0.04 } });
    expect(over.status).toBe(429);
    await a.agent.patch(`/api/coloring/${id}`).set(H).send({ budgetCapUsd: null });

    const gen = await a.agent.post(`/api/coloring/${id}/generate`).set(H).send({ pageIds, modelId: pricedId, confirmation: { acceptedTotalUsd: 0.04 } });
    expect(gen.status).toBe(202);
    const job = await waitForJob(a.agent, gen.body.jobId);
    expect(job.status).toBe('SUCCEEDED');
    book = (await a.agent.get(`/api/coloring/${id}`)).body;
    for (const p of book.pages) {
      expect(p.status).toBe('NEEDS_REVIEW');
      expect(p.current.processedAssetId).toBeTruthy();
      expect(p.current.originalAssetId).not.toBe(p.current.processedAssetId);
      expect(p.current.qc.checks.length).toBeGreaterThan(8);
      expect(Number(p.current.estimatedCostUsd)).toBeCloseTo(0.01, 6);
    }
    expect(book.cost.estimatedUsd).toBeCloseTo(0.04, 6);

    // Variation → version 2; restore version 1.
    const first = book.pages[0];
    const v = await a.agent.post(`/api/coloring/${id}/generate`).set(H).send({ pageIds: [first.id], modelId: mockId, mode: 'VARIATION', confirmation: { acceptedTotalUsd: 0 } });
    expect((await waitForJob(a.agent, v.body.jobId)).status).toBe('SUCCEEDED');
    let p0 = (await a.agent.get(`/api/coloring/${id}`)).body.pages[0];
    expect(p0.versions).toHaveLength(2);
    expect(p0.current.version).toBe(2);
    await a.agent.post(`/api/coloring/${id}/pages/${first.id}/restore`).set(H).send({ versionId: p0.versions[1].id });
    p0 = (await a.agent.get(`/api/coloring/${id}`)).body.pages[0];
    expect(p0.current.version).toBe(1);

    // Replace one page with a low-resolution upload: DPI FAIL → approval needs an override note.
    const small = svgPng('<circle cx="100" cy="150" r="60" fill="none" stroke="#000" stroke-width="5"/>', 218, 300);
    const up = await a.agent.post('/api/assets').set(H).attach('file', small, { filename: 'small.png', contentType: 'image/png' }).field('licenseNote', 'Drawn by the author');
    expect(up.status).toBe(201);
    const last = book.pages[3];
    await a.agent.post(`/api/coloring/${id}/pages/${last.id}/replace`).set(H).send({ assetId: up.body.id });
    await a.agent.post(`/api/coloring/${id}/pages/${last.id}/process`).set(H).send({ options: { upscaleToDpi: 0 } });
    const blocked = await a.agent.post(`/api/coloring/${id}/pages/${last.id}/status`).set(H).send({ status: 'APPROVED' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('QC_OVERRIDE_REQUIRED');
    expect((await a.agent.post(`/api/coloring/${id}/pages/${last.id}/status`).set(H).send({ status: 'REJECTED' })).status).toBe(200);

    // Bulk approve the rest; reorder.
    const bulk = await a.agent.post(`/api/coloring/${id}/bulk`).set(H).send({ pageIds: pageIds.slice(0, 3), action: 'approve' });
    expect(bulk.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    await a.agent.post(`/api/coloring/${id}/pages/reorder`).set(H).send({ pageIds: [pageIds[2], pageIds[0], pageIds[1], pageIds[3]] });

    // Interior: 3 illustrations, single-sided → each followed by a blank page.
    const interior = await a.agent.post(`/api/coloring/${id}/interior`).set(H).send({});
    expect(interior.status).toBe(200);
    expect(interior.body.illustrations).toBe(3);
    const imgPages = interior.body.pages.filter((p: { hasImage: boolean }) => p.hasImage);
    expect(imgPages).toHaveLength(3);
    for (const p of imgPages) expect(interior.body.pages[p.index + 1].blank).toBe(true);
    expect(interior.body.trim.widthIn).toBe(8.5);
    expect(interior.body.warnings.filter((w: { code: string; level: string }) => w.level === 'error' || w.code === 'UNKNOWN_TEMPLATE')).toEqual([]);

    const pf = await a.agent.post(`/api/coloring/${id}/preflight`).set(H).send({});
    expect(pf.status).toBe(200);
    expect(pf.body.disclaimer).toMatch(/not an approval/i);
    expect(pf.body.counts.illustrations).toBe(3);
    expect(Array.isArray(pf.body.automated)).toBe(true);
    expect(Array.isArray(pf.body.officialNeedsVerification)).toBe(true);
    expect(pf.body.manualReview.coloring.join(' ')).toMatch(/watermarks/);
    // Page count below KDP's paperback minimum (24) must surface as a failure, not be hidden.
    expect([...pf.body.automated, ...pf.body.manualReview.rules].some((r: { ruleId: string; status: string }) => r.ruleId === 'INT-PGC-001' && r.status !== 'PASS')).toBe(true);
    expect(pf.body.officialNeedsVerification.find((r: { ruleId: string; evidence: string }) => r.ruleId === 'INT-BLANK-001')?.evidence ?? '').toMatch(/single-sided/);

    // Export the non-final package files (final PDFs stay gated by preflight).
    const exp = await a.agent.post(`/api/projects/${book.projectId}/exports`).set(H).send({ kinds: ['COLORING_PAGES_ZIP', 'COLORING_PROMPT_LOG', 'COLORING_QC_REPORT', 'INTERIOR_PROOF_PDF', 'COVER_SVG'] });
    expect([200, 202]).toContain(exp.status);
    const jobId = exp.body.jobId ?? exp.body.id;
    if (jobId) expect((await waitForJob(a.agent, jobId)).status).toBe('SUCCEEDED');
    const files = await prisma.exportArtifact.findMany({ where: { projectId: book.projectId } });
    const kinds = files.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['COLORING_PAGES_ZIP', 'COLORING_PROMPT_LOG', 'COLORING_QC_REPORT']));
    const zipRow = files.find((f) => f.kind === 'COLORING_PAGES_ZIP')!;
    const { getStorage } = await import('../src/lib/storage');
    const zip = await JSZip.loadAsync(await getStorage().get(zipRow.storageKey));
    expect(Object.keys(zip.files).filter((f) => f.startsWith('print/') && !zip.files[f].dir)).toHaveLength(3);
    expect(Object.keys(zip.files).filter((f) => f.startsWith('original/') && !zip.files[f].dir)).toHaveLength(3);
    const logRow = files.find((f) => f.kind === 'COLORING_PROMPT_LOG')!;
    const log = Buffer.from(await getStorage().get(logRow.storageKey)).toString('utf8');
    expect(log.split('\n')[0]).toMatch(/^page,status,concept,version/);
    expect(log).toContain('mock/line-art-priced');

    // Dashboard, duplicate, archive.
    // Regression: the query string "false" must not be read as true.
    expect((await a.agent.get('/api/coloring?archived=false')).body.some((r: { id: string }) => r.id === id)).toBe(true);
    const list = await a.agent.get('/api/coloring');
    const row = list.body.find((r: { id: string }) => r.id === id);
    expect(row).toMatchObject({ approved: 3, pages: 4 });
    expect(row.estimatedCostUsd).toBeCloseTo(0.04, 6);
    const dup = await a.agent.post(`/api/coloring/${id}/duplicate`).set(H).send({});
    expect(dup.status).toBe(201);
    const dupBook = (await a.agent.get(`/api/coloring/${dup.body.id}`)).body;
    expect(dupBook.pages).toHaveLength(4);
    expect(dupBook.pages.every((p: { currentVersionId: string | null }) => p.currentVersionId === null)).toBe(true);
    await a.agent.post(`/api/coloring/${dup.body.id}/archive`).set(H).send({ archived: true });
    expect((await a.agent.get('/api/coloring')).body.some((r: { id: string }) => r.id === dup.body.id)).toBe(false);
    expect((await a.agent.get('/api/coloring?archived=true')).body.some((r: { id: string }) => r.id === dup.body.id)).toBe(true);

    // Isolation.
    const other = await signUp('Other Colorist');
    expect((await other.agent.get(`/api/coloring/${id}`)).status).toBe(404);
    expect((await other.agent.post(`/api/coloring/${id}/generate`).set(H).send({ pageIds, modelId: mockId, confirmation: { acceptedTotalUsd: 0 } })).status).toBe(404);
  });

  it('style profiles are reusable and a style change rebuilds non-edited prompts only', async () => {
    const sp = await a.agent.post('/api/coloring-styles').set(H).send({ name: 'Mandala fine', profile: { styleId: 'mandala', outlineThickness: 'THIN', detail: 'VERY_HIGH' } });
    expect(sp.status).toBe(201);
    const b = await a.agent.post('/api/coloring').set(H).send({ title: 'Calm Patterns', author: 'Sam Lee', audience: 'ADULTS', theme: 'mandalas', illustrationTarget: 2, styleProfileId: sp.body.id, concepts: ['lotus mandala', 'sun mandala'] });
    expect(b.body.style.styleId).toBe('mandala');
    expect(b.body.thresholds.minLineWeightPt).toBe(0.5);
    const [p1, p2] = b.body.pages;
    await a.agent.patch(`/api/coloring/${b.body.id}/pages/${p1.id}`).set(H).send({ prompt: 'My own hand-written prompt for a lotus mandala' });
    await a.agent.patch(`/api/coloring/${b.body.id}`).set(H).send({ style: { styleId: 'stained-glass' } });
    const after = (await a.agent.get(`/api/coloring/${b.body.id}`)).body.pages;
    expect(after[0].prompt).toBe('My own hand-written prompt for a lotus mandala');
    expect(after[1].prompt).not.toBe(p2.prompt);
    expect(after[1].prompt).toMatch(/stained-glass/);
  });
});
