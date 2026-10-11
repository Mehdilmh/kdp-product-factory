import { z } from 'zod';

/** Browser-safe font identifiers (no file access). */
export const FontFamily = z.enum(['sans', 'serif']);
export type FontFamily = z.infer<typeof FontFamily>;

/** CSS family names used for SVG previews/exports (fonts are served by the API as webfonts). */
export const CSS_FAMILY: Record<FontFamily, string> = { sans: 'Carlito', serif: 'Caladea' };
