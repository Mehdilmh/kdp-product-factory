import { z } from 'zod';
import { normalizeText, tokens } from '../similarity';

export const KeywordEvidence = z.object({
  keyword: z.string().min(1).max(50),
  /** Where the idea came from — e.g. "Amazon search autocomplete (manual)", "AI suggestion", "Reader survey". */
  source: z.string().max(200).default('unspecified'),
  /** ISO date the evidence was recorded. */
  recordedAt: z.string().max(40).default(''),
  /** Free-text evidence (screenshots notes, observed results). Never invented search volumes. */
  evidence: z.string().max(2000).default(''),
});
export type KeywordEvidence = z.infer<typeof KeywordEvidence>;

export const Contributor = z.object({ name: z.string().min(1).max(200), role: z.enum(['AUTHOR', 'EDITOR', 'ILLUSTRATOR', 'TRANSLATOR', 'FOREWORD', 'INTRODUCTION', 'PREFACE', 'PHOTOGRAPHER']) });

export const MetadataDraft = z.object({
  title: z.string().max(400).default(''),
  subtitle: z.string().max(400).default(''),
  author: z.string().max(200).default(''),
  contributors: z.array(Contributor).max(9).default([]),
  description: z.string().max(10000).default(''),
  categories: z.array(z.string().max(300)).max(10).default([]),
  keywords: z.array(KeywordEvidence).max(20).default([]),
  language: z.string().max(40).default('English'),
  readingAgeMin: z.number().int().min(0).max(18).nullable().default(null),
  readingAgeMax: z.number().int().min(0).max(18).nullable().default(null),
  seriesName: z.string().max(200).default(''),
  seriesNumber: z.number().int().positive().nullable().default(null),
  edition: z.string().max(40).default(''),
  isbn: z.string().max(20).default(''),
  imprint: z.string().max(200).default(''),
  lowContent: z.boolean().default(false),
});
export type MetadataDraft = z.infer<typeof MetadataDraft>;
export type MetadataDraftInput = z.input<typeof MetadataDraft>;

export interface MetadataFinding {
  field: string;
  status: 'FAIL' | 'WARNING' | 'NEEDS_HUMAN_REVIEW';
  message: string;
  evidence: string;
}

/** Promotional terms that KDP's metadata guidelines disallow in titles and keywords. */
export const PROMOTIONAL_TERMS = [
  'bestseller', 'best seller', 'bestselling', 'best selling', '#1', 'number one', 'new release', 'brand new',
  'limited time', 'kindle unlimited', 'top rated', 'award winning', 'on sale', 'discount', 'kdp',
];

/** Ambiguous terms: legitimate in some titles ("Stress-Free", "Amazon Rainforest"), so a human decides. */
export const REVIEW_TERMS = ['free', 'sale', 'kindle', 'amazon', 'new', 'cheap'];

function termHits(text: string, terms: string[]): string[] {
  // Hyphenated compounds ("stress-free") are kept intact so they don't match standalone terms.
  const n = ' ' + text.toLowerCase().replace(/#1/g, ' number one ').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ') + ' ';
  return terms.filter((term) => n.includes(' ' + term.replace('#1', 'number one').toLowerCase() + ' '));
}

/** Phrases that require substantiation; flagged for human review in descriptions and interiors. */
export const UNSUPPORTED_CLAIM_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(cures?|heals?|treats?|prevents?)\b[^.]{0,40}\b(cancer|diabetes|depression|anxiety|disease|illness|adhd|autism|covid)/i, label: 'medical treatment claim' },
  { re: /\bclinically (proven|tested)\b/i, label: 'clinical claim' },
  { re: /\b(doctor|physician|therapist)[- ]recommended\b/i, label: 'professional endorsement claim' },
  { re: /\bguarantee(d|s)?\b/i, label: 'guarantee' },
  { re: /\b(lose|drop) \d+ (pounds|lbs|kg|kilos)\b/i, label: 'weight-loss result claim' },
  { re: /\b(get rich|make \$?\d[\d,]*|passive income|double your (money|income))\b/i, label: 'financial result claim' },
  { re: /\b(scientifically|proven) (proven|to work|results)\b/i, label: 'scientific claim' },
  { re: /\b100% (effective|guaranteed|success)\b/i, label: 'absolute efficacy claim' },
  { re: /\b(official|authorized|endorsed by)\b/i, label: 'official/endorsement claim' },
];

export function isbnValid(raw: string): boolean {
  const s = raw.replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((a, c, i) => a + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  if (/^97[89]\d{10}$/.test(s)) {
    const sum = [...s].reduce((a, c, i) => a + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  return false;
}

const ALLOWED_DESC_TAGS = /^(b|i|u|em|strong|br|p|ul|ol|li|h4|h5|h6)$/i;

/** Deterministic metadata checks (length limits, promotional terms, stuffing, claims). */
export function checkMetadata(m: MetadataDraft): MetadataFinding[] {
  const out: MetadataFinding[] = [];
  const add = (field: string, status: MetadataFinding['status'], message: string, evidence = '') => out.push({ field, status, message, evidence });

  if (!m.title.trim()) add('title', 'FAIL', 'Title is required.');
  const tl = (m.title + (m.subtitle ? ': ' + m.subtitle : '')).length;
  if (tl > 200) add('title', 'FAIL', `Title + subtitle is ${tl} characters (KDP limit 200).`, `${tl} characters`);
  for (const [field, text] of [['title', m.title], ['subtitle', m.subtitle]] as const) {
    for (const term of termHits(text, PROMOTIONAL_TERMS)) add(field, 'FAIL', `"${term}" is promotional — not allowed in titles.`, text);
    for (const term of termHits(text, REVIEW_TERMS)) add(field, 'NEEDS_HUMAN_REVIEW', `"${term}" may be promotional or reference an Amazon program; confirm it describes the book.`, text);
    if (/[<>{}]|\bhttps?:/i.test(text)) add(field, 'FAIL', 'Titles may not contain HTML, braces, or URLs.', text);
    if (text && text === text.toUpperCase() && /[A-Z]{4,}/.test(text) && text.length > 12) add(field, 'WARNING', 'All-caps titles can be read as shouting/promotional.', text);
  }
  const titleTokens = tokens(m.title + ' ' + m.subtitle, true);
  const counts = new Map<string, number>();
  for (const t of titleTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([, c]) => c >= 3);
  if (repeated.length) add('subtitle', 'WARNING', 'Possible keyword stuffing in title/subtitle (word repeated 3+ times).', repeated.map(([w, c]) => `${w}×${c}`).join(', '));
  if ((m.subtitle.match(/,/g) ?? []).length >= 4) add('subtitle', 'WARNING', 'Subtitle reads like a keyword list (4+ commas).', m.subtitle);

  if (!m.author.trim()) add('author', 'FAIL', 'Author / contributor name is required.');

  const desc = m.description;
  if (!desc.trim()) add('description', 'FAIL', 'Description is required.');
  if (desc.length > 4000) add('description', 'FAIL', `Description is ${desc.length} characters (KDP limit 4000).`);
  const tags = [...desc.matchAll(/<\/?([a-zA-Z0-9]+)[^>]*>/g)].map((t) => t[1]);
  const bad = tags.filter((t) => !ALLOWED_DESC_TAGS.test(t));
  if (bad.length) add('description', 'FAIL', 'Description contains unsupported HTML tags.', [...new Set(bad)].join(', '));
  if (/\bhttps?:\/\/|www\./i.test(desc)) add('description', 'WARNING', 'Descriptions should not contain URLs.', '');
  if (/\b(review|rated|stars?)\b[^.]{0,30}\b(5|five)\b/i.test(desc)) add('description', 'NEEDS_HUMAN_REVIEW', 'Description may contain review/rating claims — only include verifiable editorial reviews.', '');
  for (const c of UNSUPPORTED_CLAIM_PATTERNS) {
    const mm = desc.match(c.re);
    if (mm) add('description', 'NEEDS_HUMAN_REVIEW', `Possible unsupported ${c.label}. Verify or remove.`, mm[0]);
  }

  const kws = m.keywords.map((k) => k.keyword.trim()).filter(Boolean);
  if (kws.length > 7) add('keywords', 'FAIL', `KDP accepts 7 keyword slots; ${kws.length} provided.`);
  for (const k of m.keywords) {
    if (k.keyword.length > 50) add('keywords', 'FAIL', `Keyword exceeds 50 characters: "${k.keyword}".`);
    for (const term of termHits(k.keyword, PROMOTIONAL_TERMS)) add('keywords', 'FAIL', `Keyword "${k.keyword}" contains a disallowed term ("${term}").`, k.keyword);
    for (const term of termHits(k.keyword, REVIEW_TERMS)) add('keywords', 'NEEDS_HUMAN_REVIEW', `Keyword "${k.keyword}" contains "${term}"; keywords must not reference Amazon programs or promotions.`, k.keyword);
    if (!k.evidence.trim() || k.source === 'unspecified') add('keywords', 'WARNING', `Keyword "${k.keyword}" has no recorded source/evidence.`, k.source);
  }
  const lowered = kws.map((k) => normalizeText(k));
  const dupes = lowered.filter((k, i) => lowered.indexOf(k) !== i);
  if (dupes.length) add('keywords', 'WARNING', 'Duplicate keywords waste slots.', [...new Set(dupes)].join(', '));
  const titleSet = new Set(titleTokens);
  const echo = lowered.filter((k) => k && tokens(k, true).every((t) => titleSet.has(t)));
  if (echo.length) add('keywords', 'WARNING', 'Keywords that only repeat title words add little discoverability.', echo.join(', '));

  if (m.categories.length > 3) add('categories', 'NEEDS_HUMAN_REVIEW', `${m.categories.length} categories selected; KDP currently allows a limited number (verify the current limit).`);
  if (m.isbn && !isbnValid(m.isbn)) add('isbn', 'FAIL', 'ISBN checksum is invalid. Never invent ISBNs — use one you own or KDP’s free ISBN.', m.isbn);
  if (m.lowContent && m.isbn) add('isbn', 'NEEDS_HUMAN_REVIEW', 'Low-content books can be published without an ISBN on KDP; confirm you intend to assign one.', m.isbn);
  if (m.readingAgeMin !== null && m.readingAgeMax !== null && m.readingAgeMin > m.readingAgeMax) add('readingAge', 'FAIL', 'Minimum reading age is greater than maximum.');
  if (m.seriesNumber !== null && !m.seriesName.trim()) add('series', 'FAIL', 'Series number set without a series name.');
  return out;
}

/** Normalized containment check used for cover/metadata title consistency. */
export function titlesConsistent(metadataTitle: string, coverText: string): boolean {
  const t = tokens(metadataTitle, true);
  if (t.length === 0) return false;
  const c = new Set(tokens(coverText));
  return t.every((w) => c.has(w));
}
