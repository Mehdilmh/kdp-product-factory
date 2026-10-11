import { imageSize, inspectPdf, sha256 } from '@kdp/core';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { requireWorkspace } from '../lib/auth';
import { badRequest, notFound } from '../lib/errors';
import { defineRoute, IdParams, registry } from '../lib/route';
import { getStorage } from '../lib/storage';

export const assetRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config().MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 } });

/**
 * Upload validation: type is determined from file *content* (magic bytes), not the client's
 * claim. Only PNG, JPEG, and PDF are accepted; SVG/HTML and scripts are rejected.
 */
assetRouter.post('/assets', upload.single('file'), async (req, res, next) => {
  try {
    const ws = requireWorkspace(req, 'EDITOR');
    const file = req.file;
    if (!file) throw badRequest('No file uploaded (field "file").');
    const bytes = new Uint8Array(file.buffer);
    const body = z.object({ projectId: z.string().optional(), kind: z.enum(['IMAGE', 'TEMPLATE', 'ILLUSTRATION']).default('IMAGE'), licenseNote: z.string().max(1000).default('') }).parse(req.body);
    if (body.projectId) {
      const p = await prisma.project.findFirst({ where: { id: body.projectId, workspaceId: ws.workspaceId } });
      if (!p) throw notFound('Project');
    }
    let mimeType: string;
    let widthPx: number | null = null;
    let heightPx: number | null = null;
    let meta: Record<string, unknown> = {};
    const img = imageSize(bytes);
    if (img) {
      mimeType = img.mimeType;
      widthPx = img.widthPx;
      heightPx = img.heightPx;
      if (widthPx > 20000 || heightPx > 20000 || widthPx * heightPx > 200_000_000) throw badRequest('Image dimensions are too large (max 20000 px per side).');
    } else if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) === '%PDF-') {
      const ins = await inspectPdf(bytes);
      if (!ins.ok) throw badRequest('PDF could not be parsed.');
      if (ins.encrypted || ins.hasJavaScript) throw badRequest('Encrypted PDFs or PDFs with JavaScript are not accepted.');
      mimeType = 'application/pdf';
      meta = { pageCount: ins.pageCount, firstPageIn: ins.pages[0]?.mediaBoxIn };
    } else throw badRequest('Unsupported file type. Upload PNG, JPEG, or PDF.');
    const safeName = file.originalname.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'pdf';
    const key = `ws/${ws.workspaceId}/assets/${Date.now().toString(36)}-${sha256(bytes).slice(0, 16)}.${ext}`;
    await getStorage().put(key, bytes, mimeType);
    const asset = await prisma.asset.create({
      data: { workspaceId: ws.workspaceId, projectId: body.projectId ?? null, kind: body.kind, filename: safeName, mimeType, sizeBytes: bytes.byteLength, storageKey: key, sha256: sha256(bytes), widthPx, heightPx, source: 'UPLOAD', licenseNote: body.licenseNote, meta: meta as object },
    });
    await audit(req, 'asset.upload', 'Asset', asset.id, { filename: safeName, mimeType });
    res.status(201).json(asset);
  } catch (e) {
    next(e);
  }
});
registry.registerPath({ method: 'post', path: '/api/assets', summary: 'Upload an image (PNG/JPEG) or PDF template (multipart field "file")', tags: ['Assets'], responses: { 201: { description: 'Asset created' } } });

defineRoute(assetRouter, { method: 'get', path: '/assets', summary: 'List workspace assets', tag: 'Assets', query: z.object({ projectId: z.string().optional() }) }, async ({ ws, query }) =>
  prisma.asset.findMany({ where: { workspaceId: ws.workspaceId, projectId: query.projectId }, orderBy: { createdAt: 'desc' }, take: 500 }),
);

defineRoute(assetRouter, { method: 'patch', path: '/assets/:id', summary: 'Update an asset license/permission note', tag: 'Assets', params: IdParams, body: z.object({ licenseNote: z.string().max(1000) }) }, async ({ ws, params, body }) => {
  const a = await prisma.asset.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } });
  if (!a) throw notFound('Asset');
  return prisma.asset.update({ where: { id: a.id }, data: { licenseNote: body.licenseNote } });
});

defineRoute(assetRouter, { method: 'get', path: '/assets/:id/file', summary: 'Asset file (workspace-scoped)', tag: 'Assets', params: IdParams, raw: true, responseContentType: 'application/octet-stream' }, async ({ ws, params, res }) => {
  const a = await prisma.asset.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } });
  if (!a) throw notFound('Asset');
  res.setHeader('Content-Type', a.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', `inline; filename="${a.filename.replace(/"/g, '')}"`);
  res.send(Buffer.from(await getStorage().get(a.storageKey)));
});

defineRoute(assetRouter, { method: 'delete', path: '/assets/:id', summary: 'Delete an asset', tag: 'Assets', params: IdParams }, async ({ ws, params, req }) => {
  const a = await prisma.asset.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } });
  if (!a) throw notFound('Asset');
  await getStorage().delete(a.storageKey);
  await prisma.asset.delete({ where: { id: a.id } });
  await audit(req, 'asset.delete', 'Asset', a.id);
  return { ok: true };
});
