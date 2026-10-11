import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { importFixture } from '../src/services/fixtures-import';
import { briefBody, H, prisma, signUp, waitForJob, type Agent } from './helpers';

async function interior(agent: Agent, pid: string) {
  return (await agent.get(`/api/projects/${pid}/interior`)).body as { doc: { frontMatter: { id: string }[]; body: { kind: string; pages: { id: string; templateId: string; locked: boolean; fields: Record<string, unknown> }[] } }; revision: number };
}

describe('interior editor API', () => {
  it('adds, duplicates, moves, locks, and inserts page sequences with optimistic concurrency', async () => {
    const { agent } = await signUp('Editor');
    const p = await agent.post('/api/projects').set(H).send(briefBody({}, { targetPageCount: 30 }));
    let { doc, revision } = await interior(agent, p.body.id);
    const n0 = doc.body.pages.length;
    const first = doc.body.pages[0].id;

    let r = await agent.post(`/api/projects/${p.body.id}/interior/ops`).set(H).send({ revision, ops: [{ op: 'duplicate', section: 'body', pageId: first, count: 2 }, { op: 'add', section: 'body', at: 0, templateId: 'habit-tracker', fields: { month: 'January' } }] });
    expect(r.status).toBe(200);
    ({ doc, revision } = await interior(agent, p.body.id));
    expect(doc.body.pages).toHaveLength(n0 + 3);
    expect(doc.body.pages[0].templateId).toBe('habit-tracker');
    expect(doc.body.pages[0].fields.month).toBe('January');

    // Stale revision is rejected.
    r = await agent.post(`/api/projects/${p.body.id}/interior/ops`).set(H).send({ revision: revision - 1, ops: [{ op: 'remove', section: 'body', pageId: first }] });
    expect(r.status).toBe(409);

    // Locked pages cannot be edited or removed until unlocked.
    r = await agent.post(`/api/projects/${p.body.id}/interior/ops`).set(H).send({ revision, ops: [{ op: 'lock', section: 'body', pageId: first, locked: true }] });
    revision = r.body.revision;
    r = await agent.post(`/api/projects/${p.body.id}/interior/ops`).set(H).send({ revision, ops: [{ op: 'remove', section: 'body', pageId: first }] });
    expect(r.status).toBe(409);
    r = await agent.put(`/api/projects/${p.body.id}/interior`).set(H).send({ revision, document: { ...doc, body: { kind: 'pages', pages: doc.body.pages.filter((x) => x.id !== first) } } });
    expect(r.status).toBe(400);

    // Repeated sequences and moves.
    r = await agent.post(`/api/projects/${p.body.id}/interior/ops`).set(H).send({ revision, ops: [{ op: 'sequence', section: 'body', templateIds: ['daily-planner', 'meeting-notes'], repeat: 3 }, { op: 'move', section: 'body', pageId: doc.body.pages[1].id, to: 0 }] });
    expect(r.status).toBe(200);
    ({ doc } = await interior(agent, p.body.id));
    expect(doc.body.pages.slice(-6).map((x) => x.templateId)).toEqual(['daily-planner', 'meeting-notes', 'daily-planner', 'meeting-notes', 'daily-planner', 'meeting-notes']);

    // Layout summary + page preview reflect the edits.
    const layout = await agent.get(`/api/projects/${p.body.id}/interior/layout`);
    expect(layout.body.pageCount).toBeGreaterThanOrEqual(doc.body.pages.length + doc.frontMatter.length);
    const svg = await agent.get(`/api/projects/${p.body.id}/interior/pages/3/preview.svg`).buffer(true).parse((res, cb) => {
      let t = '';
      res.on('data', (c: Buffer) => (t += c.toString()));
      res.on('end', () => cb(null, t));
    });
    expect(svg.headers['content-type']).toMatch(/svg/);
    expect(svg.body).toContain('viewBox="0 0 432 648"');
    const png = await agent.get(`/api/projects/${p.body.id}/interior/pages/3/preview.png?dpi=50`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(png.headers['content-type']).toBe('image/png');
    expect((png.body as Buffer).readUInt32BE(16)).toBe(300); // 6in × 50dpi
  });

  it('regenerates layout when the trim size changes and rejects invalid combinations', async () => {
    const { agent } = await signUp('Trim');
    const p = await agent.post('/api/projects').set(H).send(briefBody({}, { targetPageCount: 40 }));
    const before = (await agent.get(`/api/projects/${p.body.id}/interior/layout`)).body;
    expect(before.spec.trim.id).toBe('6x9');
    expect((await agent.patch(`/api/projects/${p.body.id}`).set(H).send({ format: { trimId: '8.5x11' } })).status).toBe(200);
    const after = (await agent.get(`/api/projects/${p.body.id}/interior/layout`)).body;
    expect(after.spec.pageWidthIn).toBe(8.5);
    expect((await agent.patch(`/api/projects/${p.body.id}`).set(H).send({ format: { ink: 'PREMIUM_COLOR', paper: 'CREAM' } })).status).toBe(400);
    expect((await agent.patch(`/api/projects/${p.body.id}`).set(H).send({ format: { format: 'HARDCOVER', trimId: '5x8' } })).status).toBe(400);
  });

  it('saves custom templates and uses them in documents', async () => {
    const { agent } = await signUp('Tpl');
    const t = await agent.post('/api/templates').set(H).send({ key: 'my-gratitude', template: { name: 'Gratitude page', elements: [{ id: 'h', type: 'heading', text: 'Three good things' }, { id: 'c', type: 'checklist', count: 3 }, { id: 'l', type: 'lines' }] } });
    expect(t.status).toBe(201);
    expect((await agent.post('/api/templates').set(H).send({ key: 'lined-journal', template: { name: 'x', elements: [] } })).status).toBe(400);
    const p = await agent.post('/api/projects').set(H).send(briefBody({}, { targetPageCount: 30 }));
    const { revision } = await interior(agent, p.body.id);
    await agent.post(`/api/projects/${p.body.id}/interior/ops`).set(H).send({ revision, ops: [{ op: 'add', section: 'body', at: 0, templateId: 'my-gratitude' }] });
    const layout = (await agent.get(`/api/projects/${p.body.id}/interior/layout`)).body;
    expect(layout.warnings.filter((w: { code: string }) => w.code === 'UNKNOWN_TEMPLATE')).toEqual([]);
    const list = await agent.get('/api/templates');
    expect(list.body.custom[0].id).toBe('my-gratitude');
    expect(list.body.builtIn.length).toBeGreaterThanOrEqual(20);
  });
});

describe('covers', () => {
  it('computes geometry from the final page count and saves designs with revision checks', async () => {
    const { agent } = await signUp('Cover');
    const p = await agent.post('/api/projects').set(H).send(briefBody({}, { targetPageCount: 120 }));
    const c = await agent.post(`/api/projects/${p.body.id}/covers`).set(H).send({ themeId: 'sage' });
    expect(c.status).toBe(201);
    const list = await agent.get(`/api/projects/${p.body.id}/covers`);
    const layout = (await agent.get(`/api/projects/${p.body.id}/interior/layout`)).body;
    expect(list.body.geometry.pageCount).toBe(layout.pageCount);
    expect(list.body.geometry.spineWidthIn).toBeCloseTo(layout.pageCount * 0.002252, 3);
    const check = await agent.post(`/api/projects/${p.body.id}/covers/${c.body.id}/check`).set(H).send({ design: c.body.design });
    expect(check.body.svg).toContain('Barcode area');
    expect(check.body.warnings).toEqual([]);
    const saved = await agent.put(`/api/projects/${p.body.id}/covers/${c.body.id}`).set(H).send({ revision: c.body.revision, design: c.body.design });
    expect(saved.status).toBe(200);
    expect((await agent.put(`/api/projects/${p.body.id}/covers/${c.body.id}`).set(H).send({ revision: c.body.revision, design: c.body.design })).status).toBe(409);
    expect((await agent.post(`/api/projects/${p.body.id}/covers/${c.body.id}/duplicate`).set(H)).status).toBe(201);
  });

  it('requires official calculator values before a hardcover cover can be designed', async () => {
    const { agent } = await signUp('HC');
    const p = await agent.post('/api/projects').set(H).send(briefBody({ contentType: 'LOGBOOK', category: 'LOGBOOK' }, { format: 'HARDCOVER', targetPageCount: 120 }));
    expect((await agent.post(`/api/projects/${p.body.id}/covers`).set(H).send({})).status).toBe(409);
    const pageCount = (await agent.get(`/api/projects/${p.body.id}/interior/layout`)).body.pageCount;
    const off = await agent.post(`/api/projects/${p.body.id}/official-template`).set(H).send({ fullWidthIn: 13.917, fullHeightIn: 10.25, spineWidthIn: 0.5, wrapIn: 0.51, hingeIn: 0.4, pageCount });
    expect(off.status).toBe(200);
    expect(off.body.geometry.source).toBe('OFFICIAL_TEMPLATE');
    expect((await agent.post(`/api/projects/${p.body.id}/covers`).set(H).send({})).status).toBe(201);
  });
});

describe('export gating and manifest', () => {
  it('blocks final export on technical failures but allows editable source exports', async () => {
    const { agent } = await signUp('Gate');
    // 10 pages is below the 24-page paperback minimum → INT-PGC-001 blocks.
    const p = await agent.post('/api/projects').set(H).send(briefBody({}, { targetPageCount: 10 }));
    await agent.post(`/api/projects/${p.body.id}/covers`).set(H).send({});
    const final = await agent.post(`/api/projects/${p.body.id}/exports`).set(H).send({ kinds: ['INTERIOR_PDF'] });
    const job = await waitForJob(agent, final.body.id);
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/INT-PGC-001/);
    const src = await agent.post(`/api/projects/${p.body.id}/exports`).set(H).send({ kinds: ['PROJECT_JSON', 'VALIDATION_REPORT'] });
    expect((await waitForJob(agent, src.body.id)).status).toBe('SUCCEEDED');
    const bundles = (await agent.get(`/api/projects/${p.body.id}/exports`)).body;
    expect(bundles[0].validationStatus).toBe('BLOCKED');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.body.id } })).status).not.toBe('EXPORTED');
  });

  it('requires human review of flagged items, then exports files whose checksums match the manifest', async () => {
    const { agent, workspaceId, userId } = await signUp('Manifest');
    const project = await importFixture(workspaceId, userId, 'hardcover');
    // The low-content notice needs a human decision before final export.
    let ex = await agent.post(`/api/projects/${project.id}/exports`).set(H).send({ kinds: ['INTERIOR_PDF', 'COVER_PDF'] });
    let job = await waitForJob(agent, ex.body.id);
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/CNT-LOWC-001/);
    const report = (await agent.get(`/api/projects/${project.id}/reports`)).body[0];
    const review = await agent.post(`/api/projects/${project.id}/reports/${report.id}/reviews`).set(H).send({ ruleId: 'CNT-LOWC-001', decision: 'ACCEPTED_RISK', note: 'Publishing without ISBN; Look Inside not needed.' });
    expect(review.status).toBe(201);
    ex = await agent.post(`/api/projects/${project.id}/exports`).set(H).send({ kinds: ['INTERIOR_PDF', 'COVER_PDF', 'COVER_SVG', 'METADATA_JSON'] });
    job = await waitForJob(agent, ex.body.id);
    expect(job.status, job.error ?? '').toBe('SUCCEEDED');
    const bundle = (await agent.get(`/api/projects/${project.id}/exports`)).body[0];
    expect(bundle.validationStatus).toBe('PASSED');
    const manifestRow = bundle.artifacts.find((a: { kind: string }) => a.kind === 'MANIFEST');
    const manifest = JSON.parse((await agent.get(`/api/exports/${manifestRow.id}/download`)).text);
    expect(manifest).toMatchObject({ specVersion: 'kdp-2026.10.1', trimSize: '6x9', format: 'HARDCOVER', validationStatus: 'PASSED' });
    expect(manifest.pageCount).toBe(120);
    for (const f of manifest.files) {
      const art = bundle.artifacts.find((a: { filename: string }) => a.filename === f.filename);
      const dl = await agent.get(`/api/exports/${art.id}/download`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(createHash('sha256').update(dl.body as Buffer).digest('hex'), f.filename).toBe(f.sha256);
    }
    const zipRow = bundle.artifacts.find((a: { kind: string }) => a.kind === 'BUNDLE_ZIP');
    expect(zipRow).toBeTruthy();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('EXPORTED');
  });

  it('refuses to accept a blocking failure via human review', async () => {
    const { agent } = await signUp('NoAccept');
    const p = await agent.post('/api/projects').set(H).send(briefBody({}, { targetPageCount: 10 }));
    await waitForJob(agent, (await agent.post(`/api/projects/${p.body.id}/validate`).set(H)).body.id);
    const report = (await agent.get(`/api/projects/${p.body.id}/reports`)).body[0];
    const r = await agent.post(`/api/projects/${p.body.id}/reports/${report.id}/reviews`).set(H).send({ ruleId: 'INT-PGC-001', decision: 'ACCEPTED_RISK', note: 'please let me' });
    expect(r.status).toBe(409);
  });
});

describe('EPUB export', () => {
  it('exports a valid EPUB and eBook cover for the Kindle fixture', async () => {
    const { agent, workspaceId, userId } = await signUp('Epub');
    const project = await importFixture(workspaceId, userId, 'ebook');
    const report = await waitForJob(agent, (await agent.post(`/api/projects/${project.id}/validate`).set(H)).body.id);
    expect(report.status).toBe('SUCCEEDED');
    const rep = (await agent.get(`/api/projects/${project.id}/reports`)).body[0];
    await agent.post(`/api/projects/${project.id}/reports/${rep.id}/reviews`).set(H).send({ ruleId: 'CNT-LOWVAL-001', decision: 'ACCEPTED_RISK', note: 'Short guide priced accordingly.' });
    const ex = await agent.post(`/api/projects/${project.id}/exports`).set(H).send({ kinds: ['EPUB', 'EBOOK_COVER_PNG', 'DOCX'] });
    const job = await waitForJob(agent, ex.body.id);
    expect(job.status, job.error ?? '').toBe('SUCCEEDED');
    const bundle = (await agent.get(`/api/projects/${project.id}/exports`)).body[0];
    const epubRow = bundle.artifacts.find((a: { kind: string }) => a.kind === 'EPUB');
    const dl = await agent.get(`/api/exports/${epubRow.id}/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const zip = await JSZip.loadAsync(dl.body as Buffer);
    expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
    expect(zip.file('OEBPS/images/cover.png')).toBeTruthy();
  });
});
