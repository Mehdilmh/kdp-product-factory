import { CoverDesign, inspectPdf, layoutCover, renderCoverSvg, starterCoverDesign, COVER_THEMES } from '@kdp/core';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { defineRoute, IdParams } from '../lib/route';
import { currentMetadata } from '../services/build';
import { projectCoverGeometry } from '../services/cover';
import { getProject } from '../services/projects';
import { checkConfirmation, NormalizedRequestSchema, prepareGeneration } from '../services/image-generation';
import { createJob } from '../services/jobs';

export const coverRouter = Router();
const CoverParams = z.object({ id: z.string(), coverId: z.string() });

async function getCover(projectId: string, coverId: string) {
  const c = await prisma.coverDesign.findFirst({ where: { id: coverId, projectId } });
  if (!c) throw notFound('Cover design');
  return c;
}

async function assetInfo(workspaceId: string, design: CoverDesign) {
  const ids = design.layers.filter((l) => l.type === 'image').map((l) => (l as { assetId: string }).assetId);
  if (design.templateGuide) ids.push(design.templateGuide.assetId);
  const rows = await prisma.asset.findMany({ where: { workspaceId, id: { in: ids } } });
  return Object.fromEntries(rows.filter((r) => r.widthPx && r.heightPx).map((r) => [r.id, { widthPx: r.widthPx!, heightPx: r.heightPx!, mimeType: r.mimeType }]));
}

defineRoute(coverRouter, { method: 'get', path: '/projects/:id/covers', summary: 'Cover designs, geometry for the current page count, and themes', tag: 'Covers', params: IdParams }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  const [covers, geometry] = await Promise.all([prisma.coverDesign.findMany({ where: { projectId: params.id }, orderBy: { updatedAt: 'desc' } }), projectCoverGeometry(params.id)]);
  return { covers, geometry, themes: COVER_THEMES };
});

defineRoute(coverRouter, { method: 'post', path: '/projects/:id/covers', summary: 'Create a cover design (starter or supplied design)', tag: 'Covers', params: IdParams, body: z.object({ name: z.string().max(100).default('Cover'), design: z.unknown().optional(), themeId: z.string().max(40).optional() }), status: 201 }, async ({ ws, params, body, req }) => {
  const p = await getProject(ws.workspaceId, params.id);
  let design: CoverDesign;
  if (body.design) design = CoverDesign.parse(body.design);
  else {
    const geom = await projectCoverGeometry(p.id);
    if (geom.source === 'UNRESOLVED') throw conflict('Enter the official KDP hardcover calculator values (Format → Official cover template) before designing a hardcover cover.');
    const { data: md } = await currentMetadata(p.id);
    const brief = await prisma.productBrief.findUnique({ where: { projectId: p.id } });
    design = starterCoverDesign(geom, { title: md.title || p.title, subtitle: md.subtitle, author: md.author || brief?.authorName || '', backText: md.description || undefined, themeId: body.themeId ?? brief?.designTheme });
  }
  await prisma.coverDesign.updateMany({ where: { projectId: p.id }, data: { isActive: false } });
  const c = await prisma.coverDesign.create({ data: { projectId: p.id, name: body.name, design: design as unknown as Prisma.InputJsonValue, isActive: true } });
  await prisma.project.update({ where: { id: p.id }, data: { updatedAt: new Date() } });
  await audit(req, 'cover.create', 'CoverDesign', c.id);
  return c;
});

defineRoute(coverRouter, { method: 'put', path: '/projects/:id/covers/:coverId', summary: 'Save a cover design (optimistic concurrency)', tag: 'Covers', params: CoverParams, body: z.object({ revision: z.number().int(), name: z.string().max(100).optional(), design: z.unknown() }) }, async ({ ws, params, body }) => {
  await getProject(ws.workspaceId, params.id);
  const c = await getCover(params.id, params.coverId);
  if (c.revision !== body.revision) throw conflict('Cover changed since you loaded it. Reload to continue.', { revision: c.revision });
  const design = CoverDesign.parse(body.design);
  // Locked layers cannot be changed.
  const prev = CoverDesign.parse(c.design);
  for (const l of prev.layers.filter((x) => x.locked)) {
    const n = design.layers.find((x) => x.id === l.id);
    if (!n || JSON.stringify({ ...n }) !== JSON.stringify({ ...l })) throw badRequest(`Layer "${l.name || l.id}" is locked.`);
  }
  return prisma.coverDesign.update({ where: { id: c.id }, data: { design: design as unknown as Prisma.InputJsonValue, name: body.name, revision: { increment: 1 } } });
});

defineRoute(coverRouter, { method: 'post', path: '/projects/:id/covers/:coverId/duplicate', summary: 'Duplicate a cover design', tag: 'Covers', params: CoverParams, status: 201 }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  const c = await getCover(params.id, params.coverId);
  return prisma.coverDesign.create({ data: { projectId: params.id, name: `${c.name} (copy)`.slice(0, 100), design: c.design as Prisma.InputJsonValue, isActive: false } });
});

defineRoute(coverRouter, { method: 'post', path: '/projects/:id/covers/:coverId/activate', summary: 'Use this design for exports', tag: 'Covers', params: CoverParams }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  const c = await getCover(params.id, params.coverId);
  await prisma.coverDesign.updateMany({ where: { projectId: params.id }, data: { isActive: false } });
  return prisma.coverDesign.update({ where: { id: c.id }, data: { isActive: true } });
});

defineRoute(coverRouter, { method: 'delete', path: '/projects/:id/covers/:coverId', summary: 'Delete a cover design', tag: 'Covers', params: CoverParams }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  const c = await getCover(params.id, params.coverId);
  await prisma.coverDesign.delete({ where: { id: c.id } });
  return { ok: true };
});

defineRoute(
  coverRouter,
  { method: 'post', path: '/projects/:id/covers/:coverId/check', summary: 'Lay out a (possibly unsaved) design and return warnings + SVG preview', tag: 'Covers', params: CoverParams, body: z.object({ design: z.unknown(), guides: z.boolean().default(true) }) },
  async ({ ws, params, body }) => {
    await getProject(ws.workspaceId, params.id);
    await getCover(params.id, params.coverId);
    const design = CoverDesign.parse(body.design);
    const geom = await projectCoverGeometry(params.id);
    const layout = layoutCover(design, geom, await assetInfo(ws.workspaceId, design));
    const guideHref = design.templateGuide ? `/api/assets/${design.templateGuide.assetId}/file` : undefined;
    return {
      geometry: geom,
      warnings: layout.warnings,
      svg: renderCoverSvg(layout, { guides: body.guides, assetHref: (id) => `/api/assets/${encodeURIComponent(id)}/file`, templateGuideHref: guideHref, templateGuideOpacity: design.templateGuide?.opacity }),
    };
  },
);

/**
 * Import an official KDP cover template PDF (uploaded as an asset). The PDF page size gives the
 * full cover dimensions; the publisher confirms the spine width (and wrap/hinge for hardcover).
 */
defineRoute(
  coverRouter,
  {
    method: 'post',
    path: '/projects/:id/official-template',
    summary: 'Record official KDP cover calculator values (optionally from an uploaded template PDF)',
    tag: 'Covers',
    params: IdParams,
    body: z.object({ assetId: z.string().optional(), fullWidthIn: z.number().positive().optional(), fullHeightIn: z.number().positive().optional(), spineWidthIn: z.number().nonnegative(), wrapIn: z.number().nonnegative().optional(), hingeIn: z.number().nonnegative().optional(), pageCount: z.number().int().positive() }),
  },
  async ({ ws, params, body, req }) => {
    const p = await getProject(ws.workspaceId, params.id);
    let w = body.fullWidthIn;
    let h = body.fullHeightIn;
    let note = 'Entered from the official KDP cover calculator';
    if (body.assetId) {
      const a = await prisma.asset.findFirst({ where: { id: body.assetId, workspaceId: ws.workspaceId } });
      if (!a) throw notFound('Template asset');
      if (a.mimeType !== 'application/pdf') throw badRequest('Upload the official template as a PDF to read its dimensions.');
      const { getStorage } = await import('../lib/storage');
      const ins = await inspectPdf(await getStorage().get(a.storageKey));
      if (!ins.ok || ins.pageCount < 1) throw badRequest('Template PDF could not be read.');
      w = ins.pages[0].mediaBoxIn.w;
      h = ins.pages[0].mediaBoxIn.h;
      note = `Official template PDF "${a.filename}" (${w}" × ${h}")`;
    }
    if (!w || !h) throw badRequest('Provide fullWidthIn/fullHeightIn or an uploaded template PDF.');
    const official = { fullWidthIn: w, fullHeightIn: h, spineWidthIn: body.spineWidthIn, wrapIn: body.wrapIn, hingeIn: body.hingeIn, pageCount: body.pageCount, sourceNote: note, importedAt: new Date().toISOString().slice(0, 10) };
    await prisma.productFormat.update({ where: { projectId: p.id }, data: { officialCover: official } });
    await audit(req, 'cover.official_template', 'Project', p.id, official);
    return { official, geometry: await projectCoverGeometry(p.id) };
  },
);

/* ------------------------------- AI cover art (model library) ------------------------------- */

/**
 * The art target comes from the verified cover geometry — never from the image model. The model
 * only paints pixels; trim, bleed, spine, barcode area and safe zones stay with the layout engine.
 */
function artTarget(geom: Awaited<ReturnType<typeof projectCoverGeometry>>, scope: 'front' | 'wrap') {
  const bleed = geom.bleedIn;
  const f = geom.panels.front;
  const wIn = scope === 'wrap' ? geom.widthIn : f.w + bleed;
  const hIn = scope === 'wrap' ? geom.heightIn : f.h + 2 * bleed;
  return { scope, widthIn: wIn, heightIn: hIn, aspect: wIn / hIn, idealWidthPx: Math.round(wIn * 300), idealHeightPx: Math.round(hIn * 300), geometrySource: geom.source };
}

defineRoute(coverRouter, { method: 'get', path: '/projects/:id/cover-art/target', summary: 'Art area (front panel + bleed, or full wrap) and the pixel size needed for 300 DPI', tag: 'Covers', params: IdParams, query: z.object({ scope: z.enum(['front', 'wrap']).default('front') }) }, async ({ ws, params, query }) => {
  await getProject(ws.workspaceId, params.id);
  const geom = await projectCoverGeometry(params.id);
  if (geom.source === 'UNRESOLVED') throw conflict('Cover geometry is unresolved (enter official hardcover values first).');
  return artTarget(geom, query.scope);
});

const CoverArtBody = z.object({
  modelId: z.string().max(64),
  scope: z.enum(['front', 'wrap']).default('front'),
  request: NormalizedRequestSchema,
  confirmation: z.object({ acceptedEstimateUsd: z.number().min(0).nullable(), acceptUnverifiedCost: z.boolean().default(false) }).optional(),
});

defineRoute(coverRouter, { method: 'post', path: '/projects/:id/cover-art', summary: 'Generate (or revise via image-to-image) cover background art with a chosen model after confirming the estimate', tag: 'Covers', params: IdParams, body: CoverArtBody, status: 202 }, async ({ ws, params, body, req }) => {
  const p = await getProject(ws.workspaceId, params.id);
  const geom = await projectCoverGeometry(p.id);
  if (geom.source === 'UNRESOLVED') throw conflict('Cover geometry is unresolved (enter official hardcover values first).');
  const t = artTarget(geom, body.scope);
  // Aspect always follows the cover geometry; the pixel size is a request the model may round.
  const scale = Math.min(1, 2048 / t.idealWidthPx, 2048 / t.idealHeightPx);
  const request = {
    ...body.request,
    aspect: t.aspect,
    widthPx: body.request.widthPx ?? Math.round((t.idealWidthPx * scale) / 8) * 8,
    heightPx: body.request.heightPx ?? Math.round((t.idealHeightPx * scale) / 8) * 8,
    prompt: /no text/i.test(body.request.prompt) ? body.request.prompt : `${body.request.prompt}. Background artwork only: no text, no letters, no numbers, no logos.`,
  };
  const prep = await prepareGeneration(ws.workspaceId, body.modelId, request);
  if (prep.errors.length) throw badRequest(`Settings are not valid for ${prep.model.displayName}`, { errors: prep.errors });
  checkConfirmation(prep.estimate, body.confirmation);
  const job = await createJob({
    workspaceId: ws.workspaceId,
    projectId: p.id,
    exclusive: false,
    type: 'IMAGE_GENERATE',
    userId: ws.user.id,
    usesAi: prep.model.provider !== 'mock',
    input: { purpose: 'COVER_ART', userId: ws.user.id, items: [{ key: 'cover-art', modelId: prep.model.id, request, confirmation: body.confirmation! }] } as Prisma.InputJsonValue,
  });
  await audit(req, 'cover.art.generate', 'Project', p.id, { model: prep.model.endpointId, estimate: prep.estimate.total, scope: body.scope });
  return { jobId: job.id, estimate: prep.estimate, target: t };
});

defineRoute(coverRouter, { method: 'post', path: '/projects/:id/covers/:coverId/apply-art', summary: 'Place an image asset as the background art layer (text layers stay live and above it)', tag: 'Covers', params: CoverParams, body: z.object({ assetId: z.string().max(64), scope: z.enum(['front', 'wrap']).default('front'), revision: z.number().int() }) }, async ({ ws, params, body, req }) => {
  await getProject(ws.workspaceId, params.id);
  const c = await getCover(params.id, params.coverId);
  if (c.revision !== body.revision) throw conflict('Cover changed since you loaded it. Reload to continue.', { revision: c.revision });
  const a = await prisma.asset.findFirst({ where: { id: body.assetId, workspaceId: ws.workspaceId } });
  if (!a || !a.mimeType.startsWith('image/')) throw notFound('Image asset');
  const geom = await projectCoverGeometry(params.id);
  const design = CoverDesign.parse(c.design);
  const existing = design.layers.find((l) => l.id === 'cover-art');
  if (existing?.locked) throw badRequest('The cover art layer is locked.');
  const bleed = geom.bleedIn;
  const t = artTarget(geom, body.scope);
  const layer = body.scope === 'wrap'
    ? { id: 'cover-art', name: 'Cover art', type: 'image', anchor: 'canvas', x: 0, y: 0, w: t.widthIn, h: t.heightIn, assetId: a.id, fit: 'cover', locked: false }
    : { id: 'cover-art', name: 'Cover art', type: 'image', anchor: 'front', x: geom.direction === 'RTL' ? -bleed : 0, y: -bleed, w: t.widthIn, h: t.heightIn, assetId: a.id, fit: 'cover', locked: false };
  const next = CoverDesign.parse({ ...design, layers: [layer, ...design.layers.filter((l) => l.id !== 'cover-art')] });
  const layout = layoutCover(next, geom, await assetInfo(ws.workspaceId, next));
  const updated = await prisma.coverDesign.update({ where: { id: c.id }, data: { design: next as unknown as Prisma.InputJsonValue, revision: { increment: 1 } } });
  await audit(req, 'cover.art.apply', 'CoverDesign', c.id, { assetId: a.id, scope: body.scope });
  return { cover: updated, warnings: layout.warnings };
});
