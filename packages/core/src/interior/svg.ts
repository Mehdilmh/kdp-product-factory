import { CSS_FAMILY, parseFontKey } from '../fonts/registry';
import { escapeXml } from '../cover/svg';
import { round } from '../units';
import type { LaidOutPage } from './layout';

export interface PageSvgOptions {
  guides?: boolean;
  /** Base URL for webfonts, e.g. "/api/fonts/". When omitted, fonts are referenced by family only. */
  fontBaseUrl?: string;
  assetHref?: (assetId: string) => string | undefined;
  gray?: boolean;
}

const n = (v: number) => String(round(v, 2));

function grayHex(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b).toString(16).padStart(2, '0');
  return `#${y}${y}${y}`;
}

/** Print-size SVG preview of a laid-out page, drawn from the same ops as the PDF. */
export function renderPageSvg(page: LaidOutPage, opts: PageSvgOptions = {}): string {
  const c = (hex: string) => (opts.gray ? grayHex(hex) : hex);
  const parts: string[] = [];
  let clipN = 0;
  for (const op of page.ops) {
    switch (op.op) {
      case 'text': {
        const f = parseFontKey(op.font);
        parts.push(
          `<text x="${n(op.x)}" y="${n(op.y)}" font-family="${CSS_FAMILY[f.family]}" font-size="${op.size}" font-weight="${f.bold ? 700 : 400}" font-style="${f.italic ? 'italic' : 'normal'}" fill="${c(op.color)}" style="font-variant-ligatures:none" xml:space="preserve">${escapeXml(op.text)}</text>`,
        );
        break;
      }
      case 'line':
        parts.push(`<line x1="${n(op.x1)}" y1="${n(op.y1)}" x2="${n(op.x2)}" y2="${n(op.y2)}" stroke="${c(op.color)}" stroke-width="${op.width}"${op.dash ? ` stroke-dasharray="${op.dash.join(' ')}"` : ''}/>`);
        break;
      case 'rect':
        parts.push(`<rect x="${n(op.x)}" y="${n(op.y)}" width="${n(op.w)}" height="${n(op.h)}"${op.radius ? ` rx="${op.radius}"` : ''} fill="${op.fill ? c(op.fill) : 'none'}"${op.stroke ? ` stroke="${c(op.stroke)}" stroke-width="${op.width}"` : ''}/>`);
        break;
      case 'circle':
        parts.push(`<circle cx="${n(op.cx)}" cy="${n(op.cy)}" r="${op.r}" fill="${c(op.fill)}"/>`);
        break;
      case 'image': {
        const href = opts.assetHref?.(op.assetId);
        if (!href) {
          parts.push(`<rect x="${n(op.x)}" y="${n(op.y)}" width="${n(op.w)}" height="${n(op.h)}" fill="#eee" stroke="#c00" stroke-dasharray="4 2"/>`);
          break;
        }
        if (op.clip) {
          clipN++;
          parts.push(`<clipPath id="c${clipN}"><rect x="${n(op.clip.x)}" y="${n(op.clip.y)}" width="${n(op.clip.w)}" height="${n(op.clip.h)}"/></clipPath>`);
        }
        parts.push(`<image href="${escapeXml(href)}" x="${n(op.x)}" y="${n(op.y)}" width="${n(op.w)}" height="${n(op.h)}" preserveAspectRatio="none"${op.clip ? ` clip-path="url(#c${clipN})"` : ''}${opts.gray ? ' filter="grayscale(1)"' : ''}/>`);
        break;
      }
    }
  }
  if (opts.guides) {
    const t = page.trimBox;
    const cb = page.contentBox;
    parts.push(`<g pointer-events="none"><rect x="${n(t.x)}" y="${n(t.y)}" width="${n(t.w)}" height="${n(t.h)}" fill="none" stroke="#E0245E" stroke-width="0.6" stroke-dasharray="4 3"/><rect x="${n(cb.x)}" y="${n(cb.y)}" width="${n(cb.w)}" height="${n(cb.h)}" fill="none" stroke="#1D72F3" stroke-width="0.5" stroke-dasharray="2 2"/></g>`);
  }
  const fonts = opts.fontBaseUrl
    ? `<style>${(['Carlito', 'Caladea'] as const)
        .flatMap((fam) =>
          [['Regular', 400, 'normal'], ['Bold', 700, 'normal'], ['Italic', 400, 'italic'], ['BoldItalic', 700, 'italic']].map(
            ([v, w, s]) => `@font-face{font-family:'${fam}';src:url('${opts.fontBaseUrl}${fam}-${v}.ttf');font-weight:${w};font-style:${s}}`,
          ),
        )
        .join('')}</style>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(page.widthPt / 72)}in" height="${n(page.heightPt / 72)}in" viewBox="0 0 ${n(page.widthPt)} ${n(page.heightPt)}" data-page="${page.pageNumber}">${fonts}<rect width="100%" height="100%" fill="#fff"/>${parts.join('')}</svg>`;
}
