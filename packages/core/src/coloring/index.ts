import { z } from 'zod';
import type { InteriorDocumentInput, PageInstanceInput } from '../interior/schema';

/**
 * Coloring Book Studio — deterministic building blocks: audience/theme/style presets, the style
 * profile, the prompt builder, repeated-concept detection, QC thresholds, and the interior
 * document builder (which feeds the existing layout engine, PDF renderer and preflight).
 */

export const AUDIENCES = ['TODDLERS', 'PRESCHOOL', 'KIDS', 'TWEENS', 'TEENS', 'ADULTS', 'SENIORS'] as const;
export const Audience = z.enum(AUDIENCES);
export type Audience = z.infer<typeof Audience>;

export const Level = z.enum(['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH']);
export type Level = z.infer<typeof Level>;

export const StyleProfile = z.object({
  name: z.string().max(80).default('Custom style'),
  styleId: z.string().max(40).default('bold-easy'),
  outlineThickness: z.enum(['THIN', 'MEDIUM', 'THICK', 'EXTRA_THICK']).default('THICK'),
  detail: Level.default('LOW'),
  complexity: Level.default('LOW'),
  subjectSize: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'FILL']).default('LARGE'),
  whiteSpace: Level.default('HIGH'),
  subjects: z.enum(['ONE', 'FEW', 'MANY']).default('ONE'),
  background: z.enum(['NONE', 'SIMPLE', 'DETAILED', 'PATTERN']).default('SIMPLE'),
  composition: z.enum(['CENTERED', 'SCENE', 'FULL_PAGE_PATTERN', 'FRAMED']).default('CENTERED'),
  aspect: z.enum(['TRIM', 'SQUARE', 'PORTRAIT', 'LANDSCAPE']).default('TRIM'),
  /** Free-text art direction appended to every prompt. */
  extraDirection: z.string().max(500).default(''),
  /** Workspace asset ids used as style references (passed to models that support references). */
  referenceAssetIds: z.array(z.string().max(64)).max(4).default([]),
});
export type StyleProfile = z.infer<typeof StyleProfile>;
export type StyleProfileInput = z.input<typeof StyleProfile>;

export const AUDIENCE_PRESETS: Record<Audience, { label: string; ageRange: string; style: Partial<StyleProfile>; difficulty: 'EASY' | 'MEDIUM' | 'HARD' }> = {
  TODDLERS: { label: 'Toddlers', ageRange: '1–3', difficulty: 'EASY', style: { styleId: 'bold-easy', outlineThickness: 'EXTRA_THICK', detail: 'VERY_LOW', complexity: 'VERY_LOW', subjectSize: 'FILL', whiteSpace: 'VERY_HIGH', subjects: 'ONE', background: 'NONE', composition: 'CENTERED' } },
  PRESCHOOL: { label: 'Preschool', ageRange: '3–5', difficulty: 'EASY', style: { styleId: 'bold-easy', outlineThickness: 'THICK', detail: 'LOW', complexity: 'VERY_LOW', subjectSize: 'LARGE', whiteSpace: 'HIGH', subjects: 'ONE', background: 'NONE', composition: 'CENTERED' } },
  KIDS: { label: 'Kids', ageRange: '6–9', difficulty: 'EASY', style: { styleId: 'cartoon', outlineThickness: 'THICK', detail: 'LOW', complexity: 'LOW', subjectSize: 'LARGE', whiteSpace: 'MEDIUM', subjects: 'FEW', background: 'SIMPLE', composition: 'SCENE' } },
  TWEENS: { label: 'Tweens', ageRange: '9–12', difficulty: 'MEDIUM', style: { styleId: 'cartoon', outlineThickness: 'MEDIUM', detail: 'MEDIUM', complexity: 'MEDIUM', subjectSize: 'MEDIUM', whiteSpace: 'MEDIUM', subjects: 'FEW', background: 'SIMPLE', composition: 'SCENE' } },
  TEENS: { label: 'Teens', ageRange: '13–17', difficulty: 'MEDIUM', style: { styleId: 'detailed-line', outlineThickness: 'MEDIUM', detail: 'HIGH', complexity: 'MEDIUM', subjectSize: 'MEDIUM', whiteSpace: 'LOW', subjects: 'FEW', background: 'DETAILED', composition: 'SCENE' } },
  ADULTS: { label: 'Adults', ageRange: '18+', difficulty: 'HARD', style: { styleId: 'intricate', outlineThickness: 'THIN', detail: 'VERY_HIGH', complexity: 'HIGH', subjectSize: 'FILL', whiteSpace: 'VERY_LOW', subjects: 'MANY', background: 'PATTERN', composition: 'FULL_PAGE_PATTERN' } },
  SENIORS: { label: 'Seniors (large print, relaxing)', ageRange: '65+', difficulty: 'MEDIUM', style: { styleId: 'bold-easy', outlineThickness: 'THICK', detail: 'MEDIUM', complexity: 'LOW', subjectSize: 'LARGE', whiteSpace: 'MEDIUM', subjects: 'ONE', background: 'SIMPLE', composition: 'CENTERED' } },
};

export const STYLE_PRESETS: Record<string, { label: string; phrase: string }> = {
  'bold-easy': { label: 'Bold & easy', phrase: 'bold and easy coloring page, simple shapes, very thick clean outlines' },
  cartoon: { label: 'Cute cartoon', phrase: 'cute cartoon coloring page, friendly rounded shapes, clean outlines' },
  kawaii: { label: 'Kawaii', phrase: 'kawaii style coloring page, chibi proportions, rounded outlines' },
  'detailed-line': { label: 'Detailed line art', phrase: 'detailed line art coloring page, crisp contour lines' },
  realistic: { label: 'Realistic line art', phrase: 'realistic line drawing for coloring, accurate proportions, contour lines only' },
  intricate: { label: 'Intricate / zentangle', phrase: 'intricate coloring page for adults, ornate decorative patterns, fine line work' },
  mandala: { label: 'Mandala', phrase: 'symmetrical mandala coloring page, radial geometric patterns' },
  'stained-glass': { label: 'Stained glass', phrase: 'stained-glass style coloring page, bold segmented regions' },
};

export const THEME_PRESETS: Record<string, { label: string; concepts: string[] }> = {
  farm: { label: 'Farm animals', concepts: ['cow in a meadow', 'pig in mud puddle', 'hen with chicks', 'horse by a fence', 'sheep on a hill', 'goat on a rock', 'duck on a pond', 'barn with tractor', 'rooster on a fence post', 'rabbit in a carrot patch', 'farm dog with a ball', 'donkey with a hay cart'] },
  ocean: { label: 'Under the sea', concepts: ['sea turtle swimming', 'octopus with shells', 'clownfish in anemone', 'whale and calf', 'seahorse among seaweed', 'crab on the sand', 'dolphin jumping', 'jellyfish group', 'starfish and coral', 'sunken treasure chest', 'pufferfish', 'manta ray gliding'] },
  dinosaurs: { label: 'Dinosaurs', concepts: ['friendly t-rex', 'triceratops eating ferns', 'stegosaurus walking', 'brachiosaurus by a lake', 'baby dinosaur hatching', 'pterodactyl flying', 'ankylosaurus', 'volcano landscape with dinosaurs', 'parasaurolophus', 'dinosaur footprints trail'] },
  vehicles: { label: 'Vehicles', concepts: ['fire truck', 'excavator digging', 'school bus', 'steam train', 'sailboat', 'helicopter', 'race car', 'tractor', 'hot air balloon', 'garbage truck', 'airplane', 'police car'] },
  garden: { label: 'Flowers & garden', concepts: ['sunflower', 'rose bouquet', 'butterfly on a daisy', 'watering can with tulips', 'garden gnome', 'bee on lavender', 'potted succulents', 'birdhouse in a tree', 'ladybug on a leaf', 'garden gate with vines'] },
  mandalas: { label: 'Mandalas & patterns', concepts: ['floral mandala', 'geometric star mandala', 'leaf mandala', 'ocean wave mandala', 'heart mandala', 'sun mandala', 'snowflake mandala', 'feather mandala', 'lotus mandala', 'paisley pattern'] },
  seasons: { label: 'Seasons & holidays (generic)', concepts: ['autumn leaves and acorns', 'snowman with scarf', 'spring blossoms', 'summer beach scene', 'pumpkin patch', 'winter cabin', 'kite in the wind', 'rainy day with umbrella'] },
  fantasy: { label: 'Fantasy creatures (original)', concepts: ['friendly dragon on a hill', 'unicorn in a forest', 'fairy house in a mushroom', 'gnome village', 'castle on a cliff', 'mermaid with shells', 'griffin', 'wizard’s potion shelf'] },
};

export const DIFFICULTY_WORDS: Record<Level, string> = { VERY_LOW: 'very low', LOW: 'low', MEDIUM: 'moderate', HIGH: 'high', VERY_HIGH: 'very high' };

/** Coloring defaults that every prompt carries (black outlines on white, no shading, no text). */
export const COLORING_DEFAULTS = ['black and white line art', 'pure black outlines on a pure white background', 'no shading', 'no gray tones', 'no color', 'no gradients', 'closed shapes suitable for coloring', 'no text', 'no letters', 'no numbers', 'no watermark', 'no signature', 'no border frame'];
export const DEFAULT_NEGATIVE = 'color, colored, shading, gray, grayscale shading, gradient, hatching, crosshatching, cross-hatching, text, letters, words, numbers, watermark, signature, logo, frame, border, blurry, low resolution, photograph, 3d render, noise, jpeg artifacts';

const OUTLINE_WORDS = { THIN: 'thin fine outlines', MEDIUM: 'medium-weight outlines', THICK: 'thick bold outlines', EXTRA_THICK: 'extra thick very bold outlines' } as const;
const SIZE_WORDS = { SMALL: 'small subject with lots of space around it', MEDIUM: 'medium-sized subject', LARGE: 'large subject filling most of the page', FILL: 'subject filling the entire page' } as const;
const SUBJECT_WORDS = { ONE: 'a single main subject', FEW: 'two or three subjects', MANY: 'many elements' } as const;
const BG_WORDS = { NONE: 'plain white background with no scenery', SIMPLE: 'simple minimal background', DETAILED: 'detailed background scene', PATTERN: 'decorative pattern background' } as const;
const COMP_WORDS = { CENTERED: 'centered composition', SCENE: 'full scene composition', FULL_PAGE_PATTERN: 'all-over full-page pattern', FRAMED: 'framed vignette composition' } as const;

export const PROMPT_BUILDER_VERSION = 'coloring-prompt-1';

export interface BuiltPrompt {
  prompt: string;
  negativePrompt: string;
  version: string;
}

/** Deterministic prompt for one page: same inputs → same prompt (stored with each version). */
export function buildColoringPrompt(concept: string, style: StyleProfile, opts: { audience?: Audience; variation?: number; edit?: boolean } = {}): BuiltPrompt {
  const s = STYLE_PRESETS[style.styleId] ?? STYLE_PRESETS['bold-easy'];
  const parts = [
    opts.edit ? `Redraw as a coloring page: ${concept.trim()}` : `Coloring page of ${concept.trim()}`,
    s.phrase,
    OUTLINE_WORDS[style.outlineThickness],
    `${DIFFICULTY_WORDS[style.detail]} detail`,
    `${DIFFICULTY_WORDS[style.complexity]} complexity`,
    SIZE_WORDS[style.subjectSize],
    SUBJECT_WORDS[style.subjects],
    BG_WORDS[style.background],
    COMP_WORDS[style.composition],
    `${DIFFICULTY_WORDS[style.whiteSpace]} amount of open white space`,
    opts.audience ? `suitable for ${AUDIENCE_PRESETS[opts.audience].label.toLowerCase()} (ages ${AUDIENCE_PRESETS[opts.audience].ageRange})` : null,
    style.extraDirection.trim() || null,
    ...COLORING_DEFAULTS,
    opts.variation ? `variation ${opts.variation}, different pose and arrangement` : null,
  ].filter(Boolean);
  return { prompt: parts.join(', '), negativePrompt: DEFAULT_NEGATIVE, version: PROMPT_BUILDER_VERSION };
}

/** Image aspect (w/h) requested from the model for a style + trim. */
export function aspectFor(style: StyleProfile, trim: { widthIn: number; heightIn: number }): number {
  switch (style.aspect) {
    case 'SQUARE':
      return 1;
    case 'PORTRAIT':
      return 3 / 4;
    case 'LANDSCAPE':
      return 4 / 3;
    default:
      return trim.widthIn / trim.heightIn;
  }
}

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'with', 'and', 'by', 'at', 'to', 'for', 'from', 'its', 'his', 'her']);
const stem = (w: string) => (/ies$/.test(w) ? w.slice(0, -3) + 'y' : /(ses|xes|zes|ches|shes)$/.test(w) ? w.slice(0, -2) : /[^s]s$/.test(w) ? w.slice(0, -1) : w);
export const conceptTokens = (c: string) => new Set(c.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map(stem));

export function conceptSimilarity(a: string, b: string): number {
  const A = conceptTokens(a);
  const B = conceptTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Pairs of page concepts that look repeated (exact or high token overlap). */
export function findRepeatedConcepts(items: { id: string; concept: string }[], threshold = 0.6): { a: string; b: string; similarity: number }[] {
  const out: { a: string; b: string; similarity: number }[] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const s = conceptSimilarity(items[i].concept, items[j].concept);
      if (s >= threshold) out.push({ a: items[i].id, b: items[j].id, similarity: Math.round(s * 100) / 100 });
    }
  return out;
}

/* ------------------------------------------- QC -------------------------------------------- */

export const QcThresholds = z.object({
  minDpi: z.number().min(72).max(1200).default(300),
  /** Fraction of pixels that must be near-white for a "white background". */
  minWhiteRatio: z.number().min(0).max(1).default(0.55),
  /** Max fraction of saturated (colored) pixels. */
  maxColorRatio: z.number().min(0).max(1).default(0.005),
  /** Max fraction of mid-gray pixels (shading). */
  maxGrayRatio: z.number().min(0).max(1).default(0.06),
  /** Ink coverage bounds (fraction of dark pixels). */
  minInkRatio: z.number().min(0).max(1).default(0.02),
  maxInkRatio: z.number().min(0).max(1).default(0.45),
  /** Minimum median stroke width in points at print size. */
  minLineWeightPt: z.number().min(0).max(10).default(0.75),
  /** Fraction of the outer border band that may contain ink before "may be cropped" is flagged. */
  maxEdgeInkRatio: z.number().min(0).max(1).default(0.02),
  /** Hamming distance (0–64) on dHash at or below which two pages are near-duplicates. */
  duplicateHamming: z.number().int().min(0).max(64).default(6),
  /** Largest empty region (fraction of page) before "large empty area" is flagged. */
  maxEmptyRatio: z.number().min(0).max(1).default(0.6),
});
export type QcThresholds = z.infer<typeof QcThresholds>;

export function qcThresholdsFor(style: StyleProfile): QcThresholds {
  const base = QcThresholds.parse({});
  const lw = { THIN: 0.5, MEDIUM: 0.75, THICK: 1.25, EXTRA_THICK: 2 }[style.outlineThickness];
  const ink = style.detail === 'VERY_HIGH' || style.detail === 'HIGH' ? { minInkRatio: 0.05, maxInkRatio: 0.6, maxEmptyRatio: 0.35 } : style.detail === 'VERY_LOW' ? { minInkRatio: 0.01, maxInkRatio: 0.3, maxEmptyRatio: 0.8 } : {};
  return { ...base, minLineWeightPt: lw, ...ink };
}

/* ---------------------------------------- Interior ---------------------------------------- */

export const ColoringInteriorSettings = z.object({
  /** Single-sided: every illustration is followed by a blank reverse page (bleed-through protection). */
  singleSided: z.boolean().default(true),
  /** Image width as a fraction of the live area. */
  scale: z.number().min(0.3).max(1).default(1),
  verticalAlign: z.enum(['top', 'center', 'bottom']).default('center'),
  pageNumbers: z.boolean().default(false),
  titlePage: z.boolean().default(true),
  belongsTo: z.boolean().default(true),
  copyrightPage: z.boolean().default(true),
  /** Optional test-colors page at the end (blank swatch boxes). */
  testPage: z.boolean().default(true),
  /** Place illustrations on recto (right-hand) pages. */
  rectoOnly: z.boolean().default(true),
  marginsIn: z.object({ inside: z.number().min(0.125).max(2), outside: z.number().min(0.125).max(2), top: z.number().min(0.125).max(2), bottom: z.number().min(0.125).max(2) }).default({ inside: 0.75, outside: 0.5, top: 0.5, bottom: 0.5 }),
  fullBleed: z.boolean().default(false),
});
export type ColoringInteriorSettings = z.infer<typeof ColoringInteriorSettings>;

export const COLORING_TRIMS = ['8.5x11', '8x10', '8.5x8.5', '8.25x8.25', '8.27x11.69', '7.5x9.25', '7x10', '6x9', '8.25x6'] as const;

/**
 * Builds the interior document from approved pages in order. Illustrations count and page count
 * are distinct: in single-sided mode each illustration gets a blank reverse.
 */
export function buildColoringDocument(pages: { id: string; assetId: string; concept: string }[], s: ColoringInteriorSettings, meta: { title: string; subtitle?: string; author: string; year?: number }): InteriorDocumentInput {
  const spacer = (id: string, weight: number) => ({ id, type: 'spacer' as const, height: { mode: 'fill' as const, weight } });
  const [topW, botW] = s.verticalAlign === 'top' ? [0.0001, 1] : s.verticalAlign === 'bottom' ? [1, 0.0001] : [1, 1];
  const body: PageInstanceInput[] = [];
  for (const p of pages) {
    if (s.rectoOnly && !s.singleSided && body.length % 2 === 1) body.push({ id: `pad-${p.id}`, templateId: null, blank: true });
    const img = { id: `img-${p.id}`, type: 'image' as const, assetId: p.assetId, fit: 'contain' as const, widthRatio: s.scale, fullBleed: s.fullBleed, height: { mode: 'fill' as const, weight: 30 } };
    body.push({ id: `page-${p.id}`, templateId: null, elements: s.scale < 1 || s.verticalAlign !== 'center' ? [spacer('t', topW), img, spacer('b', botW)] : [img] });
    if (s.singleSided) body.push({ id: `rev-${p.id}`, templateId: null, blank: true });
  }
  const front: PageInstanceInput[] = [];
  if (s.titlePage) front.push({ id: 'title', templateId: 'title-page', fields: { subtitle: meta.subtitle ?? '' } });
  if (s.copyrightPage) front.push({ id: 'copyright', templateId: 'copyright-page', fields: { year: String(meta.year ?? new Date().getUTCFullYear()) } });
  if (s.belongsTo) front.push({ id: 'belongs', templateId: 'belongs-to' });
  if (front.length % 2 === 1 && (s.singleSided || s.rectoOnly)) front.push({ id: 'front-pad', templateId: null, blank: true });
  const back: PageInstanceInput[] = [];
  if (s.testPage) {
    back.push({
      id: 'test-colors',
      templateId: null,
      elements: [
        { id: 'h', type: 'heading', text: 'Test your colors', style: { sizePt: 18, bold: true, align: 'center', font: 'sans' } },
        { id: 'g', type: 'grid', spacingPt: 54, weightPt: 1, height: { mode: 'fill', weight: 1 } },
      ],
    });
    if (s.singleSided) back.push({ id: 'test-rev', templateId: null, blank: true });
  }
  return {
    settings: {
      margins: { insideIn: s.marginsIn.inside, outsideIn: s.marginsIn.outside, topIn: s.marginsIn.top, bottomIn: s.marginsIn.bottom },
      pageNumbers: { enabled: s.pageNumbers, position: 'center', sizePt: 9 },
      runningHeader: { enabled: false },
      chapterStartRecto: false,
      includeToc: false,
      padToEven: true,
      title: meta.title,
      author: meta.author,
    },
    frontMatter: front,
    body: { kind: 'pages', pages: body },
    backMatter: back,
  };
}

/** Back-cover copy + listing checklist items specific to coloring books (no invented claims). */
export const COLORING_METADATA_CHECKLIST = [
  'Page count and illustration count in the description match the interior.',
  'Age range and difficulty match the audience you selected.',
  'Description states single-sided pages only if the interior really is single-sided.',
  'No trademarked characters, brands or franchise names in title, subtitle, keywords or art.',
  'AI-generated imagery disclosed to KDP where required (KDP asks about AI-generated content at publishing).',
  'Cover shows original artwork; no claims like “bestseller” or reviews you do not have.',
  'Paper is marketed honestly (KDP paper is not marker-proof; suggest a blotter sheet).',
];
