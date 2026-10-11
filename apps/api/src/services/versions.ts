import { InteriorDocument } from '@kdp/core';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { notFound } from '../lib/errors';
import { loadDocument, saveDocument } from './interior';

/** Full editable state of a project (no binary assets — those are referenced by id). */
export async function snapshotProject(projectId: string) {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { brief: true, format: true } });
  const { doc } = await loadDocument(projectId);
  const covers = await prisma.coverDesign.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  const metadata = await prisma.metadataDraft.findFirst({ where: { projectId, isCurrent: true } });
  const strip = <T extends object | null>(o: T) => {
    if (!o) return o;
    const { id: _id, projectId: _p, updatedAt: _u, ...rest } = o as Record<string, unknown>;
    return rest;
  };
  return {
    project: { title: p.title, category: p.category, contentClass: p.contentClass, status: p.status, aiTextGenerated: p.aiTextGenerated, aiImagesGenerated: p.aiImagesGenerated, aiDisclosureAck: p.aiDisclosureAck },
    brief: strip(p.brief),
    format: strip(p.format),
    interior: doc,
    covers: covers.map((c) => ({ name: c.name, design: c.design, isActive: c.isActive })),
    metadata: metadata?.data ?? null,
  };
}
export type ProjectSnapshot = Awaited<ReturnType<typeof snapshotProject>>;

export async function createVersion(projectId: string, label: string, userId: string | null) {
  const snapshot = await snapshotProject(projectId);
  return prisma.$transaction(async (tx) => {
    const p = await tx.project.update({ where: { id: projectId }, data: { currentVersion: { increment: 1 } } });
    return tx.projectVersion.create({ data: { projectId, version: p.currentVersion, label: label.slice(0, 200), snapshot: snapshot as unknown as Prisma.InputJsonValue, createdById: userId } });
  });
}

/** Restores a snapshot. The current state is saved as a new version first, so restore is undoable. */
export async function restoreVersion(projectId: string, versionId: string, userId: string | null) {
  const v = await prisma.projectVersion.findFirst({ where: { id: versionId, projectId } });
  if (!v) throw notFound('Version');
  await createVersion(projectId, `Before restoring v${v.version}`, userId);
  const s = v.snapshot as unknown as ProjectSnapshot;
  const { revision } = await loadDocument(projectId);
  await saveDocument(projectId, InteriorDocument.parse(s.interior), revision);
  await prisma.$transaction(async (tx) => {
    if (s.brief) await tx.productBrief.update({ where: { projectId }, data: s.brief as Prisma.ProductBriefUpdateInput });
    if (s.format) await tx.productFormat.update({ where: { projectId }, data: s.format as Prisma.ProductFormatUpdateInput });
    await tx.coverDesign.deleteMany({ where: { projectId } });
    for (const c of s.covers) await tx.coverDesign.create({ data: { projectId, name: c.name, design: c.design as Prisma.InputJsonValue, isActive: c.isActive } });
    await tx.metadataDraft.updateMany({ where: { projectId }, data: { isCurrent: false } });
    if (s.metadata) await tx.metadataDraft.create({ data: { projectId, data: s.metadata as Prisma.InputJsonValue } });
    await tx.project.update({ where: { id: projectId }, data: { title: s.project.title, category: s.project.category, contentClass: s.project.contentClass } });
  });
  return v;
}
