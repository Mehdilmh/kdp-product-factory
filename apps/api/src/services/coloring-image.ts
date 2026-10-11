import type { QcThresholds } from '@kdp/core';
import sharp from 'sharp';
import { z } from 'zod';

/**
 * Coloring-page image QC and processing. Every check here is either AUTOMATED (measured fact:
 * pixel size, DPI at print size, alpha, decode errors) or HEURISTIC (pixel statistics that
 * suggest a problem). Things pixels cannot tell us reliably — stray text, watermarks,
 * malformed anatomy, trademarked characters — are MANUAL review items, never auto-passed.
 */

export type QcKind = 'AUTOMATED' | 'HEURISTIC' | 'MANUAL';
export type QcStatus = 'PASS' | 'WARN' | 'FAIL' | 'MANUAL';
export interface QcCheck {
  id: string;
  label: string;
  kind: QcKind;
  status: QcStatus;
  message: string;
  value?: number | string | null;
}
export interface QcResult {
  checks: QcCheck[];
  metrics: Record<string, number | boolean | string | null>;
  dhash: string | null;
  summary: { fail: number; warn: number; manual: number };
  analyzedAt: string;
}

/** Placement of the image on the page (live area × scale), used for DPI and line-weight math. */
export interface Placement {
  widthIn: number;
  heightIn: number;
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

async function dHash(img: sharp.Sharp): Promise<string> {
  const { data } = await img.clone().flatten({ background: '#ffffff' }).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

export async function analyzeColoringImage(bytes: Uint8Array, placement: Placement, t: QcThresholds): Promise<QcResult> {
  const checks: QcCheck[] = [];
  const metrics: QcResult['metrics'] = {};
  const add = (c: QcCheck) => checks.push(c);
  let meta: sharp.Metadata;
  const img = sharp(Buffer.from(bytes), { failOn: 'error' });
  try {
    meta = await img.metadata();
    // Full decode catches truncated/corrupt files that still have a valid header.
    await img.clone().raw().toBuffer();
  } catch (e) {
    add({ id: 'decode', label: 'File integrity', kind: 'AUTOMATED', status: 'FAIL', message: `Image could not be decoded: ${(e as Error).message}` });
    return finish(checks, metrics, null);
  }
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  metrics.widthPx = W;
  metrics.heightPx = H;
  metrics.format = meta.format ?? null;
  add({ id: 'decode', label: 'File integrity', kind: 'AUTOMATED', status: 'PASS', message: `${meta.format?.toUpperCase()} decodes cleanly (${W}×${H}px).` });

  // DPI at placed size (contain fit inside the placement box).
  const scale = Math.min(placement.widthIn / W, placement.heightIn / H);
  const dpi = Math.floor(1 / scale);
  metrics.effectiveDpi = dpi;
  add({
    id: 'dpi',
    label: 'Print resolution',
    kind: 'AUTOMATED',
    status: dpi >= t.minDpi ? 'PASS' : dpi >= t.minDpi * 0.66 ? 'WARN' : 'FAIL',
    value: dpi,
    message: dpi >= t.minDpi ? `${dpi} DPI at the placed size.` : `${dpi} DPI at the placed size (target ${t.minDpi}). Upscale or reduce the image scale.`,
  });

  const imgAspect = W / H;
  const boxAspect = placement.widthIn / placement.heightIn;
  const aspectDiff = Math.abs(imgAspect - boxAspect) / boxAspect;
  metrics.aspectDiff = Math.round(aspectDiff * 1000) / 1000;
  add({ id: 'aspect', label: 'Aspect ratio vs. page', kind: 'AUTOMATED', status: aspectDiff <= 0.1 ? 'PASS' : 'WARN', value: metrics.aspectDiff, message: aspectDiff <= 0.1 ? 'Matches the page area.' : `Image aspect ${imgAspect.toFixed(2)} vs. page area ${boxAspect.toFixed(2)}: there will be white bands (or use “crop & position”).` });

  const hasAlpha = !!meta.hasAlpha;
  let transparent = 0;

  // Analysis raster (nearest-neighbour so line pixels are not blended into grays).
  const AW = Math.min(1200, W);
  const AH = Math.max(1, Math.round((H * AW) / W));
  const { data, info } = await img.clone().resize(AW, AH, { kernel: 'nearest', fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let white = 0;
  let dark = 0;
  let color = 0;
  let gray = 0;
  const lumHist = new Uint32Array(256);
  const isInk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    if (a < 250) transparent++;
    // Composite onto white (how a transparent area prints).
    const k = a / 255;
    const R = r * k + 255 * (1 - k);
    const G = g * k + 255 * (1 - k);
    const B = b * k + 255 * (1 - k);
    const L = lum(R, G, B);
    lumHist[Math.round(L)]++;
    const sat = Math.max(R, G, B) - Math.min(R, G, B);
    if (L >= 230) white++;
    else if (sat > 40 && L > 25) color++;
    else if (L >= 70 && L < 200) gray++;
    if (L < 128) {
      dark++;
      isInk[i] = 1;
    }
  }
  const ratio = (x: number) => Math.round((x / n) * 10000) / 10000;
  metrics.whiteRatio = ratio(white);
  metrics.inkRatio = ratio(dark);
  metrics.colorRatio = ratio(color);
  metrics.grayRatio = ratio(gray);
  metrics.transparentRatio = ratio(transparent);

  add({ id: 'alpha', label: 'Transparency', kind: 'AUTOMATED', status: !hasAlpha || transparent === 0 ? 'PASS' : 'WARN', message: !hasAlpha ? 'No alpha channel.' : transparent === 0 ? 'Alpha channel present but fully opaque.' : `${(ratio(transparent) * 100).toFixed(1)}% transparent pixels; they will print white. Processing flattens them onto white.` });
  add({ id: 'background', label: 'White background', kind: 'HEURISTIC', status: metrics.whiteRatio >= t.minWhiteRatio ? 'PASS' : 'WARN', value: metrics.whiteRatio, message: metrics.whiteRatio >= t.minWhiteRatio ? `${Math.round(metrics.whiteRatio * 100)}% white.` : `Only ${Math.round(metrics.whiteRatio * 100)}% of the page is white (minimum ${Math.round(t.minWhiteRatio * 100)}%). Background may be filled or shaded.` });
  add({ id: 'color', label: 'Color pixels', kind: 'HEURISTIC', status: metrics.colorRatio <= t.maxColorRatio ? 'PASS' : 'WARN', value: metrics.colorRatio, message: metrics.colorRatio <= t.maxColorRatio ? 'Effectively monochrome.' : `${(metrics.colorRatio * 100).toFixed(2)}% colored pixels. Convert to grayscale/threshold for a black-and-white interior.` });
  add({ id: 'gray', label: 'Gray shading', kind: 'HEURISTIC', status: metrics.grayRatio <= t.maxGrayRatio ? 'PASS' : 'WARN', value: metrics.grayRatio, message: metrics.grayRatio <= t.maxGrayRatio ? 'Little mid-gray (no obvious shading).' : `${(metrics.grayRatio * 100).toFixed(1)}% mid-gray pixels — likely shading or soft lines. Threshold processing can clean this.` });

  // Contrast: how dark are the darkest 1% of pixels?
  let acc = 0;
  let p1 = 255;
  for (let v = 0; v < 256; v++) {
    acc += lumHist[v];
    if (acc >= n * 0.01) {
      p1 = v;
      break;
    }
  }
  metrics.darkestPercentileLum = p1;
  add({ id: 'contrast', label: 'Line contrast', kind: 'HEURISTIC', status: p1 <= 60 ? 'PASS' : 'WARN', value: p1, message: p1 <= 60 ? 'Lines are dark.' : `Darkest lines are only luminance ${p1}/255; they may print faint. Increase contrast or threshold.` });

  const inkStatus = metrics.inkRatio < t.minInkRatio ? 'low' : metrics.inkRatio > t.maxInkRatio ? 'high' : 'ok';
  add({ id: 'ink', label: 'Ink coverage', kind: 'HEURISTIC', status: inkStatus === 'ok' ? 'PASS' : 'WARN', value: metrics.inkRatio, message: inkStatus === 'ok' ? `${(metrics.inkRatio * 100).toFixed(1)}% ink.` : inkStatus === 'low' ? `Only ${(metrics.inkRatio * 100).toFixed(1)}% ink — the page may be nearly empty.` : `${(metrics.inkRatio * 100).toFixed(1)}% ink — large solid black areas or very dense art (heavy ink, bleed-through risk).` });

  // Line weight: median horizontal run of ink pixels, converted to points at print size.
  const runs: number[] = [];
  for (let y = 0; y < info.height; y += 2) {
    let run = 0;
    for (let x = 0; x < info.width; x++) {
      if (isInk[y * info.width + x]) run++;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
  }
  runs.sort((a, b) => a - b);
  const medianRun = runs.length ? runs[Math.floor(runs.length / 2)] : 0;
  const ptPerAnalysisPx = (W * scale * 72) / info.width;
  const lineWeightPt = Math.round(medianRun * ptPerAnalysisPx * 100) / 100;
  metrics.medianLineWeightPt = lineWeightPt;
  add({ id: 'lines', label: 'Line weight', kind: 'HEURISTIC', status: !runs.length ? 'WARN' : lineWeightPt >= t.minLineWeightPt ? 'PASS' : 'WARN', value: lineWeightPt, message: !runs.length ? 'No lines detected.' : lineWeightPt >= t.minLineWeightPt ? `Typical line ≈ ${lineWeightPt} pt at print size.` : `Typical line ≈ ${lineWeightPt} pt; the style expects ≥ ${t.minLineWeightPt} pt. Thin lines are hard to color and may print faintly.` });

  // Edge / cropping: ink in a thin border band.
  const band = Math.max(2, Math.round(info.width * 0.015));
  let edgeInk = 0;
  let edgeN = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (x < band || y < band || x >= info.width - band || y >= info.height - band) {
        edgeN++;
        edgeInk += isInk[y * info.width + x];
      }
    }
  const edgeRatio = edgeN ? edgeInk / edgeN : 0;
  metrics.edgeInkRatio = Math.round(edgeRatio * 10000) / 10000;
  add({ id: 'crop', label: 'Cropping at edges', kind: 'HEURISTIC', status: edgeRatio <= t.maxEdgeInkRatio ? 'PASS' : 'WARN', value: metrics.edgeInkRatio, message: edgeRatio <= t.maxEdgeInkRatio ? 'Art stays clear of the edges.' : 'Lines run into the image edge — the subject may be cropped or a border frame was drawn.' });

  // Largest empty region on a 12×12 grid (4-connected flood fill of empty cells).
  const G = 12;
  const cellInk = new Float64Array(G * G);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (isInk[y * info.width + x]) cellInk[Math.min(G - 1, Math.floor((y * G) / info.height)) * G + Math.min(G - 1, Math.floor((x * G) / info.width))]++;
  const cellPx = n / (G * G);
  const empty = Array.from(cellInk, (v) => v / cellPx < 0.002);
  const seen = new Uint8Array(G * G);
  let largest = 0;
  for (let i = 0; i < G * G; i++) {
    if (!empty[i] || seen[i]) continue;
    let size = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const cx = c % G;
      const cy = Math.floor(c / G);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
        const j = ny * G + nx;
        if (empty[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    largest = Math.max(largest, size);
  }
  metrics.largestEmptyRatio = Math.round((largest / (G * G)) * 1000) / 1000;
  add({ id: 'empty', label: 'Empty areas', kind: 'HEURISTIC', status: metrics.largestEmptyRatio <= t.maxEmptyRatio ? 'PASS' : 'WARN', value: metrics.largestEmptyRatio, message: metrics.largestEmptyRatio <= t.maxEmptyRatio ? 'Art is reasonably distributed.' : `A blank region covers ${Math.round(metrics.largestEmptyRatio * 100)}% of the page. Consider a larger subject or the “crop & position” step.` });

  add({ id: 'text', label: 'Text, signatures, watermarks', kind: 'MANUAL', status: 'MANUAL', message: 'Not detected automatically. Look for stray letters, fake signatures, logos or watermarks before approving.' });
  add({ id: 'artifacts', label: 'Drawing quality', kind: 'MANUAL', status: 'MANUAL', message: 'Check for malformed anatomy, broken or unclosed outlines, and tiny fragmented areas that are hard to color.' });
  add({ id: 'originality', label: 'Originality', kind: 'MANUAL', status: 'MANUAL', message: 'Confirm no trademarked or copyrighted characters, brands or logos appear.' });

  return finish(checks, metrics, await dHash(img));
}

function finish(checks: QcCheck[], metrics: QcResult['metrics'], dhash: string | null): QcResult {
  return { checks, metrics, dhash, summary: { fail: checks.filter((c) => c.status === 'FAIL').length, warn: checks.filter((c) => c.status === 'WARN').length, manual: checks.filter((c) => c.status === 'MANUAL').length }, analyzedAt: new Date().toISOString() };
}

/* ---------------------------------------- Processing --------------------------------------- */

export const ProcessingOptions = z.object({
  flattenAlpha: z.boolean().default(true),
  grayscale: z.boolean().default(true),
  /** Stretch contrast to the full range. */
  normalize: z.boolean().default(true),
  /** Median filter radius for speckle removal (0 = off). */
  denoise: z.number().int().min(0).max(7).default(0),
  /** Pure black/white threshold (0–255); null = keep grays. */
  threshold: z.number().int().min(1).max(254).nullable().default(200),
  /** Trim surrounding white space before fitting. */
  trimWhitespace: z.boolean().default(false),
  /** Pad (never crop art) to the page aspect and add a uniform white margin (fraction). */
  padToAspect: z.boolean().default(false),
  paddingRatio: z.number().min(0).max(0.3).default(0),
  /** Resample (Lanczos) up to this DPI at the placed size. Resampling adds no real detail. */
  upscaleToDpi: z.number().int().min(0).max(600).default(300),
  maxSidePx: z.number().int().min(512).max(12000).default(6000),
});
export type ProcessingOptions = z.infer<typeof ProcessingOptions>;

export async function processColoringImage(bytes: Uint8Array, placement: Placement, o: ProcessingOptions): Promise<{ bytes: Uint8Array; widthPx: number; heightPx: number; steps: string[] }> {
  const steps: string[] = [];
  let buf: Buffer = Buffer.from(bytes);
  let img = sharp(buf);
  if (o.flattenAlpha) {
    img = img.flatten({ background: '#ffffff' });
    steps.push('flattened transparency onto white');
  }
  if (o.grayscale) {
    img = img.greyscale();
    steps.push('converted to grayscale');
  }
  if (o.normalize) {
    img = img.normalise();
    steps.push('normalized contrast');
  }
  if (o.denoise > 0) {
    img = img.median(o.denoise * 2 + 1);
    steps.push(`median denoise (${o.denoise * 2 + 1}px)`);
  }
  buf = await img.png().toBuffer();
  if (o.trimWhitespace) {
    const t = await sharp(buf).trim({ background: '#ffffff', threshold: 20 }).png().toBuffer().catch(() => null);
    if (t) {
      buf = t;
      steps.push('trimmed surrounding white space');
    }
  }
  let meta = await sharp(buf).metadata();
  if (o.padToAspect || o.paddingRatio > 0) {
    const W = meta.width!;
    const H = meta.height!;
    const target = placement.widthIn / placement.heightIn;
    let w = W * (1 + 2 * o.paddingRatio);
    let h = H * (1 + 2 * o.paddingRatio);
    if (o.padToAspect) {
      if (w / h < target) w = h * target;
      else h = w / target;
    }
    const left = Math.round((w - W) / 2);
    const top = Math.round((h - H) / 2);
    buf = await sharp(buf).extend({ left, right: Math.round(w) - W - left, top, bottom: Math.round(h) - H - top, background: '#ffffff' }).png().toBuffer();
    steps.push(o.padToAspect ? 'padded to page aspect (art not cropped)' : 'added white margin');
    meta = await sharp(buf).metadata();
  }
  if (o.upscaleToDpi > 0) {
    const scale = Math.min(placement.widthIn / meta.width!, placement.heightIn / meta.height!);
    const dpi = 1 / scale;
    if (dpi < o.upscaleToDpi) {
      const f = Math.min(o.upscaleToDpi / dpi, o.maxSidePx / Math.max(meta.width!, meta.height!));
      if (f > 1.01) {
        buf = await sharp(buf).resize(Math.round(meta.width! * f), Math.round(meta.height! * f), { kernel: 'lanczos3' }).png().toBuffer();
        steps.push(`resampled ×${f.toFixed(2)} toward ${o.upscaleToDpi} DPI (Lanczos; adds no new detail)`);
      }
    }
  }
  if (o.threshold !== null) {
    buf = await sharp(buf).greyscale().threshold(o.threshold).png().toBuffer();
    steps.push(`threshold at ${o.threshold} (pure black & white)`);
  }
  // Single-channel PNG keeps files small and is rendered as DeviceGray-equivalent.
  const out = await sharp(buf).toColourspace(o.grayscale || o.threshold !== null ? 'b-w' : 'srgb').png({ compressionLevel: 9 }).toBuffer();
  meta = await sharp(out).metadata();
  return { bytes: new Uint8Array(out), widthPx: meta.width!, heightPx: meta.height!, steps };
}
