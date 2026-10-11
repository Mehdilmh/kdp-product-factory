import { computeCoverGeometry, ebookCoverGeometry, FIXTURES, layoutDocument, sha256, starterCoverDesign, type FixtureName, type MetadataDraftInput } from '@kdp/core';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { getStorage } from '../lib/storage';
import { loadDocument, saveDocument } from './interior';
import { createProject } from './projects';
import { createVersion } from './versions';

const CATEGORY: Record<FixtureName, { category: 'GUIDED_JOURNAL' | 'WORKBOOK' | 'LOGBOOK' | 'NONFICTION' | 'ILLUSTRATED'; contentType: 'LINED' | 'WORKBOOK' | 'LOGBOOK' | 'LONG_FORM' | 'ILLUSTRATED'; theme: string }> = {
  journal: { category: 'GUIDED_JOURNAL', contentType: 'LINED', theme: 'midnight' },
  workbook: { category: 'WORKBOOK', contentType: 'WORKBOOK', theme: 'paper' },
  hardcover: { category: 'LOGBOOK', contentType: 'LOGBOOK', theme: 'industrial' },
  ebook: { category: 'NONFICTION', contentType: 'LONG_FORM', theme: 'sage' },
  illustrated: { category: 'ILLUSTRATED', contentType: 'ILLUSTRATED', theme: 'midnight' },
};

/** Imports a fixture project (document, metadata, assets, official geometry, starter cover). */
export async function importFixture(workspaceId: string, userId: string, name: FixtureName) {
  const f = FIXTURES[name]();
  const md = f.metadata as MetadataDraftInput;
  const c = CATEGORY[name];
  const project = await createProject(workspaceId, userId, {
    brief: {
      workingTitle: md.title!,
      category: c.category,
      targetReader: name === 'illustrated' ? 'Parents reading with children aged 3–7' : name === 'hardcover' ? 'Small workshop owners and maker spaces' : 'Adults who want practical, structured guidance',
      readerProblem: md.description!.slice(0, 300),
      niche: md.categories?.[0] ?? 'General',
      differentiation: `Fixture product "${md.title}" — original content written for automated tests, with a specific structure for its audience.`,
      language: 'English',
      marketplace: 'Amazon.com',
      authorName: md.author!,
      contentStyle: '',
      designTheme: c.theme,
      contentType: c.contentType,
      contentClass: f.contentClass,
    },
    format: { format: f.format, trimId: f.trimId, ink: f.ink, paper: f.paper, bleed: f.bleed, coverFinish: 'MATTE', direction: 'LTR', targetPageCount: null },
    generation: { outline: false, content: false, interior: true, coverConcept: false, titleSuggestions: false, metadata: false, similarity: true, validate: true },
  });

  // Assets: fixture ids are remapped to stored asset ids.
  const idMap = new Map<string, string>();
  for (const [id, a] of Object.entries(f.assets ?? {})) {
    const key = `ws/${workspaceId}/projects/${project.id}/assets/${id}.png`;
    await getStorage().put(key, a.bytes, a.mimeType);
    const { imageSize } = await import('@kdp/core');
    const size = imageSize(a.bytes)!;
    const row = await prisma.asset.create({ data: { workspaceId, projectId: project.id, kind: 'ILLUSTRATION', filename: `${id}.png`, mimeType: a.mimeType, sizeBytes: a.bytes.byteLength, storageKey: key, sha256: sha256(a.bytes), widthPx: size.widthPx, heightPx: size.heightPx, source: a.source, licenseNote: a.licenseNote ?? '' } });
    idMap.set(id, row.id);
  }
  const remap = (v: unknown): unknown => (Array.isArray(v) ? v.map(remap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'assetId' && typeof x === 'string' ? (idMap.get(x) ?? x) : remap(x)])) : v);
  const document = remap(f.document);
  const { revision } = await loadDocument(project.id);
  await saveDocument(project.id, document, revision);
  await prisma.metadataDraft.updateMany({ where: { projectId: project.id }, data: { isCurrent: false } });
  await prisma.metadataDraft.create({ data: { projectId: project.id, data: md as Prisma.InputJsonValue } });
  if (f.officialCover) await prisma.productFormat.update({ where: { projectId: project.id }, data: { officialCover: f.officialCover as Prisma.InputJsonValue } });

  const { doc } = await loadDocument(project.id);
  const geom =
    f.format === 'EBOOK'
      ? ebookCoverGeometry()
      : computeCoverGeometry({ format: f.format, trimId: f.trimId, ink: f.ink, paper: f.paper, official: f.officialCover ?? null, pageCount: layoutDocument(doc, { format: { format: f.format, trimId: f.trimId, ink: f.ink, paper: f.paper, bleed: f.bleed } }).pageCount });
  const design = starterCoverDesign(geom, { title: md.title!, subtitle: md.subtitle, author: md.author!, backText: md.description, themeId: c.theme });
  await prisma.coverDesign.create({ data: { projectId: project.id, name: 'Starter cover', design: design as unknown as Prisma.InputJsonValue, isActive: true } });
  await prisma.project.update({ where: { id: project.id }, data: { status: 'COVER' } });
  await createVersion(project.id, 'Fixture imported', userId);
  return prisma.project.findUniqueOrThrow({ where: { id: project.id } });
}
