import { z } from 'zod';

export const BookFormat = z.enum(['PAPERBACK', 'HARDCOVER', 'EBOOK']);
export type BookFormat = z.infer<typeof BookFormat>;

export const InkType = z.enum(['BLACK_WHITE', 'STANDARD_COLOR', 'PREMIUM_COLOR']);
export type InkType = z.infer<typeof InkType>;

export const PaperType = z.enum(['WHITE', 'CREAM']);
export type PaperType = z.infer<typeof PaperType>;

export const CoverFinish = z.enum(['GLOSSY', 'MATTE']);
export type CoverFinish = z.infer<typeof CoverFinish>;

export const ReadingDirection = z.enum(['LTR', 'RTL']);
export type ReadingDirection = z.infer<typeof ReadingDirection>;

/**
 * How confident we are that a value matches the current official KDP requirement.
 *
 * - OFFICIAL_TEMPLATE: taken from an official KDP calculator output / template the user imported.
 * - CORROBORATED: matches the published KDP help pages as quoted by multiple independent sources
 *   at `lastVerified`. Still re-verify periodically — KDP changes requirements.
 * - UNVERIFIED: maintainer default that could not be verified. Never treated as authoritative:
 *   checks that depend on it report NEEDS_HUMAN_REVIEW.
 */
export const VerificationStatus = z.enum(['OFFICIAL_TEMPLATE', 'CORROBORATED', 'UNVERIFIED']);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const Verification = z.object({
  status: VerificationStatus,
  source: z.string(),
  lastVerified: z.string(),
  note: z.string().optional(),
});
export type Verification = z.infer<typeof Verification>;

export const TrimSizeSpec = z.object({
  id: z.string(),
  label: z.string(),
  widthIn: z.number().positive(),
  heightIn: z.number().positive(),
  formats: z.array(z.enum(['PAPERBACK', 'HARDCOVER'])),
  verification: Verification,
});
export type TrimSizeSpec = z.infer<typeof TrimSizeSpec>;

export const GutterRule = z.object({
  minPages: z.number().int(),
  maxPages: z.number().int(),
  insideIn: z.number(),
});

export const PageCountLimit = z.object({
  format: z.enum(['PAPERBACK', 'HARDCOVER']),
  ink: InkType.or(z.literal('ANY')),
  paper: PaperType.or(z.literal('ANY')),
  trimClass: z.enum(['STANDARD', 'LARGE', 'ANY']),
  minPages: z.number().int(),
  maxPages: z.number().int(),
  verification: Verification,
});
export type PageCountLimit = z.infer<typeof PageCountLimit>;

export const SpineRule = z.object({
  ink: InkType,
  paper: PaperType,
  inchesPerPage: z.number(),
  verification: Verification,
});
export type SpineRule = z.infer<typeof SpineRule>;

export const InteriorRules = z.object({
  bleed: z.object({ outsideIn: z.number(), topIn: z.number(), bottomIn: z.number(), insideIn: z.number() }),
  gutterTable: z.array(GutterRule),
  minOutsideMarginNoBleedIn: z.number(),
  minOutsideMarginBleedIn: z.number(),
  verification: Verification,
});
export type InteriorRules = z.infer<typeof InteriorRules>;

export const SpecLibrary = z.object({
  version: z.string(),
  effectiveDate: z.string(),
  description: z.string(),
  /** Width > this OR height > largeTrimHeightIn => "large trim". */
  largeTrimWidthIn: z.number(),
  largeTrimHeightIn: z.number(),
  trimSizes: z.array(TrimSizeSpec),
  interior: z.object({ PAPERBACK: InteriorRules, HARDCOVER: InteriorRules }),
  pageCountLimits: z.array(PageCountLimit),
  spine: z.array(SpineRule),
  paperbackCover: z.object({
    bleedIn: z.number(),
    safeMarginIn: z.number(),
    spineTextMinPages: z.number().int(),
    spineSafeMarginIn: z.number(),
    barcode: z.object({
      widthIn: z.number(),
      heightIn: z.number(),
      offsetFromSpineIn: z.number(),
      offsetFromBottomIn: z.number(),
      verification: Verification,
    }),
    verification: Verification,
  }),
  hardcoverCover: z.object({
    /** Hardcover cover geometry is NOT formula-derived here; it must come from KDP's calculator/template. */
    requiresOfficialGeometry: z.literal(true),
    defaultWrapIn: z.number(),
    defaultHingeIn: z.number(),
    spineTextMinPages: z.number().int(),
    verification: Verification,
  }),
  ebook: z.object({
    coverIdealWidthPx: z.number().int(),
    coverIdealHeightPx: z.number().int(),
    coverMinWidthPx: z.number().int(),
    coverMinHeightPx: z.number().int(),
    coverMaxFileMb: z.number(),
    verification: Verification,
  }),
  files: z.object({
    interiorMaxMb: z.number(),
    coverMaxMb: z.number(),
    minImageDpi: z.number(),
    verification: Verification,
  }),
});
export type SpecLibrary = z.infer<typeof SpecLibrary>;
