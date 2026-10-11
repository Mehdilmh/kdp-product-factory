import { z } from 'zod';
import { FontFamily } from '../fonts/families';

/**
 * Typed interior schema. Pages are composed from a closed set of element types — never
 * AI-generated HTML or code — so rendering is predictable and safe.
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #RRGGBB');

export const TextStyle = z.object({
  font: FontFamily.default('serif'),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  sizePt: z.number().min(4).max(144).default(11),
  align: z.enum(['left', 'center', 'right', 'justify']).default('left'),
  color: hex.default('#000000'),
  lineHeight: z.number().min(0.8).max(3).default(1.3),
});
export type TextStyle = z.infer<typeof TextStyle>;
export const textStyle = (s: Partial<z.input<typeof TextStyle>> = {}): TextStyle => TextStyle.parse(s);

export const SizeSpec = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }),
  z.object({ mode: z.literal('fixed'), pt: z.number().min(0).max(2000) }),
  z.object({ mode: z.literal('fill'), weight: z.number().positive().max(100).default(1) }),
]);
export type SizeSpec = z.infer<typeof SizeSpec>;

const base = {
  id: z.string().min(1).max(64),
  locked: z.boolean().default(false),
  marginTopPt: z.number().min(0).max(500).default(0),
  marginBottomPt: z.number().min(0).max(500).default(0),
};

/** Minimum printable hairline (KDP prints lines thinner than ~0.5pt unreliably; we enforce 0.25pt hard floor and warn under 0.5pt). */
const lineWeight = z.number().min(0.25).max(12).default(0.6);

export const HeadingEl = z.object({ ...base, type: z.literal('heading'), text: z.string().max(500), style: TextStyle.default({ sizePt: 20, bold: true, align: 'center' }), height: SizeSpec.default({ mode: 'auto' }) });
export const TextEl = z.object({ ...base, type: z.literal('text'), text: z.string().max(20000), style: TextStyle.default({}), height: SizeSpec.default({ mode: 'auto' }) });
export const LinesEl = z.object({
  ...base,
  type: z.literal('lines'),
  spacingPt: z.number().min(10).max(144).default(24),
  weightPt: lineWeight,
  color: hex.default('#555555'),
  dashed: z.boolean().default(false),
  height: SizeSpec.default({ mode: 'fill', weight: 1 }),
});
export const DotGridEl = z.object({
  ...base,
  type: z.literal('dotGrid'),
  spacingPt: z.number().min(6).max(72).default(14.17),
  dotRadiusPt: z.number().min(0.3).max(3).default(0.6),
  color: hex.default('#777777'),
  height: SizeSpec.default({ mode: 'fill', weight: 1 }),
});
export const GridEl = z.object({
  ...base,
  type: z.literal('grid'),
  spacingPt: z.number().min(6).max(72).default(14.17),
  weightPt: lineWeight,
  color: hex.default('#999999'),
  height: SizeSpec.default({ mode: 'fill', weight: 1 }),
});
export const ChecklistEl = z.object({
  ...base,
  type: z.literal('checklist'),
  items: z.array(z.string().max(200)).max(200).default([]),
  /** Used when `items` is empty: draw N blank checkbox rows (or fill the available height when 0). */
  count: z.number().int().min(0).max(200).default(0),
  boxSizePt: z.number().min(5).max(36).default(9),
  rowHeightPt: z.number().min(10).max(72).default(22),
  writingLine: z.boolean().default(true),
  weightPt: lineWeight,
  style: TextStyle.default({ sizePt: 10, font: 'sans' }),
  height: SizeSpec.default({ mode: 'auto' }),
});
export const TableEl = z.object({
  ...base,
  type: z.literal('table'),
  columns: z.array(z.object({ header: z.string().max(100), width: z.number().positive().max(100).default(1) })).min(1).max(40),
  /** 0 = fill available height with as many rows as fit. */
  rows: z.number().int().min(0).max(200).default(0),
  rowHeightPt: z.number().min(10).max(144).default(22),
  cells: z.array(z.array(z.string().max(500))).max(200).default([]),
  headerFill: hex.nullable().default('#E6E6E6'),
  weightPt: lineWeight,
  headerStyle: TextStyle.default({ sizePt: 9, bold: true, font: 'sans', align: 'center' }),
  bodyStyle: TextStyle.default({ sizePt: 9, font: 'sans' }),
  height: SizeSpec.default({ mode: 'auto' }),
});
export const FieldsEl = z.object({
  ...base,
  type: z.literal('fields'),
  fields: z.array(z.object({ label: z.string().max(80), width: z.number().positive().max(100).default(1) })).min(1).max(12),
  rowHeightPt: z.number().min(12).max(72).default(24),
  weightPt: lineWeight,
  style: TextStyle.default({ sizePt: 9, font: 'sans' }),
  height: SizeSpec.default({ mode: 'auto' }),
});
export const BoxEl = z.object({
  ...base,
  type: z.literal('box'),
  label: z.string().max(200).default(''),
  weightPt: lineWeight,
  radiusPt: z.number().min(0).max(36).default(0),
  fill: hex.nullable().default(null),
  style: TextStyle.default({ sizePt: 9, font: 'sans', bold: true }),
  linesInside: z.number().min(0).max(144).default(0),
  height: SizeSpec.default({ mode: 'fill', weight: 1 }),
});
export const ImageEl = z.object({
  ...base,
  type: z.literal('image'),
  assetId: z.string().max(64),
  fit: z.enum(['contain', 'cover']).default('contain'),
  widthRatio: z.number().min(0.05).max(1).default(1),
  /** Full-bleed images extend to the bleed edge; only allowed when bleed is enabled. */
  fullBleed: z.boolean().default(false),
  caption: z.string().max(500).default(''),
  height: SizeSpec.default({ mode: 'fill', weight: 1 }),
});
export const SpacerEl = z.object({ ...base, type: z.literal('spacer'), height: SizeSpec.default({ mode: 'fixed', pt: 12 }) });
export const DividerEl = z.object({ ...base, type: z.literal('divider'), weightPt: lineWeight, color: hex.default('#333333'), height: SizeSpec.default({ mode: 'fixed', pt: 12 }) });

type ElementInput =
  | z.input<typeof HeadingEl>
  | z.input<typeof TextEl>
  | z.input<typeof LinesEl>
  | z.input<typeof DotGridEl>
  | z.input<typeof GridEl>
  | z.input<typeof ChecklistEl>
  | z.input<typeof TableEl>
  | z.input<typeof FieldsEl>
  | z.input<typeof BoxEl>
  | z.input<typeof ImageEl>
  | z.input<typeof SpacerEl>
  | z.input<typeof DividerEl>
  | (z.input<z.ZodObject<typeof base>> & {
      type: 'columns';
      gapPt?: number;
      columns: { width?: number; elements: ElementInput[] }[];
      height?: z.input<typeof SizeSpec>;
    });

export type PageElement =
  | z.infer<typeof HeadingEl>
  | z.infer<typeof TextEl>
  | z.infer<typeof LinesEl>
  | z.infer<typeof DotGridEl>
  | z.infer<typeof GridEl>
  | z.infer<typeof ChecklistEl>
  | z.infer<typeof TableEl>
  | z.infer<typeof FieldsEl>
  | z.infer<typeof BoxEl>
  | z.infer<typeof ImageEl>
  | z.infer<typeof SpacerEl>
  | z.infer<typeof DividerEl>
  | ColumnsElement;

export interface ColumnsElement {
  id: string;
  locked: boolean;
  marginTopPt: number;
  marginBottomPt: number;
  type: 'columns';
  gapPt: number;
  columns: { width: number; elements: PageElement[] }[];
  height: SizeSpec;
}

export const PageElementSchema: z.ZodType<PageElement, z.ZodTypeDef, ElementInput> = z.lazy(() =>
  z.union([
    HeadingEl,
    TextEl,
    LinesEl,
    DotGridEl,
    GridEl,
    ChecklistEl,
    TableEl,
    FieldsEl,
    BoxEl,
    ImageEl,
    SpacerEl,
    DividerEl,
    z.object({
      ...base,
      type: z.literal('columns'),
      gapPt: z.number().min(0).max(72).default(12),
      columns: z.array(z.object({ width: z.number().positive().max(100).default(1), elements: z.array(PageElementSchema).max(50) })).min(1).max(6),
      height: SizeSpec.default({ mode: 'fill', weight: 1 }),
    }),
  ]),
) as z.ZodType<PageElement, z.ZodTypeDef, ElementInput>;
export type PageElementInput = ElementInput;

export const TemplateField = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string().max(80),
  type: z.enum(['text', 'number', 'boolean']).default('text'),
  default: z.union([z.string(), z.number(), z.boolean()]).default(''),
});
export type TemplateField = z.infer<typeof TemplateField>;

export const PageTemplate = z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(120),
  kind: z.enum(['body', 'front', 'back']).default('body'),
  category: z.string().max(60).default('general'),
  description: z.string().max(1000).default(''),
  fields: z.array(TemplateField).max(40).default([]),
  elements: z.array(PageElementSchema).max(80),
  showPageNumber: z.boolean().default(true),
  showRunningHeader: z.boolean().default(true),
  version: z.number().int().positive().default(1),
});
export type PageTemplate = z.infer<typeof PageTemplate>;
export type PageTemplateInput = z.input<typeof PageTemplate>;

export const PageInstance = z.object({
  id: z.string().min(1).max(64),
  templateId: z.string().max(80).nullable().default(null),
  fields: z.record(z.union([z.string().max(5000), z.number(), z.boolean()])).default({}),
  /** When set, replaces the template's elements (a customised page). */
  elements: z.array(PageElementSchema).max(80).nullable().default(null),
  locked: z.boolean().default(false),
  blank: z.boolean().default(false),
});
export type PageInstance = z.infer<typeof PageInstance>;
export type PageInstanceInput = z.input<typeof PageInstance>;

export const FlowBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string().max(50000) }),
  z.object({ type: z.literal('heading'), text: z.string().max(500), level: z.number().int().min(2).max(4).default(2) }),
  z.object({ type: z.literal('quote'), text: z.string().max(10000) }),
  z.object({ type: z.literal('list'), items: z.array(z.string().max(2000)).max(200), ordered: z.boolean().default(false) }),
  z.object({ type: z.literal('image'), assetId: z.string().max(64), caption: z.string().max(500).default(''), widthRatio: z.number().min(0.1).max(1).default(1) }),
  z.object({ type: z.literal('sectionBreak') }),
  z.object({ type: z.literal('pageBreak') }),
]);
export type FlowBlock = z.infer<typeof FlowBlock>;

export const Chapter = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(300),
  blocks: z.array(FlowBlock).max(5000),
  /** Footnote markers `[^n]` in text resolve to these, rendered as chapter endnotes. */
  notes: z.array(z.string().max(5000)).max(500).default([]),
});
export type Chapter = z.infer<typeof Chapter>;

export const MarginSettings = z.object({
  insideIn: z.number().min(0).max(3).default(0.75),
  outsideIn: z.number().min(0).max(3).default(0.5),
  topIn: z.number().min(0).max(3).default(0.5),
  bottomIn: z.number().min(0).max(3).default(0.5),
});

export const DocumentSettings = z.object({
  margins: MarginSettings.default({}),
  bodyStyle: TextStyle.default({ font: 'serif', sizePt: 11, lineHeight: 1.4, align: 'justify' }),
  headingFont: FontFamily.default('serif'),
  pageNumbers: z.object({ enabled: z.boolean().default(true), position: z.enum(['outside', 'center']).default('center'), sizePt: z.number().min(6).max(14).default(9) }).default({}),
  runningHeader: z.object({ enabled: z.boolean().default(false), verso: z.string().max(200).default('{{title}}'), recto: z.string().max(200).default('{{section}}'), sizePt: z.number().min(6).max(14).default(8) }).default({}),
  chapterStartRecto: z.boolean().default(true),
  includeToc: z.boolean().default(true),
  padToEven: z.boolean().default(true),
  /** Replace {{title}}/{{author}} in templates. */
  title: z.string().max(300).default(''),
  author: z.string().max(300).default(''),
});
export type DocumentSettings = z.infer<typeof DocumentSettings>;

export const InteriorDocument = z.object({
  schemaVersion: z.literal(1).default(1),
  settings: DocumentSettings.default({}),
  frontMatter: z.array(PageInstance).max(50).default([]),
  body: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pages'), pages: z.array(PageInstance).max(1000) }),
    z.object({ kind: z.literal('flow'), chapters: z.array(Chapter).max(500) }),
  ]),
  backMatter: z.array(PageInstance).max(50).default([]),
  /** Workspace templates embedded so the document renders identically when exported/reimported. */
  templates: z.array(PageTemplate).max(200).default([]),
});
export type InteriorDocument = z.infer<typeof InteriorDocument>;
export type InteriorDocumentInput = z.input<typeof InteriorDocument>;
