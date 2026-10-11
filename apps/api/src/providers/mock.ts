import { rasterizeSvg, fnv1a } from '@kdp/core';
import type { ImageProvider, ImageRequest, ImageResult, TextProvider, TextRequest, TextResult } from './types';
import { ProviderError } from './types';

/**
 * Deterministic offline providers so the full workflow runs without API keys (dev, tests, demos).
 * Output is clearly generic; projects using it are flagged as AI/mock-generated for review.
 */
const pick = <T>(arr: T[], seed: string, i = 0): T => arr[(fnv1a(seed + ':' + i) >>> 0) % arr.length];

interface BriefLike {
  workingTitle?: string;
  targetReader?: string;
  readerProblem?: string;
  niche?: string;
  differentiation?: string;
  authorName?: string;
  contentType?: string;
  category?: string;
  pageTarget?: number;
}

const OPENERS = ['What', 'Which', 'When', 'How', 'Where', 'Who'];
const ANGLES = ['helped you today', 'felt harder than expected', 'you want to try differently next time', 'gave you energy', 'you are grateful for', 'you learned', 'you want to remember', 'you could simplify', 'surprised you', 'you are proud of'];

function prompts(brief: BriefLike, n: number): string[] {
  const topic = brief.niche || brief.readerProblem || 'your day';
  const out = new Set<string>();
  for (let i = 0; out.size < n && i < n * 20; i++) out.add(`${pick(OPENERS, topic, i)} part of ${topic.toLowerCase()} ${pick(ANGLES, topic, i * 7 + 3)}?`);
  return [...out];
}

export class MockTextProvider implements TextProvider {
  readonly id = 'mock';
  readonly model = 'mock-text-1';
  /** Inject failures for tests: number of calls that should fail (retryable) before succeeding. */
  constructor(private failuresBeforeSuccess = 0, private nonRetryable = false) {}
  calls = 0;
  async generate(req: TextRequest): Promise<TextResult> {
    this.calls++;
    if (this.calls <= this.failuresBeforeSuccess) throw new ProviderError('mock transient failure', this.id, !this.nonRetryable, this.nonRetryable ? 400 : 503);
    const task = req.task?.name ?? 'freeform';
    const b = (req.task?.input ?? {}) as BriefLike & { chapter?: { title: string; summary: string; keyPoints: string[] } };
    const title = b.workingTitle || 'Untitled';
    const reader = b.targetReader || 'readers';
    let out: unknown;
    switch (task) {
      case 'concept':
        out = {
          titleIdeas: [
            { title, subtitle: `A practical ${b.contentType?.toLowerCase() || 'book'} for ${reader}` },
            { title: `${title}: The Workbook`, subtitle: `Tools for ${b.readerProblem || 'everyday challenges'}` },
            { title: `The ${b.niche || 'Everyday'} Companion`, subtitle: `For ${reader}` },
          ],
          audienceInsights: [`${reader} want quick, repeatable routines.`, `They value clear structure over decoration.`, `They often abandon books that feel generic.`],
          differentiationAssessment: { score: b.differentiation && b.differentiation.length > 40 ? 7 : 4, notes: b.differentiation ? `Differentiation stated: "${b.differentiation.slice(0, 120)}". Make it visible in the interior structure, not only the title.` : 'No differentiation statement provided.' },
          risks: ['Generic prompts reduce perceived value.', 'Check the niche for trademarked terms before publishing.'],
        };
        break;
      case 'page-plan': {
        const n = Math.max(8, Math.min(60, Math.round((b.pageTarget ?? 100) / 2)));
        out = {
          howToUse: `This book is designed for ${reader}. Work through one page at a time; there is no wrong way to use it. ${b.differentiation ? 'What makes it different: ' + b.differentiation : ''}`.trim(),
          sequence: [
            { templateId: 'guided-writing', repeat: n, prompts: prompts(b, n) },
            { templateId: 'lined-journal', repeat: Math.max(4, (b.pageTarget ?? 100) - n - 6) },
          ],
        };
        break;
      }
      case 'outline':
        out = {
          chapters: [
            { title: `Why ${b.niche || 'this'} matters`, summary: `Sets out the problem for ${reader}.`, keyPoints: ['The core problem', 'Who this book is for', 'How to use it'] },
            { title: 'Getting started', summary: 'First practical steps.', keyPoints: ['A simple first routine', 'Common mistakes', 'Measuring progress'] },
            { title: 'Building the habit', summary: 'Making it stick.', keyPoints: ['Triggers and cues', 'Tracking', 'Recovering from lapses'] },
            { title: 'Going further', summary: 'Next steps.', keyPoints: ['Advanced options', 'Resources', 'A 30-day plan'] },
          ],
        };
        break;
      case 'chapter': {
        const ch = b.chapter ?? { title: 'Chapter', summary: '', keyPoints: [] };
        out = {
          blocks: [
            { type: 'paragraph', text: `${ch.summary} This chapter is written for ${reader} and focuses on practical steps rather than theory.` },
            ...ch.keyPoints.flatMap((k, i) => [
              { type: 'heading', text: k, level: 2 },
              { type: 'paragraph', text: `${k} is easier to approach in small, specific steps. Start by noticing how it shows up in your week, then choose one change you can test for seven days. Write down what happened, what helped, and what got in the way.` },
              { type: 'paragraph', text: `Many ${reader} find that the first attempt reveals more about their routine than about ${k.toLowerCase()} itself. Treat each attempt as information, not as a verdict. Step ${i + 1} is simply to begin and to record honestly.` },
            ]),
            { type: 'list', items: ch.keyPoints.map((k) => `Try one small action related to: ${k.toLowerCase()}.`) },
          ],
        };
        break;
      }
      case 'metadata':
        out = {
          titles: [{ title, subtitle: `A ${b.contentType?.toLowerCase() || 'book'} for ${reader}` }],
          description: `${title} is a ${b.contentType?.toLowerCase() || 'book'} for ${reader}. ${b.readerProblem ? 'It helps with ' + b.readerProblem.toLowerCase().replace(/\.$/, '') + '.' : ''} ${b.differentiation ?? ''}`.trim(),
          keywords: [
            { keyword: `${b.niche || 'guided'} ${b.contentType?.toLowerCase() || 'journal'}`.slice(0, 50), rationale: 'Describes the product type and niche.' },
            { keyword: `${reader} gift`.slice(0, 50), rationale: 'Audience-based phrasing.' },
            { keyword: `${b.readerProblem || 'daily'} tracker`.toLowerCase().slice(0, 50), rationale: 'Problem-based phrasing.' },
          ],
          categories: [b.category || 'Self-Help'],
        };
        break;
      case 'cover-concept':
        out = { artPrompt: `Abstract, calm background artwork for a book about ${b.niche || 'reflection'}, soft shapes, no text, no letters`, palette: ['#1B2541', '#E8C26A', '#FFFFFF'], mood: 'calm' };
        break;
      default:
        out = { text: `Mock response for ${task}` };
    }
    const text = JSON.stringify(out);
    return { text, inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4), outputTokens: Math.ceil(text.length / 4), model: this.model };
  }
}

export class MockImageProvider implements ImageProvider {
  readonly id = 'mock-image';
  readonly model = 'mock-art-1';
  async generate(req: ImageRequest): Promise<ImageResult> {
    const seed = req.seed ?? req.prompt;
    const hues = [fnv1a(seed) % 360, (fnv1a(seed + 'b') % 360) as number];
    const w = req.widthPx;
    const h = req.heightPx;
    const circles = Array.from({ length: 7 }, (_, i) => {
      const x = (fnv1a(seed + 'x' + i) % 1000) / 1000;
      const y = (fnv1a(seed + 'y' + i) % 1000) / 1000;
      const r = 0.08 + ((fnv1a(seed + 'r' + i) % 1000) / 1000) * 0.25;
      return `<circle cx="${x * w}" cy="${y * h}" r="${r * Math.min(w, h)}" fill="hsl(${(hues[1] + i * 23) % 360},45%,${55 + (i % 3) * 8}%)" opacity="0.35"/>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hues[0]},40%,25%)"/><stop offset="1" stop-color="hsl(${(hues[0] + 40) % 360},45%,12%)"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${circles}</svg>`;
    return { bytes: rasterizeSvg(svg, w), mimeType: 'image/png', model: this.model };
  }
}

/**
 * Offline mock output for the image-model library (`mock/line-art`, `mock/cover-art`).
 * Procedural shapes only — not AI. Line art is black outlines on white so the coloring
 * pipeline (QC, processing, interior) can be exercised end to end without API keys.
 */
export async function mockImage(endpointId: string, seed: string, w: number, h: number): Promise<Uint8Array> {
  if (endpointId.startsWith('mock/line-art')) {
    const stroke = Math.max(3, Math.round(Math.min(w, h) / 160));
    const shapes = Array.from({ length: 6 }, (_, i) => {
      const x = 0.15 + ((fnv1a(seed + 'x' + i) % 1000) / 1000) * 0.7;
      const y = 0.15 + ((fnv1a(seed + 'y' + i) % 1000) / 1000) * 0.7;
      const r = 0.06 + ((fnv1a(seed + 'r' + i) % 1000) / 1000) * 0.12;
      const k = fnv1a(seed + 'k' + i) % 3;
      const R = r * Math.min(w, h);
      if (k === 0) return `<circle cx="${x * w}" cy="${y * h}" r="${R}"/>`;
      if (k === 1) return `<rect x="${x * w - R}" y="${y * h - R}" width="${2 * R}" height="${2 * R}" rx="${R / 4}"/>`;
      const pts = Array.from({ length: 5 }, (_, j) => {
        const a = (Math.PI * 2 * j) / 5 - Math.PI / 2;
        return `${x * w + R * Math.cos(a)},${y * h + R * Math.sin(a)}`;
      }).join(' ');
      return `<polygon points="${pts}"/>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/><g fill="none" stroke="#000" stroke-width="${stroke}" stroke-linejoin="round">${shapes}</g></svg>`;
    return rasterizeSvg(svg, w);
  }
  const r = await new MockImageProvider().generate({ prompt: seed, seed, widthPx: w, heightPx: h } as ImageRequest);
  return r.bytes;
}
