import { round } from '../units';
import { KDP_SPEC_2026_10 } from './kdp-2026-10';
import {
  SpecLibrary,
  type BookFormat,
  type InkType,
  type PageCountLimit,
  type PaperType,
  type TrimSizeSpec,
  type Verification,
} from './types';

/**
 * Specification adapter. The renderer and validators depend only on this interface, so
 * official dimensions can be updated (new built-in version, DB override, imported template)
 * without touching rendering code.
 */
export interface SpecSource {
  listVersions(): string[];
  getLibrary(version?: string): SpecLibrary;
}

export class BuiltInSpecSource implements SpecSource {
  private readonly libraries: Map<string, SpecLibrary>;
  constructor(libraries: SpecLibrary[] = [KDP_SPEC_2026_10]) {
    this.libraries = new Map(libraries.map((l) => [l.version, SpecLibrary.parse(l)]));
  }
  listVersions(): string[] {
    return [...this.libraries.keys()].sort();
  }
  getLibrary(version?: string): SpecLibrary {
    const v = version ?? this.listVersions().at(-1)!;
    const lib = this.libraries.get(v);
    if (!lib) throw new SpecError(`Unknown specification version "${v}"`);
    return lib;
  }
}

/**
 * Applies a validated partial override (e.g. a workspace admin updating a value after KDP
 * changes a rule) on top of a base library, producing a new version string.
 */
export function applySpecOverride(base: SpecLibrary, override: Partial<SpecLibrary> & { version: string }): SpecLibrary {
  return SpecLibrary.parse({ ...base, ...override });
}

export const defaultSpecSource = new BuiltInSpecSource();

export class SpecError extends Error {}

export interface PrintSpecInput {
  format: Exclude<BookFormat, 'EBOOK'>;
  trimId: string;
  pageCount: number;
  ink: InkType;
  paper: PaperType;
  bleed: boolean;
}

export interface SpecIssue {
  code: string;
  severity: 'FAIL' | 'WARNING' | 'NEEDS_HUMAN_REVIEW';
  message: string;
  verification?: Verification;
}

export interface ResolvedPrintSpec {
  specVersion: string;
  input: PrintSpecInput;
  trim: TrimSizeSpec;
  isLargeTrim: boolean;
  /** Final PDF page size (trim + bleed where applicable). */
  pageWidthIn: number;
  pageHeightIn: number;
  bleed: { outsideIn: number; topIn: number; bottomIn: number; insideIn: number };
  minMargins: { insideIn: number; outsideIn: number; topIn: number; bottomIn: number };
  pageCountLimit: PageCountLimit | null;
  verifications: Verification[];
  issues: SpecIssue[];
}

export function isLargeTrim(lib: SpecLibrary, trim: { widthIn: number; heightIn: number }): boolean {
  return trim.widthIn > lib.largeTrimWidthIn || trim.heightIn > lib.largeTrimHeightIn;
}

export function findTrim(lib: SpecLibrary, trimId: string): TrimSizeSpec {
  const trim = lib.trimSizes.find((t) => t.id === trimId);
  if (!trim) throw new SpecError(`Trim size "${trimId}" is not in specification ${lib.version}`);
  return trim;
}

export function gutterForPageCount(lib: SpecLibrary, format: 'PAPERBACK' | 'HARDCOVER', pageCount: number): number | null {
  const table = lib.interior[format].gutterTable;
  const row = table.find((r) => pageCount >= r.minPages && pageCount <= r.maxPages);
  if (row) return row.insideIn;
  // Below the table minimum the first tier is the safest documented value.
  if (pageCount < table[0].minPages) return table[0].insideIn;
  return null;
}

export function findPageCountLimit(lib: SpecLibrary, input: PrintSpecInput, large: boolean): PageCountLimit | null {
  const trimClass = large ? 'LARGE' : 'STANDARD';
  return (
    lib.pageCountLimits.find(
      (l) =>
        l.format === input.format &&
        (l.ink === 'ANY' || l.ink === input.ink) &&
        (l.paper === 'ANY' || l.paper === input.paper) &&
        (l.trimClass === 'ANY' || l.trimClass === trimClass),
    ) ?? null
  );
}

/** Resolve every interior geometry requirement for a print format. Pure and deterministic. */
export function resolvePrintSpec(input: PrintSpecInput, source: SpecSource = defaultSpecSource, version?: string): ResolvedPrintSpec {
  const lib = source.getLibrary(version);
  const trim = findTrim(lib, input.trimId);
  const issues: SpecIssue[] = [];
  const rules = lib.interior[input.format];
  const verifications: Verification[] = [trim.verification, rules.verification];

  if (!trim.formats.includes(input.format)) {
    issues.push({
      code: 'SPEC_TRIM_FORMAT',
      severity: 'FAIL',
      message: `Trim ${trim.label} is not listed for ${input.format.toLowerCase()} in ${lib.version}.`,
      verification: trim.verification,
    });
  }
  if (input.paper === 'CREAM' && input.ink !== 'BLACK_WHITE') {
    issues.push({ code: 'SPEC_PAPER_INK', severity: 'FAIL', message: 'Cream paper is only offered with black & white ink.' });
  }

  const large = isLargeTrim(lib, trim);
  const limit = findPageCountLimit(lib, input, large);
  if (!limit) {
    issues.push({ code: 'SPEC_NO_PAGE_LIMIT', severity: 'NEEDS_HUMAN_REVIEW', message: 'No page-count rule matches this ink/paper/trim combination.' });
  } else {
    verifications.push(limit.verification);
    if (input.pageCount < limit.minPages || input.pageCount > limit.maxPages) {
      issues.push({
        code: 'SPEC_PAGE_COUNT',
        severity: limit.verification.status === 'UNVERIFIED' ? 'NEEDS_HUMAN_REVIEW' : 'FAIL',
        message: `Page count ${input.pageCount} is outside ${limit.minPages}–${limit.maxPages} for this configuration.`,
        verification: limit.verification,
      });
    }
  }

  const gutter = gutterForPageCount(lib, input.format, input.pageCount);
  if (gutter === null) {
    issues.push({ code: 'SPEC_GUTTER', severity: 'FAIL', message: `No gutter rule for ${input.pageCount} pages.` });
  }
  const outside = input.bleed ? rules.minOutsideMarginBleedIn : rules.minOutsideMarginNoBleedIn;
  const bleed = input.bleed ? rules.bleed : { outsideIn: 0, topIn: 0, bottomIn: 0, insideIn: 0 };

  return {
    specVersion: lib.version,
    input,
    trim,
    isLargeTrim: large,
    pageWidthIn: round(trim.widthIn + bleed.outsideIn + bleed.insideIn),
    pageHeightIn: round(trim.heightIn + bleed.topIn + bleed.bottomIn),
    bleed,
    minMargins: { insideIn: gutter ?? lib.interior[input.format].gutterTable.at(-1)!.insideIn, outsideIn: outside, topIn: outside, bottomIn: outside },
    pageCountLimit: limit,
    verifications,
    issues,
  };
}
