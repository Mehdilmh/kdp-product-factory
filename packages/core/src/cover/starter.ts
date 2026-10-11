import { inToPt, round } from '../units';
import type { CoverGeometry } from './geometry';
import { CoverDesign, type CoverLayerInput, type Paint } from './schema';

export interface CoverTheme {
  id: string;
  name: string;
  background: Paint;
  accent: string;
  text: string;
  titleFont: 'serif' | 'sans';
}

export const COVER_THEMES: CoverTheme[] = [
  { id: 'midnight', name: 'Midnight', background: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#1B2541' }, { offset: 1, color: '#0B1020' }] }, accent: '#E8C26A', text: '#FFFFFF', titleFont: 'serif' },
  { id: 'sage', name: 'Sage', background: { type: 'solid', color: '#DDE5D6' }, accent: '#3F5A3C', text: '#1F2A1E', titleFont: 'serif' },
  { id: 'terracotta', name: 'Terracotta', background: { type: 'linear', angle: 120, stops: [{ offset: 0, color: '#E07A5F' }, { offset: 1, color: '#B5543A' }] }, accent: '#FFF4E6', text: '#FFFFFF', titleFont: 'sans' },
  { id: 'paper', name: 'Paper', background: { type: 'solid', color: '#F7F3EA' }, accent: '#2B2B2B', text: '#1A1A1A', titleFont: 'serif' },
  { id: 'industrial', name: 'Industrial', background: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#2E3440' }, { offset: 1, color: '#434C5E' }] }, accent: '#F2A900', text: '#FFFFFF', titleFont: 'sans' },
];

export interface StarterCoverInput {
  title: string;
  subtitle?: string;
  author: string;
  backText?: string;
  themeId?: string;
}

/** Creates an editable starter design. All important text is live text, never baked into images. */
export function starterCoverDesign(geom: CoverGeometry, input: StarterCoverInput): CoverDesign {
  const theme = COVER_THEMES.find((t) => t.id === input.themeId) ?? COVER_THEMES[0];
  const f = geom.panels.front;
  const safeInset = 0.45;
  const w = round(f.w - 2 * safeInset);
  const layers: CoverLayerInput[] = [
    { id: 'accent-bar', name: 'Accent bar', type: 'rect', anchor: 'front', x: safeInset, y: round(f.h * 0.3), w, h: 0.04, fill: { type: 'solid', color: theme.accent } },
    { id: 'title', name: 'Title', type: 'text', role: 'title', anchor: 'front', x: safeInset, y: round(f.h * 0.08), w, h: round(f.h * 0.21), text: input.title, font: theme.titleFont, bold: true, sizePt: round(Math.min(44, inToPt(f.w) / 10), 1), color: theme.text, align: 'center', valign: 'bottom' },
    ...(input.subtitle
      ? [{ id: 'subtitle', name: 'Subtitle', type: 'text', role: 'subtitle', anchor: 'front', x: safeInset, y: round(f.h * 0.32), w, h: round(f.h * 0.14), text: input.subtitle, font: theme.titleFont, italic: true, sizePt: round(Math.min(18, inToPt(f.w) / 24), 1), color: theme.text, align: 'center' } as CoverLayerInput]
      : []),
    { id: 'author', name: 'Author', type: 'text', role: 'author', anchor: 'front', x: safeInset, y: round(f.h * 0.84), w, h: round(f.h * 0.08), text: input.author, font: theme.titleFont, sizePt: round(Math.min(20, inToPt(f.w) / 22), 1), color: theme.text, align: 'center', valign: 'middle' },
  ];

  if (geom.format !== 'EBOOK') {
    const b = geom.panels.back;
    if (input.backText) {
      layers.push({ id: 'back-text', name: 'Back cover text', type: 'text', role: 'back', anchor: 'back', x: safeInset, y: 0.75, w: round(b.w - 2 * safeInset), h: round(b.h * 0.5), text: input.backText, font: 'serif', sizePt: 11, color: theme.text, align: 'left', lineHeight: 1.4 });
    }
    if (geom.spineTextAllowed && geom.spineWidthIn > 0) {
      const s = geom.panels.spine;
      const len = round(s.h * 0.8);
      const thick = round(s.w);
      const size = round(Math.min(14, inToPt(geom.spineWidthIn) * 0.45), 1);
      layers.push({
        id: 'spine-text',
        name: 'Spine text',
        type: 'text',
        role: 'spine',
        anchor: 'spine',
        x: round(s.w / 2 - len / 2),
        y: round(s.h / 2 - thick / 2),
        w: len,
        h: thick,
        rotation: 90,
        text: `${input.title}  ·  ${input.author}`,
        font: theme.titleFont,
        bold: true,
        sizePt: size,
        color: theme.text,
        align: 'center',
        valign: 'middle',
        lineHeight: 1,
      });
    }
  }
  return CoverDesign.parse({ kind: geom.format === 'EBOOK' ? 'FRONT' : 'FULL_WRAP', background: theme.background, layers });
}
