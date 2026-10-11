import type { CoverDesign } from '../cover/schema';
import type { CoverGeometry } from '../cover/geometry';
import type { CoverLayout } from '../cover/layout';
import type { LayoutResult } from '../interior/layout';
import type { MetadataDraft } from '../metadata';
import type { PdfInspection } from '../pdf/inspect';
import type { InteriorFingerprint } from '../similarity';
import type { BookFormat, SpecLibrary } from '../specs/types';
import type { CheckResult, CheckStatus, ContentClass, PreflightReport, Severity } from './result-types';
export type { CheckResult, CheckStatus, ContentClass, PreflightReport, Severity };

export interface EpubInspection {
  ok: boolean;
  errors: string[];
  chapterCount: number;
  hasNav: boolean;
  hasCover: boolean;
  fileSizeBytes: number;
}

export interface PreflightContext {
  format: BookFormat;
  contentClass: ContentClass;
  category?: string;
  spec: SpecLibrary;
  interior?: { layout: LayoutResult; pdf?: PdfInspection };
  cover?: { design: CoverDesign; geometry: CoverGeometry; layout: CoverLayout; pdf?: PdfInspection; coverImagePx?: { widthPx: number; heightPx: number } };
  ebook?: { epub?: EpubInspection; text: string };
  metadata?: MetadataDraft;
  /** All interior text (for content checks). */
  interiorText?: string;
  portfolio?: { projectId: string; title: string; fingerprint?: InteriorFingerprint | null }[];
  fingerprint?: InteriorFingerprint;
  ai?: { textGenerated: boolean; imagesGenerated: boolean; disclosureAcknowledged: boolean };
  assets?: { assetId: string; source: 'UPLOAD' | 'AI' | 'SYSTEM'; licenseNote: string }[];
  reviews?: Record<string, NonNullable<CheckResult['review']>>;
}

export interface RuleOutcome {
  status: CheckStatus;
  evidence: string;
  suggestion?: string;
}

export interface RuleDefinition {
  id: string;
  version: number;
  title: string;
  description: string;
  category: CheckResult['category'];
  severity: Severity;
  appliesTo: (BookFormat | 'ALL')[];
  /** Blocking applies only when the outcome is FAIL. */
  blocking: boolean;
  source: string;
  sourceVerification: CheckResult['sourceVerification'];
  lastVerified: string;
  defaultSuggestion: string;
  check(ctx: PreflightContext): RuleOutcome;
}

export const PREFLIGHT_DISCLAIMER =
  'This preflight reduces risk but is not a guarantee of KDP acceptance, sales, or policy compliance. KDP requirements change; verify against current KDP documentation and review all NEEDS HUMAN REVIEW items before publishing.';
