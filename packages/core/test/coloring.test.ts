import { describe, expect, it } from 'vitest';
import { buildColoringDocument, buildColoringPrompt, ColoringInteriorSettings, findRepeatedConcepts, InteriorDocument, inspectPdf, layoutDocument, qcThresholdsFor, rasterizeSvg, renderInteriorPdf, StyleProfile, AUDIENCE_PRESETS } from '../src/index';

const lineArt = () => rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="3000" viewBox="0 0 2400 3000"><rect width="2400" height="3000" fill="#fff"/><circle cx="1200" cy="1500" r="900" fill="none" stroke="#000" stroke-width="20"/></svg>', 2400);

describe('coloring prompt builder', () => {
  it('is deterministic and always carries coloring defaults', () => {
    const style = StyleProfile.parse(AUDIENCE_PRESETS.PRESCHOOL.style);
    const a = buildColoringPrompt('cow in a meadow', style, { audience: 'PRESCHOOL' });
    expect(buildColoringPrompt('cow in a meadow', style, { audience: 'PRESCHOOL' })).toEqual(a);
    expect(a.prompt).toMatch(/black outlines on a pure white background/);
    expect(a.prompt).toMatch(/no text/);
    expect(a.prompt).toMatch(/ages 3–5/);
    expect(a.negativePrompt).toMatch(/shading/);
    expect(buildColoringPrompt('cow in a meadow', style, { variation: 2 }).prompt).not.toEqual(a.prompt);
  });

  it('flags repeated concepts', () => {
    const r = findRepeatedConcepts([{ id: '1', concept: 'Sea turtle swimming' }, { id: '2', concept: 'sea turtles swimming' }, { id: '3', concept: 'fire truck' }]);
    expect(r).toEqual([{ a: '1', b: '2', similarity: 1 }]);
  });

  it('derives QC thresholds from the style', () => {
    expect(qcThresholdsFor(StyleProfile.parse({ outlineThickness: 'EXTRA_THICK' })).minLineWeightPt).toBeGreaterThan(qcThresholdsFor(StyleProfile.parse({ outlineThickness: 'THIN' })).minLineWeightPt);
  });
});

describe('coloring interior', () => {
  it('single-sided: illustrations and page count are distinct, every illustration has a blank reverse, PDF renders at trim', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, assetId: `a${i}`, concept: `c${i}` }));
    const doc = InteriorDocument.parse(buildColoringDocument(pages, ColoringInteriorSettings.parse({}), { title: 'Farm Friends', author: 'A. Artist' }));
    const assets = Object.fromEntries(pages.map((p) => [p.assetId, { widthPx: 2400, heightPx: 3000, mimeType: 'image/png' }]));
    const layout = layoutDocument(doc, { format: { format: 'PAPERBACK', trimId: '8.5x11', ink: 'BLACK_WHITE', paper: 'WHITE', bleed: false }, assets });
    const imgPages = layout.pages.filter((p) => p.ops.some((o) => o.op === 'image'));
    expect(imgPages).toHaveLength(12);
    // Each image page is followed by an intentionally blank page.
    for (const p of imgPages) expect(layout.pages[layout.pages.indexOf(p) + 1].intentionalBlank).toBe(true);
    // Illustrations start on recto pages (odd page numbers, 0-based even index).
    for (const p of imgPages) expect(layout.pages.indexOf(p) % 2).toBe(0);
    expect(layout.pageCount % 2).toBe(0);
    expect(layout.warnings.filter((w) => w.level === "error" || w.code === 'UNKNOWN_TEMPLATE')).toEqual([]);
    const bytes = lineArt();
    const pdf = await renderInteriorPdf(layout, { assets: () => ({ bytes, mimeType: 'image/png' }) });
    const ins = await inspectPdf(pdf);
    expect(ins.pageCount).toBe(layout.pageCount);
    expect(ins.pages[0].trimBoxIn!.w).toBeCloseTo(8.5, 2);
  });

  it('double-sided mode packs illustrations back to back', () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, assetId: `a${i}`, concept: `c${i}` }));
    const doc = InteriorDocument.parse(buildColoringDocument(pages, ColoringInteriorSettings.parse({ singleSided: false, rectoOnly: false, titlePage: false, copyrightPage: false, belongsTo: false, testPage: false }), { title: 'T', author: 'A' }));
    const layout = layoutDocument(doc, { format: { format: 'PAPERBACK', trimId: '8.5x8.5', ink: 'BLACK_WHITE', paper: 'WHITE', bleed: false }, assets: Object.fromEntries(pages.map((p) => [p.assetId, { widthPx: 2550, heightPx: 2550, mimeType: 'image/png' }])) });
    expect(layout.pageCount).toBe(10);
  });
});
