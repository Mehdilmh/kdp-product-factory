import { RULES, RULESET_VERSION, type CheckResult } from '@kdp/core';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { defineRoute, IdParams } from '../lib/route';
import { getProject } from '../services/projects';

export const validationRouter = Router();

defineRoute(validationRouter, { method: 'get', path: '/rules', summary: 'Validation rules registry (versioned, with sources and verification dates)', tag: 'Validation' }, async () => ({
  rulesetVersion: RULESET_VERSION,
  rules: RULES.map(({ check: _c, ...r }) => r),
}));

defineRoute(validationRouter, { method: 'get', path: '/projects/:id/reports', summary: 'Validation report history', tag: 'Validation', params: IdParams }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  return prisma.validationReport.findMany({ where: { projectId: params.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, createdAt: true, blocked: true, summary: true, specVersion: true, rulesetVersion: true, projectVersion: true, format: true } });
});

defineRoute(validationRouter, { method: 'get', path: '/projects/:id/reports/:reportId', summary: 'A full validation report', tag: 'Validation', params: z.object({ id: z.string(), reportId: z.string() }) }, async ({ ws, params }) => {
  await getProject(ws.workspaceId, params.id);
  const r = await prisma.validationReport.findFirst({ where: { id: params.reportId, projectId: params.id }, include: { reviews: true } });
  if (!r) throw notFound('Report');
  return r;
});

defineRoute(
  validationRouter,
  {
    method: 'post',
    path: '/projects/:id/reports/:reportId/reviews',
    summary: 'Record a human review decision for a rule result',
    tag: 'Validation',
    params: z.object({ id: z.string(), reportId: z.string() }),
    body: z.object({ ruleId: z.string().max(40), decision: z.enum(['ACCEPTED_RISK', 'RESOLVED', 'REJECTED']), note: z.string().trim().min(3, 'Explain the decision').max(2000) }),
    status: 201,
  },
  async ({ ws, auth, params, body, req }) => {
    await getProject(ws.workspaceId, params.id);
    const r = await prisma.validationReport.findFirst({ where: { id: params.reportId, projectId: params.id } });
    if (!r) throw notFound('Report');
    const result = (r.results as unknown as CheckResult[]).find((x) => x.ruleId === body.ruleId);
    if (!result) throw notFound('Rule result');
    if (result.blocking) {
      const { conflict } = await import('../lib/errors');
      throw conflict('Blocking technical failures must be fixed, not accepted.');
    }
    const review = await prisma.humanReview.upsert({
      where: { reportId_ruleId: { reportId: r.id, ruleId: body.ruleId } },
      create: { reportId: r.id, ruleId: body.ruleId, decision: body.decision, note: body.note, reviewerId: auth.user.email },
      update: { decision: body.decision, note: body.note, reviewerId: auth.user.email },
    });
    if (body.ruleId === 'CNT-AI-001' && body.decision !== 'REJECTED') await prisma.project.update({ where: { id: params.id }, data: { aiDisclosureAck: true } });
    await audit(req, 'validation.review', 'HumanReview', review.id, { ruleId: body.ruleId, decision: body.decision });
    return review;
  },
);
