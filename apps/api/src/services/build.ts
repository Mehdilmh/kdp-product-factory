import { CoverDesign, MetadataDraft, OfficialCoverGeometry, runPipeline, type InteriorFingerprint, type PipelineAsset, type PipelineOptions, type PreflightReport, type ProductBuild, type ProductInput } from '@kdp/core';
import type { Prisma, Project } from '@prisma/client';
import { prisma } from '../db';
import { badRequest } from '../lib/errors';
import { getStorage } from '../lib/storage';
import { loadDocument } from './interior';

function collectAssetIds(doc: unknown, cover: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.assetId === 'string') ids.add(o.assetId);
      Object.values(o).forEach(walk);
    }
  };
  walk(doc);
  walk(cover);
  return ids;
}

export async function loadAssets(workspaceId: string, ids: Set<string>): Promise<Record<string, PipelineAsset>> {
  if (!ids.size) return {};
  // Workspace scoping: assets from other workspaces are silently unavailable (reported as missing).
  const rows = await prisma.asset.findMany({ where: { id: { in: [...ids] }, workspaceId } });
  const storage = getStorage();
  const out: Record<string, PipelineAsset> = {};
  for (const a of rows) {
    if (!a.mimeType.startsWith('image/')) continue;
    out[a.id] = { bytes: await storage.get(a.storageKey), mimeType: a.mimeType, source: a.source as PipelineAsset['source'], licenseNote: a.licenseNote };
  }
  return out;
}

export async function currentMetadata(projectId: string) {
  const row = await prisma.metadataDraft.findFirst({ where: { projectId, isCurrent: true }, orderBy: { createdAt: 'desc' } });
  return { row, data: MetadataDraft.parse(row?.data ?? {}) };
}

export async function activeCover(projectId: string) {
  return prisma.coverDesign.findFirst({ where: { projectId, isActive: true }, orderBy: { updatedAt: 'desc' } });
}

export async function assembleInput(project: Project, opts: { includeCover?: boolean } = {}): Promise<ProductInput> {
  const format = await prisma.productFormat.findUnique({ where: { projectId: project.id } });
  if (!format) throw badRequest('Project has no format configured');
  const { doc } = await loadDocument(project.id);
  const cover = opts.includeCover === false ? null : await activeCover(project.id);
  const { data: metadata } = await currentMetadata(project.id);
  const assets = await loadAssets(project.workspaceId, collectAssetIds(doc, cover?.design));
  const others = await prisma.project.findMany({
    where: { workspaceId: project.workspaceId, id: { not: project.id }, archivedAt: null },
    select: { id: true, title: true, fingerprint: true, metadataDrafts: { where: { isCurrent: true }, select: { data: true }, take: 1 } },
    take: 2000,
  });
  return {
    projectId: project.id,
    format: format.format,
    trimId: format.trimId,
    ink: format.ink as ProductInput['ink'],
    paper: format.paper as ProductInput['paper'],
    bleed: format.bleed,
    direction: format.direction as ProductInput['direction'],
    contentClass: project.contentClass,
    category: project.category,
    document: doc,
    cover: cover ? CoverDesign.parse(cover.design) : null,
    officialCover: format.officialCover ? OfficialCoverGeometry.parse(format.officialCover) : null,
    metadata,
    assets,
    portfolio: others.map((o) => ({ projectId: o.id, title: (o.metadataDrafts[0]?.data as { title?: string } | undefined)?.title || o.title, fingerprint: (o.fingerprint as InteriorFingerprint | null) ?? null })),
    ai: { textGenerated: project.aiTextGenerated, imagesGenerated: project.aiImagesGenerated, disclosureAcknowledged: project.aiDisclosureAck },
    date: new Date('2020-01-01T00:00:00Z'),
  };
}

/** Re-attach human review decisions whose evidence has not changed since the review. */
async function attachReviews(projectId: string, report: PreflightReport) {
  const reviews = await prisma.humanReview.findMany({ where: { report: { projectId } }, orderBy: { createdAt: 'desc' }, include: { report: { select: { results: true } } } });
  for (const r of report.results) {
    if (r.status !== 'NEEDS_HUMAN_REVIEW' && r.status !== 'WARNING' && !(r.status === 'FAIL' && !r.blocking)) continue;
    const prior = reviews.find((h) => h.ruleId === r.ruleId && (h.report.results as unknown as PreflightReport['results']).some((x) => x.ruleId === r.ruleId && x.evidence === r.evidence));
    if (prior) r.review = { decision: prior.decision as 'ACCEPTED_RISK' | 'RESOLVED' | 'REJECTED', note: prior.note, reviewer: prior.reviewerId, at: prior.createdAt.toISOString() };
  }
}

/** Full deterministic build + stored validation report. */
export async function buildAndValidate(project: Project, opts: PipelineOptions = {}): Promise<{ build: ProductBuild; reportId: string; input: ProductInput }> {
  const input = await assembleInput(project);
  const build = await runPipeline(input, opts);
  await attachReviews(project.id, build.preflight);
  const report = await prisma.validationReport.create({
    data: {
      projectId: project.id,
      projectVersion: project.currentVersion,
      format: build.preflight.format,
      specVersion: build.preflight.specVersion,
      rulesetVersion: build.preflight.rulesetVersion,
      results: build.preflight.results as unknown as Prisma.InputJsonValue,
      summary: { ...build.preflight.summary, pageCount: build.layout?.pageCount ?? null } as Prisma.InputJsonValue,
      blocked: build.preflight.blocked,
    },
  });
  const dup = build.preflight.results.find((r) => r.ruleId === 'CNT-DUP-001');
  await prisma.project.update({
    where: { id: project.id },
    data: { fingerprint: build.fingerprint as unknown as Prisma.InputJsonValue, similarity: { status: dup?.status ?? 'NOT_APPLICABLE', evidence: dup?.evidence ?? '', checkedAt: new Date().toISOString() } },
  });
  return { build, reportId: report.id, input };
}

export function pendingReviewIds(report: PreflightReport | { results: PreflightReport['results'] }) {
  return report.results.filter((r) => r.status === 'NEEDS_HUMAN_REVIEW' && !r.review).map((r) => r.ruleId);
}
