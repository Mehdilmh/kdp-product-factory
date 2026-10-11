import { describe, expect, it } from 'vitest';
import { computeCoverGeometry, ebookCoverGeometry, spineWidthFor } from '../src/index';

const pb = { format: 'PAPERBACK' as const, trimId: '6x9', ink: 'BLACK_WHITE' as const, paper: 'WHITE' as const };

describe('cover geometry', () => {
  it.each([
    ['BLACK_WHITE', 'WHITE', 100, 0.2252],
    ['BLACK_WHITE', 'CREAM', 100, 0.25],
    ['STANDARD_COLOR', 'WHITE', 100, 0.2252],
    ['PREMIUM_COLOR', 'WHITE', 100, 0.2347],
    ['BLACK_WHITE', 'WHITE', 300, 0.6756],
  ] as const)('spine width %s/%s %i pages = %f"', (ink, paper, pages, w) => {
    expect(spineWidthFor(ink, paper, pages)!.widthIn).toBeCloseTo(w, 4);
  });

  it('computes full-wrap paperback dimensions: bleed + back + spine + front + bleed', () => {
    const g = computeCoverGeometry({ ...pb, pageCount: 200 });
    const spine = 200 * 0.002252;
    expect(g.spineWidthIn).toBeCloseTo(spine, 4);
    expect(g.widthIn).toBeCloseTo(0.125 + 6 + spine + 6 + 0.125, 4);
    expect(g.heightIn).toBe(9.25);
    expect(g.panels.back).toEqual({ x: 0.125, y: 0.125, w: 6, h: 9 });
    expect(g.panels.spine.x).toBeCloseTo(6.125, 4);
    expect(g.panels.front.x).toBeCloseTo(6.125 + spine, 4);
    expect(g.safe.front.x).toBeCloseTo(g.panels.front.x + 0.125, 4);
    expect(g.source).toBe('FORMULA');
  });

  it('recomputes when the page count changes', () => {
    const a = computeCoverGeometry({ ...pb, pageCount: 120 });
    const b = computeCoverGeometry({ ...pb, pageCount: 240 });
    expect(b.spineWidthIn - a.spineWidthIn).toBeCloseTo(120 * 0.002252, 3);
    expect(b.widthIn - a.widthIn).toBeCloseTo(120 * 0.002252, 3);
  });

  it('allows spine text only from 80 pages', () => {
    expect(computeCoverGeometry({ ...pb, pageCount: 79 }).spineTextAllowed).toBe(false);
    expect(computeCoverGeometry({ ...pb, pageCount: 80 }).spineTextAllowed).toBe(true);
  });

  it('places a 2" × 1.2" barcode area on the back cover near the spine', () => {
    const g = computeCoverGeometry({ ...pb, pageCount: 100 });
    expect(g.barcode).toMatchObject({ w: 2, h: 1.2 });
    expect(g.barcode!.x + g.barcode!.w).toBeCloseTo(g.panels.back.x + g.panels.back.w - 0.25, 4);
    expect(g.barcode!.y + g.barcode!.h).toBeCloseTo(g.panels.back.y + g.panels.back.h - 0.25, 4);
    expect(g.verifications.some((v) => v.status === 'UNVERIFIED')).toBe(true);
  });

  it('mirrors panels for right-to-left books', () => {
    const g = computeCoverGeometry({ ...pb, pageCount: 100, direction: 'RTL' });
    expect(g.panels.front.x).toBe(0.125);
    expect(g.panels.back.x).toBeGreaterThan(g.panels.spine.x);
  });

  it('never derives hardcover geometry from paperback formulas', () => {
    const g = computeCoverGeometry({ ...pb, format: 'HARDCOVER', pageCount: 120 });
    expect(g.source).toBe('UNRESOLVED');
    expect(g.widthIn).toBe(0);
    expect(g.issues[0]).toMatchObject({ code: 'COVER_HARDCOVER_TEMPLATE_REQUIRED', severity: 'FAIL' });
  });

  it('uses official hardcover calculator values with wrap and hinges', () => {
    const g = computeCoverGeometry({
      ...pb,
      format: 'HARDCOVER',
      pageCount: 120,
      official: { fullWidthIn: 13.917, fullHeightIn: 10.25, spineWidthIn: 0.5, wrapIn: 0.51, hingeIn: 0.4, pageCount: 120, sourceNote: 'test' },
    });
    expect(g.source).toBe('OFFICIAL_TEMPLATE');
    expect(g.bleedIn).toBe(0.51);
    expect(g.panels.front.w).toBeCloseTo((13.917 - 1.02 - 0.5) / 2, 4);
    expect(g.hinges).toHaveLength(2);
    // Front safe area keeps clear of the hinge next to the spine.
    expect(g.safe.front.x).toBeGreaterThanOrEqual(g.hinges[1].x + g.hinges[1].w);
    expect(g.issues).toEqual([]);
  });

  it('flags an official template generated for a different page count', () => {
    const g = computeCoverGeometry({ ...pb, pageCount: 130, official: { fullWidthIn: 12.52, fullHeightIn: 9.25, spineWidthIn: 0.27, pageCount: 120, sourceNote: 't' } });
    expect(g.issues.some((i) => i.code === 'COVER_TEMPLATE_PAGECOUNT' && i.severity === 'FAIL')).toBe(true);
    expect(g.issues.some((i) => i.code === 'COVER_TEMPLATE_MISMATCH')).toBe(true);
    expect(g.source).toBe('OFFICIAL_TEMPLATE');
  });

  it('eBook cover uses the 1.6:1 front-only canvas', () => {
    const g = ebookCoverGeometry();
    expect(g.heightIn / g.widthIn).toBeCloseTo(1.6, 3);
    expect(g.barcode).toBeNull();
    expect(g.spineWidthIn).toBe(0);
  });
});
