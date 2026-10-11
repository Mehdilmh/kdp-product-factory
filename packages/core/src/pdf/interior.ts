import { PDFPage, clip, endPath, popGraphicsState, pushGraphicsState, rectangle } from 'pdf-lib';
import type { DrawOp, LayoutResult, RectPt } from '../interior/layout';
import { createDoc, FontCache, hexToColor, ImageCache, type AssetResolver } from './common';

export interface RenderInteriorOptions {
  title?: string;
  author?: string;
  assets?: AssetResolver;
  /** Proof mode draws trim/safe/bleed guides. Never used for final print files. */
  guides?: boolean;
  /** Restrict to a page range (0-based, inclusive) — used for quick previews. */
  pageRange?: [number, number];
  date?: Date;
}

/** Render a laid-out interior to a print PDF. Pure function of its inputs. */
export async function renderInteriorPdf(layout: LayoutResult, opts: RenderInteriorOptions = {}): Promise<Uint8Array> {
  const doc = await createDoc({ title: opts.title, author: opts.author, subject: `Interior — ${layout.spec.trim.label} — ${layout.spec.specVersion}`, date: opts.date });
  const fonts = new FontCache(doc);
  const images = new ImageCache(doc, opts.assets ?? (() => undefined));
  const gray = layout.spec.input.ink === 'BLACK_WHITE';
  const [from, to] = opts.pageRange ?? [0, layout.pages.length - 1];

  for (const p of layout.pages.slice(from, to + 1)) {
    const page = doc.addPage([p.widthPt, p.heightPt]);
    const H = p.heightPt;
    const flip = (r: RectPt) => ({ x: r.x, y: H - r.y - r.h, w: r.w, h: r.h });
    const trim = flip(p.trimBox);
    page.setTrimBox(trim.x, trim.y, trim.w, trim.h);
    page.setBleedBox(0, 0, p.widthPt, p.heightPt);
    for (const op of p.ops) await drawOp(page, op, H, gray, fonts, images);
    if (opts.guides) drawGuides(page, p.trimBox, p.contentBox, H);
  }
  return doc.save({ useObjectStreams: false });
}

export async function drawOp(page: PDFPage, op: DrawOp, H: number, gray: boolean, fonts: FontCache, images: ImageCache) {
  switch (op.op) {
    case 'text': {
      const font = await fonts.get(op.font);
      page.drawText(op.text, { x: op.x, y: H - op.y, size: op.size, font, color: hexToColor(op.color, gray) });
      return;
    }
    case 'line':
      page.drawLine({ start: { x: op.x1, y: H - op.y1 }, end: { x: op.x2, y: H - op.y2 }, thickness: op.width, color: hexToColor(op.color, gray), dashArray: op.dash });
      return;
    case 'rect': {
      if (op.radius) {
        const r = Math.min(op.radius, op.w / 2, op.h / 2);
        const path = `M ${r} 0 H ${op.w - r} A ${r} ${r} 0 0 1 ${op.w} ${r} V ${op.h - r} A ${r} ${r} 0 0 1 ${op.w - r} ${op.h} H ${r} A ${r} ${r} 0 0 1 0 ${op.h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
        page.drawSvgPath(path, {
          x: op.x,
          y: H - op.y,
          borderColor: op.stroke ? hexToColor(op.stroke, gray) : undefined,
          borderWidth: op.stroke ? op.width : 0,
          color: op.fill ? hexToColor(op.fill, gray) : undefined,
        });
        return;
      }
      page.drawRectangle({
        x: op.x,
        y: H - op.y - op.h,
        width: op.w,
        height: op.h,
        borderColor: op.stroke ? hexToColor(op.stroke, gray) : undefined,
        borderWidth: op.stroke ? op.width : 0,
        color: op.fill ? hexToColor(op.fill, gray) : undefined,
      });
      return;
    }
    case 'circle':
      page.drawCircle({ x: op.cx, y: H - op.cy, size: op.r, color: hexToColor(op.fill, gray) });
      return;
    case 'image': {
      const img = await images.get(op.assetId);
      if (!img) return;
      if (op.clip) {
        page.pushOperators(pushGraphicsState(), rectangle(op.clip.x, H - op.clip.y - op.clip.h, op.clip.w, op.clip.h), clip(), endPath());
      }
      page.drawImage(img, { x: op.x, y: H - op.y - op.h, width: op.w, height: op.h });
      if (op.clip) page.pushOperators(popGraphicsState());
      return;
    }
  }
}

function drawGuides(page: PDFPage, trimBox: RectPt, content: RectPt, H: number) {
  const red = hexToColor('#E0245E', false);
  const blue = hexToColor('#1D72F3', false);
  page.drawRectangle({ x: trimBox.x, y: H - trimBox.y - trimBox.h, width: trimBox.w, height: trimBox.h, borderColor: red, borderWidth: 0.5, borderDashArray: [3, 2] });
  page.drawRectangle({ x: content.x, y: H - content.y - content.h, width: content.w, height: content.h, borderColor: blue, borderWidth: 0.5, borderDashArray: [2, 2] });
}
