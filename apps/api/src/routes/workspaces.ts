import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { forbidden, notFound } from '../lib/errors';
import { defineRoute, IdParams } from '../lib/route';

export const workspaceRouter = Router();

defineRoute(workspaceRouter, { method: 'post', path: '/workspaces/:id/activate', summary: 'Switch active workspace', tag: 'Workspaces', auth: 'user', params: IdParams }, async ({ auth, params, req }) => {
  const m = await prisma.membership.findUnique({ where: { userId_workspaceId: { userId: auth.user.id, workspaceId: params.id } } });
  if (!m) throw notFound('Workspace');
  await prisma.session.update({ where: { id: auth.session.id }, data: { activeWorkspaceId: params.id } });
  await audit(req, 'workspace.activate', 'Workspace', params.id, undefined, params.id);
  return { ok: true };
});

defineRoute(workspaceRouter, { method: 'get', path: '/workspace', summary: 'Active workspace settings and limits', tag: 'Workspaces' }, async ({ ws }) => {
  const w = await prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } });
  const members = await prisma.membership.findMany({ where: { workspaceId: ws.workspaceId }, include: { user: { select: { email: true, name: true } } } });
  return { ...w, dailyCostLimitUsd: Number(w.dailyCostLimitUsd), monthlyCostLimitUsd: Number(w.monthlyCostLimitUsd), role: ws.role, members: members.map((m) => ({ id: m.id, role: m.role, email: m.user.email, name: m.user.name })) };
});

defineRoute(
  workspaceRouter,
  { method: 'patch', path: '/workspace', summary: 'Update workspace name and usage limits', tag: 'Workspaces', minRole: 'ADMIN', body: z.object({ name: z.string().trim().min(1).max(100).optional(), dailyCostLimitUsd: z.number().min(0).max(100000).optional(), monthlyCostLimitUsd: z.number().min(0).max(1000000).optional(), dailyJobLimit: z.number().int().min(1).max(100000).optional() }) },
  async ({ ws, body, req }) => {
    const w = await prisma.workspace.update({
      where: { id: ws.workspaceId },
      data: { name: body.name, dailyJobLimit: body.dailyJobLimit, dailyCostLimitUsd: body.dailyCostLimitUsd !== undefined ? new Prisma.Decimal(body.dailyCostLimitUsd) : undefined, monthlyCostLimitUsd: body.monthlyCostLimitUsd !== undefined ? new Prisma.Decimal(body.monthlyCostLimitUsd) : undefined },
    });
    await audit(req, 'workspace.update', 'Workspace', w.id, body);
    return { ok: true };
  },
);

defineRoute(workspaceRouter, { method: 'post', path: '/workspace/members', summary: 'Add an existing user to the workspace', tag: 'Workspaces', minRole: 'ADMIN', body: z.object({ email: z.string().email(), role: z.enum(['ADMIN', 'EDITOR', 'VIEWER']) }) }, async ({ ws, body, req }) => {
  if (body.role === 'ADMIN' && ws.role !== 'OWNER') throw forbidden('Only owners can add admins.');
  const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
  if (!user) throw notFound('User (they must register first)');
  const m = await prisma.membership.upsert({ where: { userId_workspaceId: { userId: user.id, workspaceId: ws.workspaceId } }, create: { userId: user.id, workspaceId: ws.workspaceId, role: body.role }, update: { role: body.role } });
  await audit(req, 'workspace.member_add', 'Membership', m.id, { email: body.email, role: body.role });
  return { ok: true };
});

defineRoute(workspaceRouter, { method: 'get', path: '/audit-logs', summary: 'Workspace audit log', tag: 'Workspaces', minRole: 'ADMIN', query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) }, async ({ ws, query }) =>
  prisma.auditLog.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { createdAt: 'desc' }, take: query.limit }),
);
