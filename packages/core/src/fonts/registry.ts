import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Bundled, embeddable fonts (SIL OFL 1.1 — see packages/core/fonts/OFL-*.txt).
 * Only bundled fonts are allowed in print output, so every PDF embeds its fonts.
 */
import { FontFamily, CSS_FAMILY } from './families';
export { FontFamily, CSS_FAMILY };

export const FontKey = z.enum([
  'sans-regular',
  'sans-bold',
  'sans-italic',
  'sans-bolditalic',
  'serif-regular',
  'serif-bold',
  'serif-italic',
  'serif-bolditalic',
]);
export type FontKey = z.infer<typeof FontKey>;

export const FONT_FILES: Record<FontKey, string> = {
  'sans-regular': 'Carlito-Regular.ttf',
  'sans-bold': 'Carlito-Bold.ttf',
  'sans-italic': 'Carlito-Italic.ttf',
  'sans-bolditalic': 'Carlito-BoldItalic.ttf',
  'serif-regular': 'Caladea-Regular.ttf',
  'serif-bold': 'Caladea-Bold.ttf',
  'serif-italic': 'Caladea-Italic.ttf',
  'serif-bolditalic': 'Caladea-BoldItalic.ttf',
};


export function fontKeyFor(family: FontFamily, bold = false, italic = false): FontKey {
  const variant = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
  return `${family}-${variant}` as FontKey;
}

export function parseFontKey(key: FontKey): { family: FontFamily; bold: boolean; italic: boolean } {
  const [family, variant] = key.split('-') as [FontFamily, string];
  return { family, bold: variant.startsWith('bold'), italic: variant.endsWith('italic') };
}

/**
 * Directory holding the bundled font files. KDP_FONTS_DIR overrides it for bundled deployments
 * (e.g. the Vercel function, where the fonts are copied next to the bundle).
 */
export function fontsDir(): string {
  const d = process.env.KDP_FONTS_DIR || fileURLToPath(new URL('../../fonts/', import.meta.url));
  return d.endsWith('/') ? d : d + '/';
}

const bytesCache = new Map<FontKey, Uint8Array>();
export function fontBytes(key: FontKey): Uint8Array {
  let b = bytesCache.get(key);
  if (!b) {
    b = new Uint8Array(readFileSync(fontsDir() + FONT_FILES[key]));
    bytesCache.set(key, b);
  }
  return b;
}

/**
 * Ligatures are disabled everywhere: measurement and embedding must use identical glyph runs,
 * and ligature glyphs break text extraction/search in some PDF viewers.
 */
export const NO_LIGATURES = { liga: false, rlig: false, clig: false, dlig: false, calt: false } as const;

interface FkFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  layout(text: string, features?: Record<string, boolean>): { advanceWidth: number };
  hasGlyphForCodePoint(cp: number): boolean;
}

const fkCache = new Map<FontKey, FkFont>();
function fk(key: FontKey): FkFont {
  let f = fkCache.get(key);
  if (!f) {
    f = (fontkit as unknown as { create(b: Uint8Array): FkFont }).create(fontBytes(key));
    fkCache.set(key, f);
  }
  return f;
}

const widthCache = new Map<string, number>();
/** Width of `text` in points at `size`. Deterministic: depends only on bundled font tables. */
export function measure(key: FontKey, text: string, size: number): number {
  if (!text) return 0;
  const ck = key + '\u0000' + text;
  let units = widthCache.get(ck);
  if (units === undefined) {
    const f = fk(key);
    units = f.layout(text, { ...NO_LIGATURES }).advanceWidth / f.unitsPerEm;
    if (widthCache.size > 200_000) widthCache.clear();
    widthCache.set(ck, units);
  }
  return units * size;
}

export function fontMetrics(key: FontKey, size: number): { ascent: number; descent: number } {
  const f = fk(key);
  return { ascent: (f.ascent / f.unitsPerEm) * size, descent: (Math.abs(f.descent) / f.unitsPerEm) * size };
}

/** Characters (deduplicated) that the font cannot render — reported as layout warnings. */
export function missingGlyphs(key: FontKey, text: string): string[] {
  const f = fk(key);
  const missing = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a || cp === 0x0d || cp === 0x09) continue;
    if (!f.hasGlyphForCodePoint(cp)) missing.add(ch);
  }
  return [...missing];
}

export interface WrappedLine {
  text: string;
  width: number;
  /** Words with their x offsets — used for justified text. */
  words: { text: string; width: number }[];
  /** True when the line ends a paragraph (never justified). */
  last: boolean;
}

/** Greedy line wrapping. Breaks over-long words by character. */
export function wrapText(key: FontKey, text: string, size: number, maxWidth: number, firstLineIndent = 0): WrappedLine[] {
  const out: WrappedLine[] = [];
  const space = measure(key, ' ', size);
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  for (const para of paragraphs) {
    const words = para.split(/[ \t]+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push({ text: '', width: 0, words: [], last: true });
      continue;
    }
    let line: { text: string; width: number }[] = [];
    let lineWidth = 0;
    let avail = maxWidth - (out.length === 0 || out[out.length - 1].last ? firstLineIndent : 0);
    const flush = (last: boolean) => {
      out.push({ text: line.map((w) => w.text).join(' '), width: lineWidth, words: line, last });
      line = [];
      lineWidth = 0;
      avail = maxWidth;
    };
    for (const raw of words) {
      let word = raw;
      let w = measure(key, word, size);
      // Break words that cannot fit on an empty line.
      while (w > avail && line.length === 0 && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && measure(key, word.slice(0, cut), size) > avail) cut--;
        line.push({ text: word.slice(0, cut), width: measure(key, word.slice(0, cut), size) });
        lineWidth = line[0].width;
        flush(false);
        word = word.slice(cut);
        w = measure(key, word, size);
      }
      const needed = line.length === 0 ? w : lineWidth + space + w;
      if (needed > avail && line.length > 0) {
        flush(false);
        line.push({ text: word, width: w });
        lineWidth = w;
      } else {
        line.push({ text: word, width: w });
        lineWidth = needed;
      }
    }
    flush(true);
  }
  return out;
}
