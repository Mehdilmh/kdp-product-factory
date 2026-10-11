import { createHash } from 'node:crypto';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, grayscale, rgb, type Color, type PDFFont, type PDFImage } from 'pdf-lib';
import { FONT_FILES, NO_LIGATURES, fontBytes, type FontKey } from '../fonts/registry';

/** Fixed timestamp keeps output byte-identical for identical input. */
export const DEFAULT_PDF_DATE = new Date('2020-01-01T00:00:00Z');

export interface AssetBytes {
  bytes: Uint8Array;
  mimeType: string;
}
export type AssetResolver = (assetId: string) => AssetBytes | undefined | Promise<AssetBytes | undefined>;

export function hexToColor(hex: string, gray: boolean): Color {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  if (gray) return grayscale(Math.round((0.299 * r + 0.587 * g + 0.114 * b) * 1000) / 1000);
  return rgb(r, g, b);
}

export async function createDoc(meta: { title?: string; author?: string; subject?: string; date?: Date }) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const date = meta.date ?? DEFAULT_PDF_DATE;
  doc.setTitle(meta.title || 'Untitled', { showInWindowTitleBar: false });
  if (meta.author) doc.setAuthor(meta.author);
  if (meta.subject) doc.setSubject(meta.subject);
  doc.setCreator('KDP Product Factory');
  doc.setProducer('KDP Product Factory (pdf-lib)');
  doc.setCreationDate(date);
  doc.setModificationDate(date);
  return doc;
}

export class FontCache {
  private fonts = new Map<FontKey, PDFFont>();
  constructor(private doc: PDFDocument) {}
  async get(key: FontKey): Promise<PDFFont> {
    let f = this.fonts.get(key);
    if (!f) {
      // Full embedding: pdf-lib's fontkit subsetter drops glyphs from some TrueType fonts
      // (observed with Carlito), which would silently corrupt printed text.
      const name = FONT_FILES[key].replace(/\.ttf$/, '');
      f = await this.doc.embedFont(fontBytes(key), { subset: false, customName: name, features: NO_LIGATURES });
      this.fonts.set(key, f);
    }
    return f;
  }
}

export class ImageCache {
  private images = new Map<string, PDFImage | null>();
  constructor(
    private doc: PDFDocument,
    private resolve: AssetResolver,
  ) {}
  async get(assetId: string): Promise<PDFImage | null> {
    if (this.images.has(assetId)) return this.images.get(assetId)!;
    const a = await this.resolve(assetId);
    let img: PDFImage | null = null;
    if (a) {
      if (a.mimeType === 'image/png') img = await this.doc.embedPng(a.bytes);
      else if (a.mimeType === 'image/jpeg') img = await this.doc.embedJpg(a.bytes);
    }
    this.images.set(assetId, img);
    return img;
  }
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
