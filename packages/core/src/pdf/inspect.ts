import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, type PDFObject } from 'pdf-lib';
import { ptToIn, round } from '../units';

export interface InspectedFont {
  name: string;
  subtype: string;
  embedded: boolean;
}

export interface InspectedPage {
  index: number;
  mediaBoxIn: { w: number; h: number };
  trimBoxIn: { x: number; y: number; w: number; h: number } | null;
  bleedBoxIn: { x: number; y: number; w: number; h: number } | null;
  rotation: number;
  fonts: InspectedFont[];
  images: { name: string; widthPx: number; heightPx: number }[];
  hasAnnotations: boolean;
}

export interface PdfInspection {
  ok: boolean;
  error?: string;
  encrypted: boolean;
  pageCount: number;
  fileSizeBytes: number;
  pdfVersion: string | null;
  pages: InspectedPage[];
  /** Unique fonts across the document. */
  fonts: InspectedFont[];
  allFontsEmbedded: boolean;
  hasJavaScript: boolean;
}

function box(page: PDFDict, name: string): { x: number; y: number; w: number; h: number } | null {
  const arr = page.lookup(PDFName.of(name));
  if (!(arr instanceof PDFArray)) return null;
  const n = arr.asArray().map((o) => Number((o as unknown as { asNumber(): number }).asNumber()));
  return { x: round(ptToIn(n[0])), y: round(ptToIn(n[1])), w: round(ptToIn(n[2] - n[0])), h: round(ptToIn(n[3] - n[1])) };
}

function fontEmbedded(font: PDFDict): boolean {
  const subtype = font.lookup(PDFName.of('Subtype'));
  if (subtype === PDFName.of('Type0')) {
    const desc = font.lookup(PDFName.of('DescendantFonts'));
    if (!(desc instanceof PDFArray)) return false;
    const d = desc.lookup(0);
    return d instanceof PDFDict ? fontEmbedded(d) : false;
  }
  if (subtype === PDFName.of('Type3')) return true; // glyphs defined inline
  const fd = font.lookup(PDFName.of('FontDescriptor'));
  if (!(fd instanceof PDFDict)) return false;
  return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.lookup(PDFName.of(k)) instanceof PDFStream);
}

/**
 * Structural inspection of a PDF: page boxes, font embedding, encryption, images.
 * Works on any PDF (ours or an uploaded manuscript/cover).
 */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 16));
  const versionMatch = header.match(/%PDF-(\d\.\d)/);
  const base: PdfInspection = {
    ok: false,
    encrypted: false,
    pageCount: 0,
    fileSizeBytes: bytes.byteLength,
    pdfVersion: versionMatch?.[1] ?? null,
    pages: [],
    fonts: [],
    allFontsEmbedded: false,
    hasJavaScript: false,
  };
  if (!versionMatch) return { ...base, error: 'Not a PDF file (missing %PDF header).' };
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: true });
  } catch (e) {
    return { ...base, error: `PDF could not be parsed: ${(e as Error).message}` };
  }
  const encrypted = doc.isEncrypted;
  const fontMap = new Map<string, InspectedFont>();
  const pages: InspectedPage[] = doc.getPages().map((p, index) => {
    const node = p.node;
    const media = box(node, 'MediaBox') ?? { x: 0, y: 0, w: round(ptToIn(p.getWidth())), h: round(ptToIn(p.getHeight())) };
    const fonts: InspectedFont[] = [];
    const images: InspectedPage['images'] = [];
    const res = node.Resources();
    const fontDict = res?.lookup(PDFName.of('Font'));
    if (fontDict instanceof PDFDict) {
      for (const [, ref] of fontDict.entries()) {
        const f = (ref instanceof PDFRef ? doc.context.lookup(ref) : ref) as PDFObject;
        if (!(f instanceof PDFDict)) continue;
        const name = String(f.lookup(PDFName.of('BaseFont')) ?? 'unknown').replace(/^\//, '');
        const subtype = String(f.lookup(PDFName.of('Subtype')) ?? '').replace(/^\//, '');
        const info = { name, subtype, embedded: fontEmbedded(f) };
        fonts.push(info);
        fontMap.set(name + subtype, info);
      }
    }
    const xo = res?.lookup(PDFName.of('XObject'));
    if (xo instanceof PDFDict) {
      for (const [key, ref] of xo.entries()) {
        const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
        if (s instanceof PDFStream && s.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) {
          images.push({
            name: key.toString(),
            widthPx: Number(String(s.dict.lookup(PDFName.of('Width')))),
            heightPx: Number(String(s.dict.lookup(PDFName.of('Height')))),
          });
        }
      }
    }
    return {
      index,
      mediaBoxIn: { w: media.w, h: media.h },
      trimBoxIn: box(node, 'TrimBox'),
      bleedBoxIn: box(node, 'BleedBox'),
      rotation: p.getRotation().angle,
      fonts,
      images,
      hasAnnotations: (() => {
        const a = node.lookup(PDFName.of('Annots'));
        return a instanceof PDFArray && a.size() > 0;
      })(),
    };
  });
  const catalog = doc.catalog;
  const names = catalog.lookup(PDFName.of('Names'));
  const hasJavaScript = names instanceof PDFDict && names.lookup(PDFName.of('JavaScript')) !== undefined || catalog.lookup(PDFName.of('OpenAction')) !== undefined;
  const fonts = [...fontMap.values()];
  return {
    ...base,
    ok: true,
    encrypted,
    pageCount: pages.length,
    pages,
    fonts,
    allFontsEmbedded: fonts.every((f) => f.embedded),
    hasJavaScript,
  };
}
