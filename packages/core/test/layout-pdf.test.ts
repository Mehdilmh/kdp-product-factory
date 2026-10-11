import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { inspectPdf, layoutDocument, renderInteriorPdf, renderPageSvg, sha256, type InteriorDocumentInput } from '../src/index';

const fmt = { format: 'PAPERBACK' as const, trimId: '6x9', ink: 'BLACK_WHITE' as const, paper: 'WHITE' as const, bleed: false };
const lined = (n: number): InteriorDocumentInput => ({ settings: { title: 'T', author: 'A' }, body: { kind: 'pages', pages: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, templateId: 'lined-journal' })) } });

describe('deterministic layout engine', () => {
  it('alternates the gutter side and enforces minimum margins', () => {
    const l = layoutDocument({ ...lined(24), settings: { margins: { insideIn: 0.1, outsideIn: 0.1, topIn: 0.1, bottomIn: 0.1 } } }, { format: fmt });
    expect(l.margins).toEqual({ insideIn: 0.375, outsideIn: 0.25, topIn: 0.25, bottomIn: 0.25 });
    expect(l.warnings.filter((w) => w.code === 'MARGIN_ADJUSTED')).toHaveLength(4);
    const [p1, p2] = l.pages;
    expect(p1.gutterSide).toBe('left');
    expect(p2.gutterSide).toBe('right');
    expect(p1.contentBox.x).toBeCloseTo(0.375 * 72, 2);
    expect(p2.contentBox.x).toBeCloseTo(0.25 * 72, 2);
  });

  it('places bleed on the outside edge only', () => {
    const l = layoutDocument(lined(24), { format: { ...fmt, bleed: true } });
    expect(l.pages[0].widthPt).toBeCloseTo(6.125 * 72, 3);
    expect(l.pages[0].heightPt).toBeCloseTo(9.25 * 72, 3);
    expect(l.pages[0].trimBox.x).toBe(0); // recto: bleed on the right
    expect(l.pages[1].trimBox.x).toBeCloseTo(9, 3); // verso: bleed on the left
    expect(l.spec.minMargins.outsideIn).toBe(0.375);
  });

  it('raises the gutter when page count crosses a tier', () => {
    expect(layoutDocument(lined(150), { format: fmt }).margins.insideIn).toBe(0.75); // user default 0.75 > 0.375
    const tight = (n: number) => layoutDocument({ ...lined(n), settings: { margins: { insideIn: 0 } } }, { format: fmt });
    expect(tight(150).margins.insideIn).toBe(0.375);
    expect(tight(152).margins.insideIn).toBe(0.5);
    expect(tight(302).margins.insideIn).toBe(0.625);
  });

  it('regenerates layout for a new trim size', () => {
    const a = layoutDocument(lined(24), { format: fmt });
    const b = layoutDocument(lined(24), { format: { ...fmt, trimId: '8.5x11' } });
    expect(b.pages[0].widthPt).toBe(8.5 * 72);
    const lines = (l: typeof a) => l.pages[0].ops.filter((o) => o.op === 'line').length;
    expect(lines(b)).toBeGreaterThan(lines(a));
  });

  it('pads to an even page count and numbers body pages from 1', () => {
    const l = layoutDocument({ ...lined(24), frontMatter: [{ id: 't', templateId: 'title-page' }] }, { format: fmt });
    expect(l.pageCount).toBe(26);
    expect(l.pages[0].displayNumber).toBeNull();
    expect(l.pages[1].displayNumber).toBe('1');
    expect(l.pages[25].intentionalBlank).toBe(true);
  });

  it('detects text overflow and clipping instead of silently dropping content', () => {
    const l = layoutDocument(
      { body: { kind: 'pages', pages: [{ id: 'x', elements: [{ id: 'big', type: 'text', text: 'word '.repeat(4000), height: { mode: 'fixed', pt: 100 } }] }] } },
      { format: fmt },
    );
    expect(l.warnings.some((w) => w.code === 'OVERFLOW' && w.elementId === 'big')).toBe(true);
    const tooTall = layoutDocument({ body: { kind: 'pages', pages: [{ id: 'y', elements: [{ id: 's', type: 'spacer', height: { mode: 'fixed', pt: 2000 } }, { id: 'h', type: 'heading', text: 'Lost' }] }] } }, { format: fmt });
    expect(tooTall.warnings.some((w) => w.code === 'CLIPPED' && w.elementId === 'h')).toBe(true);
  });

  it('reports characters the embedded font cannot render', () => {
    const l = layoutDocument({ body: { kind: 'pages', pages: [{ id: 'x', elements: [{ id: 't', type: 'text', text: 'Hello 你好' }] }] } }, { format: fmt });
    expect(l.warnings.some((w) => w.code === 'MISSING_GLYPH')).toBe(true);
  });

  it('keeps every op inside the live area for all built-in body templates', () => {
    const ids = ['lined-journal', 'guided-writing', 'daily-planner', 'weekly-planner', 'work-order-log', 'equipment-inspection', 'meeting-notes', 'habit-tracker', 'budget-tracker', 'reading-log', 'workbook-exercise', 'chapter-page', 'dot-grid', 'graph-grid'];
    for (const trimId of ['6x9', '8.5x11', '5x8']) {
      const l = layoutDocument({ body: { kind: 'pages', pages: ids.map((t, i) => ({ id: `p${i}`, templateId: t })) } }, { format: { ...fmt, trimId } });
      const bad = l.warnings.filter((w) => ['OUTSIDE_SAFE', 'OVERFLOW', 'CLIPPED'].includes(w.code));
      expect(bad, `${trimId}: ${JSON.stringify(bad.slice(0, 3))}`).toEqual([]);
    }
  });

  it('flows long-form chapters with TOC page numbers, running heads, and recto chapter starts', () => {
    const para = 'The quick brown fox considers the lazy dog with patience and curiosity. '.repeat(30);
    const l = layoutDocument(
      {
        settings: { title: 'Book', author: 'Me', runningHeader: { enabled: true }, chapterStartRecto: true },
        frontMatter: [{ id: 'toc', templateId: 'toc' }],
        body: { kind: 'flow', chapters: [1, 2, 3].map((n) => ({ id: `c${n}`, title: `Chapter ${n}`, blocks: Array.from({ length: 6 }, () => ({ type: 'paragraph' as const, text: para })), notes: n === 1 ? ['A note.'] : [] })) },
      },
      { format: fmt },
    );
    expect(l.toc).toHaveLength(3);
    for (const t of l.toc) {
      const page = l.pages[t.pageIndex];
      expect(page.gutterSide, `chapter "${t.title}" should start on a recto`).toBe('left');
      expect(page.textContent).toContain(t.title);
    }
    expect(l.pages[0].textContent).toContain(`Chapter 2 ${l.toc[1].displayNumber}`);
    const headed = l.pages.filter((p) => p.ops.some((o) => o.elementId === '__runningHeader'));
    expect(headed.length).toBeGreaterThan(0);
    expect(l.warnings.filter((w) => w.level === 'error')).toEqual([]);
  });
});

describe('interior PDF rendering', () => {
  it('produces a valid PDF with embedded fonts and correct boxes', async () => {
    const l = layoutDocument(lined(24), { format: { ...fmt, bleed: true } });
    const pdf = await renderInteriorPdf(l, { title: 'Test' });
    const ins = await inspectPdf(pdf);
    expect(ins.ok).toBe(true);
    expect(ins.encrypted).toBe(false);
    expect(ins.pageCount).toBe(24);
    expect(ins.allFontsEmbedded).toBe(true);
    expect(ins.fonts.length).toBeGreaterThan(0);
    expect(ins.pages[0].mediaBoxIn).toEqual({ w: 6.125, h: 9.25 });
    expect(ins.pages[0].trimBoxIn).toEqual({ x: 0, y: 0.125, w: 6, h: 9 });
    expect(ins.pages[1].trimBoxIn).toEqual({ x: 0.125, y: 0.125, w: 6, h: 9 });
  });

  it('is byte-for-byte deterministic', async () => {
    const make = async () => renderInteriorPdf(layoutDocument(lined(30), { format: fmt }), { title: 'Same' });
    expect(sha256(await make())).toBe(sha256(await make()));
  });

  it('detects non-embedded fonts and encryption in arbitrary PDFs', async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([432, 648]);
    p.drawText('hi', { font: await d.embedFont(StandardFonts.Helvetica) });
    const bytes = await d.save({ useObjectStreams: false });
    const ins = await inspectPdf(bytes);
    expect(ins.allFontsEmbedded).toBe(false);
    const text = Buffer.from(bytes).toString('latin1').replace('trailer\n<<', 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>');
    expect((await inspectPdf(new Uint8Array(Buffer.from(text, 'latin1')))).encrypted).toBe(true);
    expect((await inspectPdf(new TextEncoder().encode('not a pdf'))).ok).toBe(false);
  });

  it('renders print-size SVG previews from the same ops', () => {
    const l = layoutDocument(lined(24), { format: fmt });
    const svg = renderPageSvg(l.pages[0], { guides: true });
    expect(svg).toContain('width="6in"');
    expect(svg).toContain('viewBox="0 0 432 648"');
    expect((svg.match(/<line /g) ?? []).length).toBeGreaterThan(10);
  });
});
