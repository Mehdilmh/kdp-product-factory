import {
  PDFDict,
  PDFName,
  PDFOperator,
  PDFPage,
  clip,
  concatTransformationMatrix,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  type PDFContext,
} from 'pdf-lib';
import { gradientVector, pathFit, type CoverLayout } from '../cover/layout';
import type { Paint } from '../cover/schema';
import { createDoc, FontCache, hexToColor, ImageCache, type AssetResolver } from './common';

export interface RenderCoverOptions {
  title?: string;
  author?: string;
  assets?: AssetResolver;
  date?: Date;
}

const rgbArr = (hex: string) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000);

/** Builds a PDF axial shading (type 2) with a stitched function for multi-stop gradients. */
function shading(ctx: PDFContext, paint: Extract<Paint, { type: 'linear' }>, coords: number[]) {
  const stops = [...paint.stops].sort((a, b) => a.offset - b.offset);
  const segs = stops.slice(1).map((s, i) => ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: rgbArr(stops[i].color), C1: rgbArr(s.color), N: 1 }));
  const fn =
    segs.length === 1
      ? segs[0]
      : ctx.obj({
          FunctionType: 3,
          Domain: [stops[0].offset, stops.at(-1)!.offset],
          Functions: segs,
          Bounds: stops.slice(1, -1).map((s) => s.offset),
          Encode: segs.flatMap(() => [0, 1]),
        });
  return ctx.register(ctx.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: coords, Function: fn, Extend: [true, true] }));
}

let shCounter = 0;
function fillPaint(page: PDFPage, paint: Paint, box: { x: number; y: number; w: number; h: number }, H: number, opacity = 1) {
  if (paint.type === 'solid') {
    page.drawRectangle({ x: box.x, y: H - box.y - box.h, width: box.w, height: box.h, color: hexToColor(paint.color, false), opacity });
    return;
  }
  const v = gradientVector(box, paint.angle);
  const ref = shading(page.doc.context, paint, [v.x0, H - v.y0, v.x1, H - v.y1]);
  const res = page.node.Resources()!;
  let shDict = res.lookup(PDFName.of('Shading'));
  if (!(shDict instanceof PDFDict)) {
    shDict = page.doc.context.obj({});
    res.set(PDFName.of('Shading'), shDict);
  }
  const name = `Sh${++shCounter}`;
  (shDict as PDFDict).set(PDFName.of(name), ref);
  page.pushOperators(
    pushGraphicsState(),
    rectangle(box.x, H - box.y - box.h, box.w, box.h),
    clip(),
    endPath(),
    PDFOperator.of('sh' as never, [PDFName.of(name)]),
    popGraphicsState(),
  );
}

/** Render a laid-out cover to a single-page print PDF (full wrap incl. bleed, or eBook front). */
export async function renderCoverPdf(layout: CoverLayout, opts: RenderCoverOptions = {}): Promise<Uint8Array> {
  shCounter = 0;
  const doc = await createDoc({ title: opts.title, author: opts.author, subject: `Cover — ${layout.geometry.format} — ${layout.geometry.specVersion}`, date: opts.date });
  const fonts = new FontCache(doc);
  const images = new ImageCache(doc, opts.assets ?? (() => undefined));
  const W = layout.widthPt;
  const H = layout.heightPt;
  const page = doc.addPage([W, H]);
  const g = layout.geometry;
  const bleed = g.bleedIn * 72;
  if (bleed > 0) {
    page.setTrimBox(bleed, bleed, W - 2 * bleed, H - 2 * bleed);
    page.setBleedBox(0, 0, W, H);
  }

  fillPaint(page, layout.background, { x: 0, y: 0, w: W, h: H }, H);

  for (const rl of layout.layers) {
    const l = rl.layer;
    const b = rl.box;
    page.pushOperators(pushGraphicsState());
    if (l.rotation) {
      // Rotate about the layer centre (PDF y-up: clockwise in SVG == negative angle here).
      const r = (-l.rotation * Math.PI) / 180;
      const cx = rl.cx;
      const cy = H - rl.cy;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      page.pushOperators(concatTransformationMatrix(cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy));
    }
    switch (l.type) {
      case 'rect':
        if (l.fill?.type === 'linear') fillPaint(page, l.fill, b, H, l.opacity);
        page.drawRectangle({
          x: b.x,
          y: H - b.y - b.h,
          width: b.w,
          height: b.h,
          color: l.fill?.type === 'solid' ? hexToColor(l.fill.color, false) : undefined,
          borderColor: l.stroke ? hexToColor(l.stroke, false) : undefined,
          borderWidth: l.stroke ? l.strokeWidthPt : 0,
          opacity: l.opacity,
          borderOpacity: l.opacity,
        });
        break;
      case 'ellipse':
        page.drawEllipse({
          x: rl.cx,
          y: H - rl.cy,
          xScale: b.w / 2,
          yScale: b.h / 2,
          color: l.fill ? hexToColor(l.fill.type === 'solid' ? l.fill.color : l.fill.stops[0].color, false) : undefined,
          borderColor: l.stroke ? hexToColor(l.stroke, false) : undefined,
          borderWidth: l.stroke ? l.strokeWidthPt : 0,
          opacity: l.opacity,
        });
        break;
      case 'path': {
        const pf = pathFit(l.viewBoxW, l.viewBoxH, b);
        page.drawSvgPath(l.d, {
          x: pf.x,
          y: H - pf.y,
          scale: pf.scale,
          color: l.fill ? hexToColor(l.fill, false) : undefined,
          borderColor: l.stroke ? hexToColor(l.stroke, false) : undefined,
          borderWidth: l.stroke ? l.strokeWidthPt / pf.scale : 0,
          opacity: l.opacity,
          borderOpacity: l.opacity,
        });
        break;
      }
      case 'image': {
        const img = await images.get(l.assetId);
        if (img && rl.image) {
          page.pushOperators(rectangle(b.x, H - b.y - b.h, b.w, b.h), clip(), endPath());
          page.drawImage(img, { x: rl.image.drawX, y: H - rl.image.drawY - rl.image.drawH, width: rl.image.drawW, height: rl.image.drawH, opacity: l.opacity });
        }
        break;
      }
      case 'text': {
        if (!rl.text) break;
        const font = await fonts.get(rl.text.font);
        for (const ln of rl.text.lines) {
          if (!ln.text) continue;
          page.drawText(ln.text, { x: ln.x, y: H - ln.y, size: rl.text.size, font, color: hexToColor(l.color, false), opacity: l.opacity });
        }
        break;
      }
    }
    page.pushOperators(popGraphicsState());
  }
  return doc.save({ useObjectStreams: false });
}
