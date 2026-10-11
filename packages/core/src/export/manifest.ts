import { sha256 } from '../pdf/common';

export interface ManifestFile {
  filename: string;
  kind: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

export interface ExportManifest {
  manifestVersion: 1;
  generator: string;
  generatedAt: string;
  project: { id: string; title: string; version: number };
  format: string;
  specVersion: string;
  rulesetVersion: string | null;
  trimSize: string | null;
  pageCount: number | null;
  validationStatus: 'PASSED' | 'PASSED_WITH_WARNINGS' | 'NEEDS_REVIEW' | 'BLOCKED' | 'NOT_RUN';
  files: ManifestFile[];
  notice: string;
}

export function manifestFile(filename: string, kind: string, contentType: string, data: Uint8Array | string): ManifestFile {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return { filename, kind, contentType, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

export function buildManifest(input: Omit<ExportManifest, 'manifestVersion' | 'generator' | 'notice'>): ExportManifest {
  return {
    manifestVersion: 1,
    generator: 'KDP Product Factory',
    ...input,
    files: [...input.files].sort((a, b) => a.filename.localeCompare(b.filename)),
    notice: 'Checksums are SHA-256. Validation status reflects automated preflight only and is not a guarantee of KDP acceptance.',
  };
}
