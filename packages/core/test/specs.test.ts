import { describe, expect, it } from 'vitest';
import { BuiltInSpecSource, KDP_SPEC_2026_10, applySpecOverride, gutterForPageCount, resolvePrintSpec } from '../src/index';

const base = { format: 'PAPERBACK' as const, trimId: '6x9', ink: 'BLACK_WHITE' as const, paper: 'WHITE' as const, bleed: false };

describe('print specification engine', () => {
  it('resolves 6x9 without bleed to the exact trim size', () => {
    const s = resolvePrintSpec({ ...base, pageCount: 100 });
    expect(s.pageWidthIn).toBe(6);
    expect(s.pageHeightIn).toBe(9);
    expect(s.specVersion).toBe('kdp-2026.10.1');
    expect(s.issues).toEqual([]);
  });

  it('adds 0.125" to width and 0.25" to height when bleed is enabled', () => {
    const s = resolvePrintSpec({ ...base, trimId: '8.5x11', pageCount: 100, bleed: true });
    expect(s.pageWidthIn).toBe(8.625);
    expect(s.pageHeightIn).toBe(11.25);
    expect(s.bleed).toEqual({ outsideIn: 0.125, topIn: 0.125, bottomIn: 0.125, insideIn: 0 });
  });

  it.each([
    [24, 0.375],
    [150, 0.375],
    [151, 0.5],
    [300, 0.5],
    [301, 0.625],
    [500, 0.625],
    [501, 0.75],
    [700, 0.75],
    [701, 0.875],
    [828, 0.875],
  ])('gutter for %i pages is %f"', (pages, gutter) => {
    expect(gutterForPageCount(KDP_SPEC_2026_10, 'PAPERBACK', pages)).toBe(gutter);
    expect(resolvePrintSpec({ ...base, pageCount: pages }).minMargins.insideIn).toBe(gutter);
  });

  it('raises outside margin minimum from 0.25" to 0.375" with bleed', () => {
    expect(resolvePrintSpec({ ...base, pageCount: 100 }).minMargins.outsideIn).toBe(0.25);
    expect(resolvePrintSpec({ ...base, pageCount: 100, bleed: true }).minMargins.outsideIn).toBe(0.375);
  });

  it('fails page counts outside corroborated limits and asks for review on unverified ones', () => {
    expect(resolvePrintSpec({ ...base, pageCount: 20 }).issues.find((i) => i.code === 'SPEC_PAGE_COUNT')?.severity).toBe('FAIL');
    expect(resolvePrintSpec({ ...base, paper: 'CREAM', pageCount: 800 }).issues.find((i) => i.code === 'SPEC_PAGE_COUNT')?.severity).toBe('FAIL');
    const large = resolvePrintSpec({ ...base, trimId: '8.5x11', ink: 'PREMIUM_COLOR', pageCount: 700 });
    expect(large.isLargeTrim).toBe(true);
    expect(large.issues.find((i) => i.code === 'SPEC_PAGE_COUNT')?.severity).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('applies hardcover limits (75–550) and rejects cream paper with color ink', () => {
    const hc = resolvePrintSpec({ ...base, format: 'HARDCOVER', pageCount: 60 });
    expect(hc.issues.some((i) => i.code === 'SPEC_PAGE_COUNT' && i.severity === 'FAIL')).toBe(true);
    expect(resolvePrintSpec({ ...base, format: 'HARDCOVER', pageCount: 120 }).issues).toEqual([]);
    expect(resolvePrintSpec({ ...base, ink: 'PREMIUM_COLOR', paper: 'CREAM', pageCount: 100 }).issues.some((i) => i.code === 'SPEC_PAPER_INK')).toBe(true);
    expect(resolvePrintSpec({ ...base, format: 'HARDCOVER', trimId: '5x8', pageCount: 120 }).issues.some((i) => i.code === 'SPEC_TRIM_FORMAT')).toBe(true);
  });

  it('every spec value carries a verification record', () => {
    for (const t of KDP_SPEC_2026_10.trimSizes) expect(t.verification.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const l of KDP_SPEC_2026_10.pageCountLimits) expect(['CORROBORATED', 'UNVERIFIED', 'OFFICIAL_TEMPLATE']).toContain(l.verification.status);
    expect(KDP_SPEC_2026_10.hardcoverCover.verification.status).toBe('UNVERIFIED');
  });

  it('supports versioned overrides through the adapter without touching the renderer', () => {
    const v2 = applySpecOverride(KDP_SPEC_2026_10, { version: 'kdp-2027.01.0', paperbackCover: { ...KDP_SPEC_2026_10.paperbackCover, spineTextMinPages: 100 } });
    const src = new BuiltInSpecSource([KDP_SPEC_2026_10, v2]);
    expect(src.listVersions()).toEqual(['kdp-2026.10.1', 'kdp-2027.01.0']);
    expect(src.getLibrary().version).toBe('kdp-2027.01.0');
    expect(src.getLibrary('kdp-2026.10.1').paperbackCover.spineTextMinPages).toBe(80);
    expect(() => src.getLibrary('nope')).toThrow();
  });
});
