import { layoutDocument, type AssetInfo, type LaidOutPage, type LayoutResult } from '@kdp/core';
import { getStorage } from '../lib/storage';
import { prisma } from '../db';
import { badRequest } from '../lib/errors';
import { loadDocument } from './interior';

/** Small LRU of layouts keyed by document revision + format, so previews stay fast while editing. */
const cache = new Map<string, LayoutResult>();
const MAX = 30;

export async function cachedLayout(projectId: string): Promise<{ layout: LayoutResult; revision: number }> {
  const format = await prisma.productFormat.findUniqueOrThrow({ where: { projectId } });
  if (format.format === 'EBOOK') throw badRequest('Kindle eBooks are reflowable; use the EPUB preview instead of print pages.');
  const { doc, revision } = await loadDocument(projectId);
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { workspaceId: true } });
  const assetRows = await prisma.asset.findMany({ where: { workspaceId: project.workspaceId, mimeType: { startsWith: 'image/' } }, select: { id: true, widthPx: true, heightPx: true, mimeType: true, createdAt: true } });
  const key = `${projectId}:${revision}:${format.updatedAt.getTime()}:${assetRows.length}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return { layout: hit, revision };
  }
  const assets: Record<string, AssetInfo> = {};
  for (const a of assetRows) if (a.widthPx && a.heightPx) assets[a.id] = { widthPx: a.widthPx, heightPx: a.heightPx, mimeType: a.mimeType };
  const layout = layoutDocument(doc, {
    format: { format: format.format as 'PAPERBACK' | 'HARDCOVER', trimId: format.trimId, ink: format.ink as never, paper: format.paper as never, bleed: format.bleed },
    direction: format.direction as 'LTR' | 'RTL',
    assets,
  });
  cache.set(key, layout);
  while (cache.size > MAX) cache.delete(cache.keys().next().value!);
  return { layout, revision };
}

/** Small byte-bounded LRU for rendered preview PNGs. */
class PngCache {
  private m = new Map<string, Uint8Array>();
  private bytes = 0;
  constructor(private maxBytes = 64 * 1024 * 1024) {}
  get(k: string) {
    const v = this.m.get(k);
    if (v) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: Uint8Array) {
    this.m.set(k, v);
    this.bytes += v.byteLength;
    while (this.bytes > this.maxBytes && this.m.size > 1) {
      const [oldK, oldV] = this.m.entries().next().value!;
      this.m.delete(oldK);
      this.bytes -= oldV.byteLength;
    }
  }
}
export const pngCache = new PngCache();

/** data: URIs for the images used on a page (workspace-scoped). */
export async function pageAssetDataUris(workspaceId: string, page: LaidOutPage): Promise<Record<string, string>> {
  const ids = [...new Set(page.ops.filter((o) => o.op === 'image').map((o) => (o as { assetId: string }).assetId))];
  if (!ids.length) return {};
  const rows = await prisma.asset.findMany({ where: { workspaceId, id: { in: ids } } });
  const out: Record<string, string> = {};
  for (const a of rows) out[a.id] = `data:${a.mimeType};base64,${Buffer.from(await getStorage().get(a.storageKey)).toString('base64')}`;
  return out;
}
