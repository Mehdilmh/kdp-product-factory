import type { MetadataDraft } from '../metadata';

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function metadataToJson(m: MetadataDraft, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, metadata: m }, null, 2);
}

/** One row per field — easy to paste into KDP's form by hand. Nothing is published automatically. */
export function metadataToCsv(m: MetadataDraft): string {
  const rows: [string, unknown][] = [
    ['title', m.title],
    ['subtitle', m.subtitle],
    ['author', m.author],
    ['contributors', m.contributors.map((c) => `${c.name} (${c.role})`).join('; ')],
    ['description', m.description],
    ['categories', m.categories.join('; ')],
    ...m.keywords.map((k, i): [string, unknown] => [`keyword_${i + 1}`, k.keyword]),
    ['language', m.language],
    ['reading_age', m.readingAgeMin !== null ? `${m.readingAgeMin}-${m.readingAgeMax ?? ''}` : ''],
    ['series', m.seriesName ? `${m.seriesName}${m.seriesNumber ? ' #' + m.seriesNumber : ''}` : ''],
    ['edition', m.edition],
    ['isbn', m.isbn],
    ['imprint', m.imprint],
    ['low_content', m.lowContent ? 'yes' : 'no'],
  ];
  return ['field,value', ...rows.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`)].join('\r\n') + '\r\n';
}

/** Keyword research log with source/date/evidence for each candidate. */
export function keywordEvidenceCsv(m: MetadataDraft): string {
  return ['keyword,source,recorded_at,evidence', ...m.keywords.map((k) => [k.keyword, k.source, k.recordedAt, k.evidence].map(csvCell).join(','))].join('\r\n') + '\r\n';
}
