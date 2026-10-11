import {
  buildDocx,
  buildEpub,
  buildManifest,
  keywordEvidenceCsv,
  manifestFile,
  metadataToCsv,
  metadataToJson,
  renderInteriorPdf,
  renderCoverSvg,
  reportToHtml,
  RULESET_VERSION,
  sha256,
  type ManifestFile,
} from '@kdp/core';
import type { Project } from '@prisma/client';
import JSZip from 'jszip';
import { z } from 'zod';
import { prisma } from '../db';
import { conflict } from '../lib/errors';
import { getStorage } from '../lib/storage';
import { buildAndValidate, currentMetadata, pendingReviewIds } from './build';
import { coloringExportFiles } from './coloring';
import { loadDocument } from './interior';
import { snapshotProject } from './versions';

export const EXPORT_KINDS = [
  'INTERIOR_PDF',
  'COVER_PDF',
  'COVER_SVG',
  'INTERIOR_PROOF_PDF',
  'VALIDATION_REPORT',
  'PROJECT_JSON',
  'TEMPLATES_JSON',
  'ASSETS_ZIP',
  'DOCX',
  'EPUB',
  'EBOOK_COVER_PNG',
  'METADATA_CSV',
  'METADATA_JSON',
  'KEYWORDS_CSV',
  'COLORING_PAGES_ZIP',
  'COLORING_PROMPT_LOG',
  'COLORING_QC_REPORT',
] as const;
export const ExportKind = z.enum(EXPORT_KINDS);
export type ExportKind = z.infer<typeof ExportKind>;

/** Final publishing files: gated on technical preflight, human review, and (batch) approval. */
export const FINAL_KINDS: ExportKind[] = ['INTERIOR_PDF', 'COVER_PDF', 'EPUB', 'EBOOK_COVER_PNG'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'book';

export interface ExportResult {
  bundleId: string;
  validationStatus: string;
  files: ManifestFile[];
}

export async function createExport(project: Project, kinds: ExportKind[], log: (m: string) => void = () => {}): Promise<ExportResult> {
  const wantsFinal = kinds.some((k) => FINAL_KINDS.includes(k));
  if (wantsFinal) {
    const item = await prisma.batchItem.findUnique({ where: { projectId: project.id } });
    if (item && item.status !== 'APPROVED') throw conflict('This batch product needs manual approval before final export.', { batchItemId: item.id, status: item.status });
  }

  log('Building and validating…');
  const { build, input } = await buildAndValidate(project);
  const pf = build.preflight;
  if (wantsFinal && pf.blocked) throw conflict('Export blocked by technical preflight failures.', { blockingRuleIds: pf.blockingRuleIds });
  const pending = pendingReviewIds(pf);
  if (wantsFinal && pending.length) throw conflict('Review the items marked NEEDS HUMAN REVIEW before final export.', { pendingReviews: pending });
  if (kinds.includes('COVER_PDF') && !build.coverPdf) throw conflict('No print cover is available. Design a cover first (and for hardcover, enter official template values).');
  if (kinds.includes('EPUB') && !build.epub) throw conflict('EPUB export applies to Kindle eBook projects.');

  const validationStatus = pf.blocked ? 'BLOCKED' : pending.length ? 'NEEDS_REVIEW' : pf.summary.WARNING + pf.summary.FAIL > 0 ? 'PASSED_WITH_WARNINGS' : 'PASSED';
  const { data: md } = await currentMetadata(project.id);
  const { doc } = await loadDocument(project.id);
  const base = slug(md.title || project.title);
  const files: { name: string; kind: string; type: string; data: Uint8Array | string }[] = [];
  const add = (name: string, kind: string, type: string, data: Uint8Array | string) => files.push({ name, kind, type, data });

  let coloring: Awaited<ReturnType<typeof coloringExportFiles>> | undefined;
  for (const k of kinds) {
    log(`Exporting ${k}…`);
    switch (k) {
      case 'INTERIOR_PDF':
        if (build.interiorPdf) add(`${base}-interior.pdf`, k, 'application/pdf', build.interiorPdf);
        break;
      case 'INTERIOR_PROOF_PDF':
        if (build.layout) add(`${base}-interior-PROOF-not-for-upload.pdf`, k, 'application/pdf', await renderInteriorPdf(build.layout, { title: md.title, author: md.author, guides: true, assets: (id) => input.assets?.[id] }));
        break;
      case 'COVER_PDF':
        if (build.coverPdf) add(`${base}-cover-${input.format.toLowerCase()}.pdf`, k, 'application/pdf', build.coverPdf);
        break;
      case 'COVER_SVG':
        if (build.coverSvg) add(`${base}-cover-editable.svg`, k, 'image/svg+xml', build.coverSvg);
        else if (build.coverLayout) add(`${base}-cover-editable.svg`, k, 'image/svg+xml', renderCoverSvg(build.coverLayout, { embedFonts: true }));
        break;
      case 'EBOOK_COVER_PNG':
        if (build.ebookCoverPng) add(`${base}-ebook-cover.png`, k, 'image/png', build.ebookCoverPng);
        break;
      case 'EPUB':
        if (build.epub) add(`${base}.epub`, k, 'application/epub+zip', build.epub);
        break;
      case 'VALIDATION_REPORT':
        add(`${base}-preflight.json`, k, 'application/json', JSON.stringify(pf, null, 2));
        add(`${base}-preflight.html`, k, 'text/html', reportToHtml(pf, md.title || project.title));
        break;
      case 'PROJECT_JSON': {
        const snap = await snapshotProject(project.id);
        add(`${base}-project.json`, k, 'application/json', JSON.stringify({ kind: 'kdp-factory-project', schemaVersion: 1, ...snap }, null, 2));
        break;
      }
      case 'TEMPLATES_JSON': {
        const used = new Set([...doc.frontMatter, ...(doc.body.kind === 'pages' ? doc.body.pages : []), ...doc.backMatter].map((p) => p.templateId).filter(Boolean));
        const { BUILT_IN_TEMPLATES } = await import('@kdp/core');
        const tpls = [...doc.templates, ...BUILT_IN_TEMPLATES.filter((t) => used.has(t.id))];
        add(`${base}-templates.json`, k, 'application/json', JSON.stringify({ kind: 'kdp-factory-templates', schemaVersion: 1, templates: tpls }, null, 2));
        break;
      }
      case 'ASSETS_ZIP': {
        const zip = new JSZip();
        const assets = await prisma.asset.findMany({ where: { workspaceId: project.workspaceId, projectId: project.id } });
        const storage = getStorage();
        for (const a of assets) zip.file(`assets/${a.id}-${a.filename.replace(/[^\w.-]/g, '_')}`, await storage.get(a.storageKey), { date: new Date('2020-01-01') });
        zip.file('design-metadata.json', JSON.stringify({ assets: assets.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, widthPx: a.widthPx, heightPx: a.heightPx, source: a.source, licenseNote: a.licenseNote, sha256: a.sha256 })), cover: input.cover, coverGeometry: build.coverGeometry ?? null }, null, 2), { date: new Date('2020-01-01') });
        add(`${base}-assets.zip`, k, 'application/zip', await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
        break;
      }
      case 'DOCX': {
        const trim = build.layout?.spec.trim ?? { widthIn: 6, heightIn: 9 };
        const margins = build.layout?.margins ?? { insideIn: 0.75, outsideIn: 0.5, topIn: 0.5, bottomIn: 0.5 };
        add(`${base}-manuscript.docx`, k, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', await buildDocx({ document: doc, title: md.title, author: md.author, trim, margins, assets: input.assets }));
        break;
      }
      case 'METADATA_CSV':
        add(`${base}-metadata.csv`, k, 'text/csv', metadataToCsv(md));
        break;
      case 'METADATA_JSON':
        add(`${base}-metadata.json`, k, 'application/json', metadataToJson(md, { projectId: project.id, format: input.format }));
        break;
      case 'KEYWORDS_CSV':
        add(`${base}-keyword-research.csv`, k, 'text/csv', keywordEvidenceCsv(md));
        break;
      case 'COLORING_PAGES_ZIP':
      case 'COLORING_PROMPT_LOG':
      case 'COLORING_QC_REPORT': {
        coloring ??= await coloringExportFiles(project.id);
        if (!coloring) throw conflict('Coloring exports apply to Coloring Studio projects.');
        if (k === 'COLORING_PAGES_ZIP') add(`${base}-coloring-pages.zip`, k, 'application/zip', coloring.pagesZip);
        if (k === 'COLORING_PROMPT_LOG') add(`${base}-prompt-log.csv`, k, 'text/csv', coloring.promptLog);
        if (k === 'COLORING_QC_REPORT') {
          add(`${base}-coloring-qc.json`, k, 'application/json', coloring.qcJson);
          add(`${base}-coloring-qc.html`, k, 'text/html', coloring.qcHtml);
        }
        break;
      }
    }
  }

  const bundleId = `b${Date.now().toString(36)}`;
  const storage = getStorage();
  const manifestFiles = files.map((f) => manifestFile(f.name, f.kind, f.type, f.data));
  const manifest = buildManifest({
    generatedAt: new Date().toISOString(),
    project: { id: project.id, title: md.title || project.title, version: project.currentVersion },
    format: input.format,
    specVersion: pf.specVersion,
    rulesetVersion: RULESET_VERSION,
    trimSize: input.format === 'EBOOK' ? null : input.trimId,
    pageCount: build.layout?.pageCount ?? null,
    validationStatus: validationStatus as 'PASSED',
    files: manifestFiles,
  });
  const manifestJson = JSON.stringify(manifest, null, 2);
  files.push({ name: 'manifest.json', kind: 'MANIFEST', type: 'application/json', data: manifestJson });
  const bundle = new JSZip();
  for (const f of files) bundle.file(f.name, f.data, { date: new Date('2020-01-01') });
  files.push({ name: `${base}-bundle.zip`, kind: 'BUNDLE_ZIP', type: 'application/zip', data: await bundle.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) });

  for (const f of files) {
    const bytes = typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data;
    const key = `ws/${project.workspaceId}/projects/${project.id}/exports/${bundleId}/${f.name}`;
    await storage.put(key, bytes, f.type);
    await prisma.exportArtifact.create({
      data: {
        projectId: project.id,
        bundleId,
        projectVersion: project.currentVersion,
        kind: f.kind,
        filename: f.name,
        mimeType: f.type,
        storageKey: key,
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        specVersion: pf.specVersion,
        rulesetVersion: RULESET_VERSION,
        pageCount: build.layout?.pageCount ?? null,
        trimSize: input.format === 'EBOOK' ? null : input.trimId,
        validationStatus,
      },
    });
  }
  if (wantsFinal) await prisma.project.update({ where: { id: project.id }, data: { status: 'EXPORTED' } });
  return { bundleId, validationStatus, files: manifestFiles };
}
