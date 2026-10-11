import { BUILT_IN_TEMPLATES, Chapter, DocumentSettings, InteriorDocument, layoutDocument, PageTemplate, rasterizeSvg, renderPageSvg } from '@kdp/core';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { defineRoute, IdParams } from '../lib/route';
import { applyPageOp, loadDocument, saveDocument, type PageOp } from '../services/interior';
import { cachedLayout, pageAssetDataUris, pngCache } from '../services/preview';
import { getProject } from '../services/projects';

export const interiorRouter = Router();

const Section = z.enum(['front', 'body', 'back']);
const FieldValues = z.record(z.union([z.string().max(5000), z.number(), z.boolean()]));
const PageOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), section: Section, at: z.number().int().min(0).optional(), templateId: z.string().max(80).nullable(), fields: FieldValues.optional() }),
  z.object({ op: z.literal('remove'), section: Section, pageId: z.string() }),
  z.object({ op: z.literal('duplicate'), section: Section, pageId: z.string(), count: z.number().int().min(1).max(500).optional() }),
  z.object({ op: z.literal('move'), section: Section, pageId: z.string(), to: z.number().int().min(0) }),
  z.object({ op: z.literal('update'), section: Section, pageId: z.string(), fields: FieldValues.optional(), elements: z.array(z.unknown()).max(80).nullable().optional(), templateId: z.string().max(80).nullable().optional() }),
  z.object({ op: z.literal('lock'), section: Section, pageId: z.string(), locked: z.boolean() }),
  z.object({ op: z.literal('sequence'), section: Section, at: z.number().int().min(0).optional(), templateIds: z.array(z.string().max(80)).min(1).max(20), repeat: z.number().int().min(1).max(500), fieldsList: z.array(FieldValues).max(1000).optional() }),
]);

defineRoute(interiorRouter, { method: 'get', path: '/projects/:id/interior', summary: 'Interior document (typed schema) and revision', tag: 'Interior', params: IdParams }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  return loadDocument(params.id);
});

defineRoute(interiorRouter, { method: 'put', path: '/projects/:id/interior', summary: 'Replace the interior document (optimistic concurrency)', tag: 'Interior', params: IdParams, body: z.object({ revision: z.number().int(), document: z.unknown() }) }, async ({ ws, params, body }) => {
  await getProject(ws.workspaceId, params.id);
  const { doc: current } = await loadDocument(params.id);
  const next = InteriorDocument.parse(body.document);
  // Locked pages may not be changed via a full save either.
  const all = (d: InteriorDocument) => [...d.frontMatter, ...(d.body.kind === 'pages' ? d.body.pages : []), ...d.backMatter];
  const nextById = new Map(all(next).map((p) => [p.id, p]));
  for (const p of all(current).filter((x) => x.locked)) {
    const n = nextById.get(p.id);
    if (!n || JSON.stringify(n) !== JSON.stringify(p)) throw badRequest(`Page "${p.id}" is locked (approved). Unlock it before changing or removing it.`);
  }
  const revision = await saveDocument(params.id, next, body.revision);
  return { revision };
});

defineRoute(interiorRouter, { method: 'patch', path: '/projects/:id/interior/settings', summary: 'Update document settings (fonts, margins, numbering, headers)', tag: 'Interior', params: IdParams, body: z.object({ revision: z.number().int(), settings: DocumentSettings.partial() }) }, async ({ ws, params, body }) => {
  await getProject(ws.workspaceId, params.id);
  const { doc } = await loadDocument(params.id);
  const merged = InteriorDocument.parse({ ...doc, settings: { ...doc.settings, ...body.settings } });
  return { revision: await saveDocument(params.id, merged, body.revision) };
});

defineRoute(interiorRouter, { method: 'post', path: '/projects/:id/interior/ops', summary: 'Apply page operations (add, remove, duplicate, move, update, lock, sequence)', tag: 'Interior', params: IdParams, body: z.object({ revision: z.number().int(), ops: z.array(PageOpSchema).min(1).max(100) }) }, async ({ ws, params, body }) => {
  await getProject(ws.workspaceId, params.id);
  let { doc } = await loadDocument(params.id);
  for (const op of body.ops) doc = applyPageOp(doc, op as PageOp);
  const revision = await saveDocument(params.id, doc, body.revision);
  return { revision, document: doc };
});

defineRoute(interiorRouter, { method: 'put', path: '/projects/:id/interior/chapters', summary: 'Replace long-form chapters', tag: 'Interior', params: IdParams, body: z.object({ revision: z.number().int(), chapters: z.array(Chapter).max(500) }) }, async ({ ws, params, body }) => {
  await getProject(ws.workspaceId, params.id);
  const { doc } = await loadDocument(params.id);
  if (doc.body.kind !== 'flow') throw badRequest('This book uses pages, not flowing chapters.');
  return { revision: await saveDocument(params.id, { ...doc, body: { kind: 'flow', chapters: body.chapters } }, body.revision) };
});

defineRoute(interiorRouter, { method: 'get', path: '/projects/:id/interior/layout', summary: 'Layout summary: page list, warnings, margins, TOC, spec', tag: 'Interior', params: IdParams }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  const { layout, revision } = await cachedLayout(params.id);
  return {
    revision,
    pageCount: layout.pageCount,
    margins: layout.margins,
    spec: { version: layout.spec.specVersion, trim: layout.spec.trim, pageWidthIn: layout.spec.pageWidthIn, pageHeightIn: layout.spec.pageHeightIn, bleed: layout.spec.bleed, minMargins: layout.spec.minMargins, pageCountLimit: layout.spec.pageCountLimit, issues: layout.spec.issues, verifications: layout.spec.verifications },
    toc: layout.toc,
    warnings: layout.warnings.slice(0, 500),
    pages: layout.pages.map((p) => ({ index: p.index, pageNumber: p.pageNumber, displayNumber: p.displayNumber, section: p.section, source: p.source, isBlank: p.isBlank, intentionalBlank: p.intentionalBlank, gutterSide: p.gutterSide })),
  };
});

defineRoute(
  interiorRouter,
  { method: 'get', path: '/projects/:id/interior/pages/:page/preview.svg', summary: 'Print-size SVG preview of one page (same layout as the PDF)', tag: 'Interior', params: z.object({ id: z.string(), page: z.coerce.number().int().min(1) }), query: z.object({ guides: z.enum(['0', '1']).default('1') }), raw: true, responseContentType: 'image/svg+xml' },
  async ({ ws, params, query, res }) => {
    await getProject(ws.workspaceId, params.id);
    const { layout } = await cachedLayout(params.id);
    const page = layout.pages[params.page - 1];
    if (!page) throw notFound('Page');
    const svg = renderPageSvg(page, { guides: query.guides === '1', fontBaseUrl: '/api/fonts/', assetHref: (id) => `/api/assets/${encodeURIComponent(id)}/file`, gray: layout.spec.input.ink === 'BLACK_WHITE' });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=0');
    res.send(svg);
  },
);

/**
 * Raster preview (PNG) rendered on the server with the bundled fonts and embedded images, so it
 * matches the PDF exactly. (Browsers do not load fonts or images inside SVGs shown via <img>.)
 */
defineRoute(
  interiorRouter,
  { method: 'get', path: '/projects/:id/interior/pages/:page/preview.png', summary: 'Print-accurate PNG preview of one page', tag: 'Interior', params: z.object({ id: z.string(), page: z.coerce.number().int().min(1) }), query: z.object({ guides: z.enum(['0', '1']).default('1'), dpi: z.coerce.number().int().min(12).max(300).default(96) }), raw: true, responseContentType: 'image/png' },
  async ({ ws, params, query, res }) => {
    const project = await getProject(ws.workspaceId, params.id);
    const { layout, revision } = await cachedLayout(params.id);
    const page = layout.pages[params.page - 1];
    if (!page) throw notFound('Page');
    const key = `${params.id}:${revision}:${layout.spec.input.trimId}:${layout.spec.input.bleed}:${params.page}:${query.dpi}:${query.guides}`;
    let png = pngCache.get(key);
    if (!png) {
      const hrefs = await pageAssetDataUris(project.workspaceId, page);
      const svg = renderPageSvg(page, { guides: query.guides === '1', assetHref: (id) => hrefs[id], gray: layout.spec.input.ink === 'BLACK_WHITE' });
      png = rasterizeSvg(svg, Math.round((page.widthPt / 72) * query.dpi));
      pngCache.set(key, png);
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(png));
  },
);

/* --------------------------------------- Templates ------------------------------------------ */

defineRoute(interiorRouter, { method: 'get', path: '/templates', summary: 'Built-in and workspace page templates', tag: 'Templates' }, async ({ ws }) => {
  const custom = await prisma.pageTemplate.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { updatedAt: 'desc' } });
  return {
    builtIn: BUILT_IN_TEMPLATES,
    custom: custom.map((t) => ({ ...PageTemplate.parse({ ...(t.definition as object), id: t.key, name: t.name, kind: t.kind, category: t.category, version: t.version }), dbId: t.id, approved: t.approved, updatedAt: t.updatedAt })),
  };
});

const TemplateBody = z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'lowercase letters, digits, and dashes'), template: z.unknown(), approved: z.boolean().default(false) });

defineRoute(interiorRouter, { method: 'post', path: '/templates', summary: 'Save a custom template (new version if the key exists)', tag: 'Templates', body: TemplateBody, status: 201 }, async ({ ws, body, req }) => {
  if (BUILT_IN_TEMPLATES.some((t) => t.id === body.key)) throw badRequest('That key is used by a built-in template.');
  const t = PageTemplate.parse({ ...(body.template as object), id: body.key });
  const existing = await prisma.pageTemplate.findUnique({ where: { workspaceId_key: { workspaceId: ws.workspaceId, key: body.key } } });
  const def = { ...t, id: undefined } as unknown as Prisma.InputJsonValue;
  const row = existing
    ? await prisma.pageTemplate.update({ where: { id: existing.id }, data: { name: t.name, kind: t.kind, category: t.category, definition: def, approved: body.approved, version: { increment: 1 } } })
    : await prisma.pageTemplate.create({ data: { workspaceId: ws.workspaceId, key: body.key, name: t.name, kind: t.kind, category: t.category, definition: def, approved: body.approved } });
  await audit(req, existing ? 'template.update' : 'template.create', 'PageTemplate', row.id, { key: body.key });
  return { id: row.id, key: row.key, version: row.version };
});

defineRoute(interiorRouter, { method: 'delete', path: '/templates/:id', summary: 'Delete a custom template', tag: 'Templates', params: IdParams }, async ({ ws, params, req }) => {
  const t = await prisma.pageTemplate.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } });
  if (!t) throw notFound('Template');
  await prisma.pageTemplate.delete({ where: { id: t.id } });
  await audit(req, 'template.delete', 'PageTemplate', t.id);
  return { ok: true };
});

defineRoute(
  interiorRouter,
  { method: 'post', path: '/templates/preview', summary: 'Render a template (saved or unsaved) on a sample page; returns SVG and layout warnings', tag: 'Templates', body: z.object({ template: z.unknown(), trimId: z.string().max(20).default('6x9'), fields: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}) }) },
  async ({ body }) => {
    const t = PageTemplate.parse({ id: '__preview', ...(body.template as object) });
    const l = layoutDocument(
      { settings: { title: 'Sample Title', author: 'Sample Author' }, body: { kind: 'pages', pages: [{ id: 'p1', templateId: '__preview', fields: body.fields }] }, templates: [t], frontMatter: [] },
      { format: { format: 'PAPERBACK', trimId: body.trimId, ink: 'BLACK_WHITE', paper: 'WHITE', bleed: false } },
    );
    return { svg: renderPageSvg(l.pages[0], { guides: true, fontBaseUrl: '/api/fonts/' }), warnings: l.warnings.filter((w) => w.code !== 'MARGIN_ADJUSTED') };
  },
);
