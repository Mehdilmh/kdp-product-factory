import { describe, expect, it } from 'vitest';
import { computeCoverGeometry, CoverDesign, inspectPdf, layoutCover, renderCoverPdf, renderCoverSvg, sha256, starterCoverDesign } from '../src/index';

const geom = (pageCount: number) => computeCoverGeometry({ format: 'PAPERBACK', trimId: '6x9', pageCount, ink: 'BLACK_WHITE', paper: 'WHITE' });

describe('cover layout, SVG, and PDF', () => {
  it('starter design keeps all text editable and inside safe zones', () => {
    const g = geom(200);
    const d = starterCoverDesign(g, { title: 'Field Notes', subtitle: 'For curious walkers', author: 'Sam Reed', backText: 'A notebook for walks.' });
    const l = layoutCover(d, g);
    expect(l.warnings).toEqual([]);
    expect(d.layers.find((x) => x.id === 'spine-text')).toBeTruthy();
    const svg = renderCoverSvg(l);
    expect(svg).toContain('>Field Notes</text>');
    expect(svg).toContain('data-role="spine"');
    expect(svg).not.toContain('id="guides"');
    expect(renderCoverSvg(l, { guides: true })).toContain('Barcode area');
  });

  it('omits spine text below 80 pages and flags manual spine text', () => {
    const g = geom(60);
    const d = starterCoverDesign(g, { title: 'Thin', author: 'A' });
    expect(d.layers.find((x) => (x.type === 'text' && x.role === 'spine') || x.anchor === 'spine')).toBeUndefined();
    const withSpine = CoverDesign.parse({ ...d, layers: [...d.layers, { id: 's', type: 'text', role: 'spine', anchor: 'spine', x: 0, y: 1, w: 0.1, h: 4, text: 'Thin' }] });
    expect(layoutCover(withSpine, g).warnings.some((w) => w.code === 'SPINE_TEXT_NOT_ALLOWED')).toBe(true);
  });

  it('detects text outside the safe zone, in the barcode area, and placeholder text', () => {
    const g = geom(120);
    const d = CoverDesign.parse({
      layers: [
        { id: 'edge', type: 'text', anchor: 'front', x: 0, y: 0, w: 3, h: 1, text: 'Edge title', role: 'title' },
        { id: 'bc', type: 'text', anchor: 'back', x: 3.5, y: 7.6, w: 2, h: 1, text: 'Over barcode', sizePt: 12 },
        { id: 'ph', type: 'text', anchor: 'front', x: 1, y: 3, w: 4, h: 1, text: 'Your Title Here' },
      ],
    });
    const codes = layoutCover(d, g).warnings.map((w) => w.code);
    expect(codes).toContain('TEXT_OUTSIDE_SAFE');
    expect(codes).toContain('BARCODE_AREA_OBSTRUCTED');
    expect(codes).toContain('PLACEHOLDER_TEXT');
  });

  it('flags artwork that stops inside the bleed', () => {
    const g = geom(120);
    const d = CoverDesign.parse({ layers: [{ id: 'r', type: 'rect', anchor: 'canvas', x: 0.1, y: 0, w: 5, h: 9.25, fill: { type: 'solid', color: '#123456' } }] });
    expect(layoutCover(d, g).warnings.some((w) => w.code === 'BLEED_GAP')).toBe(true);
  });

  it('rejects unsafe SVG path data', () => {
    expect(() => CoverDesign.parse({ layers: [{ id: 'p', type: 'path', x: 0, y: 0, w: 1, h: 1, d: 'M0 0"/><script>alert(1)</script>', viewBoxW: 1, viewBoxH: 1 }] })).toThrow();
  });

  it('renders a single-page, full-wrap PDF with bleed boxes, embedded fonts, and gradients deterministically', async () => {
    const g = geom(200);
    const l = layoutCover(starterCoverDesign(g, { title: 'Field Notes', author: 'Sam Reed' }), g);
    const pdf = await renderCoverPdf(l, { title: 'Field Notes' });
    const ins = await inspectPdf(pdf);
    expect(ins.pageCount).toBe(1);
    expect(ins.pages[0].mediaBoxIn.w).toBeCloseTo(g.widthIn, 2);
    expect(ins.pages[0].mediaBoxIn.h).toBeCloseTo(9.25, 3);
    expect(ins.pages[0].trimBoxIn).toMatchObject({ x: 0.125, y: 0.125 });
    expect(ins.allFontsEmbedded).toBe(true);
    expect(Buffer.from(pdf).toString('latin1')).toContain('/ShadingType 2');
    expect(sha256(await renderCoverPdf(l, { title: 'Field Notes' }))).toBe(sha256(pdf));
  });
});
