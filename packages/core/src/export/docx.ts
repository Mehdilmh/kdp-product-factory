import { AlignmentType, Document, HeadingLevel, ImageRun, PageBreak, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, convertInchesToTwip } from 'docx';
import { imageSize } from '../cover/raster';
import { interpolate } from '../interior/layout';
import type { FlowBlock, InteriorDocument, PageElement } from '../interior/schema';
import { InteriorDocument as InteriorDocumentSchema } from '../interior/schema';
import { getTemplate } from '../interior/templates';

export interface DocxInput {
  document: InteriorDocument | unknown;
  title: string;
  author: string;
  trim: { widthIn: number; heightIn: number };
  margins: { insideIn: number; outsideIn: number; topIn: number; bottomIn: number };
  assets?: Record<string, { bytes: Uint8Array; mimeType: string }>;
}

const FIXED = new Date('2020-01-01T00:00:00Z');

function runs(text: string, opts: { italic?: boolean; bold?: boolean } = {}): TextRun[] {
  // Footnote markers become superscript numbers in the editable manuscript.
  const parts = text.split(/(\[\^\d+\])/);
  return parts.filter(Boolean).map((p) => {
    const m = p.match(/^\[\^(\d+)\]$/);
    return m ? new TextRun({ text: m[1], superScript: true }) : new TextRun({ text: p, ...opts });
  });
}

function imagePara(bytes: Uint8Array, maxWidthIn: number): Paragraph | null {
  const size = imageSize(bytes);
  if (!size) return null;
  const w = Math.min(maxWidthIn * 96, size.widthPx);
  const h = (w * size.heightPx) / size.widthPx;
  return new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: size.mimeType === 'image/png' ? 'png' : 'jpg', data: bytes, transformation: { width: w, height: h } })] });
}

/** Editable DOCX manuscript (not a print master — the PDF is). */
export async function buildDocx(input: DocxInput): Promise<Uint8Array> {
  const doc = InteriorDocumentSchema.parse(input.document);
  const contentWidthIn = input.trim.widthIn - input.margins.insideIn - input.margins.outsideIn;
  const children: (Paragraph | Table)[] = [];
  const vars = { title: doc.settings.title || input.title, author: doc.settings.author || input.author };

  const elementBlocks = (el: PageElement, v: Record<string, string | number | boolean>): (Paragraph | Table)[] => {
    switch (el.type) {
      case 'heading': {
        const t = interpolate(el.text, v).trim();
        return t ? [new Paragraph({ heading: HeadingLevel.HEADING_2, alignment: el.style.align === 'center' ? AlignmentType.CENTER : undefined, children: [new TextRun(t)] })] : [];
      }
      case 'text': {
        const t = interpolate(el.text, v).trim();
        return t ? t.split(/\n+/).map((p) => new Paragraph({ children: runs(p, { italic: el.style.italic, bold: el.style.bold }) })) : [];
      }
      case 'fields':
        return [new Paragraph({ children: [new TextRun(el.fields.map((f) => `${interpolate(f.label, v)}: ____________`).join('    '))] })];
      case 'checklist': {
        const n = el.items.length || el.count || 5;
        return Array.from({ length: n }, (_, i) => new Paragraph({ children: [new TextRun(`☐ ${el.items[i] ? interpolate(el.items[i], v) : '______________________'}`)] }));
      }
      case 'table': {
        const rows = Math.max(el.rows || 8, el.cells.length);
        return [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: el.columns.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: interpolate(c.header, v), bold: true })] })] })) }),
              ...Array.from({ length: rows }, (_, r) => new TableRow({ children: el.columns.map((_, c) => new TableCell({ children: [new Paragraph(interpolate(el.cells[r]?.[c] ?? '', v))] })) })),
            ],
          }),
        ];
      }
      case 'lines':
        return Array.from({ length: 8 }, () => new Paragraph({ children: [new TextRun('_'.repeat(60))] }));
      case 'box': {
        const l = interpolate(el.label, v).trim();
        return l ? [new Paragraph({ children: [new TextRun({ text: l, bold: true })] })] : [];
      }
      case 'image': {
        const a = input.assets?.[el.assetId];
        const p = a ? imagePara(a.bytes, contentWidthIn) : null;
        return p ? [p] : [];
      }
      case 'columns':
        return el.columns.flatMap((c) => c.elements.flatMap((e) => elementBlocks(e, v)));
      default:
        return [];
    }
  };

  const flowBlock = (b: FlowBlock): Paragraph[] => {
    switch (b.type) {
      case 'paragraph':
        return b.text.split(/\n+/).map((p) => new Paragraph({ children: runs(p), indent: { firstLine: convertInchesToTwip(0.25) } }));
      case 'heading':
        return [new Paragraph({ heading: b.level === 2 ? HeadingLevel.HEADING_2 : b.level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4, children: [new TextRun(b.text)] })];
      case 'quote':
        return [new Paragraph({ indent: { left: convertInchesToTwip(0.4), right: convertInchesToTwip(0.4) }, children: runs(b.text, { italic: true }) })];
      case 'list':
        return b.items.map((it, i) => new Paragraph({ children: runs(`${b.ordered ? `${i + 1}.` : '•'} ${it}`) }));
      case 'sectionBreak':
        return [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('* * *')] })];
      case 'pageBreak':
        return [new Paragraph({ children: [new PageBreak()] })];
      case 'image': {
        const a = input.assets?.[b.assetId];
        const p = a ? imagePara(a.bytes, contentWidthIn * b.widthRatio) : null;
        return [...(p ? [p] : []), ...(b.caption ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: b.caption, italics: true })] })] : [])];
      }
    }
  };

  const pagesOut = (pages: InteriorDocument['frontMatter']) => {
    for (const inst of pages) {
      if (inst.templateId === 'toc') continue;
      const tpl = inst.templateId ? getTemplate(inst.templateId, doc.templates) : undefined;
      const v = { ...vars, ...Object.fromEntries((tpl?.fields ?? []).map((f) => [f.key, typeof f.default === 'string' ? interpolate(f.default, vars) : f.default])), ...inst.fields };
      for (const el of inst.elements ?? tpl?.elements ?? []) children.push(...elementBlocks(el, v));
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  };

  pagesOut(doc.frontMatter);
  if (doc.body.kind === 'flow') {
    for (const ch of doc.body.chapters) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, pageBreakBefore: true, children: [new TextRun(ch.title)] }));
      for (const b of ch.blocks) children.push(...flowBlock(b));
      if (ch.notes.length) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun('Notes')] }));
        ch.notes.forEach((n, i) => children.push(new Paragraph({ children: [new TextRun(`${i + 1}. ${n}`)] })));
      }
    }
  } else {
    pagesOut(doc.body.pages);
  }
  pagesOut(doc.backMatter);

  const d = new Document({
    creator: input.author,
    title: input.title,
    description: 'Editable manuscript exported by KDP Product Factory',
    sections: [
      {
        properties: {
          page: {
            size: { width: convertInchesToTwip(input.trim.widthIn), height: convertInchesToTwip(input.trim.heightIn) },
            margin: {
              top: convertInchesToTwip(input.margins.topIn),
              bottom: convertInchesToTwip(input.margins.bottomIn),
              left: convertInchesToTwip(input.margins.insideIn),
              right: convertInchesToTwip(input.margins.outsideIn),
            },
          },
        },
        children,
      },
    ],
  });
  const buf = await Packer.toBuffer(d);
  return normalizeZipDates(new Uint8Array(buf));
}

/** Rewrites docx timestamps so identical input yields identical bytes. */
async function normalizeZipDates(bytes: Uint8Array): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const out = new JSZip();
  for (const name of Object.keys(zip.files).sort()) {
    const f = zip.files[name];
    if (f.dir) continue;
    let content = await f.async('uint8array');
    if (name === 'docProps/core.xml') {
      const s = new TextDecoder().decode(content).replace(/(<dcterms:(created|modified)[^>]*>)[^<]*/g, `$1${FIXED.toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
      content = new TextEncoder().encode(s);
    }
    out.file(name, content, { date: FIXED, compression: 'DEFLATE' });
  }
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
