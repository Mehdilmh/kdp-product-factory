import { checkMetadata, titlesConsistent, UNSUPPORTED_CLAIM_PATTERNS } from '../metadata';
import { findSimilar, normalizeText } from '../similarity';
import { approxEqual, round } from '../units';
import { COPYRIGHT_SIGNALS, PLACEHOLDER_RE, RESTRICTED_SIGNALS, TRADEMARK_WATCHLIST } from './lists';
import type { PreflightContext, RuleDefinition, RuleOutcome } from './types';

/**
 * Versioned rules registry. Bump `version` whenever a rule's logic or thresholds change so
 * stored reports remain auditable. `blocking` is reserved for explicit technical failures.
 */
export const RULESET_VERSION = 'rules-2026.10.1';

const D = '2026-10-10';
const KDP_INTERIOR = 'https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6';
const KDP_COVER = 'https://kdp.amazon.com/en_US/help/topic/G201953020';
const KDP_METADATA = 'https://kdp.amazon.com/en_US/help/topic/G201097560';
const KDP_CONTENT = 'https://kdp.amazon.com/en_US/help/topic/G200672390';
const KDP_AI = 'https://kdp.amazon.com/en_US/help/topic/G200672390#aicontent';
const KDP_LOW_CONTENT = 'https://kdp.amazon.com/en_US/help/topic/GHPAQXRZ8JD9P7MR';
const INTERNAL = 'Internal heuristic (KDP Product Factory)';

const PASS = (evidence: string): RuleOutcome => ({ status: 'PASS', evidence });
const NA = (evidence: string): RuleOutcome => ({ status: 'NOT_APPLICABLE', evidence });
const FAIL = (evidence: string, suggestion?: string): RuleOutcome => ({ status: 'FAIL', evidence, suggestion });
const WARN = (evidence: string, suggestion?: string): RuleOutcome => ({ status: 'WARNING', evidence, suggestion });
const REVIEW = (evidence: string, suggestion?: string): RuleOutcome => ({ status: 'NEEDS_HUMAN_REVIEW', evidence, suggestion });

const PRINT: RuleDefinition['appliesTo'] = ['PAPERBACK', 'HARDCOVER'];
const ALL: RuleDefinition['appliesTo'] = ['ALL'];

const list = (items: string[], max = 5) => items.slice(0, max).join('; ') + (items.length > max ? `; … (+${items.length - max} more)` : '');
const layoutWarnings = (ctx: PreflightContext, codes: string[]) => (ctx.interior?.layout.warnings ?? []).filter((w) => codes.includes(w.code));
const pg = (i?: number) => (i === undefined ? '' : `p.${i + 1}: `);

function allMetadataText(ctx: PreflightContext): string {
  const m = ctx.metadata;
  if (!m) return '';
  return [m.title, m.subtitle, m.description, ...m.keywords.map((k) => k.keyword)].join('\n');
}
function coverText(ctx: PreflightContext): string {
  return (ctx.cover?.design.layers ?? []).filter((l) => l.type === 'text' && !l.hidden).map((l) => (l as { text: string }).text).join('\n');
}

export const RULES: RuleDefinition[] = [
  /* ------------------------------- Interior technical ---------------------------------- */
  {
    id: 'INT-DIM-001',
    version: 1,
    title: 'Interior PDF page dimensions',
    description: 'Every page must equal the trim size, plus bleed (0.125" outside, 0.25" total height) when bleed is enabled.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_INTERIOR,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Re-render the interior with the selected trim size and bleed setting.',
    check(ctx) {
      const i = ctx.interior;
      if (!i?.pdf) return NA('No interior PDF rendered yet.');
      const s = i.layout.spec;
      const bad = i.pdf.pages.filter((p) => !approxEqual(p.mediaBoxIn.w, s.pageWidthIn, 0.01) || !approxEqual(p.mediaBoxIn.h, s.pageHeightIn, 0.01));
      const trimBad = i.pdf.pages.filter((p) => !p.trimBoxIn || !approxEqual(p.trimBoxIn.w, s.trim.widthIn, 0.01) || !approxEqual(p.trimBoxIn.h, s.trim.heightIn, 0.01));
      if (bad.length || trimBad.length)
        return FAIL(`Expected ${s.pageWidthIn}" × ${s.pageHeightIn}" (trim ${s.trim.widthIn}" × ${s.trim.heightIn}"). Mismatched pages: ${list([...bad, ...trimBad].map((p) => `p.${p.index + 1} ${p.mediaBoxIn.w}×${p.mediaBoxIn.h}`))}`);
      return PASS(`All ${i.pdf.pageCount} pages are ${s.pageWidthIn}" × ${s.pageHeightIn}" with TrimBox ${s.trim.widthIn}" × ${s.trim.heightIn}".`);
    },
  },
  {
    id: 'INT-PGC-001',
    version: 1,
    title: 'Page count within format limits',
    description: 'Page count must fall inside the minimum/maximum for the format, ink, paper, and trim class.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: 'https://kdp.amazon.com/en_US/help/topic/G201834180',
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Add or remove pages, or choose a format/paper whose limits fit the book.',
    check(ctx) {
      const l = ctx.interior?.layout;
      if (!l) return NA('No interior layout.');
      const lim = l.spec.pageCountLimit;
      if (!lim) return REVIEW('No page-count rule matches this configuration.', 'Confirm availability of this ink/paper/trim combination in KDP.');
      const inRange = l.pageCount >= lim.minPages && l.pageCount <= lim.maxPages;
      if (inRange) return PASS(`${l.pageCount} pages (allowed ${lim.minPages}–${lim.maxPages}, ${lim.verification.status.toLowerCase()}).`);
      const ev = `${l.pageCount} pages; allowed ${lim.minPages}–${lim.maxPages} for this configuration.`;
      return lim.verification.status === 'UNVERIFIED' ? REVIEW(ev + ' (limit unverified)') : FAIL(ev);
    },
  },
  {
    id: 'INT-PGC-002',
    version: 1,
    title: 'Rendered PDF page count matches the document',
    description: 'The exported PDF must contain exactly the pages produced by the layout engine.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Re-render the interior PDF.',
    check(ctx) {
      const i = ctx.interior;
      if (!i?.pdf) return NA('No interior PDF rendered yet.');
      return i.pdf.pageCount === i.layout.pageCount ? PASS(`${i.pdf.pageCount} pages in PDF and layout.`) : FAIL(`PDF has ${i.pdf.pageCount} pages; layout has ${i.layout.pageCount}.`);
    },
  },
  {
    id: 'INT-BLD-001',
    version: 1,
    title: 'Bleed settings consistent with content',
    description: 'Full-bleed elements require bleed; bleed PDFs must include bleed on the outside edge, top, and bottom only.',
    category: 'TECHNICAL',
    severity: 'MAJOR',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_INTERIOR,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Enable bleed for full-bleed artwork, or move artwork inside the margins.',
    check(ctx) {
      const l = ctx.interior?.layout;
      if (!l) return NA('No interior layout.');
      const w = layoutWarnings(ctx, ['BLEED_DISABLED']);
      if (w.length) return FAIL(list(w.map((x) => pg(x.pageIndex) + x.message)));
      const anyBleedContent = l.pages.some((p) => p.ops.some((o) => o.op === 'image' && o.fullBleed));
      if (l.spec.input.bleed && !anyBleedContent) return WARN('Bleed is enabled but no page uses full-bleed content.', 'Disable bleed unless artwork must reach the page edge (bleed raises the outside margin minimum).');
      return PASS(l.spec.input.bleed ? 'Bleed enabled and used by full-bleed content.' : 'No bleed; no full-bleed content.');
    },
  },
  {
    id: 'INT-MRG-001',
    version: 1,
    title: 'Minimum margins and gutter',
    description: 'Inside margin (gutter) must meet the page-count tier; outside/top/bottom margins must meet the bleed/no-bleed minimum.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_INTERIOR,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Increase margins to at least the required minimum.',
    check(ctx) {
      const l = ctx.interior?.layout;
      if (!l) return NA('No interior layout.');
      const min = l.spec.minMargins;
      const m = l.margins;
      const fails = (Object.keys(min) as (keyof typeof min)[]).filter((k) => m[k] + 1e-6 < min[k]);
      if (fails.length) return FAIL(fails.map((k) => `${k}: ${m[k]}" < ${min[k]}"`).join(', '));
      const adjusted = layoutWarnings(ctx, ['MARGIN_ADJUSTED']);
      const ev = `Gutter ${m.insideIn}" (min ${min.insideIn}" for ${l.pageCount} pages); outside ${m.outsideIn}", top ${m.topIn}", bottom ${m.bottomIn}" (min ${min.outsideIn}").`;
      return adjusted.length ? PASS(ev + ' Some margins were raised automatically to the minimum.') : PASS(ev);
    },
  },
  {
    id: 'INT-SAFE-001',
    version: 1,
    title: 'Content inside safe area',
    description: 'Text and important elements must lie inside the margins (live area).',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_INTERIOR,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Move or resize the flagged element so it sits inside the margins.',
    check(ctx) {
      if (!ctx.interior) return NA('No interior layout.');
      const w = layoutWarnings(ctx, ['OUTSIDE_SAFE']);
      return w.length ? FAIL(list(w.map((x) => pg(x.pageIndex) + x.message))) : PASS('All content is inside the live area.');
    },
  },
  {
    id: 'INT-OVF-001',
    version: 1,
    title: 'Text clipping and overflow',
    description: 'No text or element may be cut off or omitted because it does not fit.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: ALL,
    blocking: true,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Shorten the text, reduce the font size, or give the element more space.',
    check(ctx) {
      if (!ctx.interior) return NA('No interior layout.');
      const w = layoutWarnings(ctx, ['OVERFLOW', 'CLIPPED']);
      return w.length ? FAIL(`${w.length} issue(s): ${list(w.map((x) => pg(x.pageIndex) + x.message))}`) : PASS('No overflow or clipping detected.');
    },
  },
  {
    id: 'INT-GLYPH-001',
    version: 1,
    title: 'All characters renderable',
    description: 'Every character must exist in the embedded font; missing glyphs print as boxes or blanks.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: ALL,
    blocking: true,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Replace unsupported characters or choose a font that supports them.',
    check(ctx) {
      if (!ctx.interior) return NA('No interior layout.');
      const w = layoutWarnings(ctx, ['MISSING_GLYPH']);
      return w.length ? FAIL(list(w.map((x) => pg(x.pageIndex) + x.message))) : PASS('All characters are covered by the embedded fonts.');
    },
  },
  {
    id: 'INT-BLANK-001',
    version: 1,
    title: 'Blank and missing pages',
    description: 'Flags unintended blank pages and long runs of blank pages, which KDP may question.',
    category: 'TECHNICAL',
    severity: 'MINOR',
    appliesTo: PRINT,
    blocking: false,
    source: KDP_INTERIOR,
    sourceVerification: 'UNVERIFIED',
    lastVerified: D,
    defaultSuggestion: 'Remove unintended blank pages; keep intentional ones (e.g. recto chapter starts) to a minimum.',
    check(ctx) {
      const l = ctx.interior?.layout;
      if (!l) return NA('No interior layout.');
      const accidental = l.pages.filter((p) => p.isBlank && !p.intentionalBlank);
      let run = 0;
      let maxRun = 0;
      for (const p of l.pages) {
        run = p.isBlank ? run + 1 : 0;
        maxRun = Math.max(maxRun, run);
      }
      const blankShare = l.pages.filter((p) => p.isBlank).length / Math.max(1, l.pages.length);
      const issues: string[] = [];
      if (accidental.length) issues.push(`Unintended blank pages: ${list(accidental.map((p) => `p.${p.pageNumber}`))}`);
      if (maxRun > 2) issues.push(`${maxRun} consecutive blank pages.`);
      if (blankShare > 0.1) issues.push(`${Math.round(blankShare * 100)}% of pages are blank.`);
      if (l.pages.at(-1)?.isBlank && l.pages.at(-2)?.isBlank && l.pages.at(-3)?.isBlank) issues.push('Three or more blank pages at the end.');
      return issues.length ? WARN(issues.join(' ')) : PASS('No unintended blank pages.');
    },
  },
  {
    id: 'INT-NUM-001',
    version: 1,
    title: 'Page numbering sequence',
    description: 'Printed page numbers must increase by one per physical body page (gaps only where numbers are hidden).',
    category: 'TECHNICAL',
    severity: 'MAJOR',
    appliesTo: PRINT,
    blocking: false,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Re-render to regenerate numbering, or check custom page-number text.',
    check(ctx) {
      const l = ctx.interior?.layout;
      if (!l) return NA('No interior layout.');
      const numbered = l.pages.filter((p) => p.displayNumber !== null);
      if (!l.settings.pageNumbers.enabled) return NA('Page numbers are disabled for this book by design.');
      if (numbered.length === 0) return WARN('No page numbers are printed.', 'Page numbers help readers; low-content books may omit them intentionally.');
      const bodyStart = l.pages.findIndex((p) => p.section !== 'front');
      const bad = numbered.filter((p) => Number(p.displayNumber) !== p.index - bodyStart + 1);
      const frontNumbered = l.pages.filter((p) => p.section === 'front' && p.displayNumber !== null);
      if (bad.length || frontNumbered.length) return FAIL(`Inconsistent numbers on ${list([...bad, ...frontNumbered].map((p) => `p.${p.pageNumber} shows "${p.displayNumber}"`))}`);
      return PASS(`${numbered.length} pages numbered sequentially from the first body page.`);
    },
  },
  {
    id: 'INT-FONT-001',
    version: 1,
    title: 'Fonts embedded',
    description: 'All fonts in the interior PDF must be embedded.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_INTERIOR,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Re-export using only the bundled embeddable fonts.',
    check(ctx) {
      const p = ctx.interior?.pdf;
      if (!p) return NA('No interior PDF rendered yet.');
      const missing = p.fonts.filter((f) => !f.embedded);
      return missing.length ? FAIL(`Not embedded: ${missing.map((f) => f.name).join(', ')}`) : PASS(`${p.fonts.length} font(s), all embedded: ${p.fonts.map((f) => f.name).join(', ')}.`);
    },
  },
  {
    id: 'INT-IMG-001',
    version: 1,
    title: 'Image resolution',
    description: 'Images should print at 300 DPI or more.',
    category: 'TECHNICAL',
    severity: 'MAJOR',
    appliesTo: PRINT,
    blocking: false,
    source: KDP_INTERIOR,
    sourceVerification: 'UNVERIFIED',
    lastVerified: D,
    defaultSuggestion: 'Use a higher-resolution image or print it smaller.',
    check(ctx) {
      const l = ctx.interior?.layout;
      if (!l) return NA('No interior layout.');
      if (l.imageUsage.length === 0) return NA('No images in the interior.');
      const low = l.imageUsage.filter((u) => u.effectiveDpi < ctx.spec.files.minImageDpi);
      return low.length ? WARN(list(low.map((u) => `p.${u.pageIndex + 1}: ${u.assetId} at ${u.effectiveDpi} DPI`))) : PASS(`${l.imageUsage.length} image placement(s), all ≥ ${ctx.spec.files.minImageDpi} DPI.`);
    },
  },
  {
    id: 'INT-IMG-002',
    version: 1,
    title: 'Referenced images present',
    description: 'Every referenced image asset must exist and be embedded.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: ALL,
    blocking: true,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Re-upload the missing image or remove the element.',
    check(ctx) {
      if (!ctx.interior) return NA('No interior layout.');
      const w = layoutWarnings(ctx, ['MISSING_ASSET']);
      return w.length ? FAIL(list(w.map((x) => pg(x.pageIndex) + x.message))) : PASS('All referenced images are available.');
    },
  },
  {
    id: 'INT-PDF-001',
    version: 1,
    title: 'PDF integrity, encryption, and interactivity',
    description: 'The PDF must parse cleanly, must not be encrypted, and must not contain JavaScript or annotations.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_INTERIOR,
    sourceVerification: 'UNVERIFIED',
    lastVerified: D,
    defaultSuggestion: 'Re-export the PDF without security settings, forms, or scripts.',
    check(ctx) {
      const p = ctx.interior?.pdf;
      if (!p) return NA('No interior PDF rendered yet.');
      const issues: string[] = [];
      if (!p.ok) issues.push(p.error ?? 'PDF could not be parsed.');
      if (p.encrypted) issues.push('PDF is encrypted.');
      if (p.hasJavaScript) issues.push('PDF contains JavaScript/OpenAction.');
      if (p.pages.some((x) => x.hasAnnotations)) issues.push('PDF contains annotations/links.');
      if (p.pages.some((x) => x.rotation !== 0)) issues.push('Some pages are rotated.');
      return issues.length ? FAIL(issues.join(' ')) : PASS(`PDF ${p.pdfVersion} parses cleanly; not encrypted; no scripts or annotations.`);
    },
  },
  {
    id: 'INT-SIZE-001',
    version: 1,
    title: 'Interior file size',
    description: 'Interior PDF must be under the maximum upload size.',
    category: 'TECHNICAL',
    severity: 'MAJOR',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_INTERIOR,
    sourceVerification: 'UNVERIFIED',
    lastVerified: D,
    defaultSuggestion: 'Reduce image resolution above 300 DPI or compress images.',
    check(ctx) {
      const p = ctx.interior?.pdf;
      if (!p) return NA('No interior PDF rendered yet.');
      const mb = p.fileSizeBytes / 1024 / 1024;
      return mb > ctx.spec.files.interiorMaxMb ? FAIL(`${round(mb, 1)} MB > ${ctx.spec.files.interiorMaxMb} MB.`) : PASS(`${round(mb, 2)} MB.`);
    },
  },
  {
    id: 'INT-PLH-001',
    version: 1,
    title: 'No placeholder text',
    description: 'Template placeholders, lorem ipsum, and TODO markers must not reach print.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: ALL,
    blocking: true,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Fill in or delete the placeholder text.',
    check(ctx) {
      const l = ctx.interior?.layout;
      if (!l) return NA('No interior layout.');
      const hits = l.pages.filter((p) => PLACEHOLDER_RE.test(p.textContent)).map((p) => `p.${p.pageNumber}: "${p.textContent.match(PLACEHOLDER_RE)![0]}"`);
      return hits.length ? FAIL(list(hits)) : PASS('No placeholder text found.');
    },
  },
  {
    id: 'INT-LINE-001',
    version: 1,
    title: 'Printable line weights',
    description: 'Lines thinner than 0.5pt may not reproduce reliably.',
    category: 'TECHNICAL',
    severity: 'MINOR',
    appliesTo: PRINT,
    blocking: false,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Use line weights of 0.5pt or more.',
    check(ctx) {
      if (!ctx.interior) return NA('No interior layout.');
      const w = layoutWarnings(ctx, ['THIN_LINE']);
      return w.length ? WARN(`${w.length} thin line element(s): ${list([...new Set(w.map((x) => x.message))])}`) : PASS('All lines ≥ 0.5pt.');
    },
  },
  {
    id: 'INT-COLOR-001',
    version: 1,
    title: 'Color in black & white interior',
    description: 'Colored elements in a black & white interior are printed in grayscale.',
    category: 'TECHNICAL',
    severity: 'INFO',
    appliesTo: PRINT,
    blocking: false,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Check contrast in grayscale or choose a color interior.',
    check(ctx) {
      const l = ctx.interior?.layout;
      if (!l) return NA('No interior layout.');
      if (l.spec.input.ink !== 'BLACK_WHITE') return NA('Color interior.');
      const w = layoutWarnings(ctx, ['COLOR_IN_BW']);
      return w.length ? WARN(`${w.length} colored element(s) converted to grayscale.`) : PASS('Interior is grayscale.');
    },
  },
  /* ---------------------------------- Cover technical ---------------------------------- */
  {
    id: 'COV-GEO-001',
    version: 1,
    title: 'Cover geometry resolved for final page count',
    description: 'Cover dimensions must be computed from the final page count, paper, and trim (hardcover from the official calculator/template).',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_COVER,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Regenerate cover geometry after finalising the interior; for hardcover enter the official calculator values.',
    check(ctx) {
      const c = ctx.cover;
      if (!c) return NA('No cover design.');
      const g = c.geometry;
      const fails = g.issues.filter((i) => i.severity === 'FAIL');
      if (fails.length) return FAIL(fails.map((i) => i.message).join(' '));
      if (ctx.interior && g.pageCount !== ctx.interior.layout.pageCount) return FAIL(`Cover was built for ${g.pageCount} pages; interior has ${ctx.interior.layout.pageCount}.`);
      const reviews = g.issues.filter((i) => i.severity !== 'FAIL');
      const ev = `${g.widthIn}" × ${g.heightIn}", spine ${g.spineWidthIn}" (${g.source === 'OFFICIAL_TEMPLATE' ? 'official template values' : 'KDP formula'}).`;
      if (reviews.length) return REVIEW(ev + ' ' + reviews.map((i) => i.message).join(' '));
      return PASS(ev);
    },
  },
  {
    id: 'COV-DIM-001',
    version: 1,
    title: 'Cover PDF dimensions',
    description: 'Cover PDF must be one page sized exactly to the full wrap (including bleed/wrap).',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_COVER,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Re-render the cover PDF.',
    check(ctx) {
      const c = ctx.cover;
      if (!c?.pdf) return NA('No cover PDF rendered yet.');
      if (c.pdf.pageCount !== 1) return FAIL(`Cover PDF has ${c.pdf.pageCount} pages; expected 1.`);
      const p = c.pdf.pages[0];
      if (!approxEqual(p.mediaBoxIn.w, c.geometry.widthIn, 0.01) || !approxEqual(p.mediaBoxIn.h, c.geometry.heightIn, 0.01))
        return FAIL(`PDF is ${p.mediaBoxIn.w}" × ${p.mediaBoxIn.h}"; expected ${c.geometry.widthIn}" × ${c.geometry.heightIn}".`);
      return PASS(`Single page ${p.mediaBoxIn.w}" × ${p.mediaBoxIn.h}".`);
    },
  },
  {
    id: 'COV-SPN-001',
    version: 1,
    title: 'Spine text eligibility and fit',
    description: 'Spine text is only allowed above the minimum page count and must fit inside the spine safe area.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_COVER,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Remove spine text for thin books, or reduce its size.',
    check(ctx) {
      const c = ctx.cover;
      if (!c) return NA('No cover design.');
      const w = c.layout.warnings.filter((x) => x.code === 'SPINE_TEXT_NOT_ALLOWED' || x.code === 'SPINE_TEXT_TOO_WIDE');
      if (w.length) return FAIL(w.map((x) => x.message).join(' '));
      return PASS(c.geometry.spineTextAllowed ? `Spine ${c.geometry.spineWidthIn}" — spine text allowed and fits.` : `No spine text (${c.geometry.pageCount} pages is below the spine-text minimum).`);
    },
  },
  {
    id: 'COV-SAFE-001',
    version: 1,
    title: 'Cover text inside safe zones',
    description: 'Cover text must be at least 0.125" inside the trim (and clear of hinges on hardcover).',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: ALL,
    blocking: true,
    source: KDP_COVER,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Move the text inside the blue safe-zone guide.',
    check(ctx) {
      const c = ctx.cover;
      if (!c) return NA('No cover design.');
      const w = c.layout.warnings.filter((x) => x.code === 'TEXT_OUTSIDE_SAFE' || x.code === 'TEXT_OVERFLOW');
      return w.length ? FAIL(list(w.map((x) => x.message))) : PASS('All cover text is inside the safe zones.');
    },
  },
  {
    id: 'COV-BAR-001',
    version: 1,
    title: 'Barcode area clear',
    description: 'When KDP supplies the barcode, the barcode area on the back cover must be free of text and important art. Never invent ISBNs or barcodes.',
    category: 'TECHNICAL',
    severity: 'MAJOR',
    appliesTo: PRINT,
    blocking: false,
    source: KDP_COVER,
    sourceVerification: 'UNVERIFIED',
    lastVerified: D,
    defaultSuggestion: 'Move text/art out of the barcode area, or confirm placement with the official template.',
    check(ctx) {
      const c = ctx.cover;
      if (!c) return NA('No cover design.');
      if (c.design.barcode === 'OWN_BARCODE') return REVIEW('Publisher-supplied barcode: confirm it encodes your own valid ISBN and scans correctly.');
      if (c.design.barcode === 'NOT_APPLICABLE') return REVIEW('Barcode marked not applicable — confirm the chosen KDP workflow does not require a clear barcode area.');
      const w = c.layout.warnings.filter((x) => x.code === 'BARCODE_AREA_OBSTRUCTED');
      return w.length ? FAIL(list(w.map((x) => x.message)) + ' (barcode position from unverified default; confirm with the official template)') : PASS('Barcode area is clear.');
    },
  },
  {
    id: 'COV-IMG-001',
    version: 1,
    title: 'Cover image resolution',
    description: 'Cover images should print at 300 DPI or more.',
    category: 'TECHNICAL',
    severity: 'MAJOR',
    appliesTo: PRINT,
    blocking: false,
    source: KDP_COVER,
    sourceVerification: 'UNVERIFIED',
    lastVerified: D,
    defaultSuggestion: 'Use a larger image or reduce its printed size.',
    check(ctx) {
      const c = ctx.cover;
      if (!c) return NA('No cover design.');
      const imgs = c.layout.layers.filter((l) => l.image);
      if (!imgs.length) return NA('No raster images on the cover.');
      const w = c.layout.warnings.filter((x) => x.code === 'LOW_DPI');
      return w.length ? WARN(list(w.map((x) => x.message))) : PASS(`${imgs.length} image(s) at ≥ ${ctx.spec.files.minImageDpi} DPI.`);
    },
  },
  {
    id: 'COV-BLEED-001',
    version: 1,
    title: 'Cover artwork extends to bleed',
    description: 'Background art touching the trim must continue to the bleed edge.',
    category: 'TECHNICAL',
    severity: 'MINOR',
    appliesTo: PRINT,
    blocking: false,
    source: KDP_COVER,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Extend the element to the canvas edge.',
    check(ctx) {
      const c = ctx.cover;
      if (!c) return NA('No cover design.');
      const w = c.layout.warnings.filter((x) => x.code === 'BLEED_GAP');
      return w.length ? WARN(list(w.map((x) => x.message))) : PASS('No bleed gaps detected.');
    },
  },
  {
    id: 'COV-FONT-001',
    version: 1,
    title: 'Cover fonts embedded and glyphs present',
    description: 'All cover fonts must be embedded and support every character used.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: ALL,
    blocking: true,
    source: KDP_COVER,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Use bundled fonts and supported characters.',
    check(ctx) {
      const c = ctx.cover;
      if (!c) return NA('No cover design.');
      const glyph = c.layout.warnings.filter((x) => x.code === 'MISSING_GLYPH');
      const notEmb = c.pdf?.fonts.filter((f) => !f.embedded) ?? [];
      if (glyph.length || notEmb.length) return FAIL([...glyph.map((x) => x.message), ...notEmb.map((f) => `Not embedded: ${f.name}`)].join(' '));
      return PASS(c.pdf ? `Fonts embedded: ${c.pdf.fonts.map((f) => f.name).join(', ') || 'none'}.` : 'All glyphs available (PDF not rendered yet).');
    },
  },
  {
    id: 'COV-PDF-001',
    version: 1,
    title: 'Cover PDF integrity and size',
    description: 'Cover PDF must parse, be unencrypted, and stay under the size limit (≤ 40 MB recommended).',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: PRINT,
    blocking: true,
    source: KDP_COVER,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Re-export the cover; compress oversized images.',
    check(ctx) {
      const p = ctx.cover?.pdf;
      if (!p) return NA('No cover PDF rendered yet.');
      if (!p.ok || p.encrypted || p.hasJavaScript) return FAIL([p.error, p.encrypted && 'Encrypted.', p.hasJavaScript && 'Contains JavaScript.'].filter(Boolean).join(' '));
      const mb = p.fileSizeBytes / 1024 / 1024;
      if (mb > 650) return FAIL(`${round(mb, 1)} MB exceeds 650 MB.`);
      if (mb > ctx.spec.files.coverMaxMb) return WARN(`${round(mb, 1)} MB exceeds the recommended ${ctx.spec.files.coverMaxMb} MB.`);
      return PASS(`${round(mb, 2)} MB; parses cleanly; not encrypted.`);
    },
  },
  {
    id: 'COV-PLH-001',
    version: 1,
    title: 'No placeholder text on cover',
    description: 'Placeholder or template text must not appear on the cover.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: ALL,
    blocking: true,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Replace placeholder text.',
    check(ctx) {
      const c = ctx.cover;
      if (!c) return NA('No cover design.');
      const w = c.layout.warnings.filter((x) => x.code === 'PLACEHOLDER_TEXT');
      return w.length ? FAIL(list(w.map((x) => x.message))) : PASS('No placeholder text.');
    },
  },
  {
    id: 'COV-META-001',
    version: 1,
    title: 'Cover title matches metadata',
    description: 'The title on the cover should match the metadata title; the author name should match too.',
    category: 'METADATA',
    severity: 'MAJOR',
    appliesTo: ALL,
    blocking: false,
    source: KDP_METADATA,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Make the cover title/author identical to the metadata.',
    check(ctx) {
      if (!ctx.cover || !ctx.metadata) return NA('Needs both a cover and metadata.');
      const text = coverText(ctx);
      const issues: string[] = [];
      if (!titlesConsistent(ctx.metadata.title, text)) issues.push(`Cover text does not contain the metadata title "${ctx.metadata.title}".`);
      if (ctx.metadata.author && !titlesConsistent(ctx.metadata.author, text)) issues.push(`Cover text does not contain the author "${ctx.metadata.author}".`);
      return issues.length ? FAIL(issues.join(' ')) : PASS('Cover title and author match metadata.');
    },
  },
  /* ---------------------------------------- eBook ---------------------------------------- */
  {
    id: 'EBK-COV-001',
    version: 1,
    title: 'eBook cover image dimensions',
    description: 'eBook covers should be 1600 × 2560 px (minimum 625 × 1000 px, 1.6:1 ratio).',
    category: 'TECHNICAL',
    severity: 'MAJOR',
    appliesTo: ['EBOOK'],
    blocking: false,
    source: 'https://kdp.amazon.com/en_US/help/topic/G6GTK3T3NUHKLEFX',
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Export the eBook cover at 1600 × 2560 px.',
    check(ctx) {
      const px = ctx.cover?.coverImagePx;
      if (!px) return NA('No eBook cover image exported yet.');
      const e = ctx.spec.ebook;
      if (px.widthPx < e.coverMinWidthPx || px.heightPx < e.coverMinHeightPx) return FAIL(`${px.widthPx} × ${px.heightPx} px is below the ${e.coverMinWidthPx} × ${e.coverMinHeightPx} px minimum.`);
      const ratio = px.heightPx / px.widthPx;
      if (Math.abs(ratio - 1.6) > 0.05) return WARN(`Aspect ratio ${round(ratio, 2)}:1; recommended 1.6:1.`);
      return PASS(`${px.widthPx} × ${px.heightPx} px.`);
    },
  },
  {
    id: 'EBK-EPUB-001',
    version: 1,
    title: 'EPUB structure',
    description: 'EPUB must contain mimetype, container, package document, navigation, and at least one content document.',
    category: 'TECHNICAL',
    severity: 'CRITICAL',
    appliesTo: ['EBOOK'],
    blocking: true,
    source: 'https://www.w3.org/TR/epub-33/',
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Re-export the EPUB.',
    check(ctx) {
      const e = ctx.ebook?.epub;
      if (!e) return NA('No EPUB exported yet.');
      return e.ok ? PASS(`${e.chapterCount} content document(s); nav ${e.hasNav ? 'present' : 'missing'}; cover ${e.hasCover ? 'present' : 'missing'}.`) : FAIL(e.errors.join(' '));
    },
  },
  {
    id: 'EBK-FIT-001',
    version: 1,
    title: 'Content suitable for reflowable eBook',
    description: 'Low-content and form-based books (journals, planners, logbooks) generally do not work as reflowable Kindle eBooks.',
    category: 'CONTENT',
    severity: 'MAJOR',
    appliesTo: ['EBOOK'],
    blocking: false,
    source: INTERNAL,
    sourceVerification: 'INTERNAL_HEURISTIC',
    lastVerified: D,
    defaultSuggestion: 'Publish fillable products as print books; use eBook for text-based content.',
    check(ctx) {
      if (ctx.contentClass === 'LOW') return FAIL('Low-content products are not meaningful as reflowable eBooks (readers cannot write in them).');
      if (ctx.contentClass === 'MEDIUM') return REVIEW('Medium-content product: confirm the eBook delivers value without writable pages, or use a fixed-layout workflow.');
      return PASS('Full-content book.');
    },
  },
  /* -------------------------------------- Metadata --------------------------------------- */
  ...(
    [
      ['META-TTL-001', 'Title and subtitle', ['title', 'subtitle'], 'Keep titles accurate and free of promotional terms; title + subtitle ≤ 200 characters.'],
      ['META-AUTH-001', 'Author and contributors', ['author'], 'Enter the author/contributor names exactly as on the cover.'],
      ['META-DESC-001', 'Description', ['description'], 'Describe the actual content; avoid unverifiable claims, URLs, and unsupported HTML.'],
      ['META-KW-001', 'Keywords', ['keywords'], 'Use up to 7 relevant keywords ≤ 50 characters, with recorded research evidence; no promotional terms or other brands.'],
      ['META-CAT-001', 'Categories', ['categories'], 'Choose categories that match the book content.'],
      ['META-ID-001', 'ISBN, series, and reading age', ['isbn', 'series', 'readingAge'], 'Use only ISBNs you own (or KDP-assigned). Never invent identifiers.'],
    ] as const
  ).map(
    ([id, title, fields, suggestion]): RuleDefinition => ({
      id,
      version: 1,
      title,
      description: `Metadata checks for: ${fields.join(', ')}.`,
      category: 'METADATA',
      severity: 'MAJOR',
      appliesTo: ALL,
      blocking: false,
      source: KDP_METADATA,
      sourceVerification: 'CORROBORATED',
      lastVerified: D,
      defaultSuggestion: suggestion,
      check(ctx) {
        if (!ctx.metadata) return NA('No metadata draft.');
        const f = checkMetadata(ctx.metadata).filter((x) => (fields as readonly string[]).includes(x.field));
        if (!f.length) return PASS('No issues found.');
        const ev = list(f.map((x) => x.message + (x.evidence ? ` [${x.evidence.slice(0, 80)}]` : '')), 8);
        if (f.some((x) => x.status === 'FAIL')) return FAIL(ev);
        if (f.some((x) => x.status === 'NEEDS_HUMAN_REVIEW')) return REVIEW(ev);
        return WARN(ev);
      },
    }),
  ),
  /* --------------------------------- Content & policy risk -------------------------------- */
  {
    id: 'CNT-TM-001',
    version: 1,
    title: 'Potential trademark conflicts',
    description: 'Screens titles, metadata, cover text, and interior text against a watch-list of well-known marks.',
    category: 'CONTENT',
    severity: 'MAJOR',
    appliesTo: ALL,
    blocking: false,
    source: KDP_CONTENT,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Remove third-party marks unless you have rights; run a proper trademark search (e.g. USPTO) for your title.',
    check(ctx) {
      const corpus = ' ' + normalizeText([allMetadataText(ctx), coverText(ctx), ctx.interiorText ?? ''].join('\n')) + ' ';
      const hits = TRADEMARK_WATCHLIST.filter((t) => corpus.includes(' ' + normalizeText(t) + ' '));
      return hits.length ? REVIEW(`Watch-list terms found: ${hits.join(', ')}. This is a screening hit, not a legal finding.`) : PASS('No watch-list trademarks found (screening only; not a trademark search).');
    },
  },
  {
    id: 'CNT-CPY-001',
    version: 1,
    title: 'Potential copyright / third-party material',
    description: 'Looks for lyrics, long quotations, excerpts, and third-party assets that may need permission.',
    category: 'CONTENT',
    severity: 'MAJOR',
    appliesTo: ALL,
    blocking: false,
    source: KDP_CONTENT,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Confirm you own or have permission for flagged material; keep permission records.',
    check(ctx) {
      const text = [ctx.interiorText ?? '', ctx.ebook?.text ?? '', ctx.metadata?.description ?? ''].join('\n');
      const hits = COPYRIGHT_SIGNALS.filter((s) => s.re.test(text)).map((s) => `${s.label}: "${text.match(s.re)![0].slice(0, 60)}"`);
      // Copyright notices naming someone other than the author/imprint suggest third-party material.
      const owners = [ctx.metadata?.author, ctx.metadata?.imprint, ...(ctx.metadata?.contributors.map((c) => c.name) ?? [])].filter(Boolean).map((o) => normalizeText(o!));
      for (const m of text.matchAll(/(?:©|\(c\)|copyright)\s*(?:©\s*)?\d{4}(?:[-–]\d{2,4})?\s+([^.\n]{2,60})/gi)) {
        const holder = normalizeText(m[1].replace(/all rights reserved/i, ''));
        if (holder && !owners.some((o) => holder.includes(o) || o.includes(holder))) hits.push(`third-party copyright notice: "${m[0].slice(0, 60)}"`);
      }
      const unlicensed = (ctx.assets ?? []).filter((a) => a.source === 'UPLOAD' && !a.licenseNote.trim()).map((a) => `uploaded asset ${a.assetId} has no license note`);
      const all = [...hits, ...unlicensed];
      return all.length ? REVIEW(list(all)) : PASS('No third-party material signals found (heuristic).');
    },
  },
  {
    id: 'CNT-DUP-001',
    version: 1,
    title: 'Near-duplicate titles or interiors in your portfolio',
    description: 'Compares this product with your other projects. KDP may reject near-identical books.',
    category: 'CONTENT',
    severity: 'MAJOR',
    appliesTo: ALL,
    blocking: false,
    source: KDP_CONTENT,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Differentiate the content (structure, prompts, audience-specific material), not just title/colour.',
    check(ctx) {
      if (!ctx.portfolio?.length) return NA('No other projects to compare.');
      const title = ctx.metadata?.title ?? '';
      const matches = findSimilar({ title, fingerprint: ctx.fingerprint }, ctx.portfolio);
      return matches.length ? REVIEW(list(matches.map((m) => `${m.kind} similarity ${m.score} with "${m.title}"`))) : PASS(`Compared with ${ctx.portfolio.length} project(s); no near-duplicates.`);
    },
  },
  {
    id: 'CNT-LOWVAL-001',
    version: 1,
    title: 'Repeated or low-value content',
    description: 'Flags interiors made of a single repeated page with little variation, or full-content books with very little text.',
    category: 'CONTENT',
    severity: 'MAJOR',
    appliesTo: ALL,
    blocking: false,
    source: KDP_CONTENT,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Add purposeful structure (guidance pages, varied prompts, sections) that serves the target reader.',
    check(ctx) {
      const l = ctx.interior?.layout;
      const words = (ctx.interiorText ?? '').split(/\s+/).filter(Boolean).length;
      if (!l) {
        if (!ctx.interiorText) return NA('No interior content.');
        if (ctx.contentClass === 'FULL' && words < 2500) return REVIEW(`Full-content book with only ~${words} words of text. Make sure the length matches the price and description.`);
        return PASS(`~${words} words of text.`);
      }
      const body = l.pages.filter((p) => p.section === 'body' && !p.isBlank);
      const templates = new Set(body.map((p) => p.source.templateId ?? p.source.chapterId ?? 'custom'));
      const uniq = ctx.fingerprint?.uniquePageRatio ?? 1;
      if (ctx.contentClass === 'FULL' && words < 2500) return REVIEW(`Full-content book with only ~${words} words of text.`);
      if (ctx.contentClass !== 'LOW' && uniq < 0.2) return REVIEW(`Only ${Math.round(uniq * 100)}% of pages are distinct for a ${ctx.contentClass.toLowerCase()}-content book.`);
      if (templates.size === 1 && body.length > 20 && !l.pages.some((p) => p.section === 'front')) return WARN(`All ${body.length} body pages use one layout and there is no front matter.`, 'Add a title page and at least a how-to-use page, or vary the page sequence.');
      return PASS(`${templates.size} distinct page layout(s); ${Math.round(uniq * 100)}% distinct pages.`);
    },
  },
  {
    id: 'CNT-CLAIM-001',
    version: 1,
    title: 'Unsupported factual claims',
    description: 'Medical, financial, and efficacy claims need substantiation.',
    category: 'CONTENT',
    severity: 'MAJOR',
    appliesTo: ALL,
    blocking: false,
    source: KDP_CONTENT,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Remove the claim or add verifiable sources and appropriate disclaimers.',
    check(ctx) {
      const text = [ctx.interiorText ?? '', ctx.ebook?.text ?? '', allMetadataText(ctx), coverText(ctx)].join('\n');
      const hits = UNSUPPORTED_CLAIM_PATTERNS.filter((c) => c.re.test(text)).map((c) => `${c.label}: "${text.match(c.re)![0]}"`);
      return hits.length ? REVIEW(list(hits)) : PASS('No claim patterns detected (heuristic).');
    },
  },
  {
    id: 'CNT-RESTRICT-001',
    version: 1,
    title: 'Potentially restricted content',
    description: 'Screens for content categories KDP restricts or reviews closely.',
    category: 'CONTENT',
    severity: 'MAJOR',
    appliesTo: ALL,
    blocking: false,
    source: KDP_CONTENT,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Review against the KDP content guidelines.',
    check(ctx) {
      const text = [ctx.interiorText ?? '', ctx.ebook?.text ?? '', allMetadataText(ctx), coverText(ctx)].join('\n');
      const hits = RESTRICTED_SIGNALS.filter((c) => c.re.test(text)).map((c) => c.label);
      return hits.length ? REVIEW(`Signals: ${hits.join(', ')}.`) : PASS('No restricted-content signals (heuristic).');
    },
  },
  {
    id: 'CNT-EXP-001',
    version: 1,
    title: 'Reader expectations match the product',
    description: 'Numeric promises in the title/subtitle/description (e.g. "365 days", "100 prompts") should match the interior.',
    category: 'CONTENT',
    severity: 'MAJOR',
    appliesTo: ALL,
    blocking: false,
    source: KDP_METADATA,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Make the title/description promise match the actual content.',
    check(ctx) {
      const l = ctx.interior?.layout;
      const m = ctx.metadata;
      if (!l || !m) return NA('Needs interior and metadata.');
      const text = `${m.title} ${m.subtitle} ${m.description}`;
      const issues: string[] = [];
      for (const mm of text.matchAll(/\b(\d{2,4})[- ](days?|pages?|weeks?|prompts?|entries|logs?|exercises?|recipes?)\b/gi)) {
        const n = Number(mm[1]);
        const unit = mm[2].toLowerCase();
        const bodyPages = l.pages.filter((p) => p.section === 'body' && !p.isBlank).length;
        if (unit.startsWith('page') && Math.abs(l.pageCount - n) > Math.max(4, n * 0.05)) issues.push(`Promises ${n} pages; book has ${l.pageCount}.`);
        if ((unit.startsWith('day') || unit.startsWith('entr') || unit.startsWith('log') || unit.startsWith('prompt') || unit.startsWith('exercise')) && bodyPages < n * 0.9 && bodyPages * 2 < n)
          issues.push(`Promises ${n} ${unit}; only ${bodyPages} body pages (verify capacity).`);
        if (unit.startsWith('week') && bodyPages < n) issues.push(`Promises ${n} weeks; only ${bodyPages} body pages.`);
      }
      if (/\bguided\b/i.test(text) && ctx.contentClass === 'LOW') issues.push('Marketed as "guided" but classified as low-content (no prompts/guidance).');
      return issues.length ? REVIEW(issues.join(' ')) : PASS('No mismatched numeric promises detected.');
    },
  },
  {
    id: 'CNT-AI-001',
    version: 1,
    title: 'AI-generated content disclosure',
    description: 'KDP asks publishers to disclose AI-generated text, images, or translations when publishing.',
    category: 'CONTENT',
    severity: 'MAJOR',
    appliesTo: ALL,
    blocking: false,
    source: KDP_AI,
    sourceVerification: 'CORROBORATED',
    lastVerified: D,
    defaultSuggestion: 'Answer the AI-content questions truthfully in KDP during publishing, then acknowledge here.',
    check(ctx) {
      const a = ctx.ai;
      if (!a || (!a.textGenerated && !a.imagesGenerated)) return PASS('No AI-generated content recorded for this project.');
      const what = [a.textGenerated && 'text', a.imagesGenerated && 'images'].filter(Boolean).join(' and ');
      return a.disclosureAcknowledged ? PASS(`AI-generated ${what} recorded; disclosure reminder acknowledged.`) : REVIEW(`This project contains AI-generated ${what}. You must disclose this in KDP's content questions.`);
    },
  },
  {
    id: 'CNT-LOWC-001',
    version: 1,
    title: 'Low-content classification',
    description: 'Low-content books (journals, logbooks, notebooks) have specific KDP options and limitations.',
    category: 'CONTENT',
    severity: 'INFO',
    appliesTo: ALL,
    blocking: false,
    source: KDP_LOW_CONTENT,
    sourceVerification: 'UNVERIFIED',
    lastVerified: D,
    defaultSuggestion: 'Tick the low-content option in KDP where appropriate.',
    check(ctx) {
      if (ctx.contentClass !== 'LOW') return NA(`${ctx.contentClass.toLowerCase()}-content product.`);
      const notes = ['Low-content print books can be published without an ISBN (no ISBN means a narrower distribution).', '"Look Inside" may not be available.'];
      if (ctx.format === 'HARDCOVER') return REVIEW(notes.join(' ') + ' Confirm low-content is supported for hardcover in your marketplace.');
      return REVIEW(notes.join(' '));
    },
  },
];

export function getRule(id: string): RuleDefinition | undefined {
  return RULES.find((r) => r.id === id);
}
