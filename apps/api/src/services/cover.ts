import { computeCoverGeometry, ebookCoverGeometry, OfficialCoverGeometry, type CoverGeometry } from '@kdp/core';
import { prisma } from '../db';
import { cachedLayout } from './preview';

/** Cover geometry from the *current final* interior page count. */
export async function projectCoverGeometry(projectId: string): Promise<CoverGeometry> {
  const format = await prisma.productFormat.findUniqueOrThrow({ where: { projectId } });
  if (format.format === 'EBOOK') return ebookCoverGeometry();
  const { layout } = await cachedLayout(projectId);
  return computeCoverGeometry({
    format: format.format,
    trimId: format.trimId,
    pageCount: layout.pageCount,
    ink: format.ink as never,
    paper: format.paper as never,
    direction: format.direction as 'LTR' | 'RTL',
    official: format.officialCover ? OfficialCoverGeometry.parse(format.officialCover) : null,
  });
}
