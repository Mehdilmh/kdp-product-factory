import { z } from 'zod';
import { defaultSpecSource, findTrim, type SpecIssue, type SpecSource } from '../specs/engine';
import type { InkType, PaperType, ReadingDirection, Verification } from '../specs/types';
import { round } from '../units';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const inset = (r: Rect, d: number): Rect => ({ x: round(r.x + d), y: round(r.y + d), w: round(r.w - 2 * d), h: round(r.h - 2 * d) });

/** Values read from the official KDP cover calculator / downloaded template. */
export const OfficialCoverGeometry = z.object({
  fullWidthIn: z.number().positive(),
  fullHeightIn: z.number().positive(),
  spineWidthIn: z.number().nonnegative(),
  /** Hardcover only: wrap that folds around the board (all four edges). */
  wrapIn: z.number().nonnegative().optional(),
  /** Hardcover only: hinge width on each side of the spine. */
  hingeIn: z.number().nonnegative().optional(),
  sourceNote: z.string().default('Entered from official KDP cover calculator'),
  pageCount: z.number().int().positive(),
  importedAt: z.string().optional(),
});
export type OfficialCoverGeometry = z.infer<typeof OfficialCoverGeometry>;

export interface CoverGeometryInput {
  format: 'PAPERBACK' | 'HARDCOVER';
  trimId: string;
  pageCount: number;
  ink: InkType;
  paper: PaperType;
  direction?: ReadingDirection;
  official?: OfficialCoverGeometry | null;
}

export interface CoverGeometry {
  specVersion: string;
  format: 'PAPERBACK' | 'HARDCOVER' | 'EBOOK';
  source: 'FORMULA' | 'OFFICIAL_TEMPLATE' | 'UNRESOLVED';
  widthIn: number;
  heightIn: number;
  /** Paperback bleed or hardcover wrap — the area beyond the trim/board on all outer edges. */
  bleedIn: number;
  spineWidthIn: number;
  pageCount: number;
  spineTextAllowed: boolean;
  direction: ReadingDirection;
  /** Trimmed panels (what the reader sees). */
  panels: { back: Rect; spine: Rect; front: Rect };
  /** Areas where text and important elements must stay. */
  safe: { back: Rect; spine: Rect; front: Rect };
  barcode: Rect | null;
  hinges: Rect[];
  verifications: Verification[];
  issues: SpecIssue[];
}

export function spineWidthFor(ink: InkType, paper: PaperType, pageCount: number, source: SpecSource = defaultSpecSource, version?: string) {
  const lib = source.getLibrary(version);
  const rule = lib.spine.find((s) => s.ink === ink && s.paper === paper);
  if (!rule) return null;
  return { widthIn: round(pageCount * rule.inchesPerPage, 4), rule };
}

function layoutPanels(opts: {
  outerIn: number;
  panelW: number;
  panelH: number;
  spineW: number;
  direction: ReadingDirection;
}) {
  const { outerIn, panelW, panelH, spineW, direction } = opts;
  const left: Rect = { x: outerIn, y: outerIn, w: panelW, h: panelH };
  const spine: Rect = { x: round(outerIn + panelW), y: outerIn, w: spineW, h: panelH };
  const right: Rect = { x: round(outerIn + panelW + spineW), y: outerIn, w: panelW, h: panelH };
  // LTR books: back cover on the left of the flat wrap. RTL books bind on the right: front on the left.
  return direction === 'RTL' ? { back: right, spine, front: left } : { back: left, spine, front: right };
}

function barcodeRect(back: Rect, spineSide: 'left' | 'right', w: number, h: number, offSpine: number, offBottom: number): Rect {
  const x = spineSide === 'right' ? back.x + back.w - offSpine - w : back.x + offSpine;
  return { x: round(x), y: round(back.y + back.h - offBottom - h), w, h };
}

/**
 * Compute full-wrap print cover geometry. Must be called only once the final interior page
 * count, binding, paper, and trim are known (the API enforces this).
 */
export function computeCoverGeometry(input: CoverGeometryInput, source: SpecSource = defaultSpecSource, version?: string): CoverGeometry {
  const lib = source.getLibrary(version);
  const trim = findTrim(lib, input.trimId);
  const direction = input.direction ?? 'LTR';
  const issues: SpecIssue[] = [];
  const verifications: Verification[] = [];

  if (input.format === 'PAPERBACK') {
    const pc = lib.paperbackCover;
    verifications.push(pc.verification);
    const spine = spineWidthFor(input.ink, input.paper, input.pageCount, source, version);
    if (!spine) {
      issues.push({ code: 'COVER_SPINE_RULE', severity: 'FAIL', message: `No spine rule for ${input.ink}/${input.paper}.` });
    } else {
      verifications.push(spine.rule.verification);
    }
    let spineW = spine?.widthIn ?? 0;
    let width = round(pc.bleedIn * 2 + trim.widthIn * 2 + spineW);
    let height = round(pc.bleedIn * 2 + trim.heightIn);
    let src: CoverGeometry['source'] = 'FORMULA';

    if (input.official) {
      const o = OfficialCoverGeometry.parse(input.official);
      if (o.pageCount !== input.pageCount) {
        issues.push({
          code: 'COVER_TEMPLATE_PAGECOUNT',
          severity: 'FAIL',
          message: `Official template was generated for ${o.pageCount} pages but the interior has ${input.pageCount}. Regenerate the template.`,
        });
      }
      const dw = Math.abs(o.fullWidthIn - width);
      const dh = Math.abs(o.fullHeightIn - height);
      if (dw > 0.01 || dh > 0.01) {
        issues.push({
          code: 'COVER_TEMPLATE_MISMATCH',
          severity: 'WARNING',
          message: `Official template (${o.fullWidthIn}" × ${o.fullHeightIn}") differs from the formula (${width}" × ${height}"). Official values are used.`,
        });
      }
      width = round(o.fullWidthIn);
      height = round(o.fullHeightIn);
      spineW = round(o.spineWidthIn);
      src = 'OFFICIAL_TEMPLATE';
      verifications.push({ status: 'OFFICIAL_TEMPLATE', source: o.sourceNote, lastVerified: o.importedAt ?? lib.effectiveDate });
    }

    const panelW = round((width - 2 * pc.bleedIn - spineW) / 2);
    const panelH = round(height - 2 * pc.bleedIn);
    const panels = layoutPanels({ outerIn: pc.bleedIn, panelW, panelH, spineW, direction });
    const spineTextAllowed = input.pageCount >= pc.spineTextMinPages;
    const spineSafe: Rect =
      spineW > 2 * pc.spineSafeMarginIn
        ? { x: round(panels.spine.x + pc.spineSafeMarginIn), y: round(panels.spine.y + pc.safeMarginIn), w: round(spineW - 2 * pc.spineSafeMarginIn), h: round(panelH - 2 * pc.safeMarginIn) }
        : { x: panels.spine.x, y: panels.spine.y, w: 0, h: 0 };
    verifications.push(pc.barcode.verification);
    return {
      specVersion: lib.version,
      format: 'PAPERBACK',
      source: src,
      widthIn: width,
      heightIn: height,
      bleedIn: pc.bleedIn,
      spineWidthIn: spineW,
      pageCount: input.pageCount,
      spineTextAllowed,
      direction,
      panels,
      safe: { back: inset(panels.back, pc.safeMarginIn), spine: spineSafe, front: inset(panels.front, pc.safeMarginIn) },
      barcode: barcodeRect(panels.back, direction === 'RTL' ? 'left' : 'right', pc.barcode.widthIn, pc.barcode.heightIn, pc.barcode.offsetFromSpineIn, pc.barcode.offsetFromBottomIn),
      hinges: [],
      verifications,
      issues,
    };
  }

  // HARDCOVER — never derived from paperback formulas.
  const hc = lib.hardcoverCover;
  verifications.push(hc.verification);
  if (!input.official) {
    issues.push({
      code: 'COVER_HARDCOVER_TEMPLATE_REQUIRED',
      severity: 'FAIL',
      message: 'Hardcover cover geometry requires the official KDP cover calculator values or template for this trim and page count.',
      verification: hc.verification,
    });
    return {
      specVersion: lib.version,
      format: 'HARDCOVER',
      source: 'UNRESOLVED',
      widthIn: 0,
      heightIn: 0,
      bleedIn: hc.defaultWrapIn,
      spineWidthIn: 0,
      pageCount: input.pageCount,
      spineTextAllowed: false,
      direction,
      panels: { back: { x: 0, y: 0, w: 0, h: 0 }, spine: { x: 0, y: 0, w: 0, h: 0 }, front: { x: 0, y: 0, w: 0, h: 0 } },
      safe: { back: { x: 0, y: 0, w: 0, h: 0 }, spine: { x: 0, y: 0, w: 0, h: 0 }, front: { x: 0, y: 0, w: 0, h: 0 } },
      barcode: null,
      hinges: [],
      verifications,
      issues,
    };
  }
  const o = OfficialCoverGeometry.parse(input.official);
  if (o.pageCount !== input.pageCount) {
    issues.push({
      code: 'COVER_TEMPLATE_PAGECOUNT',
      severity: 'FAIL',
      message: `Official template was generated for ${o.pageCount} pages but the interior has ${input.pageCount}. Regenerate the template.`,
    });
  }
  const wrap = o.wrapIn ?? hc.defaultWrapIn;
  const hinge = o.hingeIn ?? hc.defaultHingeIn;
  if (o.wrapIn === undefined || o.hingeIn === undefined) {
    issues.push({
      code: 'COVER_HARDCOVER_DEFAULTS',
      severity: 'NEEDS_HUMAN_REVIEW',
      message: `Wrap/hinge not supplied; using unverified defaults (wrap ${hc.defaultWrapIn}", hinge ${hc.defaultHingeIn}"). Confirm against the official template.`,
      verification: hc.verification,
    });
  }
  verifications.push({ status: 'OFFICIAL_TEMPLATE', source: o.sourceNote, lastVerified: o.importedAt ?? lib.effectiveDate });
  const panelW = round((o.fullWidthIn - 2 * wrap - o.spineWidthIn) / 2);
  const panelH = round(o.fullHeightIn - 2 * wrap);
  if (panelW <= 0 || panelH <= 0) {
    issues.push({ code: 'COVER_HARDCOVER_INVALID', severity: 'FAIL', message: 'Official dimensions produce non-positive board sizes.' });
  }
  const panels = layoutPanels({ outerIn: wrap, panelW, panelH, spineW: round(o.spineWidthIn), direction });
  const safeMargin = lib.paperbackCover.safeMarginIn;
  const hinges: Rect[] = [
    { x: round(panels.spine.x - hinge), y: wrap, w: hinge, h: panelH },
    { x: round(panels.spine.x + panels.spine.w), y: wrap, w: hinge, h: panelH },
  ];
  // Keep important content clear of the hinge on each board.
  const boardSafe = (r: Rect, hingeOnLeft: boolean): Rect => {
    const s = inset(r, safeMargin);
    return hingeOnLeft ? { ...s, x: round(s.x + hinge), w: round(s.w - hinge) } : { ...s, w: round(s.w - hinge) };
  };
  const frontHingeLeft = panels.front.x > panels.spine.x;
  return {
    specVersion: lib.version,
    format: 'HARDCOVER',
    source: 'OFFICIAL_TEMPLATE',
    widthIn: round(o.fullWidthIn),
    heightIn: round(o.fullHeightIn),
    bleedIn: wrap,
    spineWidthIn: round(o.spineWidthIn),
    pageCount: input.pageCount,
    spineTextAllowed: input.pageCount >= hc.spineTextMinPages,
    direction,
    panels,
    safe: {
      back: boardSafe(panels.back, !frontHingeLeft),
      spine: inset(panels.spine, Math.min(0.0625, panels.spine.w / 4)),
      front: boardSafe(panels.front, frontHingeLeft),
    },
    barcode: barcodeRect(panels.back, direction === 'RTL' ? 'left' : 'right', lib.paperbackCover.barcode.widthIn, lib.paperbackCover.barcode.heightIn, lib.paperbackCover.barcode.offsetFromSpineIn + hinge, lib.paperbackCover.barcode.offsetFromBottomIn),
    hinges,
    verifications,
    issues,
  };
}

/**
 * Front-only eBook cover canvas. The design space is 6" wide with the ideal pixel aspect ratio
 * (so typography matches a 6×9 print cover); it is rasterised to the ideal pixel width on export.
 */
export function ebookCoverGeometry(source: SpecSource = defaultSpecSource, version?: string): CoverGeometry {
  const lib = source.getLibrary(version);
  const w = 6;
  const h = round((6 * lib.ebook.coverIdealHeightPx) / lib.ebook.coverIdealWidthPx, 4);
  const front: Rect = { x: 0, y: 0, w, h };
  const zero: Rect = { x: 0, y: 0, w: 0, h: 0 };
  return {
    specVersion: lib.version,
    format: 'EBOOK',
    source: 'FORMULA',
    widthIn: w,
    heightIn: h,
    bleedIn: 0,
    spineWidthIn: 0,
    pageCount: 0,
    spineTextAllowed: false,
    direction: 'LTR',
    panels: { back: zero, spine: zero, front },
    safe: { back: zero, spine: zero, front: inset(front, 0.25) },
    barcode: null,
    hinges: [],
    verifications: [lib.ebook.verification],
    issues: [],
  };
}
