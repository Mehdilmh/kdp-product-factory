import { describe, expect, it } from 'vitest';
import { FIXTURES, inspectEpub, runPipeline, withStarterCover, type FixtureName } from '../src/index';

/**
 * For every fixture: generate the files, run preflight, and verify the resulting PDFs against
 * the specification that applies to that fixture's format.
 */
describe.each(Object.keys(FIXTURES) as FixtureName[])('fixture: %s', (name) => {
  it('builds, renders, and passes technical preflight', async () => {
    const base = FIXTURES[name]();
    const pass1 = await runPipeline(base, { renderInterior: false, renderCover: false, renderEpub: false });
    const build = await runPipeline(withStarterCover(base, pass1.layout?.pageCount ?? 0));
    const p = build.preflight;
    expect(p.blockingRuleIds, JSON.stringify(p.results.filter((r) => r.blocking))).toEqual([]);
    expect(p.results.filter((r) => r.status === 'FAIL').map((r) => `${r.ruleId}: ${r.evidence}`)).toEqual([]);

    if (base.format === 'EBOOK') {
      expect(build.epub).toBeDefined();
      expect((await inspectEpub(build.epub!)).ok).toBe(true);
      expect(build.preflight.results.find((r) => r.ruleId === 'EBK-COV-001')!.status).toBe('PASS');
      expect(build.interiorPdf).toBeUndefined();
      return;
    }

    const l = build.layout!;
    const ins = build.interiorInspection!;
    expect(ins.pageCount).toBe(l.pageCount);
    expect(ins.allFontsEmbedded).toBe(true);
    expect(ins.encrypted).toBe(false);
    for (const pg of ins.pages) {
      expect(pg.mediaBoxIn.w).toBeCloseTo(l.spec.pageWidthIn, 2);
      expect(pg.mediaBoxIn.h).toBeCloseTo(l.spec.pageHeightIn, 2);
      expect(pg.trimBoxIn!.w).toBeCloseTo(l.spec.trim.widthIn, 2);
    }
    const c = build.coverInspection!;
    expect(c.pageCount).toBe(1);
    expect(c.pages[0].mediaBoxIn.w).toBeCloseTo(build.coverGeometry!.widthIn, 2);
    expect(build.coverGeometry!.pageCount).toBe(l.pageCount);

    if (name === 'journal') {
      expect(l.pageCount).toBe(100);
      expect(l.spec.trim.id).toBe('6x9');
      expect(build.coverGeometry!.spineWidthIn).toBeCloseTo(100 * 0.0025, 4); // cream paper
    }
    if (name === 'workbook') expect(ins.pages[0].mediaBoxIn).toEqual({ w: 8.5, h: 11 });
    if (name === 'hardcover') {
      expect(build.coverGeometry!.source).toBe('OFFICIAL_TEMPLATE');
      expect(build.coverGeometry!.hinges).toHaveLength(2);
    }
    if (name === 'illustrated') {
      expect(ins.pages[0].mediaBoxIn).toEqual({ w: 8.625, h: 8.75 });
      expect(l.imageUsage.every((u) => u.effectiveDpi >= 300)).toBe(true);
      expect(l.pages.some((pg) => pg.ops.some((o) => o.op === 'image' && o.fullBleed))).toBe(true);
    }
  });
});
