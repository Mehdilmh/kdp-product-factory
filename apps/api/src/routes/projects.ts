import { defaultSpecSource } from '@kdp/core';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest } from '../lib/errors';
import { defineRoute, IdParams } from '../lib/route';
import { createJob } from '../services/jobs';
import { createProject, getProject, projectSummary, setStatus, STATUS_ORDER } from '../services/projects';
import { CreateProjectInput, GenerationSettings, UpdateBriefInput, UpdateFormatInput } from '../services/schemas';
import { createVersion, restoreVersion } from '../services/versions';

export const projectRouter = Router();

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(STATUS_ORDER as [string, ...string[]]).optional(),
  category: z.string().max(40).optional(),
  format: z.enum(['PAPERBACK', 'HARDCOVER', 'EBOOK']).optional(),
  sort: z.enum(['updated', 'created', 'title']).default('updated'),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

defineRoute(projectRouter, { method: 'get', path: '/projects', summary: 'List and search projects', tag: 'Projects', query: ListQuery }, async ({ ws, query }) => {
  const where: Prisma.ProjectWhereInput = {
    workspaceId: ws.workspaceId,
    archivedAt: null,
    status: query.status as Prisma.ProjectWhereInput['status'],
    category: query.category,
    format: query.format ? { format: query.format } : undefined,
    OR: query.q ? [{ title: { contains: query.q, mode: 'insensitive' } }, { brief: { niche: { contains: query.q, mode: 'insensitive' } } }] : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy: query.sort === 'title' ? { title: 'asc' } : query.sort === 'created' ? { createdAt: 'desc' } : { updatedAt: 'desc' },
      take: query.take,
      skip: query.skip,
      include: { format: { select: { format: true, trimId: true, ink: true, paper: true } }, validationReports: { orderBy: { createdAt: 'desc' }, take: 1, select: { blocked: true, summary: true, createdAt: true } }, jobs: { where: { status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true, stage: true, progress: true, type: true } } },
    }),
    prisma.project.count({ where }),
  ]);
  return { items, total };
});

defineRoute(projectRouter, { method: 'post', path: '/projects', summary: 'Create a project from a product brief', tag: 'Projects', body: CreateProjectInput, status: 201 }, async ({ ws, auth, body, req }) => {
  const p = await createProject(ws.workspaceId, auth.user.id, body);
  await createVersion(p.id, 'Created', auth.user.id);
  await audit(req, 'project.create', 'Project', p.id, { title: p.title });
  return projectSummary(ws.workspaceId, p.id);
});

defineRoute(projectRouter, { method: 'get', path: '/projects/:id', summary: 'Project detail', tag: 'Projects', params: IdParams }, async ({ ws, params }) => projectSummary(ws.workspaceId, params.id));

defineRoute(projectRouter, { method: 'patch', path: '/projects/:id', summary: 'Update project fields, brief, format, or status', tag: 'Projects', params: IdParams, body: z.object({ title: z.string().trim().min(1).max(200).optional(), contentClass: z.enum(['LOW', 'MEDIUM', 'FULL']).optional(), status: z.enum(STATUS_ORDER as [string, ...string[]]).optional(), aiDisclosureAck: z.boolean().optional(), brief: UpdateBriefInput.optional(), format: UpdateFormatInput.optional() }) }, async ({ ws, params, body, req }) => {
  const p = await getProject(ws.workspaceId, params.id);
  if (body.format) {
    const cur = await prisma.productFormat.findUniqueOrThrow({ where: { projectId: p.id } });
    const next = { ...cur, ...body.format };
    if (next.paper === 'CREAM' && next.ink !== 'BLACK_WHITE') throw badRequest('Cream paper is only available with black & white ink.');
    if (next.format !== 'EBOOK') {
      const trim = defaultSpecSource.getLibrary().trimSizes.find((t) => t.id === next.trimId);
      if (!trim || !trim.formats.includes(next.format as 'PAPERBACK' | 'HARDCOVER')) throw badRequest(`Trim ${next.trimId} is not available for ${next.format.toLowerCase()}.`);
    }
    const { officialCover, ...rest } = body.format;
    await prisma.productFormat.update({ where: { projectId: p.id }, data: { ...rest, officialCover: officialCover === undefined ? undefined : officialCover === null ? (null as unknown as Prisma.InputJsonValue) : (officialCover as Prisma.InputJsonValue), specVersion: defaultSpecSource.getLibrary().version } });
  }
  if (body.brief) {
    const { category, contentClass: _cc, ...rest } = body.brief;
    await prisma.productBrief.update({ where: { projectId: p.id }, data: rest });
    if (category) await prisma.project.update({ where: { id: p.id }, data: { category } });
  }
  if (body.status) await setStatus(p, body.status as Parameters<typeof setStatus>[1]);
  await prisma.project.update({ where: { id: p.id }, data: { title: body.title, contentClass: body.contentClass, aiDisclosureAck: body.aiDisclosureAck } });
  await audit(req, 'project.update', 'Project', p.id, body as Prisma.InputJsonValue);
  return projectSummary(ws.workspaceId, p.id);
});

defineRoute(projectRouter, { method: 'delete', path: '/projects/:id', summary: 'Archive a project', tag: 'Projects', params: IdParams, minRole: 'EDITOR' }, async ({ ws, params, req }) => {
  const p = await getProject(ws.workspaceId, params.id);
  await prisma.project.update({ where: { id: p.id }, data: { archivedAt: new Date() } });
  await audit(req, 'project.archive', 'Project', p.id);
  return { ok: true };
});

defineRoute(projectRouter, { method: 'post', path: '/projects/:id/generate', summary: 'Start an AI generation job (async)', tag: 'Jobs', params: IdParams, body: z.object({ settings: GenerationSettings.optional() }), status: 202 }, async ({ ws, auth, params, body, req }) => {
  const p = await getProject(ws.workspaceId, params.id);
  const brief = await prisma.productBrief.findUniqueOrThrow({ where: { projectId: p.id } });
  const settings = body.settings ?? GenerationSettings.parse(brief.generationSettings ?? {});
  await createVersion(p.id, 'Before AI generation', auth.user.id);
  const job = await createJob({ workspaceId: ws.workspaceId, projectId: p.id, type: 'GENERATE', input: { settings }, userId: auth.user.id, usesAi: true });
  await audit(req, 'job.create', 'GenerationJob', job.id, { type: 'GENERATE', projectId: p.id });
  return job;
});

defineRoute(projectRouter, { method: 'post', path: '/projects/:id/validate', summary: 'Run technical preflight and content checks (async)', tag: 'Validation', params: IdParams, status: 202 }, async ({ ws, auth, params }) => {
  const p = await getProject(ws.workspaceId, params.id);
  return createJob({ workspaceId: ws.workspaceId, projectId: p.id, type: 'VALIDATE', input: {}, userId: auth.user.id, maxAttempts: 1 });
});

// Version history
defineRoute(projectRouter, { method: 'get', path: '/projects/:id/versions', summary: 'Version history', tag: 'Versions', params: IdParams }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  return prisma.projectVersion.findMany({ where: { projectId: params.id }, orderBy: { version: 'desc' }, select: { id: true, version: true, label: true, createdAt: true, createdById: true } });
});
defineRoute(projectRouter, { method: 'post', path: '/projects/:id/versions', summary: 'Save a named version', tag: 'Versions', params: IdParams, body: z.object({ label: z.string().trim().min(1).max(200) }), status: 201 }, async ({ ws, auth, params, body }) => {
  await getProject(ws.workspaceId, params.id);
  const v = await createVersion(params.id, body.label, auth.user.id);
  return { id: v.id, version: v.version, label: v.label, createdAt: v.createdAt };
});
defineRoute(projectRouter, { method: 'post', path: '/projects/:id/versions/:versionId/restore', summary: 'Restore a version (current state is saved first)', tag: 'Versions', params: z.object({ id: z.string(), versionId: z.string() }) }, async ({ ws, auth, params, req }) => {
  await getProject(ws.workspaceId, params.id);
  const v = await restoreVersion(params.id, params.versionId, auth.user.id);
  await audit(req, 'project.restore', 'ProjectVersion', v.id, { version: v.version });
  return projectSummary(ws.workspaceId, params.id);
});
