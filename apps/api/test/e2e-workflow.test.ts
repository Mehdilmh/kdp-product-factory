import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { QUALITY_CHECKLIST } from '../src/services/batch';
import { app, briefBody, drainJobs, H, prisma, signUp, waitForJob } from './helpers';

/**
 * Definition of done, end to end through the HTTP API with the mock providers:
 * create → format → brief → generate/edit interior → design cover → render → validate →
 * review warnings → correct issues → export → reopen without losing edits.
 */
describe('MVP workflow (end to end)', () => {
  it('takes a product from brief to exported files', async () => {
    const { agent, email } = await signUp('Publisher');

    // 1–3. Create a project with a KDP format and a product brief.
    const created = await agent.post('/api/projects').set(H).send(briefBody({ contentType: 'LINED' }, { trimId: '6x9', targetPageCount: 110 }));
    expect(created.status).toBe(201);
    const pid = created.body.id;
    expect(created.body.status).toBe('DRAFT');

    // 4. Generate original interior + cover + metadata (async job, mock providers).
    const gen = await agent.post(`/api/projects/${pid}/generate`).set(H).send({});
    expect(gen.status).toBe(202);
    const genJob = await waitForJob(agent, gen.body.id);
    expect(genJob.status, genJob.error ?? '').toBe('SUCCEEDED');
    expect(genJob.result.completedStages).toEqual(expect.arrayContaining(['research', 'content', 'interior', 'metadata', 'cover', 'validation']));

    //    …and edit it: set a custom prompt on the first body page.
    const { doc, revision } = (await agent.get(`/api/projects/${pid}/interior`)).body;
    const firstGuided = doc.body.pages.find((p: { templateId: string }) => p.templateId === 'guided-writing');
    expect(firstGuided).toBeTruthy();
    const edit = await agent.post(`/api/projects/${pid}/interior/ops`).set(H).send({ revision, ops: [{ op: 'update', section: 'body', pageId: firstGuided.id, fields: { prompt: 'What did your preceptor show you today that you want to remember?' } }] });
    expect(edit.status).toBe(200);

    // 5. Design the cover: edit the generated design (cover art is an image layer; text stays live).
    const covers = (await agent.get(`/api/projects/${pid}/covers`)).body;
    const cover = covers.covers.find((c: { isActive: boolean }) => c.isActive);
    expect(cover.design.layers.some((l: { type: string; role?: string }) => l.type === 'text' && l.role === 'title')).toBe(true);
    expect(cover.design.layers.some((l: { type: string }) => l.type === 'image')).toBe(true);
    const design = { ...cover.design, layers: cover.design.layers.map((l: { id: string; text?: string }) => (l.id === 'subtitle' ? { ...l, text: 'Clinical-debrief prompts for your first year' } : l)) };
    expect((await agent.put(`/api/projects/${pid}/covers/${cover.id}`).set(H).send({ revision: cover.revision, design })).status).toBe(200);

    // Metadata with a deliberate policy problem.
    const md = (await agent.get(`/api/projects/${pid}/metadata`)).body.data;
    expect(md.keywords.length).toBeGreaterThan(0);
    expect(md.keywords[0].source).toMatch(/AI suggestion/);
    await agent.put(`/api/projects/${pid}/metadata`).set(H).send({ data: { ...md, subtitle: 'The #1 Bestselling Nurse Journal', description: 'A reflection journal for first-year nurses using clinical-debrief prompts.' } });

    // 6–8. Render + validate; review warnings.
    let v = await waitForJob(agent, (await agent.post(`/api/projects/${pid}/validate`).set(H)).body.id);
    expect(v.status).toBe('SUCCEEDED');
    let report = (await agent.get(`/api/projects/${pid}/reports`)).body[0];
    let full = (await agent.get(`/api/projects/${pid}/reports/${report.id}`)).body;
    const byId = (id: string) => full.results.find((r: { ruleId: string }) => r.ruleId === id);
    expect(byId('META-TTL-001').status).toBe('FAIL');
    expect(byId('CNT-AI-001').status).toBe('NEEDS_HUMAN_REVIEW');
    expect(byId('INT-FONT-001').status).toBe('PASS');
    expect(byId('INT-DIM-001').status).toBe('PASS');
    expect(full.blocked).toBe(false);

    // Final export is refused until the human-review items are handled.
    let ex = await waitForJob(agent, (await agent.post(`/api/projects/${pid}/exports`).set(H).send({ kinds: ['INTERIOR_PDF', 'COVER_PDF'] })).body.id);
    expect(ex.status).toBe('FAILED');
    expect(ex.error).toMatch(/CNT-AI-001/);

    // 9. Correct the issues: fix metadata; acknowledge the AI disclosure; review remaining items.
    await agent.put(`/api/projects/${pid}/metadata`).set(H).send({ data: { ...md, subtitle: 'Clinical-debrief prompts for your first year', description: 'A reflection journal for first-year nurses using clinical-debrief prompts.' } });
    v = await waitForJob(agent, (await agent.post(`/api/projects/${pid}/validate`).set(H)).body.id);
    report = (await agent.get(`/api/projects/${pid}/reports`)).body[0];
    full = (await agent.get(`/api/projects/${pid}/reports/${report.id}`)).body;
    expect(byId('META-TTL-001').status).not.toBe('FAIL');
    for (const r of full.results.filter((x: { status: string }) => x.status === 'NEEDS_HUMAN_REVIEW')) {
      const rv = await agent.post(`/api/projects/${pid}/reports/${report.id}/reviews`).set(H).send({ ruleId: r.ruleId, decision: 'ACCEPTED_RISK', note: `Reviewed ${r.ruleId}: acceptable for this product.` });
      expect(rv.status).toBe(201);
    }

    // 10. Export manuscript and cover.
    ex = await waitForJob(agent, (await agent.post(`/api/projects/${pid}/exports`).set(H).send({ kinds: ['INTERIOR_PDF', 'COVER_PDF', 'COVER_SVG', 'DOCX', 'METADATA_CSV', 'VALIDATION_REPORT', 'PROJECT_JSON'] })).body.id);
    expect(ex.status, ex.error ?? '').toBe('SUCCEEDED');
    const bundle = (await agent.get(`/api/projects/${pid}/exports`)).body[0];
    expect(bundle.artifacts.map((a: { kind: string }) => a.kind)).toEqual(expect.arrayContaining(['INTERIOR_PDF', 'COVER_PDF', 'MANIFEST', 'BUNDLE_ZIP']));
    expect((await agent.get(`/api/projects/${pid}`)).body.status).toBe('EXPORTED');

    // 11. Reopen in a new session without losing edits.
    const again = request.agent(app);
    await again.post('/api/auth/login').set(H).send({ email, password: 'correct horse battery' });
    const reopened = (await again.get(`/api/projects/${pid}/interior`)).body.doc;
    expect(reopened.body.pages.find((p: { id: string }) => p.id === firstGuided.id).fields.prompt).toMatch(/preceptor/);
    const reCover = (await again.get(`/api/projects/${pid}/covers`)).body.covers.find((c: { isActive: boolean }) => c.isActive);
    expect(reCover.design.layers.find((l: { id: string }) => l.id === 'subtitle').text).toBe('Clinical-debrief prompts for your first year');
    expect((await again.get(`/api/projects/${pid}/metadata`)).body.data.subtitle).toBe('Clinical-debrief prompts for your first year');

    // Version history can restore the pre-generation state (and the restore is itself undoable).
    const versions = (await again.get(`/api/projects/${pid}/versions`)).body;
    const preGen = versions.find((x: { label: string }) => x.label === 'Before AI generation');
    expect((await again.post(`/api/projects/${pid}/versions/${preGen.id}/restore`).set(H)).status).toBe(200);
    expect((await again.get(`/api/projects/${pid}/versions`)).body[0].label).toMatch(/Before restoring/);
    const usage = (await again.get('/api/usage')).body;
    expect(usage.byProvider.length).toBeGreaterThan(0);
  });
});

describe('batch generation', () => {
  const header = 'workingTitle,category,contentType,targetReader,readerProblem,niche,differentiation,authorName,format,trimId,pageCount';
  const row = (title: string, reader: string, diff: string) =>
    `"${title}",GUIDED_JOURNAL,LINED,"${reader}","Unwinding after demanding shifts and noticing progress","shift work reflection","${diff}",Sam Lee,PAPERBACK,6x9,60`;

  it('imports CSV, flags near-duplicates, runs items, and requires approval before final export', async () => {
    const { agent } = await signUp('Batcher');
    const csv = [
      header,
      row('Night Shift Notes', 'Night-shift warehouse workers', 'Prompts are scheduled around rotating shifts with a sleep-debt tracker and a weekly recovery plan for night workers.'),
      // Same brief, only the audience word and title changed → duplicate.
      row('Night Shift Notes for Drivers', 'Night-shift delivery drivers', 'Prompts are scheduled around rotating shifts with a sleep-debt tracker and a weekly recovery plan for night workers.'),
      `"Garden Seasons Planner",PLANNER,PLANNER,"Allotment gardeners in temperate climates","Planning sowing and harvest across the year","allotment planning","Month-by-month sowing calendar with succession-planting worksheets and a harvest log that feeds next year's plan.",Sam Lee,PAPERBACK,8.5x11,48`,
    ].join('\n');
    const bad = await agent.post('/api/batches').set(H).send({ name: 'x', csv: header + '\n"T",NOT_A_CATEGORY,LINED,a,b,c,d,e,PAPERBACK,6x9,10' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.rowErrors[0].row).toBe(2);

    const b = await agent.post('/api/batches').set(H).send({ name: 'Autumn list', csv, concurrency: 2 });
    expect(b.status).toBe(201);
    const statuses = b.body.items.map((i: { status: string }) => i.status);
    expect(statuses).toEqual(['PENDING', 'DUPLICATE', 'PENDING']);
    expect(b.body.items[1].differentiationNotes.join(' ')).toMatch(/identical/);

    expect((await agent.post(`/api/batches/${b.body.id}/resume`).set(H)).status).toBe(409);
    const started = await agent.post(`/api/batches/${b.body.id}/start`).set(H);
    expect(started.status).toBe(200);
    await drainJobs();
    await drainJobs();
    let batch = (await agent.get(`/api/batches/${b.body.id}`)).body;
    expect(batch.items.map((i: { status: string }) => i.status)).toEqual(['AWAITING_APPROVAL', 'DUPLICATE', 'AWAITING_APPROVAL']);
    expect(batch.status).toBe('COMPLETED');

    const item = batch.items[0];
    // Final export is refused until a human approves the item.
    const ex = await waitForJob(agent, (await agent.post(`/api/projects/${item.projectId}/exports`).set(H).send({ kinds: ['INTERIOR_PDF'] })).body.id);
    expect(ex.status).toBe('FAILED');
    expect(ex.error).toMatch(/manual approval/);

    expect((await agent.post(`/api/batch-items/${item.id}/review`).set(H).send({ decision: 'APPROVED', checklist: { interiorReviewed: true } })).status).toBe(400);
    const approved = await agent.post(`/api/batch-items/${item.id}/review`).set(H).send({ decision: 'APPROVED', checklist: Object.fromEntries(QUALITY_CHECKLIST.map((k) => [k, true])) });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    batch = (await agent.get('/api/batches')).body[0];
    expect(batch.counts.APPROVED).toBe(1);
    expect(batch.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(await prisma.project.count({ where: { batchItem: { batchId: b.body.id } } })).toBe(2);
  });

  it('pauses and resumes, generating nothing while paused', async () => {
    const { agent } = await signUp('Pauser');
    const items = [1, 2, 3].map((n) => ({
      brief: { workingTitle: `Distinct Product ${n}`, category: 'NOTEBOOK', contentType: 'DOT_GRID', targetReader: `Audience ${n}`, readerProblem: `Problem number ${n} ${'abcdefghij'.slice(0, n * 3)}`, niche: `niche ${n}`, differentiation: `Unique angle ${n}: ${['bullet journaling for engineers with isometric grids', 'sketch planning for architects with scale rulers', 'calligraphy drills with slant guides for left-handed writers'][n - 1]}`, authorName: 'Pat' },
      format: { format: 'PAPERBACK', trimId: '6x9', targetPageCount: 30 },
      generation: { outline: false, content: false, interior: true, coverConcept: false, titleSuggestions: false, metadata: false, similarity: false, validate: true },
    }));
    const b = await agent.post('/api/batches').set(H).send({ name: 'Pausable', items, concurrency: 1 });
    expect(b.body.items.every((i: { status: string }) => i.status === 'PENDING')).toBe(true);
    await agent.post(`/api/batches/${b.body.id}/start`).set(H);
    await agent.post(`/api/batches/${b.body.id}/pause`).set(H);
    await drainJobs();
    let batch = (await agent.get(`/api/batches/${b.body.id}`)).body;
    expect(batch.status).toBe('PAUSED');
    expect(batch.items.filter((i: { status: string }) => i.status === 'PENDING').length).toBe(2);
    await agent.post(`/api/batches/${b.body.id}/resume`).set(H);
    for (let i = 0; i < 4; i++) await drainJobs();
    batch = (await agent.get(`/api/batches/${b.body.id}`)).body;
    expect(batch.items.every((i: { status: string }) => i.status === 'AWAITING_APPROVAL')).toBe(true);
  });
});
