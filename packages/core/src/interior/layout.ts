import { fontKeyFor, fontMetrics, measure, missingGlyphs, wrapText, type FontKey } from '../fonts/registry';
import { resolvePrintSpec, type PrintSpecInput, type ResolvedPrintSpec, type SpecSource, defaultSpecSource } from '../specs/engine';
import type { ReadingDirection } from '../specs/types';
import { inToPt, round } from '../units';
import type { Chapter, DocumentSettings, InteriorDocument, PageElement, PageInstance, PageTemplate, TextStyle } from './schema';
import { InteriorDocument as InteriorDocumentSchema } from './schema';
import { getTemplate } from './templates';

/* ------------------------------------------------------------------------------------------ */
/* Output model                                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface RectPt {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Draw operations. Coordinates are points from the top-left of the media box. */
export type DrawOp =
  | { op: 'text'; x: number; y: number; text: string; font: FontKey; size: number; color: string; elementId?: string }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: string; dash?: number[]; elementId?: string }
  | { op: 'rect'; x: number; y: number; w: number; h: number; stroke: string | null; fill: string | null; width: number; radius?: number; elementId?: string }
  | { op: 'circle'; cx: number; cy: number; r: number; fill: string; elementId?: string }
  | { op: 'image'; x: number; y: number; w: number; h: number; assetId: string; clip?: RectPt; fullBleed?: boolean; elementId?: string };

export type LayoutWarningCode =
  | 'OVERFLOW'
  | 'CLIPPED'
  | 'OUTSIDE_SAFE'
  | 'MISSING_GLYPH'
  | 'MISSING_ASSET'
  | 'LOW_DPI'
  | 'THIN_LINE'
  | 'COLOR_IN_BW'
  | 'MARGIN_ADJUSTED'
  | 'BLEED_DISABLED'
  | 'UNKNOWN_TEMPLATE'
  | 'IMAGE_SCALED';

export interface LayoutWarning {
  code: LayoutWarningCode;
  message: string;
  pageIndex?: number;
  elementId?: string;
  /** Severity hint for preflight mapping. */
  level: 'info' | 'warning' | 'error';
}

export interface LaidOutPage {
  index: number;
  /** Physical page number (1-based). */
  pageNumber: number;
  /** Printed page number, or null when not shown. */
  displayNumber: string | null;
  gutterSide: 'left' | 'right';
  widthPt: number;
  heightPt: number;
  trimBox: RectPt;
  contentBox: RectPt;
  ops: DrawOp[];
  isBlank: boolean;
  /** Intentionally blank (e.g. chapter recto padding) vs. accidentally empty. */
  intentionalBlank: boolean;
  section: 'front' | 'body' | 'back';
  source: { instanceId?: string; templateId?: string | null; chapterId?: string };
  /** Text actually placed on the page — used for similarity and text-overflow checks. */
  textContent: string;
}

export interface AssetInfo {
  widthPx: number;
  heightPx: number;
  mimeType: string;
}

export interface LayoutResult {
  spec: ResolvedPrintSpec;
  settings: DocumentSettings;
  pages: LaidOutPage[];
  pageCount: number;
  margins: { insideIn: number; outsideIn: number; topIn: number; bottomIn: number };
  warnings: LayoutWarning[];
  toc: { title: string; pageIndex: number; displayNumber: string | null }[];
  imageUsage: { assetId: string; pageIndex: number; effectiveDpi: number }[];
  iterations: number;
}

export interface LayoutOptions {
  format: Omit<PrintSpecInput, 'pageCount'>;
  direction?: ReadingDirection;
  assets?: Record<string, AssetInfo>;
  specSource?: SpecSource;
  specVersion?: string;
}

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                     */
/* ------------------------------------------------------------------------------------------ */

const isGray = (hex: string) => {
  const r = hex.slice(1, 3), g = hex.slice(3, 5), b = hex.slice(5, 7);
  return r.toLowerCase() === g.toLowerCase() && g.toLowerCase() === b.toLowerCase();
};

export function interpolate(text: string, vars: Record<string, string | number | boolean>): string {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

const SUPERSCRIPT: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
function footnoteMarkers(text: string, font: FontKey): string {
  return text.replace(/\[\^(\d+)\]/g, (_, n: string) => {
    const sup = [...n].map((d) => SUPERSCRIPT[d]).join('');
    return missingGlyphs(font, sup).length === 0 ? sup : `[${n}]`;
  });
}

class Sink {
  ops: DrawOp[] = [];
  warnings: LayoutWarning[] = [];
  text: string[] = [];
  images: { assetId: string; effectiveDpi: number }[] = [];
  /** Media box of the page being built (for full-bleed elements). */
  media: RectPt | null = null;
  constructor(
    readonly ctx: LayoutCtx,
    readonly pageIndex: number,
  ) {}
  warn(code: LayoutWarningCode, message: string, elementId?: string, level: LayoutWarning['level'] = 'warning') {
    this.warnings.push({ code, message, elementId, level, pageIndex: this.pageIndex });
  }
}

interface LayoutCtx {
  spec: ResolvedPrintSpec;
  settings: DocumentSettings;
  assets: Record<string, AssetInfo>;
  templates: PageTemplate[];
  bw: boolean;
  minDpi: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Text                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function styleFont(s: TextStyle): FontKey {
  return fontKeyFor(s.font, s.bold, s.italic);
}

function textBlockHeight(text: string, style: TextStyle, width: number): number {
  if (!text.trim()) return 0;
  const lines = wrapText(styleFont(style), text, style.sizePt, width);
  return lines.length * style.sizePt * style.lineHeight;
}

/** Draws wrapped text inside `rect`; returns used height. Reports overflow if it doesn't fit. */
function drawText(sink: Sink, text: string, style: TextStyle, rect: RectPt, elementId?: string, opts: { indent?: number } = {}): number {
  if (!text.trim()) return 0;
  const font = styleFont(style);
  const miss = missingGlyphs(font, text);
  if (miss.length) sink.warn('MISSING_GLYPH', `Font cannot render: ${miss.slice(0, 10).join(' ')}`, elementId, 'error');
  if (sink.ctx.bw && !isGray(style.color)) sink.warn('COLOR_IN_BW', `Colored text (${style.color}) will print in grayscale.`, elementId, 'info');
  const lines = wrapText(font, text, style.sizePt, rect.w, opts.indent ?? 0);
  const lh = style.sizePt * style.lineHeight;
  const { ascent, descent } = fontMetrics(font, style.sizePt);
  let y = rect.y;
  let drawn = 0;
  for (let i = 0; i < lines.length; i++) {
    if (y + lh > rect.y + rect.h + 0.01) {
      sink.warn('OVERFLOW', `Text overflows its area; ${lines.length - drawn} line(s) not printed.`, elementId, 'error');
      break;
    }
    const line = lines[i];
    const baseline = y + (lh - (ascent + descent)) / 2 + ascent;
    const indent = i === 0 || lines[i - 1].last ? (opts.indent ?? 0) : 0;
    const avail = rect.w - indent;
    if (style.align === 'justify' && !line.last && line.words.length > 1) {
      const total = line.words.reduce((a, w) => a + w.width, 0);
      const gap = (avail - total) / (line.words.length - 1);
      let x = rect.x + indent;
      for (const w of line.words) {
        sink.ops.push({ op: 'text', x: round(x, 3), y: round(baseline, 3), text: w.text, font, size: style.sizePt, color: style.color, elementId });
        x += w.width + gap;
      }
    } else if (line.text) {
      const x =
        style.align === 'center' ? rect.x + (rect.w - line.width) / 2 : style.align === 'right' ? rect.x + rect.w - line.width : rect.x + indent;
      sink.ops.push({ op: 'text', x: round(x, 3), y: round(baseline, 3), text: line.text, font, size: style.sizePt, color: style.color, elementId });
    }
    sink.text.push(line.text);
    y += lh;
    drawn++;
  }
  return Math.min(lines.length * lh, rect.h);
}

/* ------------------------------------------------------------------------------------------ */
/* Elements                                                                                    */
/* ------------------------------------------------------------------------------------------ */

function hairline(sink: Sink, w: number, id: string) {
  if (w < 0.5) sink.warn('THIN_LINE', `Line weight ${w}pt may not reproduce reliably in print (recommend ≥ 0.5pt).`, id);
}

/** Intrinsic height for auto-sized elements, or null when the element should fill. */
function intrinsicHeight(el: PageElement, width: number, vars: Record<string, string | number | boolean>, ctx: LayoutCtx): number | null {
  switch (el.type) {
    case 'heading':
    case 'text':
      return textBlockHeight(interpolate(el.text, vars), el.style, width);
    case 'checklist': {
      const n = el.items.length || el.count;
      return n > 0 ? n * el.rowHeightPt : null;
    }
    case 'table':
      return el.rows > 0 ? (el.rows + 1) * el.rowHeightPt : null;
    case 'fields':
      return el.rowHeightPt;
    case 'columns': {
      let max = 0;
      const widths = columnWidths(el, width);
      el.columns.forEach((c, i) => {
        let sum = 0;
        for (const child of c.elements) {
          const h = resolveFixed(child, widths[i], vars, ctx);
          if (h !== null) sum += h + child.marginTopPt + child.marginBottomPt;
        }
        max = Math.max(max, sum);
      });
      return max;
    }
    default:
      return null;
  }
}

function resolveFixed(el: PageElement, width: number, vars: Record<string, string | number | boolean>, ctx: LayoutCtx): number | null {
  if (el.height.mode === 'fixed') return el.height.pt;
  if (el.height.mode === 'fill') return null;
  return intrinsicHeight(el, width, vars, ctx);
}

function columnWidths(el: Extract<PageElement, { type: 'columns' }>, width: number): number[] {
  const total = el.columns.reduce((a, c) => a + c.width, 0);
  const usable = width - el.gapPt * (el.columns.length - 1);
  return el.columns.map((c) => (usable * c.width) / total);
}

/** Vertical stack layout of elements inside `rect`. */
function layoutStack(sink: Sink, elements: PageElement[], rect: RectPt, vars: Record<string, string | number | boolean>) {
  const ctx = sink.ctx;
  const fixed = elements.map((el) => resolveFixed(el, rect.w, vars, ctx));
  const isEmptyText = (el: PageElement) => (el.type === 'heading' || el.type === 'text') && !interpolate(el.text, vars).trim();
  let used = 0;
  let weights = 0;
  elements.forEach((el, i) => {
    if (isEmptyText(el)) return;
    used += el.marginTopPt + el.marginBottomPt + (fixed[i] ?? 0);
    if (fixed[i] === null) weights += el.height.mode === 'fill' ? el.height.weight : 1;
  });
  const remaining = rect.h - used;
  if (remaining < -0.5) {
    sink.warn('OVERFLOW', `Page content needs ${round(used, 1)}pt but only ${round(rect.h, 1)}pt is available; lower elements are clipped.`, undefined, 'error');
  }
  let y = rect.y;
  const bottom = rect.y + rect.h;
  elements.forEach((el, i) => {
    if (isEmptyText(el)) return;
    y += el.marginTopPt;
    let h = fixed[i] ?? (weights > 0 ? (Math.max(remaining, 0) * (el.height.mode === 'fill' ? el.height.weight : 1)) / weights : 0);
    if (y + h > bottom + 0.5) {
      const visible = bottom - y;
      if (visible <= 0) {
        sink.warn('CLIPPED', `Element "${el.id}" does not fit on the page and was not printed.`, el.id, 'error');
        y += h + el.marginBottomPt;
        return;
      }
      sink.warn('CLIPPED', `Element "${el.id}" was cut to fit the page.`, el.id, 'error');
      h = visible;
    }
    drawElement(sink, el, { x: rect.x, y, w: rect.w, h }, vars);
    y += h + el.marginBottomPt;
  });
}

function drawElement(sink: Sink, el: PageElement, r: RectPt, vars: Record<string, string | number | boolean>) {
  const ctx = sink.ctx;
  switch (el.type) {
    case 'heading':
    case 'text':
      drawText(sink, interpolate(el.text, vars), el.style, r, el.id);
      return;
    case 'spacer':
      return;
    case 'divider': {
      hairline(sink, el.weightPt, el.id);
      const y = r.y + r.h / 2;
      sink.ops.push({ op: 'line', x1: r.x, y1: y, x2: r.x + r.w, y2: y, width: el.weightPt, color: el.color, elementId: el.id });
      return;
    }
    case 'lines': {
      hairline(sink, el.weightPt, el.id);
      if (ctx.bw && !isGray(el.color)) sink.warn('COLOR_IN_BW', `Colored lines will print in grayscale.`, el.id, 'info');
      for (let y = r.y + el.spacingPt; y <= r.y + r.h + 0.01; y += el.spacingPt) {
        sink.ops.push({ op: 'line', x1: r.x, y1: round(y, 3), x2: r.x + r.w, y2: round(y, 3), width: el.weightPt, color: el.color, dash: el.dashed ? [2, 2] : undefined, elementId: el.id });
      }
      return;
    }
    case 'dotGrid': {
      const cols = Math.floor(r.w / el.spacingPt);
      const rows = Math.floor(r.h / el.spacingPt);
      const ox = r.x + (r.w - cols * el.spacingPt) / 2;
      const oy = r.y + (r.h - rows * el.spacingPt) / 2;
      for (let j = 0; j <= rows; j++)
        for (let i = 0; i <= cols; i++)
          sink.ops.push({ op: 'circle', cx: round(ox + i * el.spacingPt, 3), cy: round(oy + j * el.spacingPt, 3), r: el.dotRadiusPt, fill: el.color, elementId: el.id });
      return;
    }
    case 'grid': {
      hairline(sink, el.weightPt, el.id);
      const cols = Math.floor(r.w / el.spacingPt);
      const rows = Math.floor(r.h / el.spacingPt);
      const ox = r.x + (r.w - cols * el.spacingPt) / 2;
      const oy = r.y + (r.h - rows * el.spacingPt) / 2;
      for (let i = 0; i <= cols; i++) {
        const x = round(ox + i * el.spacingPt, 3);
        sink.ops.push({ op: 'line', x1: x, y1: oy, x2: x, y2: round(oy + rows * el.spacingPt, 3), width: el.weightPt, color: el.color, elementId: el.id });
      }
      for (let j = 0; j <= rows; j++) {
        const y = round(oy + j * el.spacingPt, 3);
        sink.ops.push({ op: 'line', x1: ox, y1: y, x2: round(ox + cols * el.spacingPt, 3), y2: y, width: el.weightPt, color: el.color, elementId: el.id });
      }
      return;
    }
    case 'checklist': {
      hairline(sink, el.weightPt, el.id);
      const n = el.items.length || el.count || Math.floor(r.h / el.rowHeightPt);
      const font = styleFont(el.style);
      for (let i = 0; i < n; i++) {
        const top = r.y + i * el.rowHeightPt;
        if (top + el.rowHeightPt > r.y + r.h + 0.01) {
          if (el.items.length || el.count) sink.warn('CLIPPED', `Checklist rows exceed the available height.`, el.id, 'error');
          break;
        }
        const by = top + (el.rowHeightPt - el.boxSizePt) / 2;
        sink.ops.push({ op: 'rect', x: r.x, y: round(by, 3), w: el.boxSizePt, h: el.boxSizePt, stroke: '#000000', fill: null, width: el.weightPt, elementId: el.id });
        const tx = r.x + el.boxSizePt + 6;
        const label = el.items[i] ? interpolate(el.items[i], vars) : '';
        if (label) {
          const { ascent, descent } = fontMetrics(font, el.style.sizePt);
          const base = top + (el.rowHeightPt - (ascent + descent)) / 2 + ascent;
          const fitted = fitSingleLine(sink, font, label, el.style.sizePt, r.w - (tx - r.x), el.id);
          sink.ops.push({ op: 'text', x: round(tx, 3), y: round(base, 3), text: fitted, font, size: el.style.sizePt, color: el.style.color, elementId: el.id });
          sink.text.push(fitted);
        } else if (el.writingLine) {
          const ly = round(top + el.rowHeightPt - 4, 3);
          sink.ops.push({ op: 'line', x1: round(tx, 3), y1: ly, x2: r.x + r.w, y2: ly, width: el.weightPt, color: '#555555', elementId: el.id });
        }
      }
      return;
    }
    case 'table': {
      hairline(sink, el.weightPt, el.id);
      const total = el.columns.reduce((a, c) => a + c.width, 0);
      const widths = el.columns.map((c) => (r.w * c.width) / total);
      const headH = el.rowHeightPt;
      // A fixed row count in a fill-height table stretches rows to use the space (never below 14pt).
      const rowH = el.rows > 0 && el.height.mode === 'fill' ? Math.max(14, (r.h - headH) / el.rows) : el.rowHeightPt;
      const bodyRows = el.rows > 0 ? el.rows : Math.max(0, Math.floor((r.h - headH) / rowH));
      const tableH = headH + bodyRows * rowH;
      if (tableH > r.h + 0.5) sink.warn('CLIPPED', `Table needs ${round(tableH, 1)}pt; only ${round(r.h, 1)}pt available.`, el.id, 'error');
      const rowsFit = Math.min(bodyRows, Math.floor((r.h - headH) / rowH + 0.001));
      const h = headH + rowsFit * rowH;
      const rowTop = (i: number) => (i === 0 ? r.y : r.y + headH + (i - 1) * rowH);
      if (el.headerFill) {
        if (ctx.bw && !isGray(el.headerFill)) sink.warn('COLOR_IN_BW', 'Colored table header will print in grayscale.', el.id, 'info');
        sink.ops.push({ op: 'rect', x: r.x, y: r.y, w: r.w, h: el.rowHeightPt, stroke: null, fill: el.headerFill, width: 0, elementId: el.id });
      }
      // Grid lines
      for (let i = 0; i <= rowsFit + 1; i++) {
        const y = round(rowTop(i), 3);
        sink.ops.push({ op: 'line', x1: r.x, y1: y, x2: r.x + r.w, y2: y, width: el.weightPt, color: '#000000', elementId: el.id });
      }
      let x = r.x;
      for (let c = 0; c <= widths.length; c++) {
        sink.ops.push({ op: 'line', x1: round(x, 3), y1: r.y, x2: round(x, 3), y2: round(r.y + h, 3), width: el.weightPt, color: '#000000', elementId: el.id });
        x += widths[c] ?? 0;
      }
      const cell = (text: string, style: TextStyle, cx: number, cy: number, cw: number, ch: number) => {
        if (!text) return;
        const font = styleFont(style);
        const pad = Math.min(3, cw * 0.1);
        // Shrink to fit (down to 6pt) before truncating.
        let size = style.sizePt;
        while (size > 6 && measure(font, text, size) > cw - 2 * pad) size = Math.max(6, size - 0.5);
        const fitted = fitSingleLine(sink, font, text, size, cw - 2 * pad, el.id);
        const tw = measure(font, fitted, size);
        const { ascent, descent } = fontMetrics(font, size);
        const base = cy + (Math.min(ch, el.rowHeightPt) - (ascent + descent)) / 2 + ascent;
        const tx = style.align === 'center' ? cx + (cw - tw) / 2 : style.align === 'right' ? cx + cw - pad - tw : cx + pad;
        sink.ops.push({ op: 'text', x: round(tx, 3), y: round(base, 3), text: fitted, font, size, color: style.color, elementId: el.id });
        sink.text.push(fitted);
      };
      x = r.x;
      el.columns.forEach((col, c) => {
        cell(interpolate(col.header, vars), el.headerStyle, x, r.y, widths[c], headH);
        for (let row = 0; row < rowsFit; row++) {
          const v = el.cells[row]?.[c];
          if (v) cell(interpolate(v, vars), el.bodyStyle, x, rowTop(row + 1), widths[c], rowH);
        }
        x += widths[c];
      });
      return;
    }
    case 'fields': {
      hairline(sink, el.weightPt, el.id);
      const total = el.fields.reduce((a, f) => a + f.width, 0);
      const gap = 10;
      const usable = r.w - gap * (el.fields.length - 1);
      const font = styleFont(el.style);
      let x = r.x;
      const lineY = round(r.y + Math.min(el.rowHeightPt, r.h) - 4, 3);
      for (const f of el.fields) {
        const fw = (usable * f.width) / total;
        const label = interpolate(f.label, vars);
        const text = label ? `${label}:` : '';
        const lw = text ? measure(font, text, el.style.sizePt) + 4 : 0;
        if (text) {
          const fitted = fitSingleLine(sink, font, text, el.style.sizePt, fw, el.id);
          sink.ops.push({ op: 'text', x: round(x, 3), y: round(lineY - 2, 3), text: fitted, font, size: el.style.sizePt, color: el.style.color, elementId: el.id });
          sink.text.push(fitted);
        }
        if (fw - lw > 6) sink.ops.push({ op: 'line', x1: round(x + lw, 3), y1: lineY, x2: round(x + fw, 3), y2: lineY, width: el.weightPt, color: '#000000', elementId: el.id });
        x += fw + gap;
      }
      return;
    }
    case 'box': {
      hairline(sink, el.weightPt, el.id);
      sink.ops.push({ op: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, stroke: '#000000', fill: el.fill, width: el.weightPt, radius: el.radiusPt || undefined, elementId: el.id });
      const pad = 6;
      let top = r.y + pad;
      const label = interpolate(el.label, vars);
      if (label) {
        const used = drawText(sink, label, el.style, { x: r.x + pad, y: top, w: r.w - 2 * pad, h: r.h - 2 * pad }, el.id);
        top += used;
      }
      if (el.linesInside > 0) {
        for (let y = top + el.linesInside; y <= r.y + r.h - pad + 0.01; y += el.linesInside) {
          sink.ops.push({ op: 'line', x1: r.x + pad, y1: round(y, 3), x2: r.x + r.w - pad, y2: round(y, 3), width: Math.max(0.5, el.weightPt * 0.8), color: '#666666', elementId: el.id });
        }
      }
      return;
    }
    case 'image':
      drawImage(sink, el, r, vars);
      return;
    case 'columns': {
      const widths = columnWidths(el, r.w);
      let x = r.x;
      el.columns.forEach((c, i) => {
        layoutStack(sink, c.elements, { x, y: r.y, w: widths[i], h: r.h }, vars);
        x += widths[i] + el.gapPt;
      });
      return;
    }
  }
}

function fitSingleLine(sink: Sink, font: FontKey, text: string, size: number, maxW: number, id: string): string {
  if (measure(font, text, size) <= maxW) return text;
  sink.warn('CLIPPED', `Text "${text.slice(0, 40)}" is too wide for its cell and was truncated.`, id, 'error');
  let t = text;
  while (t.length > 1 && measure(font, t + '…', size) > maxW) t = t.slice(0, -1);
  return t + '…';
}

function drawImage(sink: Sink, el: Extract<PageElement, { type: 'image' }>, r: RectPt, vars: Record<string, string | number | boolean>) {
  const info = sink.ctx.assets[el.assetId];
  if (!info) {
    sink.warn('MISSING_ASSET', `Image asset "${el.assetId}" is missing; nothing was printed in its place.`, el.id, 'error');
    return;
  }
  let area = { ...r };
  const caption = interpolate(el.caption, vars);
  const capStyle: TextStyle = { font: 'serif', bold: false, italic: true, sizePt: 9, align: 'center', color: '#000000', lineHeight: 1.3 };
  const capH = caption ? textBlockHeight(caption, capStyle, r.w) + 4 : 0;
  const fullBleed = el.fullBleed && sink.ctx.spec.input.bleed && sink.media !== null;
  if (el.fullBleed && !fullBleed) sink.warn('BLEED_DISABLED', `Image "${el.assetId}" is set to full bleed but bleed is disabled; it was placed inside the margins.`, el.id, 'warning');
  if (fullBleed) {
    area = sink.media!;
  } else {
    area = { x: r.x + (r.w * (1 - el.widthRatio)) / 2, y: r.y, w: r.w * el.widthRatio, h: r.h - capH };
  }
  const ar = info.widthPx / info.heightPx;
  let w = area.w;
  let h = w / ar;
  let clip: RectPt | undefined;
  if (el.fit === 'contain') {
    if (h > area.h) {
      h = area.h;
      w = h * ar;
    }
  } else {
    if (h < area.h) {
      h = area.h;
      w = h * ar;
    }
    clip = area;
  }
  if (fullBleed) clip = area;
  const x = area.x + (area.w - w) / 2;
  const y = area.y + (el.fit === 'contain' ? 0 : (area.h - h) / 2);
  const dpi = info.widthPx / (w / 72);
  if (dpi < sink.ctx.minDpi) sink.warn('LOW_DPI', `Image "${el.assetId}" prints at ${Math.round(dpi)} DPI (minimum ${sink.ctx.minDpi}).`, el.id, 'warning');
  sink.images.push({ assetId: el.assetId, effectiveDpi: Math.round(dpi) });
  sink.ops.push({ op: 'image', x: round(x, 3), y: round(y, 3), w: round(w, 3), h: round(h, 3), assetId: el.assetId, clip, fullBleed: fullBleed || undefined, elementId: el.id });
  if (caption && !fullBleed) drawText(sink, caption, capStyle, { x: r.x, y: y + Math.min(h, area.h) + 4, w: r.w, h: capH }, el.id);
}

/* ------------------------------------------------------------------------------------------ */
/* Page frames                                                                                  */
/* ------------------------------------------------------------------------------------------ */

interface Frame {
  widthPt: number;
  heightPt: number;
  trim: RectPt;
  media: RectPt;
  content: RectPt;
  /** Body area: content minus header/footer bands. */
  body: RectPt;
  header: RectPt | null;
  footer: RectPt | null;
  gutterSide: 'left' | 'right';
}

export function gutterSideFor(pageNumber: number, direction: ReadingDirection): 'left' | 'right' {
  const odd = pageNumber % 2 === 1;
  return direction === 'LTR' ? (odd ? 'left' : 'right') : odd ? 'right' : 'left';
}

function makeFrame(spec: ResolvedPrintSpec, margins: LayoutResult['margins'], settings: DocumentSettings, pageNumber: number, direction: ReadingDirection): Frame {
  const gutterSide = gutterSideFor(pageNumber, direction);
  const widthPt = inToPt(spec.pageWidthIn);
  const heightPt = inToPt(spec.pageHeightIn);
  // Bleed is added on the outside edge only (never into the gutter).
  const trimX = gutterSide === 'left' ? inToPt(spec.bleed.insideIn) : inToPt(spec.bleed.outsideIn);
  const trim: RectPt = { x: trimX, y: inToPt(spec.bleed.topIn), w: inToPt(spec.trim.widthIn), h: inToPt(spec.trim.heightIn) };
  const left = gutterSide === 'left' ? margins.insideIn : margins.outsideIn;
  const right = gutterSide === 'left' ? margins.outsideIn : margins.insideIn;
  const content: RectPt = {
    x: round(trim.x + inToPt(left), 3),
    y: round(trim.y + inToPt(margins.topIn), 3),
    w: round(trim.w - inToPt(left + right), 3),
    h: round(trim.h - inToPt(margins.topIn + margins.bottomIn), 3),
  };
  const headerH = settings.runningHeader.enabled ? settings.runningHeader.sizePt * 2.4 : 0;
  const footerH = settings.pageNumbers.enabled ? settings.pageNumbers.sizePt * 2.4 : 0;
  return {
    widthPt,
    heightPt,
    trim,
    media: { x: 0, y: 0, w: widthPt, h: heightPt },
    content,
    body: { x: content.x, y: content.y + headerH, w: content.w, h: content.h - headerH - footerH },
    header: headerH ? { x: content.x, y: content.y, w: content.w, h: headerH } : null,
    footer: footerH ? { x: content.x, y: content.y + content.h - footerH, w: content.w, h: footerH } : null,
    gutterSide,
  };
}

function drawPageFurniture(sink: Sink, frame: Frame, settings: DocumentSettings, displayNumber: string | null, headerText: string | null) {
  if (frame.footer && displayNumber) {
    const font = fontKeyFor(settings.bodyStyle.font);
    const size = settings.pageNumbers.sizePt;
    const w = measure(font, displayNumber, size);
    const outside = settings.pageNumbers.position === 'outside';
    const x = !outside ? frame.footer.x + (frame.footer.w - w) / 2 : frame.gutterSide === 'left' ? frame.footer.x + frame.footer.w - w : frame.footer.x;
    const y = frame.footer.y + frame.footer.h - fontMetrics(font, size).descent - 1;
    sink.ops.push({ op: 'text', x: round(x, 3), y: round(y, 3), text: displayNumber, font, size, color: '#000000', elementId: '__pageNumber' });
  }
  if (frame.header && headerText) {
    const style: TextStyle = { ...settings.bodyStyle, sizePt: settings.runningHeader.sizePt, italic: true, bold: false, align: 'center', lineHeight: 1.2 };
    const font = styleFont(style);
    const fitted = fitSingleLine(sink, font, headerText, style.sizePt, frame.header.w, '__runningHeader');
    const w = measure(font, fitted, style.sizePt);
    sink.ops.push({ op: 'text', x: round(frame.header.x + (frame.header.w - w) / 2, 3), y: round(frame.header.y + style.sizePt, 3), text: fitted, font, size: style.sizePt, color: '#000000', elementId: '__runningHeader' });
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Document pagination                                                                         */
/* ------------------------------------------------------------------------------------------ */

interface PendingPage {
  section: 'front' | 'body' | 'back';
  build: (sink: Sink, frame: Frame) => void;
  numbered: boolean;
  showHeader: boolean;
  headerSection: string;
  source: LaidOutPage['source'];
  intentionalBlank: boolean;
}

function templateVars(settings: DocumentSettings, extra: Record<string, string | number | boolean> = {}) {
  return { title: settings.title, author: settings.author, ...extra };
}

function instancePage(inst: PageInstance, ctx: LayoutCtx, section: PendingPage['section'], tocBuilder?: () => TocLine[]): PendingPage {
  const tpl = inst.templateId ? getTemplate(inst.templateId, ctx.templates) : undefined;
  const base = templateVars(ctx.settings);
  const fieldDefaults = Object.fromEntries((tpl?.fields ?? []).map((f) => [f.key, f.default]));
  const raw = { ...fieldDefaults, ...inst.fields };
  // Field values may reference built-ins such as {{author}}.
  const vars: Record<string, string | number | boolean> = { ...base };
  for (const [k, v] of Object.entries(raw)) vars[k] = typeof v === 'string' ? interpolate(v, base) : v;
  const elements = inst.elements ?? tpl?.elements ?? [];
  const blank = inst.blank || (inst.templateId === 'blank' && !inst.elements);
  return {
    section,
    numbered: !blank && (tpl?.showPageNumber ?? true),
    showHeader: !blank && (tpl?.showRunningHeader ?? true),
    headerSection: tpl?.name ?? '',
    source: { instanceId: inst.id, templateId: inst.templateId },
    intentionalBlank: blank,
    build: (sink, frame) => {
      if (inst.templateId && !tpl) sink.warn('UNKNOWN_TEMPLATE', `Template "${inst.templateId}" not found.`, undefined, 'error');
      // Line spacing field convention for lined pages.
      const els = elements.map((e) => (e.type === 'lines' && typeof vars.lineSpacing === 'number' && vars.lineSpacing > 0 ? { ...e, spacingPt: vars.lineSpacing } : e));
      layoutStack(sink, els, frame.body, vars);
      if (inst.templateId === 'toc' && tocBuilder) drawToc(sink, frame, tocBuilder(), ctx);
    },
  };
}

interface TocLine {
  title: string;
  page: string;
}

function drawToc(sink: Sink, frame: Frame, lines: TocLine[], ctx: LayoutCtx) {
  const style: TextStyle = { ...ctx.settings.bodyStyle, align: 'left', lineHeight: 1.6 };
  const font = styleFont(style);
  const lh = style.sizePt * style.lineHeight;
  // Heading drawn by template occupies the top; entries start below a fixed offset.
  let y = frame.body.y + 18 * 1.3 + 12 + lh;
  for (const l of lines) {
    if (y > frame.body.y + frame.body.h) {
      sink.warn('OVERFLOW', 'Table of contents does not fit on one page.', 'toc', 'error');
      break;
    }
    const pw = measure(font, l.page, style.sizePt);
    const title = fitSingleLine(sink, font, l.title, style.sizePt, frame.body.w - pw - 24, 'toc');
    sink.ops.push({ op: 'text', x: frame.body.x, y: round(y, 3), text: title, font, size: style.sizePt, color: '#000000', elementId: 'toc' });
    const tw = measure(font, title, style.sizePt);
    const dot = measure(font, '. ', style.sizePt);
    const dots = Math.max(0, Math.floor((frame.body.w - tw - pw - 12) / dot));
    if (dots > 0) {
      const leader = '. '.repeat(dots).trim();
      const lw = measure(font, leader, style.sizePt);
      sink.ops.push({ op: 'text', x: round(frame.body.x + frame.body.w - pw - 6 - lw, 3), y: round(y, 3), text: leader, font, size: style.sizePt, color: '#000000', elementId: 'toc' });
    }
    sink.ops.push({ op: 'text', x: round(frame.body.x + frame.body.w - pw, 3), y: round(y, 3), text: l.page, font, size: style.sizePt, color: '#000000', elementId: 'toc' });
    sink.text.push(`${l.title} ${l.page}`);
    y += lh;
  }
}

/* ---------------------------------- Long-form flow ------------------------------------------ */

interface FlowPage {
  sink: Sink;
  frame: Frame;
  y: number;
  chapterId: string;
  chapterTitle: string;
  opener: boolean;
  intentionalBlank: boolean;
}

function flowChapters(chapters: Chapter[], ctx: LayoutCtx, firstPageNumber: number, direction: ReadingDirection, margins: LayoutResult['margins']) {
  const pages: FlowPage[] = [];
  const toc: { title: string; pageOffset: number }[] = [];
  const s = ctx.settings;
  const body = s.bodyStyle;
  const bodyFont = styleFont(body);
  const lh = body.sizePt * body.lineHeight;
  let cur: FlowPage | null = null;

  const newPage = (chapter: Chapter, opener = false, intentionalBlank = false): FlowPage => {
    const pageNumber = firstPageNumber + pages.length;
    const frame = makeFrame(ctx.spec, margins, s, pageNumber, direction);
    const p: FlowPage = { sink: new Sink(ctx, pageNumber - 1), frame, y: frame.body.y, chapterId: chapter.id, chapterTitle: chapter.title, opener, intentionalBlank };
    pages.push(p);
    cur = p;
    return p;
  };
  const remaining = () => (cur ? cur.frame.body.y + cur.frame.body.h - cur.y : 0);
  const ensure = (chapter: Chapter, h: number) => {
    if (!cur || remaining() < h - 0.01) newPage(chapter);
    return cur!;
  };

  const placeLines = (chapter: Chapter, text: string, style: TextStyle, opts: { indent?: number; leftPad?: number; rightPad?: number; prefix?: string } = {}) => {
    const font = styleFont(style);
    const t = footnoteMarkers(text, font);
    const miss = missingGlyphs(font, t);
    const lineH = style.sizePt * style.lineHeight;
    const page0 = ensure(chapter, lineH);
    if (miss.length) page0.sink.warn('MISSING_GLYPH', `Font cannot render: ${miss.slice(0, 10).join(' ')}`, chapter.id, 'error');
    const width = page0.frame.body.w - (opts.leftPad ?? 0) - (opts.rightPad ?? 0);
    const lines = wrapText(font, t, style.sizePt, width, opts.indent ?? 0);
    // Orphan control: avoid leaving a single line of a multi-line paragraph at the page bottom.
    if (lines.length > 1 && remaining() < 2 * lineH) newPage(chapter);
    const { ascent, descent } = fontMetrics(font, style.sizePt);
    lines.forEach((line, i) => {
      // Widow control: don't carry a single last line onto a new page.
      const lastTwo = lines.length > 2 && i === lines.length - 2 && remaining() < 2 * lineH && remaining() >= lineH;
      if (lastTwo || remaining() < lineH - 0.01) newPage(chapter);
      const p = cur!;
      const base = p.y + (lineH - (ascent + descent)) / 2 + ascent;
      const indent = i === 0 ? (opts.indent ?? 0) : 0;
      const x0 = p.frame.body.x + (opts.leftPad ?? 0);
      if (i === 0 && opts.prefix) {
        const pw = measure(font, opts.prefix, style.sizePt);
        p.sink.ops.push({ op: 'text', x: round(x0 - pw - 4, 3), y: round(base, 3), text: opts.prefix, font, size: style.sizePt, color: style.color });
      }
      if (style.align === 'justify' && !line.last && line.words.length > 1) {
        const total = line.words.reduce((a, w) => a + w.width, 0);
        const gap = (width - indent - total) / (line.words.length - 1);
        let x = x0 + indent;
        for (const w of line.words) {
          p.sink.ops.push({ op: 'text', x: round(x, 3), y: round(base, 3), text: w.text, font, size: style.sizePt, color: style.color });
          x += w.width + gap;
        }
      } else if (line.text) {
        const x = style.align === 'center' ? x0 + (width - line.width) / 2 : style.align === 'right' ? x0 + width - line.width : x0 + indent;
        p.sink.ops.push({ op: 'text', x: round(x, 3), y: round(base, 3), text: line.text, font, size: style.sizePt, color: style.color });
      }
      p.sink.text.push(line.text);
      p.y += lineH;
    });
  };

  chapters.forEach((chapter, ci) => {
    // Chapter openers start on a fresh page, optionally a recto (gutter-left in LTR).
    if (cur) cur = null;
    let pageNumber = firstPageNumber + pages.length;
    const wantsRecto = s.chapterStartRecto;
    const isRecto = (n: number) => gutterSideFor(n, direction) === (direction === 'LTR' ? 'left' : 'right');
    if (wantsRecto && !isRecto(pageNumber)) {
      newPage(chapter, false, true);
      pageNumber++;
    }
    const opener = newPage(chapter, true);
    toc.push({ title: chapter.title, pageOffset: pages.length - 1 });
    opener.y += 72;
    const titleStyle: TextStyle = { font: s.headingFont, bold: true, italic: false, sizePt: 22, align: 'center', color: '#000000', lineHeight: 1.25 };
    const used = drawText(opener.sink, chapter.title, titleStyle, { x: opener.frame.body.x, y: opener.y, w: opener.frame.body.w, h: opener.frame.body.h - 72 }, chapter.id);
    opener.y += used + 30;
    let indentNext = false;
    for (const block of chapter.blocks) {
      switch (block.type) {
        case 'paragraph':
          placeLines(chapter, block.text, body, { indent: indentNext ? 18 : 0 });
          indentNext = true;
          break;
        case 'heading': {
          const size = block.level === 2 ? 15 : block.level === 3 ? 13 : 11.5;
          const hs: TextStyle = { font: s.headingFont, bold: true, italic: false, sizePt: size, align: 'left', color: '#000000', lineHeight: 1.3 };
          // Keep with next: heading + two body lines.
          ensure(chapter, size * 1.3 * 2 + 2 * lh + 10);
          if (cur!.y > cur!.frame.body.y) cur!.y += 10;
          placeLines(chapter, block.text, hs);
          cur!.y += 4;
          indentNext = false;
          break;
        }
        case 'quote':
          ensure(chapter, lh);
          cur!.y += lh * 0.3;
          placeLines(chapter, block.text, { ...body, italic: true, align: 'left' }, { leftPad: 24, rightPad: 24 });
          cur!.y += lh * 0.3;
          indentNext = false;
          break;
        case 'list':
          block.items.forEach((item, i) => placeLines(chapter, item, { ...body, align: 'left' }, { leftPad: 20, prefix: block.ordered ? `${i + 1}.` : '•' }));
          indentNext = false;
          break;
        case 'sectionBreak':
          ensure(chapter, lh * 2);
          placeLines(chapter, '*   *   *', { ...body, align: 'center' });
          indentNext = false;
          break;
        case 'pageBreak':
          cur = null;
          indentNext = false;
          break;
        case 'image': {
          const info = ctx.assets[block.assetId];
          const page = ensure(chapter, lh);
          if (!info) {
            page.sink.warn('MISSING_ASSET', `Image asset "${block.assetId}" is missing.`, chapter.id, 'error');
            break;
          }
          const w0 = page.frame.body.w * block.widthRatio;
          let h = (w0 * info.heightPx) / info.widthPx;
          const capH = block.caption ? 9 * 1.3 * 2 + 4 : 0;
          const maxH = page.frame.body.h - capH;
          let w = w0;
          if (h > maxH) {
            page.sink.warn('IMAGE_SCALED', `Image "${block.assetId}" was scaled down to fit the page.`, chapter.id, 'info');
            h = maxH;
            w = (h * info.widthPx) / info.heightPx;
          }
          const p = ensure(chapter, h + capH + 6);
          const x = p.frame.body.x + (p.frame.body.w - w) / 2;
          const dpi = info.widthPx / (w / 72);
          if (dpi < ctx.minDpi) p.sink.warn('LOW_DPI', `Image "${block.assetId}" prints at ${Math.round(dpi)} DPI (minimum ${ctx.minDpi}).`, chapter.id);
          p.sink.images.push({ assetId: block.assetId, effectiveDpi: Math.round(dpi) });
          p.sink.ops.push({ op: 'image', x: round(x, 3), y: round(p.y, 3), w: round(w, 3), h: round(h, 3), assetId: block.assetId });
          p.y += h + 4;
          if (block.caption) placeLines(chapter, block.caption, { ...body, sizePt: 9, italic: true, align: 'center', lineHeight: 1.3 });
          p.y += 6;
          indentNext = false;
          break;
        }
      }
    }
    if (chapter.notes.length) {
      ensure(chapter, lh * 4);
      cur!.y += lh;
      placeLines(chapter, 'Notes', { font: s.headingFont, bold: true, italic: false, sizePt: 12, align: 'left', color: '#000000', lineHeight: 1.4 });
      chapter.notes.forEach((n, i) => placeLines(chapter, n, { ...body, sizePt: Math.max(7, body.sizePt - 2), align: 'left' }, { leftPad: 16, prefix: `${i + 1}.` }));
    }
  });
  return { pages, toc };
}

/* ---------------------------------- Main entry ------------------------------------------------ */

function layoutPass(doc: InteriorDocument, spec: ResolvedPrintSpec, opts: LayoutOptions, minDpi: number) {
  const direction = opts.direction ?? 'LTR';
  const settings = doc.settings;
  const ctx: LayoutCtx = {
    spec,
    settings,
    assets: opts.assets ?? {},
    templates: doc.templates,
    bw: spec.input.ink === 'BLACK_WHITE',
    minDpi,
  };
  const docWarnings: LayoutWarning[] = [];
  const m = settings.margins;
  const margins = {
    insideIn: Math.max(m.insideIn, spec.minMargins.insideIn),
    outsideIn: Math.max(m.outsideIn, spec.minMargins.outsideIn),
    topIn: Math.max(m.topIn, spec.minMargins.topIn),
    bottomIn: Math.max(m.bottomIn, spec.minMargins.bottomIn),
  };
  for (const k of Object.keys(margins) as (keyof typeof margins)[]) {
    if (margins[k] !== m[k]) docWarnings.push({ code: 'MARGIN_ADJUSTED', level: 'info', message: `${k.replace('In', '')} margin raised from ${m[k]}" to the required minimum ${margins[k]}".` });
  }

  const front: PendingPage[] = [];
  const back: PendingPage[] = [];
  let tocLines: TocLine[] = [];
  for (const inst of doc.frontMatter) front.push(instancePage(inst, ctx, 'front', () => tocLines));
  for (const inst of doc.backMatter) back.push(instancePage(inst, ctx, 'back'));

  const out: LaidOutPage[] = [];
  const imageUsage: LayoutResult['imageUsage'] = [];
  let bodyCounter = 0;
  const finalize = (sink: Sink, frame: Frame, meta: Omit<LaidOutPage, 'index' | 'pageNumber' | 'widthPt' | 'heightPt' | 'trimBox' | 'contentBox' | 'ops' | 'isBlank' | 'gutterSide' | 'textContent'>) => {
    // Safety check: everything except full-bleed images must stay inside the content box.
    for (const op of sink.ops) {
      const b = opBounds(op);
      const c = frame.content;
      const inside = b.x >= c.x - 0.6 && b.y >= c.y - 0.6 && b.x + b.w <= c.x + c.w + 0.6 && b.y + b.h <= c.y + c.h + 0.6;
      if (!inside && !(op.op === 'image' && op.fullBleed)) {
        sink.warn('OUTSIDE_SAFE', `Content at (${round(b.x, 1)}, ${round(b.y, 1)})pt lies outside the safe area.`, op.elementId, 'error');
        break;
      }
    }
    const ops = sink.ops;
    const index = out.length;
    for (const img of sink.images) imageUsage.push({ ...img, pageIndex: index });
    out.push({
      ...meta,
      index,
      pageNumber: index + 1,
      widthPt: frame.widthPt,
      heightPt: frame.heightPt,
      trimBox: frame.trim,
      contentBox: frame.content,
      gutterSide: frame.gutterSide,
      ops,
      isBlank: ops.filter((o) => o.elementId !== '__pageNumber' && o.elementId !== '__runningHeader').length === 0,
      textContent: sink.text.join('\n'),
    });
    docWarnings.push(...sink.warnings.map((w) => ({ ...w, pageIndex: index })));
  };

  const renderPending = (p: PendingPage) => {
    const pageNumber = out.length + 1;
    const frame = makeFrame(spec, margins, settings, pageNumber, direction);
    const sink = new Sink(ctx, pageNumber - 1);
    sink.media = frame.media;
    p.build(sink, frame);
    let display: string | null = null;
    if (p.section !== 'front') {
      bodyCounter++;
      if (p.numbered && settings.pageNumbers.enabled) display = String(bodyCounter);
    }
    const header = p.section === 'body' && p.showHeader && settings.runningHeader.enabled ? headerFor(frame, settings, p.headerSection) : null;
    drawPageFurniture(sink, frame, settings, display, header);
    finalize(sink, frame, { displayNumber: display, section: p.section, source: p.source, intentionalBlank: p.intentionalBlank });
  };

  // Front matter is rendered after the body is known (TOC needs body page numbers), but its
  // page count is fixed (one instance = one page), so body numbering can be computed up front.
  const frontCount = front.length;
  const bodyStart = frontCount + 1;
  const bodyPages: (() => void)[] = [];
  let toc: LayoutResult['toc'] = [];

  if (doc.body.kind === 'pages') {
    const pending = doc.body.pages.map((inst) => instancePage(inst, ctx, 'body'));
    for (const p of pending) bodyPages.push(() => renderPending(p));
    // Structured books: the TOC lists chapter-opener pages.
    let n = 0;
    doc.body.pages.forEach((inst, i) => {
      const tpl = inst.templateId ? getTemplate(inst.templateId, ctx.templates) : undefined;
      n++;
      if (inst.templateId === 'chapter-page') {
        const def = tpl?.fields.find((f) => f.key === 'chapterTitle')?.default ?? '';
        const title = String(inst.fields.chapterTitle ?? def);
        const numbered = settings.pageNumbers.enabled && (tpl?.showPageNumber ?? true) && !inst.blank;
        toc.push({ title, pageIndex: frontCount + i, displayNumber: numbered ? String(n) : null });
      }
    });
    tocLines = toc.map((t) => ({ title: t.title, page: t.displayNumber ?? '' }));
  } else {
    const flow = flowChapters(doc.body.chapters, ctx, bodyStart, direction, margins);
    toc = flow.toc.map((t) => ({ title: t.title, pageIndex: frontCount + t.pageOffset, displayNumber: String(t.pageOffset + 1) }));
    tocLines = toc.map((t) => ({ title: t.title, page: t.displayNumber ?? '' }));
    for (const fp of flow.pages) {
      bodyPages.push(() => {
        bodyCounter++;
        const blank = fp.intentionalBlank || fp.sink.ops.length === 0;
        const display = !blank && settings.pageNumbers.enabled ? String(bodyCounter) : null;
        const header = !blank && !fp.opener && settings.runningHeader.enabled ? headerFor(fp.frame, settings, fp.chapterTitle) : null;
        drawPageFurniture(fp.sink, fp.frame, settings, display, header);
        finalize(fp.sink, fp.frame, { displayNumber: display, section: 'body', source: { chapterId: fp.chapterId }, intentionalBlank: fp.intentionalBlank });
      });
    }
  }

  for (const p of front) renderPending(p);
  for (const b of bodyPages) b();
  for (const p of back) renderPending(p);

  if (settings.padToEven && out.length % 2 === 1) {
    renderPending({ section: 'back', build: () => {}, numbered: false, showHeader: false, headerSection: '', source: {}, intentionalBlank: true });
  }
  return { pages: out, warnings: docWarnings, margins, toc, imageUsage };
}

function headerFor(frame: Frame, settings: DocumentSettings, section: string): string | null {
  const recto = frame.gutterSide === 'left';
  const t = interpolate(recto ? settings.runningHeader.recto : settings.runningHeader.verso, { title: settings.title, author: settings.author, section });
  return t.trim() || null;
}

export function opBounds(op: DrawOp): RectPt {
  switch (op.op) {
    case 'text': {
      const w = measure(op.font, op.text, op.size);
      return { x: op.x, y: op.y - op.size * 0.8, w, h: op.size };
    }
    case 'line':
      return { x: Math.min(op.x1, op.x2) - op.width / 2, y: Math.min(op.y1, op.y2) - op.width / 2, w: Math.abs(op.x2 - op.x1) + op.width, h: Math.abs(op.y2 - op.y1) + op.width };
    case 'rect':
      return { x: op.x - op.width / 2, y: op.y - op.width / 2, w: op.w + op.width, h: op.h + op.width };
    case 'circle':
      return { x: op.cx - op.r, y: op.cy - op.r, w: 2 * op.r, h: 2 * op.r };
    case 'image':
      return op.clip ?? { x: op.x, y: op.y, w: op.w, h: op.h };
  }
}

/**
 * Lay out a complete interior. Because the required gutter depends on the final page count
 * (and the page count of flowed text depends on the gutter), the layout iterates until the
 * gutter tier is stable.
 */
export function layoutDocument(input: InteriorDocument | unknown, opts: LayoutOptions): LayoutResult {
  const doc = InteriorDocumentSchema.parse(input);
  const source = opts.specSource ?? defaultSpecSource;
  const lib = source.getLibrary(opts.specVersion);
  const minDpi = lib.files.minImageDpi;
  let guess =
    doc.body.kind === 'pages'
      ? doc.frontMatter.length + doc.body.pages.length + doc.backMatter.length
      : Math.max(24, doc.frontMatter.length + doc.backMatter.length + 24);
  let result: ReturnType<typeof layoutPass> | null = null;
  let spec: ResolvedPrintSpec | null = null;
  let iterations = 0;
  for (; iterations < 5; iterations++) {
    spec = resolvePrintSpec({ ...opts.format, pageCount: Math.max(1, guess) }, source, opts.specVersion);
    result = layoutPass(doc, spec, opts, minDpi);
    const actual = result.pages.length;
    const gNow = spec.minMargins.insideIn;
    const gActual = resolvePrintSpec({ ...opts.format, pageCount: Math.max(1, actual) }, source, opts.specVersion).minMargins.insideIn;
    if (gNow === gActual) {
      guess = actual;
      break;
    }
    guess = actual;
  }
  const finalSpec = resolvePrintSpec({ ...opts.format, pageCount: Math.max(1, result!.pages.length) }, source, opts.specVersion);
  const warnings = [...result!.warnings];
  if (!opts.format.bleed) {
  }
  return {
    spec: finalSpec,
    settings: doc.settings,
    pages: result!.pages,
    pageCount: result!.pages.length,
    margins: result!.margins,
    warnings,
    toc: result!.toc,
    imageUsage: result!.imageUsage,
    iterations: iterations + 1,
  };
}
