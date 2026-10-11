import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { getStorage } from '../lib/storage';
import { defineRoute, IdParams } from '../lib/route';
import { ExportKind } from '../services/exports';
import { createJob } from '../services/jobs';
import { getProject } from '../services/projects';

export const exportRouter = Router();

defineRoute(exportRouter, { method: 'post', path: '/projects/:id/exports', summary: 'Create an export bundle (async). Final files require passing preflight and completed reviews.', tag: 'Exports', params: IdParams, body: z.object({ kinds: z.array(ExportKind).min(1).max(20) }), status: 202 }, async ({ ws, auth, params, body, req }) => {
  const p = await getProject(ws.workspaceId, params.id);
  const job = await createJob({ workspaceId: ws.workspaceId, projectId: p.id, type: 'EXPORT', input: { kinds: body.kinds }, userId: auth.user.id, maxAttempts: 1 });
  await audit(req, 'export.request', 'Project', p.id, { kinds: body.kinds, jobId: job.id });
  return job;
});

defineRoute(exportRouter, { method: 'get', path: '/projects/:id/exports', summary: 'Export bundles with artifacts and checksums', tag: 'Exports', params: IdParams }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  const rows = await prisma.exportArtifact.findMany({ where: { projectId: params.id }, orderBy: { createdAt: 'desc' }, take: 500, select: { id: true, bundleId: true, kind: true, filename: true, mimeType: true, sha256: true, sizeBytes: true, specVersion: true, rulesetVersion: true, pageCount: true, trimSize: true, validationStatus: true, projectVersion: true, createdAt: true } });
  const bundles = new Map<string, { bundleId: string; createdAt: Date; validationStatus: string; artifacts: typeof rows }>();
  for (const r of rows) {
    if (!bundles.has(r.bundleId)) bundles.set(r.bundleId, { bundleId: r.bundleId, createdAt: r.createdAt, validationStatus: r.validationStatus, artifacts: [] });
    bundles.get(r.bundleId)!.artifacts.push(r);
  }
  return [...bundles.values()];
});

defineRoute(exportRouter, { method: 'get', path: '/exports/:id/download', summary: 'Download an export artifact', tag: 'Exports', params: IdParams, raw: true, responseContentType: 'application/octet-stream' }, async ({ ws, params, res, req }) => {
  const a = await prisma.exportArtifact.findFirst({ where: { id: params.id, project: { workspaceId: ws.workspaceId } } });
  if (!a) throw notFound('Artifact');
  const bytes = await getStorage().get(a.storageKey);
  await audit(req, 'export.download', 'ExportArtifact', a.id);
  res.setHeader('Content-Type', a.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${a.filename.replace(/"/g, '')}"`);
  res.setHeader('X-Content-SHA256', a.sha256);
  res.send(Buffer.from(bytes));
});
