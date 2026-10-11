import { checkMetadata, MetadataDraft } from '@kdp/core';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { defineRoute, IdParams } from '../lib/route';
import { currentMetadata } from '../services/build';
import { createJob } from '../services/jobs';
import { getProject } from '../services/projects';

export const metadataRouter = Router();

defineRoute(metadataRouter, { method: 'get', path: '/projects/:id/metadata', summary: 'Current metadata draft, AI suggestions, and deterministic findings', tag: 'Metadata', params: IdParams }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  const { row, data } = await currentMetadata(params.id);
  return { id: row?.id ?? null, data, suggestions: row?.suggestions ?? null, findings: checkMetadata(data), updatedAt: row?.updatedAt ?? null };
});

defineRoute(metadataRouter, { method: 'put', path: '/projects/:id/metadata', summary: 'Save the metadata draft (never published automatically)', tag: 'Metadata', params: IdParams, body: z.object({ data: MetadataDraft }) }, async ({ ws, params, body, req }) => {
  const p = await getProject(ws.workspaceId, params.id);
  const { row } = await currentMetadata(p.id);
  const data = body.data as unknown as Prisma.InputJsonValue;
  if (row) await prisma.metadataDraft.update({ where: { id: row.id }, data: { data } });
  else await prisma.metadataDraft.create({ data: { projectId: p.id, data } });
  if (body.data.title) await prisma.project.update({ where: { id: p.id }, data: { title: body.data.title } });
  await audit(req, 'metadata.update', 'Project', p.id);
  return { data: body.data, findings: checkMetadata(body.data) };
});

defineRoute(metadataRouter, { method: 'post', path: '/projects/:id/metadata/suggest', summary: 'Generate metadata suggestions with the text provider (async)', tag: 'Metadata', params: IdParams, status: 202 }, async ({ ws, auth, params }) => {
  const p = await getProject(ws.workspaceId, params.id);
  return createJob({ workspaceId: ws.workspaceId, projectId: p.id, type: 'GENERATE', input: { settings: { outline: false, content: false, interior: false, coverConcept: false, titleSuggestions: true, metadata: true, similarity: false, validate: false } }, userId: auth.user.id, usesAi: true });
});
