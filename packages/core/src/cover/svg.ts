import { CSS_FAMILY, fontBytes, parseFontKey, type FontKey } from '../fonts/registry';
import { inToPt, round } from '../units';
import type { Rect } from './geometry';
import { gradientVector, pathFit, type CoverLayout } from './layout';
import type { Paint } from './schema';

export interface CoverSvgOptions {
  /** Draw bleed/trim/spine/safe/barcode guides (editor previews only, never in print exports). */
  guides?: boolean;
  /** Embed the bundled fonts as base64 @font-face so the SVG renders identically anywhere. */
  embedFonts?: boolean;
  /** href for image assets (URL in the editor, data: URI for exports). */
  assetHref?: (assetId: string) => string | undefined;
  /** Template guide image href (official KDP template). */
  templateGuideHref?: string;
  templateGuideOpacity?: number;
}

export const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

const n = (v: number) => String(round(v, 3));

function paintRef(paint: Paint, id: string, box: { x: number; y: number; w: number; h: number }, defs: string[]): string {
  if (paint.type === 'solid') return paint.color;
  const v = gradientVector(box, paint.angle);
  defs.push(
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(v.x0)}" y1="${n(v.y0)}" x2="${n(v.x1)}" y2="${n(v.y1)}">${paint.stops
      .map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`)
      .join('')}</linearGradient>`,
  );
  return `url(#${id})`;
}

export function renderCoverSvg(layout: CoverLayout, opts: CoverSvgOptions = {}): string {
  const { widthPt: W, heightPt: H, geometry: g } = layout;
  const defs: string[] = [];
  const body: string[] = [];
  const usedFonts = new Set<FontKey>();

  body.push(`<rect id="background" x="0" y="0" width="${n(W)}" height="${n(H)}" fill="${paintRef(layout.background, 'bg-grad', { x: 0, y: 0, w: W, h: H }, defs)}"/>`);

  for (const rl of layout.layers) {
    const l = rl.layer;
    const tf = l.rotation ? ` transform="rotate(${l.rotation} ${n(rl.cx)} ${n(rl.cy)})"` : '';
    const op = l.opacity < 1 ? ` opacity="${l.opacity}"` : '';
    const b = rl.box;
    const attrs = `id="${escapeXml(l.id)}" data-name="${escapeXml(l.name)}"${tf}${op}`;
    switch (l.type) {
      case 'rect': {
        const fill = l.fill ? paintRef(l.fill, `g-${l.id}`, b, defs) : 'none';
        const stroke = l.stroke ? ` stroke="${l.stroke}" stroke-width="${l.strokeWidthPt}"` : '';
        const r = l.radiusIn ? ` rx="${n(inToPt(l.radiusIn))}"` : '';
        body.push(`<rect ${attrs} x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}"${r} fill="${fill}"${stroke}/>`);
        break;
      }
      case 'ellipse': {
        const fill = l.fill ? paintRef(l.fill, `g-${l.id}`, b, defs) : 'none';
        const stroke = l.stroke ? ` stroke="${l.stroke}" stroke-width="${l.strokeWidthPt}"` : '';
        body.push(`<ellipse ${attrs} cx="${n(rl.cx)}" cy="${n(rl.cy)}" rx="${n(b.w / 2)}" ry="${n(b.h / 2)}" fill="${fill}"${stroke}/>`);
        break;
      }
      case 'path': {
        const pf = pathFit(l.viewBoxW, l.viewBoxH, b);
        const stroke = l.stroke ? ` stroke="${l.stroke}" stroke-width="${n(l.strokeWidthPt / pf.scale)}"` : '';
        body.push(`<g ${attrs}><path transform="translate(${n(pf.x)} ${n(pf.y)}) scale(${n(pf.scale)})" d="${escapeXml(l.d)}" fill="${l.fill ?? 'none'}"${stroke}/></g>`);
        break;
      }
      case 'image': {
        const href = opts.assetHref?.(l.assetId);
        if (!href || !rl.image) break;
        const clipId = `clip-${l.id}`;
        defs.push(`<clipPath id="${escapeXml(clipId)}"><rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}"/></clipPath>`);
        body.push(
          `<g ${attrs} clip-path="url(#${escapeXml(clipId)})"><image href="${escapeXml(href)}" x="${n(rl.image.drawX)}" y="${n(rl.image.drawY)}" width="${n(rl.image.drawW)}" height="${n(rl.image.drawH)}" preserveAspectRatio="none"/></g>`,
        );
        break;
      }
      case 'text': {
        if (!rl.text) break;
        usedFonts.add(rl.text.font);
        const f = parseFontKey(rl.text.font);
        const style = `font-family:'${CSS_FAMILY[f.family]}';font-size:${l.sizePt}px;font-weight:${f.bold ? 700 : 400};font-style:${f.italic ? 'italic' : 'normal'};font-variant-ligatures:none`;
        // Each wrapped line is an editable <text> element positioned exactly as in the PDF.
        const lines = rl.text.lines
          .filter((ln) => ln.text)
          .map((ln) => `<text x="${n(ln.x)}" y="${n(ln.y)}" fill="${l.color}" style="${style}" xml:space="preserve">${escapeXml(ln.text)}</text>`)
          .join('');
        body.push(`<g ${attrs} data-role="${l.role}">${lines}</g>`);
        break;
      }
    }
  }

  if (opts.templateGuideHref) {
    body.push(`<image id="template-guide" href="${escapeXml(opts.templateGuideHref)}" x="0" y="0" width="${n(W)}" height="${n(H)}" opacity="${opts.templateGuideOpacity ?? 0.5}" preserveAspectRatio="none" pointer-events="none"/>`);
  }

  if (opts.guides) body.push(guidesSvg(layout));

  if (opts.embedFonts && usedFonts.size) {
    const faces = [...usedFonts]
      .map((k) => {
        const f = parseFontKey(k);
        const b64 = Buffer.from(fontBytes(k)).toString('base64');
        return `@font-face{font-family:'${CSS_FAMILY[f.family]}';font-weight:${f.bold ? 700 : 400};font-style:${f.italic ? 'italic' : 'normal'};src:url(data:font/ttf;base64,${b64}) format('truetype');}`;
      })
      .join('');
    defs.push(`<style>${faces}</style>`);
  }

  const wIn = round(g.widthIn, 4);
  const hIn = round(g.heightIn, 4);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${wIn}in" height="${hIn}in" viewBox="0 0 ${n(W)} ${n(H)}" data-spec-version="${g.specVersion}" data-spine-width-in="${g.spineWidthIn}" data-page-count="${g.pageCount}">`,
    `<title>Cover ${wIn}in × ${hIn}in</title>`,
    `<defs>${defs.join('')}</defs>`,
    ...body,
    `</svg>`,
  ].join('\n');
}

function guidesSvg(layout: CoverLayout): string {
  const g = layout.geometry;
  const P = inToPt;
  const r = (rect: Rect, cls: string, label?: string) =>
    rect.w > 0 && rect.h > 0
      ? `<rect class="${cls}" x="${n(P(rect.x))}" y="${n(P(rect.y))}" width="${n(P(rect.w))}" height="${n(P(rect.h))}"/>` +
        (label ? `<text x="${n(P(rect.x) + 3)}" y="${n(P(rect.y) + 9)}" class="guide-label">${escapeXml(label)}</text>` : '')
      : '';
  const W = layout.widthPt;
  const H = layout.heightPt;
  const b = P(g.bleedIn);
  return [
    `<g id="guides" pointer-events="none">`,
    `<style>.trim{fill:none;stroke:#E0245E;stroke-width:0.75;stroke-dasharray:4 3}.safe{fill:none;stroke:#1D72F3;stroke-width:0.6;stroke-dasharray:2 2}.spine{fill:rgba(255,196,0,0.12);stroke:#C99700;stroke-width:0.6}.barcode{fill:rgba(255,255,255,0.85);stroke:#333;stroke-width:0.6}.hinge{fill:rgba(128,0,255,0.08);stroke:#8000FF;stroke-width:0.4}.bleed{fill:rgba(224,36,94,0.10)}.guide-label{font:7px sans-serif;fill:#333}</style>`,
    b > 0
      ? `<path class="bleed" fill-rule="evenodd" d="M0 0H${n(W)}V${n(H)}H0Z M${n(b)} ${n(b)}V${n(H - b)}H${n(W - b)}V${n(b)}Z"/>`
      : '',
    r(g.panels.back, 'trim', 'Back cover'),
    r(g.panels.front, 'trim', 'Front cover'),
    r(g.panels.spine, 'spine', g.spineWidthIn > 0.3 ? 'Spine' : undefined),
    r(g.safe.back, 'safe'),
    r(g.safe.front, 'safe'),
    r(g.safe.spine, 'safe'),
    ...g.hinges.map((h) => r(h, 'hinge')),
    g.barcode ? r(g.barcode, 'barcode', 'Barcode area — keep clear') : '',
    `</g>`,
  ].join('');
}

