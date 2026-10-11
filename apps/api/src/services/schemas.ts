import { BookFormat, CoverDesign, DocumentSettings, InkType, MetadataDraft, OfficialCoverGeometry, PaperType, ReadingDirection } from '@kdp/core';
import { z } from 'zod';

export const PRODUCT_CATEGORIES = [
  'BLANK_LINED_JOURNAL',
  'GUIDED_JOURNAL',
  'NOTEBOOK',
  'PLANNER',
  'LOGBOOK',
  'TRACKER',
  'WORKBOOK',
  'ACTIVITY_BOOK',
  'EDUCATIONAL',
  'NONFICTION',
  'ILLUSTRATED',
  'COLORING_BOOK',
] as const;
export const ProductCategory = z.enum(PRODUCT_CATEGORIES);

export const CONTENT_TYPES = ['BLANK', 'LINED', 'DOT_GRID', 'STRUCTURED_FORMS', 'PLANNER', 'LOGBOOK', 'WORKBOOK', 'LONG_FORM', 'ILLUSTRATED', 'COLORING'] as const;
export const ContentType = z.enum(CONTENT_TYPES);

/** Default content class per category; users can override with justification. */
export const DEFAULT_CONTENT_CLASS: Record<z.infer<typeof ProductCategory>, 'LOW' | 'MEDIUM' | 'FULL'> = {
  BLANK_LINED_JOURNAL: 'LOW',
  NOTEBOOK: 'LOW',
  LOGBOOK: 'LOW',
  TRACKER: 'LOW',
  PLANNER: 'LOW',
  GUIDED_JOURNAL: 'MEDIUM',
  WORKBOOK: 'MEDIUM',
  ACTIVITY_BOOK: 'MEDIUM',
  EDUCATIONAL: 'FULL',
  NONFICTION: 'FULL',
  ILLUSTRATED: 'MEDIUM',
  // Original illustrations (not a blank/low-content template).
  COLORING_BOOK: 'MEDIUM',
};

export const GenerationSettings = z.object({
  outline: z.boolean().default(true),
  content: z.boolean().default(true),
  interior: z.boolean().default(true),
  coverConcept: z.boolean().default(true),
  titleSuggestions: z.boolean().default(true),
  metadata: z.boolean().default(true),
  similarity: z.boolean().default(true),
  validate: z.boolean().default(true),
});

export const BriefInput = z.object({
  workingTitle: z.string().trim().min(1).max(200),
  category: ProductCategory,
  targetReader: z.string().trim().min(3).max(500),
  readerProblem: z.string().trim().min(3).max(1000),
  niche: z.string().trim().min(2).max(200),
  differentiation: z.string().trim().min(20, 'Describe what makes this product different (at least 20 characters).').max(2000),
  language: z.string().max(40).default('English'),
  marketplace: z.string().max(60).default('Amazon.com'),
  authorName: z.string().trim().min(1).max(200),
  contentStyle: z.string().max(300).default(''),
  designTheme: z.string().max(40).default('midnight'),
  contentType: ContentType,
  contentClass: z.enum(['LOW', 'MEDIUM', 'FULL']).optional(),
});

export const FormatInput = z
  .object({
    format: BookFormat,
    trimId: z.string().max(20).default('6x9'),
    ink: InkType.default('BLACK_WHITE'),
    paper: PaperType.default('WHITE'),
    bleed: z.boolean().default(false),
    coverFinish: z.enum(['GLOSSY', 'MATTE']).default('MATTE'),
    direction: ReadingDirection.default('LTR'),
    targetPageCount: z.number().int().min(1).max(900).nullable().default(null),
  })
  .refine((f) => !(f.paper === 'CREAM' && f.ink !== 'BLACK_WHITE'), { message: 'Cream paper is only available with black & white ink', path: ['paper'] });

export const CreateProjectInput = z.object({
  brief: BriefInput,
  format: FormatInput,
  generation: GenerationSettings.default({}),
  presetId: z.string().optional(),
});

export const UpdateBriefInput = BriefInput.partial();
export const UpdateFormatInput = z.object({
  format: BookFormat.optional(),
  trimId: z.string().max(20).optional(),
  ink: InkType.optional(),
  paper: PaperType.optional(),
  bleed: z.boolean().optional(),
  coverFinish: z.enum(['GLOSSY', 'MATTE']).optional(),
  direction: ReadingDirection.optional(),
  targetPageCount: z.number().int().min(1).max(900).nullable().optional(),
  officialCover: OfficialCoverGeometry.nullable().optional(),
});

export { CoverDesign, DocumentSettings, MetadataDraft };
