import { computeCoverGeometry, ebookCoverGeometry, type CoverGeometry, type OfficialCoverGeometry } from './cover/geometry';
import { layoutCover, type CoverLayout } from './cover/layout';
import { imageSize, rasterizeSvg } from './cover/raster';
import { CoverDesign, type CoverDesignInput } from './cover/schema';
import { renderCoverSvg } from './cover/svg';
import { buildEpub, inspectEpub } from './export/epub';
import { layoutDocument, type AssetInfo, type LayoutResult } from './interior/layout';
import { InteriorDocument, type InteriorDocumentInput } from './interior/schema';
import { getTemplate } from './interior/templates';
import { MetadataDraft, type MetadataDraftInput } from './metadata';
import { renderCoverPdf } from './pdf/cover';
import { inspectPdf, type PdfInspection } from './pdf/inspect';
import { renderInteriorPdf } from './pdf/interior';
import { interiorFingerprint, type InteriorFingerprint } from './similarity';
import { defaultSpecSource, type SpecSource } from './specs/engine';
import type { BookFormat, InkType, PaperType, ReadingDirection } from './specs/types';
import { runPreflight } from './validation/run';
import type { CheckResult, ContentClass, EpubInspection, PreflightContext, PreflightReport } from './validation/types';

export interface PipelineAsset {
  bytes: Uint8Array;
  mimeType: string;
  source: 'UPLOAD' | 'AI' | 'SYSTEM';
  licenseNote?: string;
}

export interface ProductInput {
  projectId: string;
  format: BookFormat;
  trimId: string;
  ink: InkType;
  paper: PaperType;
  bleed: boolean;
  direction?: ReadingDirection;
  contentClass: ContentClass;
  category?: string;
  document: InteriorDocumentInput | InteriorDocument;
  cover?: CoverDesignInput | CoverDesign | null;
  officialCover?: OfficialCoverGeometry | null;
  metadata: MetadataDraftInput | MetadataDraft;
  assets?: Record<string, PipelineAsset>;
  portfolio?: PreflightContext['portfolio'];
  ai?: PreflightContext['ai'];
  reviews?: Record<string, NonNullable<CheckResult['review']>>;
  date?: Date;
}

export interface ProductBuild {
  layout?: LayoutResult;
  interiorPdf?: Uint8Array;
  interiorInspection?: PdfInspection;
  coverGeometry?: CoverGeometry;
  coverLayout?: CoverLayout;
  coverPdf?: Uint8Array;
  coverSvg?: string;
  coverInspection?: PdfInspection;
  ebookCoverPng?: Uint8Array;
  epub?: Uint8Array;
  epubInspection?: EpubInspection;
  fingerprint: InteriorFingerprint;
  interiorText: string;
  preflight: PreflightReport;
}

export interface PipelineOptions {
  renderInterior?: boolean;
  renderCover?: boolean;
  renderEpub?: boolean;
  specSource?: SpecSource;
  specVersion?: string;
  now?: Date;
}

/** Plain text of a document without layout (eBooks and similarity). */
export function documentText(input: InteriorDocumentInput | InteriorDocument): string {
  const doc = InteriorDocument.parse(input);
  const out: string[] = [];
  const pageText = (inst: InteriorDocument['frontMatter'][number]) => {
    const tpl = inst.templateId ? getTemplate(inst.templateId, doc.templates) : undefined;
    const els = inst.elements ?? tpl?.elements ?? [];
    for (const v of Object.values(inst.fields)) if (typeof v === 'string') out.push(v);
    const walk = (e: (typeof els)[number]): void => {
      if (e.type === 'heading' || e.type === 'text') out.push(e.text.replace(/\{\{[^}]+\}\}/g, ''));
      if (e.type === 'columns') e.columns.forEach((c) => c.elements.forEach(walk));
    };
    els.forEach(walk);
  };
  doc.frontMatter.forEach(pageText);
  if (doc.body.kind === 'flow') {
    for (const ch of doc.body.chapters) {
      out.push(ch.title);
      for (const b of ch.blocks) {
        if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'quote') out.push(b.text);
        if (b.type === 'list') out.push(...b.items);
        if (b.type === 'image' && b.caption) out.push(b.caption);
      }
      out.push(...ch.notes);
    }
  } else doc.body.pages.forEach(pageText);
  doc.backMatter.forEach(pageText);
  return out.join('\n');
}

/**
 * Deterministic build: lay out the interior, render and inspect PDFs, compute cover geometry
 * from the *final* page count, render the cover, optionally build an EPUB, then preflight.
 */
export async function runPipeline(input: ProductInput, opts: PipelineOptions = {}): Promise<ProductBuild> {
  const source = opts.specSource ?? defaultSpecSource;
  const lib = source.getLibrary(opts.specVersion);
  const doc = InteriorDocument.parse(input.document);
  const metadata = MetadataDraft.parse(input.metadata);
  const assets = input.assets ?? {};
  const assetInfo: Record<string, AssetInfo> = {};
  for (const [id, a] of Object.entries(assets)) {
    const size = imageSize(a.bytes);
    if (size) assetInfo[id] = { widthPx: size.widthPx, heightPx: size.heightPx, mimeType: size.mimeType };
  }
  const resolver = (id: string) => (assets[id] ? { bytes: assets[id].bytes, mimeType: assets[id].mimeType } : undefined);
  const build: Partial<ProductBuild> = {};
  const isPrint = input.format !== 'EBOOK';
  const pdfTitle = metadata.title || doc.settings.title;
  const pdfAuthor = metadata.author || doc.settings.author;

  if (isPrint) {
    build.layout = layoutDocument(doc, {
      format: { format: input.format as 'PAPERBACK' | 'HARDCOVER', trimId: input.trimId, ink: input.ink, paper: input.paper, bleed: input.bleed },
      direction: input.direction,
      assets: assetInfo,
      specSource: source,
      specVersion: opts.specVersion,
    });
    if (opts.renderInterior !== false) {
      build.interiorPdf = await renderInteriorPdf(build.layout, { title: pdfTitle, author: pdfAuthor, assets: resolver, date: input.date });
      build.interiorInspection = await inspectPdf(build.interiorPdf);
    }
  }

  const interiorText = build.layout ? build.layout.pages.map((p) => p.textContent).join('\n') : documentText(doc);
  build.interiorText = interiorText;
  build.fingerprint = build.layout
    ? interiorFingerprint(build.layout.pages.map((p) => ({ text: p.textContent, structureKey: p.source.templateId ?? (p.source.chapterId ? 'chapter' : p.isBlank ? 'blank' : 'custom') })))
    : interiorFingerprint(interiorText.split(/\n{2,}|\n/).map((t) => ({ text: t, structureKey: 'flow' })));

  let coverCtx: PreflightContext['cover'];
  if (input.cover) {
    const design = CoverDesign.parse(input.cover);
    const geom =
      input.format === 'EBOOK'
        ? ebookCoverGeometry(source, opts.specVersion)
        : computeCoverGeometry(
            { format: input.format, trimId: input.trimId, pageCount: build.layout!.pageCount, ink: input.ink, paper: input.paper, direction: input.direction, official: input.officialCover ?? null },
            source,
            opts.specVersion,
          );
    const cl = layoutCover(design, geom, assetInfo, lib.files.minImageDpi);
    build.coverGeometry = geom;
    build.coverLayout = cl;
    coverCtx = { design, geometry: geom, layout: cl };
    if (opts.renderCover !== false && geom.widthIn > 0) {
      const toDataUri = (id: string) => (assets[id] ? `data:${assets[id].mimeType};base64,${Buffer.from(assets[id].bytes).toString('base64')}` : undefined);
      build.coverSvg = renderCoverSvg(cl, { embedFonts: true, assetHref: toDataUri });
      if (input.format === 'EBOOK') {
        build.ebookCoverPng = rasterizeSvg(renderCoverSvg(cl, { assetHref: toDataUri }), lib.ebook.coverIdealWidthPx);
        const s = imageSize(build.ebookCoverPng)!;
        coverCtx.coverImagePx = { widthPx: s.widthPx, heightPx: s.heightPx };
      } else {
        build.coverPdf = await renderCoverPdf(cl, { title: pdfTitle, author: pdfAuthor, assets: resolver, date: input.date });
        build.coverInspection = await inspectPdf(build.coverPdf);
        coverCtx.pdf = build.coverInspection;
      }
    }
  }

  if (input.format === 'EBOOK' && opts.renderEpub !== false) {
    build.epub = await buildEpub({
      document: doc,
      title: metadata.title || doc.settings.title,
      subtitle: metadata.subtitle,
      author: metadata.author || doc.settings.author,
      language: metadata.language,
      description: metadata.description,
      identifier: input.projectId,
      isbn: metadata.isbn || undefined,
      coverPng: build.ebookCoverPng,
      assets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, { bytes: v.bytes, mimeType: v.mimeType }])),
      rtl: input.direction === 'RTL',
      modified: input.date,
    });
    build.epubInspection = await inspectEpub(build.epub);
  }

  build.preflight = runPreflight(
    {
      format: input.format,
      contentClass: input.contentClass,
      category: input.category,
      spec: lib,
      interior: build.layout ? { layout: build.layout, pdf: build.interiorInspection } : undefined,
      cover: coverCtx,
      ebook: input.format === 'EBOOK' ? { epub: build.epubInspection, text: interiorText } : undefined,
      metadata,
      interiorText,
      portfolio: input.portfolio,
      fingerprint: build.fingerprint,
      ai: input.ai,
      assets: Object.entries(assets).map(([assetId, a]) => ({ assetId, source: a.source, licenseNote: a.licenseNote ?? '' })),
      reviews: input.reviews,
    },
    { now: opts.now },
  );
  return build as ProductBuild;
}
