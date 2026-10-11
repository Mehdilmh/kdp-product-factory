import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  buildDocx,
  buildEpub,
  buildManifest,
  ebookFixture,
  inspectEpub,
  KDP_SPEC_2026_10,
  layoutDocument,
  manifestFile,
  MetadataDraft,
  metadataToCsv,
  reportToHtml,
  RULES,
  runPreflight,
  sha256,
} from '../src/index';

const fmt = { format: 'PAPERBACK' as const, trimId: '6x9', ink: 'BLACK_WHITE' as const, paper: 'WHITE' as const, bleed: false };

describe('rules registry', () => {
  it('has unique ids, versions, sources, and verification dates', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES) {
      expect(r.version).toBeGreaterThan(0);
      expect(r.source).toBeTruthy();
      expect(r.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Only technical rules may block exports.
      if (r.blocking) expect(r.category).toBe('TECHNICAL');
    }
  });

  it('returns every required field and blocks only on blocking technical failures', () => {
    const tooShort = layoutDocument({ body: { kind: 'pages', pages: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, templateId: 'lined-journal' })) } }, { format: fmt });
    const r = runPreflight({ format: 'PAPERBACK', contentClass: 'LOW', spec: KDP_SPEC_2026_10, interior: { layout: tooShort }, metadata: MetadataDraft.parse({ title: 'Best Seller Notebook', author: 'X', description: 'Notebook' }) });
    for (const res of r.results) {
      for (const k of ['ruleId', 'severity', 'status', 'evidence', 'suggestion', 'applicableFormats', 'source', 'lastVerified'] as const) expect(res[k]).toBeDefined();
    }
    expect(r.blockingRuleIds).toContain('INT-PGC-001');
    const meta = r.results.find((x) => x.ruleId === 'META-TTL-001')!;
    expect(meta.status).toBe('FAIL');
    expect(meta.blocking).toBe(false);
    expect(r.results.find((x) => x.ruleId === 'EBK-EPUB-001')!.status).toBe('NOT_APPLICABLE');
    expect(r.disclaimer).toMatch(/not a guarantee/);
    expect(reportToHtml(r, 'x')).toContain('INT-PGC-001');
  });

  it('records human review decisions and AI disclosure acknowledgement', () => {
    const base = { format: 'PAPERBACK' as const, contentClass: 'LOW' as const, spec: KDP_SPEC_2026_10 };
    const r1 = runPreflight({ ...base, ai: { textGenerated: true, imagesGenerated: false, disclosureAcknowledged: false } });
    expect(r1.results.find((x) => x.ruleId === 'CNT-AI-001')!.status).toBe('NEEDS_HUMAN_REVIEW');
    const r2 = runPreflight({ ...base, ai: { textGenerated: true, imagesGenerated: false, disclosureAcknowledged: true } });
    expect(r2.results.find((x) => x.ruleId === 'CNT-AI-001')!.status).toBe('PASS');
    const r3 = runPreflight({ ...base, metadata: MetadataDraft.parse({ title: 'Harry Potter Notebook', author: 'X', description: 'd' }), reviews: { 'CNT-TM-001': { decision: 'REJECTED', note: 'rename', reviewer: 'me', at: '2026-10-10' } } });
    const tm = r3.results.find((x) => x.ruleId === 'CNT-TM-001')!;
    expect(tm.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(tm.review?.decision).toBe('REJECTED');
  });

  it('a crashing rule never silently passes', () => {
    const r = runPreflight({ format: 'PAPERBACK', contentClass: 'LOW', spec: KDP_SPEC_2026_10 }, { rules: [{ ...RULES[0], appliesTo: ['ALL'], check: () => { throw new Error('boom'); } }] });
    expect(r.results[0].status).toBe('NEEDS_HUMAN_REVIEW');
  });
});

describe('exports', () => {
  it('builds a structurally valid, deterministic EPUB', async () => {
    const f = ebookFixture();
    const make = () => buildEpub({ document: f.document, title: 'Balcony Harvest', author: 'Lena', language: 'English', identifier: 'p1' });
    const epub = await make();
    const ins = await inspectEpub(epub);
    expect(ins.errors).toEqual([]);
    expect(ins.ok).toBe(true);
    expect(ins.hasNav).toBe(true);
    expect(ins.chapterCount).toBeGreaterThanOrEqual(4);
    const zip = await JSZip.loadAsync(epub);
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    expect(await zip.file('OEBPS/chapter-001.xhtml')!.async('string')).toContain('epub:type="noteref"');
    expect(sha256(await make())).toBe(sha256(epub));
  });

  it('inspectEpub reports broken archives', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'wrong');
    const ins = await inspectEpub(await zip.generateAsync({ type: 'uint8array' }));
    expect(ins.ok).toBe(false);
    expect(ins.errors.join(' ')).toMatch(/mimetype/);
  });

  it('builds a DOCX manuscript', async () => {
    const f = ebookFixture();
    const bytes = await buildDocx({ document: f.document, title: 'T', author: 'A', trim: { widthIn: 6, heightIn: 9 }, margins: { insideIn: 0.75, outsideIn: 0.5, topIn: 0.5, bottomIn: 0.5 } });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('Start With the Light You Have');
    expect(xml).toContain('w:pgSz');
  });

  it('exports metadata CSV with formula-injection protection', () => {
    const csv = metadataToCsv(MetadataDraft.parse({ title: '=HYPERLINK("x")', author: 'A, B', description: 'Line "quoted"' }));
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"A, B"');
  });

  it('generates a manifest with sha-256 checksums sorted by filename', () => {
    const m = buildManifest({
      generatedAt: '2026-10-10T00:00:00Z',
      project: { id: 'p', title: 'T', version: 3 },
      format: 'PAPERBACK',
      specVersion: 'kdp-2026.10.1',
      rulesetVersion: 'rules-2026.10.1',
      trimSize: '6x9',
      pageCount: 100,
      validationStatus: 'PASSED',
      files: [manifestFile('z.pdf', 'INTERIOR_PDF', 'application/pdf', 'zzz'), manifestFile('a.json', 'SOURCE', 'application/json', '{}')],
    });
    expect(m.files.map((f) => f.filename)).toEqual(['a.json', 'z.pdf']);
    expect(m.files[1].sha256).toBe(sha256('zzz'));
    expect(m.files[1].bytes).toBe(3);
  });
});
