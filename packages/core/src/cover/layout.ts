import { fontKeyFor, fontMetrics, missingGlyphs, wrapText, type FontKey } from '../fonts/registry';
import { inToPt, round } from '../units';
import type { CoverGeometry, Rect } from './geometry';
import { CoverDesign, type CoverLayer, type Paint } from './schema';

/** Absolute (canvas, points) representation of a cover, shared by the SVG and PDF renderers. */
export interface CoverTextLine {
  x: number;
  y: number;
  text: string;
  width: number;
}

export interface ResolvedLayer {
  layer: CoverLayer;
  /** Box in canvas points (top-left origin). */
  box: { x: number; y: number; w: number; h: number };
  /** Rotation centre. */
  cx: number;
  cy: number;
  text?: { font: FontKey; size: number; lines: CoverTextLine[]; bounds: { x: number; y: number; w: number; h: number } };
  image?: { drawX: number; drawY: number; drawW: number; drawH: number; effectiveDpi: number | null };
}

export interface CoverWarning {
  code:
    | 'TEXT_OUTSIDE_SAFE'
    | 'SPINE_TEXT_NOT_ALLOWED'
    | 'SPINE_TEXT_TOO_WIDE'
    | 'BARCODE_AREA_OBSTRUCTED'
    | 'LOW_DPI'
    | 'MISSING_ASSET'
    | 'MISSING_GLYPH'
    | 'TEXT_OVERFLOW'
    | 'BLEED_GAP'
    | 'PLACEHOLDER_TEXT'
    | 'GEOMETRY_UNRESOLVED'
    | 'NO_TITLE';
  level: 'info' | 'warning' | 'error';
  message: string;
  layerId?: string;
}

export interface CoverLayout {
  widthPt: number;
  heightPt: number;
  background: Paint;
  layers: ResolvedLayer[];
  warnings: CoverWarning[];
  geometry: CoverGeometry;
}

export interface CoverAssetInfo {
  widthPx: number;
  heightPx: number;
  mimeType: string;
}

const PLACEHOLDER = /(\{\{|\}\}|lorem ipsum|your title here|author name here|placeholder|\[insert)/i;

function anchorRect(geom: CoverGeometry, anchor: CoverLayer['anchor']): Rect {
  if (anchor === 'canvas') return { x: 0, y: 0, w: geom.widthIn, h: geom.heightIn };
  return geom.panels[anchor];
}

function intersects(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function contains(outer: { x: number; y: number; w: number; h: number }, inner: { x: number; y: number; w: number; h: number }, tol = 0.5) {
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;
}

/** Axis-aligned bounds of a box rotated about (cx, cy). */
function rotatedBounds(b: { x: number; y: number; w: number; h: number }, deg: number, cx: number, cy: number) {
  if (!deg) return b;
  const r = (deg * Math.PI) / 180;
  const pts = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x, b.y + b.h],
    [b.x + b.w, b.y + b.h],
  ].map(([x, y]) => [cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r), cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

export function layoutCover(input: CoverDesign | unknown, geom: CoverGeometry, assets: Record<string, CoverAssetInfo> = {}, minDpi = 300): CoverLayout {
  const design = CoverDesign.parse(input);
  const warnings: CoverWarning[] = [];
  const P = inToPt;
  if (geom.widthIn <= 0 || geom.heightIn <= 0) {
    warnings.push({ code: 'GEOMETRY_UNRESOLVED', level: 'error', message: 'Cover geometry is unresolved (official hardcover template values required).' });
  }
  const safePt = (r: Rect) => ({ x: P(r.x), y: P(r.y), w: P(r.w), h: P(r.h) });
  const layers: ResolvedLayer[] = [];

  for (const layer of design.layers) {
    if (layer.hidden) continue;
    const a = anchorRect(geom, layer.anchor);
    const box = { x: P(a.x + layer.x), y: P(a.y + layer.y), w: P(layer.w), h: P(layer.h) };
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const rl: ResolvedLayer = { layer, box, cx, cy };

    if (layer.type === 'text') {
      const font = fontKeyFor(layer.font, layer.bold, layer.italic);
      const miss = missingGlyphs(font, layer.text);
      if (miss.length) warnings.push({ code: 'MISSING_GLYPH', level: 'error', message: `Font cannot render: ${miss.join(' ')}`, layerId: layer.id });
      if (PLACEHOLDER.test(layer.text)) warnings.push({ code: 'PLACEHOLDER_TEXT', level: 'error', message: `Layer "${layer.name || layer.id}" contains placeholder text.`, layerId: layer.id });
      const wrapped = wrapText(font, layer.text, layer.sizePt, box.w);
      const lh = layer.sizePt * layer.lineHeight;
      const { ascent, descent } = fontMetrics(font, layer.sizePt);
      const blockH = wrapped.length * lh;
      if (blockH > box.h + 0.5) warnings.push({ code: 'TEXT_OVERFLOW', level: 'error', message: `Text in "${layer.name || layer.id}" is taller than its box.`, layerId: layer.id });
      const top = layer.valign === 'middle' ? box.y + (box.h - blockH) / 2 : layer.valign === 'bottom' ? box.y + box.h - blockH : box.y;
      const lines: CoverTextLine[] = wrapped.map((l, i) => {
        const x = layer.align === 'center' ? box.x + (box.w - l.width) / 2 : layer.align === 'right' ? box.x + box.w - l.width : box.x;
        return { x: round(x, 3), y: round(top + i * lh + (lh - (ascent + descent)) / 2 + ascent, 3), text: l.text, width: l.width };
      });
      const minX = Math.min(...lines.map((l) => l.x), box.x + box.w);
      const maxX = Math.max(...lines.map((l) => l.x + l.width), box.x);
      const bounds = { x: minX, y: top, w: Math.max(0, maxX - minX), h: blockH };
      rl.text = { font, size: layer.sizePt, lines, bounds };

      // Safety checks use the rotated bounds of the actual ink.
      const ink = rotatedBounds(bounds, layer.rotation, cx, cy);
      const onSpine = layer.anchor === 'spine' || layer.role === 'spine';
      if (onSpine && geom.format !== 'EBOOK' && !geom.spineTextAllowed && layer.text.trim()) {
        warnings.push({ code: 'SPINE_TEXT_NOT_ALLOWED', level: 'error', message: `Spine text requires at least the minimum page count; this book has ${geom.pageCount} pages.`, layerId: layer.id });
      }
      if (layer.text.trim()) {
        const safeRects = [geom.safe.front, geom.safe.back, geom.safe.spine].filter((r) => r.w > 0 && r.h > 0).map(safePt);
        const target = onSpine ? safePt(geom.safe.spine) : layer.anchor === 'canvas' ? null : safePt(geom.safe[layer.anchor]);
        const ok = target ? contains(target, ink) : safeRects.some((r) => contains(r, ink));
        if (!ok) {
          warnings.push({
            code: onSpine ? 'SPINE_TEXT_TOO_WIDE' : 'TEXT_OUTSIDE_SAFE',
            level: 'error',
            message: onSpine ? `Spine text "${layer.text.slice(0, 30)}" does not fit inside the spine safe area.` : `Text "${layer.text.slice(0, 30)}" extends outside the safe area.`,
            layerId: layer.id,
          });
        }
        if (geom.barcode && design.barcode === 'KDP_BARCODE' && intersects(ink, safePt(geom.barcode))) {
          warnings.push({ code: 'BARCODE_AREA_OBSTRUCTED', level: 'error', message: `Text "${layer.text.slice(0, 30)}" overlaps the barcode area.`, layerId: layer.id });
        }
      }
    }

    if (layer.type === 'path' && geom.barcode && design.barcode === 'KDP_BARCODE' && intersects(rotatedBounds(box, layer.rotation, cx, cy), safePt(geom.barcode))) {
      warnings.push({ code: 'BARCODE_AREA_OBSTRUCTED', level: 'warning', message: `Vector element "${layer.name || layer.id}" overlaps the barcode area.`, layerId: layer.id });
    }

    if (layer.type === 'image') {
      const info = assets[layer.assetId];
      if (!info) {
        warnings.push({ code: 'MISSING_ASSET', level: 'error', message: `Image asset "${layer.assetId}" is missing.`, layerId: layer.id });
      } else {
        const ar = info.widthPx / info.heightPx;
        let w = box.w;
        let h = w / ar;
        if ((layer.fit === 'contain' && h > box.h) || (layer.fit === 'cover' && h < box.h)) {
          h = box.h;
          w = h * ar;
        }
        const dpi = info.widthPx / (w / 72);
        rl.image = { drawX: box.x + (box.w - w) / 2, drawY: box.y + (box.h - h) / 2, drawW: w, drawH: h, effectiveDpi: Math.round(dpi) };
        if (geom.format !== 'EBOOK' && dpi < minDpi) warnings.push({ code: 'LOW_DPI', level: 'warning', message: `Image "${layer.name || layer.assetId}" prints at ${Math.round(dpi)} DPI (minimum ${minDpi}).`, layerId: layer.id });
      }
    }

    // Shapes/images that stop at the trim line instead of the bleed edge leave a white sliver.
    if ((layer.type === 'image' || layer.type === 'rect') && geom.bleedIn > 0 && !layer.rotation) {
      const b = { x: box.x, y: box.y, w: box.w, h: box.h };
      const W = P(geom.widthIn);
      const H = P(geom.heightIn);
      const bleed = P(geom.bleedIn);
      const gap = (edgeDist: number) => edgeDist > 0.5 && edgeDist <= bleed + 0.5;
      if (gap(b.x) || gap(b.y) || gap(W - (b.x + b.w)) || gap(H - (b.y + b.h))) {
        warnings.push({ code: 'BLEED_GAP', level: 'warning', message: `"${layer.name || layer.id}" stops inside the bleed area; extend it to the canvas edge to avoid a white edge after trimming.`, layerId: layer.id });
      }
    }
    layers.push(rl);
  }

  if (!design.layers.some((l) => l.type === 'text' && l.role === 'title' && !l.hidden && l.text.trim())) {
    warnings.push({ code: 'NO_TITLE', level: 'warning', message: 'No visible title text layer on the cover.' });
  }

  return { widthPt: P(geom.widthIn), heightPt: P(geom.heightIn), background: design.background, layers, warnings, geometry: geom };
}

/** Gradient endpoints across a box for an angle in degrees (0 = left→right). */
export function gradientVector(box: { x: number; y: number; w: number; h: number }, angle: number) {
  const r = (angle * Math.PI) / 180;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const half = (Math.abs(box.w * Math.cos(r)) + Math.abs(box.h * Math.sin(r))) / 2;
  return { x0: cx - Math.cos(r) * half, y0: cy - Math.sin(r) * half, x1: cx + Math.cos(r) * half, y1: cy + Math.sin(r) * half };
}

/** Uniform scale + centring of a path viewBox inside a box (identical in SVG and PDF). */
export function pathFit(vbW: number, vbH: number, box: { x: number; y: number; w: number; h: number }) {
  const scale = Math.min(box.w / vbW, box.h / vbH);
  return { scale, x: box.x + (box.w - vbW * scale) / 2, y: box.y + (box.h - vbH * scale) / 2 };
}
