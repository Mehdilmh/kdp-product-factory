import type { SpecLibrary, Verification } from './types';

/**
 * Built-in KDP specification library, version 2026.10.1.
 *
 * Every value carries a verification record. The official KDP help pages could not be fetched
 * from the build environment on 2026-10-10, so values are marked CORROBORATED only where the
 * official page text was quoted consistently by independent sources; everything else is
 * UNVERIFIED and surfaces as NEEDS_HUMAN_REVIEW in preflight. Update this file (or add a new
 * version) when KDP publishes changes — the renderer never hardcodes these numbers.
 */
const D = '2026-10-10';

const coverHelp = 'https://kdp.amazon.com/en_US/help/topic/G201953020'; // Create a paperback cover
const interiorHelp = 'https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6'; // Set trim size, bleed, margins
const trimHelp = 'https://kdp.amazon.com/en_US/help/topic/G201834560'; // Trim size
const printOptionsHelp = 'https://kdp.amazon.com/en_US/help/topic/G201834180'; // Print options
const ebookCoverHelp = 'https://kdp.amazon.com/en_US/help/topic/G6GTK3T3NUHKLEFX'; // eBook cover

const corroborated = (source: string, note?: string): Verification => ({
  status: 'CORROBORATED',
  source,
  lastVerified: D,
  note,
});
const unverified = (source: string, note: string): Verification => ({
  status: 'UNVERIFIED',
  source,
  lastVerified: D,
  note,
});

const trimV = corroborated(trimHelp, 'Common KDP trim size.');
const trimU = unverified(trimHelp, 'Listed from maintainer knowledge; confirm availability for your ink/paper in KDP.');

export const KDP_SPEC_2026_10: SpecLibrary = {
  version: 'kdp-2026.10.1',
  effectiveDate: D,
  description:
    'KDP print & eBook specification defaults. Verify against KDP help pages and the official cover calculator before publishing.',
  largeTrimWidthIn: 6.12,
  largeTrimHeightIn: 9,
  trimSizes: [
    { id: '5x8', label: '5" × 8"', widthIn: 5, heightIn: 8, formats: ['PAPERBACK'], verification: trimU },
    { id: '5.06x7.81', label: '5.06" × 7.81"', widthIn: 5.06, heightIn: 7.81, formats: ['PAPERBACK'], verification: trimU },
    { id: '5.25x8', label: '5.25" × 8"', widthIn: 5.25, heightIn: 8, formats: ['PAPERBACK'], verification: trimU },
    { id: '5.5x8.5', label: '5.5" × 8.5"', widthIn: 5.5, heightIn: 8.5, formats: ['PAPERBACK', 'HARDCOVER'], verification: trimV },
    { id: '6x9', label: '6" × 9"', widthIn: 6, heightIn: 9, formats: ['PAPERBACK', 'HARDCOVER'], verification: trimV },
    { id: '6.14x9.21', label: '6.14" × 9.21"', widthIn: 6.14, heightIn: 9.21, formats: ['PAPERBACK', 'HARDCOVER'], verification: trimU },
    { id: '6.69x9.61', label: '6.69" × 9.61"', widthIn: 6.69, heightIn: 9.61, formats: ['PAPERBACK'], verification: trimU },
    { id: '7x10', label: '7" × 10"', widthIn: 7, heightIn: 10, formats: ['PAPERBACK', 'HARDCOVER'], verification: trimU },
    { id: '7.44x9.69', label: '7.44" × 9.69"', widthIn: 7.44, heightIn: 9.69, formats: ['PAPERBACK'], verification: trimU },
    { id: '7.5x9.25', label: '7.5" × 9.25"', widthIn: 7.5, heightIn: 9.25, formats: ['PAPERBACK'], verification: trimU },
    { id: '8x10', label: '8" × 10"', widthIn: 8, heightIn: 10, formats: ['PAPERBACK'], verification: trimU },
    { id: '8.25x6', label: '8.25" × 6" (landscape)', widthIn: 8.25, heightIn: 6, formats: ['PAPERBACK'], verification: trimU },
    { id: '8.25x8.25', label: '8.25" × 8.25"', widthIn: 8.25, heightIn: 8.25, formats: ['PAPERBACK'], verification: trimU },
    { id: '8.5x8.5', label: '8.5" × 8.5"', widthIn: 8.5, heightIn: 8.5, formats: ['PAPERBACK'], verification: trimU },
    { id: '8.5x11', label: '8.5" × 11"', widthIn: 8.5, heightIn: 11, formats: ['PAPERBACK'], verification: trimV },
    { id: '8.27x11.69', label: 'A4 8.27" × 11.69"', widthIn: 8.27, heightIn: 11.69, formats: ['PAPERBACK'], verification: trimU },
    { id: '8.25x11', label: '8.25" × 11"', widthIn: 8.25, heightIn: 11, formats: ['HARDCOVER'], verification: trimU },
  ],
  interior: {
    PAPERBACK: {
      bleed: { outsideIn: 0.125, topIn: 0.125, bottomIn: 0.125, insideIn: 0 },
      gutterTable: [
        { minPages: 24, maxPages: 150, insideIn: 0.375 },
        { minPages: 151, maxPages: 300, insideIn: 0.5 },
        { minPages: 301, maxPages: 500, insideIn: 0.625 },
        { minPages: 501, maxPages: 700, insideIn: 0.75 },
        { minPages: 701, maxPages: 828, insideIn: 0.875 },
      ],
      minOutsideMarginNoBleedIn: 0.25,
      minOutsideMarginBleedIn: 0.375,
      verification: corroborated(interiorHelp, 'Gutter tiers and outside minimums quoted consistently by independent guides.'),
    },
    HARDCOVER: {
      bleed: { outsideIn: 0.125, topIn: 0.125, bottomIn: 0.125, insideIn: 0 },
      gutterTable: [
        { minPages: 24, maxPages: 150, insideIn: 0.375 },
        { minPages: 151, maxPages: 300, insideIn: 0.5 },
        { minPages: 301, maxPages: 500, insideIn: 0.625 },
        { minPages: 501, maxPages: 700, insideIn: 0.75 },
      ],
      minOutsideMarginNoBleedIn: 0.25,
      minOutsideMarginBleedIn: 0.375,
      verification: unverified(interiorHelp, 'Assumes hardcover uses the paperback margin table. Confirm in KDP hardcover guidelines.'),
    },
  },
  pageCountLimits: [
    { format: 'PAPERBACK', ink: 'BLACK_WHITE', paper: 'WHITE', trimClass: 'STANDARD', minPages: 24, maxPages: 828, verification: corroborated(printOptionsHelp) },
    { format: 'PAPERBACK', ink: 'BLACK_WHITE', paper: 'CREAM', trimClass: 'STANDARD', minPages: 24, maxPages: 776, verification: corroborated(printOptionsHelp) },
    { format: 'PAPERBACK', ink: 'STANDARD_COLOR', paper: 'WHITE', trimClass: 'STANDARD', minPages: 72, maxPages: 600, verification: corroborated(printOptionsHelp) },
    { format: 'PAPERBACK', ink: 'PREMIUM_COLOR', paper: 'WHITE', trimClass: 'STANDARD', minPages: 24, maxPages: 828, verification: corroborated(printOptionsHelp) },
    { format: 'PAPERBACK', ink: 'BLACK_WHITE', paper: 'WHITE', trimClass: 'LARGE', minPages: 24, maxPages: 828, verification: unverified(printOptionsHelp, 'Large-trim maximum not confirmed.') },
    { format: 'PAPERBACK', ink: 'BLACK_WHITE', paper: 'CREAM', trimClass: 'LARGE', minPages: 24, maxPages: 776, verification: unverified(printOptionsHelp, 'Large-trim maximum not confirmed; cream may be unavailable for some large trims.') },
    { format: 'PAPERBACK', ink: 'STANDARD_COLOR', paper: 'WHITE', trimClass: 'LARGE', minPages: 72, maxPages: 600, verification: unverified(printOptionsHelp, 'Large-trim maximum not confirmed.') },
    { format: 'PAPERBACK', ink: 'PREMIUM_COLOR', paper: 'WHITE', trimClass: 'LARGE', minPages: 24, maxPages: 590, verification: unverified(printOptionsHelp, 'Secondary sources report 590 for some large trims; confirm.') },
    { format: 'HARDCOVER', ink: 'ANY', paper: 'ANY', trimClass: 'ANY', minPages: 75, maxPages: 550, verification: corroborated(printOptionsHelp, 'Confirmed for standard trims only.') },
  ],
  spine: [
    { ink: 'BLACK_WHITE', paper: 'WHITE', inchesPerPage: 0.002252, verification: corroborated(coverHelp) },
    { ink: 'BLACK_WHITE', paper: 'CREAM', inchesPerPage: 0.0025, verification: corroborated(coverHelp) },
    { ink: 'STANDARD_COLOR', paper: 'WHITE', inchesPerPage: 0.002252, verification: corroborated(coverHelp) },
    { ink: 'PREMIUM_COLOR', paper: 'WHITE', inchesPerPage: 0.002347, verification: corroborated(coverHelp) },
  ],
  paperbackCover: {
    bleedIn: 0.125,
    safeMarginIn: 0.125,
    spineTextMinPages: 80,
    spineSafeMarginIn: 0.0625,
    barcode: {
      widthIn: 2,
      heightIn: 1.2,
      offsetFromSpineIn: 0.25,
      offsetFromBottomIn: 0.25,
      verification: unverified(
        coverHelp,
        'Barcode area size/position from maintainer knowledge. Use the official cover template to confirm placement.',
      ),
    },
    verification: corroborated(coverHelp, 'Wrap = bleed + back + spine + front + bleed; height = bleed + trim + bleed. Spine text needs 80+ pages.'),
  },
  hardcoverCover: {
    requiresOfficialGeometry: true,
    defaultWrapIn: 0.51,
    defaultHingeIn: 0.4,
    spineTextMinPages: 75,
    verification: unverified(
      'https://kdp.amazon.com/cover-calculator',
      'Hardcover spine/wrap/hinge must come from the official KDP cover calculator or template for the exact trim and page count.',
    ),
  },
  ebook: {
    coverIdealWidthPx: 1600,
    coverIdealHeightPx: 2560,
    coverMinWidthPx: 625,
    coverMinHeightPx: 1000,
    coverMaxFileMb: 50,
    verification: corroborated(ebookCoverHelp, '1600×2560 ideal; minimum and 50 MB cap from secondary sources.'),
  },
  files: {
    interiorMaxMb: 650,
    coverMaxMb: 40,
    minImageDpi: 300,
    verification: unverified(
      coverHelp,
      'Cover: >650 MB will not convert, ≤40 MB recommended. Interior 650 MB and 300 DPI are commonly cited; confirm.',
    ),
  },
};
