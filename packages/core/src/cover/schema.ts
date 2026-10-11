import { z } from 'zod';
import { FontFamily } from '../fonts/families';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #RRGGBB');

export const Paint = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solid'), color: hex }),
  z.object({
    type: z.literal('linear'),
    /** Degrees; 0 = left→right, 90 = top→bottom. */
    angle: z.number().min(-360).max(360).default(90),
    stops: z.array(z.object({ offset: z.number().min(0).max(1), color: hex })).min(2).max(8),
  }),
]);
export type Paint = z.infer<typeof Paint>;

/** Anchor panel: layer coordinates are relative to that panel's trim rectangle (inches). */
export const Anchor = z.enum(['front', 'back', 'spine', 'canvas']);
export type Anchor = z.infer<typeof Anchor>;

/** SVG path data restricted to path commands and numbers — no markup, no scripts. */
export const SafePathData = z
  .string()
  .max(20000)
  .regex(/^[MmLlHhVvCcSsQqTtAaZz0-9eE\s,.+-]*$/, 'Path data may only contain SVG path commands and numbers');

const layerBase = {
  id: z.string().min(1).max(64),
  name: z.string().max(80).default(''),
  anchor: Anchor.default('front'),
  x: z.number().min(-50).max(100),
  y: z.number().min(-50).max(100),
  w: z.number().min(0).max(100),
  h: z.number().min(0).max(100),
  rotation: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
};

export const CoverLayer = z.discriminatedUnion('type', [
  z.object({ ...layerBase, type: z.literal('rect'), fill: Paint.nullable().default(null), stroke: hex.nullable().default(null), strokeWidthPt: z.number().min(0).max(36).default(0), radiusIn: z.number().min(0).max(5).default(0) }),
  z.object({ ...layerBase, type: z.literal('ellipse'), fill: Paint.nullable().default(null), stroke: hex.nullable().default(null), strokeWidthPt: z.number().min(0).max(36).default(0) }),
  z.object({
    ...layerBase,
    type: z.literal('text'),
    role: z.enum(['title', 'subtitle', 'author', 'spine', 'back', 'tagline', 'other']).default('other'),
    text: z.string().max(5000),
    font: FontFamily.default('serif'),
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    sizePt: z.number().min(4).max(400).default(24),
    color: hex.default('#000000'),
    align: z.enum(['left', 'center', 'right']).default('center'),
    lineHeight: z.number().min(0.7).max(3).default(1.15),
    /** Vertical alignment of the text block inside its box. */
    valign: z.enum(['top', 'middle', 'bottom']).default('top'),
  }),
  z.object({ ...layerBase, type: z.literal('image'), assetId: z.string().max(64), fit: z.enum(['cover', 'contain']).default('cover') }),
  z.object({
    ...layerBase,
    type: z.literal('path'),
    d: SafePathData,
    viewBoxW: z.number().positive().max(10000),
    viewBoxH: z.number().positive().max(10000),
    fill: hex.nullable().default('#000000'),
    stroke: hex.nullable().default(null),
    strokeWidthPt: z.number().min(0).max(36).default(0),
  }),
]);
export type CoverLayer = z.infer<typeof CoverLayer>;
export type CoverLayerInput = z.input<typeof CoverLayer>;

export const CoverDesign = z.object({
  schemaVersion: z.literal(1).default(1),
  kind: z.enum(['FULL_WRAP', 'FRONT']).default('FULL_WRAP'),
  background: Paint.default({ type: 'solid', color: '#FFFFFF' }),
  layers: z.array(CoverLayer).max(200).default([]),
  /**
   * KDP_BARCODE: no ISBN barcode supplied — keep the barcode area clear (KDP places one when
   * applicable). OWN_BARCODE: the publisher placed their own barcode image layer.
   */
  barcode: z.enum(['KDP_BARCODE', 'OWN_BARCODE', 'NOT_APPLICABLE']).default('KDP_BARCODE'),
  /** Imported official template image used as a locked, non-printing guide. */
  templateGuide: z.object({ assetId: z.string().max(64), opacity: z.number().min(0).max(1).default(0.5) }).nullable().default(null),
});
export type CoverDesign = z.infer<typeof CoverDesign>;
export type CoverDesignInput = z.input<typeof CoverDesign>;
