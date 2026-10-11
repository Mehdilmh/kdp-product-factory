import { Resvg } from '@resvg/resvg-js';
import { FONT_FILES, fontsDir } from '../fonts/registry';

/**
 * Rasterise an SVG (e.g. the eBook front cover) to PNG with the bundled fonts.
 * Deterministic: no system fonts are loaded.
 */
export function rasterizeSvg(svg: string, widthPx: number): Uint8Array {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: widthPx },
    font: {
      loadSystemFonts: false,
      fontFiles: Object.values(FONT_FILES).map((f) => fontsDir() + f),
      defaultFontFamily: 'Caladea',
    },
    background: '#ffffff',
  });
  return new Uint8Array(resvg.render().asPng());
}

/** Reads width/height from a PNG or JPEG header without decoding the image. */
export function imageSize(bytes: Uint8Array): { widthPx: number; heightPx: number; mimeType: 'image/png' | 'image/jpeg' } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { widthPx: dv.getUint32(16), heightPx: dv.getUint32(20), mimeType: 'image/png' };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { heightPx: (bytes[i + 5] << 8) | bytes[i + 6], widthPx: (bytes[i + 7] << 8) | bytes[i + 8], mimeType: 'image/jpeg' };
      }
      i += 2 + len;
    }
  }
  return null;
}
