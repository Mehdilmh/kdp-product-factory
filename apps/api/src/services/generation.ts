import { BUILT_IN_TEMPLATES, computeCoverGeometry, ebookCoverGeometry, FlowBlock, imageSize, InteriorDocument, MetadataDraft, OfficialCoverGeometry, sha256, starterCoverDesign, type CoverLayerInput, type PageInstanceInput } from '@kdp/core';
import type { Prisma, Project } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { getStorage } from '../lib/storage';
import { generateImage, generateText, type CallContext } from '../providers/gateway';
import { ProviderError } from '../providers/types';
import { assembleInput, currentMetadata } from './build';
import { loadDocument, saveDocument } from './interior';
import { layoutDocument } from '@kdp/core';

const SYSTEM = `You are a careful publishing assistant helping an independent publisher create ORIGINAL books.
Rules:
- Write original text. Never reproduce copyrighted text, song lyrics, or other books.
- Never use trademarks, brand names, celebrity names, or franchise characters.
- Never make medical, legal, financial, or efficacy claims, and never invent facts, statistics, reviews, or search volumes.
- Match the target reader and the stated differentiation; avoid generic filler.
- Respond ONLY with a single JSON object that matches the requested schema. No prose outside JSON.`;

export interface GenCtx extends CallContext {
  project: Project;
}

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(t);
}

/** Ask for JSON and validate it; one repair attempt with the validation error, then give up. */
export async function askJson<T extends z.ZodTypeAny>(ctx: GenCtx, task: string, input: unknown, schema: T, instructions: string, maxOutputTokens = 4096): Promise<z.infer<T>> {
  let prompt = `${instructions}\n\nINPUT:\n${JSON.stringify(input, null, 2)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await generateText({ ...ctx, operation: task }, { system: SYSTEM, prompt, json: true, maxOutputTokens, task: { name: task, input } });
    let parsed: unknown;
    try {
      parsed = parseJson(res.text);
    } catch {
      prompt += `\n\nYour previous reply was not valid JSON. Reply with JSON only.`;
      continue;
    }
    const r = schema.safeParse(parsed);
    if (r.success) return r.data;
    prompt += `\n\nYour previous JSON did not match the schema: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. Fix it.`;
  }
  throw new ProviderError(`The text provider did not return valid ${task} JSON after a repair attempt.`, 'generation', false);
}

async function briefInput(project: Project) {
  const brief = await prisma.productBrief.findUniqueOrThrow({ where: { projectId: project.id } });
  const format = await prisma.productFormat.findUniqueOrThrow({ where: { projectId: project.id } });
  return {
    workingTitle: brief.workingTitle,
    category: project.category,
    contentClass: project.contentClass,
    contentType: brief.contentType,
    targetReader: brief.targetReader,
    readerProblem: brief.readerProblem,
    niche: brief.niche,
    differentiation: brief.differentiation,
    language: brief.language,
    contentStyle: brief.contentStyle,
    authorName: brief.authorName,
    format: format.format,
    trimId: format.trimId,
    pageTarget: format.targetPageCount ?? (format.format === 'HARDCOVER' ? 120 : 100),
  };
}

/* ----------------------------------------- Research ----------------------------------------- */

export const ConceptSchema = z.object({
  titleIdeas: z.array(z.object({ title: z.string().min(1).max(200), subtitle: z.string().max(200).default('') })).min(1).max(10),
  audienceInsights: z.array(z.string().max(500)).max(10).default([]),
  differentiationAssessment: z.object({ score: z.number().min(0).max(10), notes: z.string().max(2000) }),
  risks: z.array(z.string().max(500)).max(10).default([]),
});

export async function stageResearch(ctx: GenCtx) {
  const input = await briefInput(ctx.project);
  const concept = await askJson(ctx, 'concept', input, ConceptSchema, 'Assess this product concept. Propose up to 5 original title/subtitle ideas, list audience insights, score the differentiation 0–10 with notes, and list risks (e.g. generic content, trademark terms in the niche).');
  const { row } = await currentMetadata(ctx.project.id);
  if (row) await prisma.metadataDraft.update({ where: { id: row.id }, data: { suggestions: { ...((row.suggestions as object) ?? {}), concept } as Prisma.InputJsonValue } });
  return concept;
}

/* ----------------------------------------- Content ------------------------------------------ */

const allowedTemplates = BUILT_IN_TEMPLATES.filter((t) => t.kind === 'body').map((t) => t.id) as [string, ...string[]];
export const PagePlanSchema = z.object({
  howToUse: z.string().max(3000).default(''),
  sequence: z
    .array(z.object({ templateId: z.enum(allowedTemplates), repeat: z.number().int().min(1).max(500), prompts: z.array(z.string().min(3).max(300)).max(500).optional() }))
    .min(1)
    .max(30),
});
export const OutlineSchema = z.object({ chapters: z.array(z.object({ title: z.string().min(1).max(200), summary: z.string().max(1000).default(''), keyPoints: z.array(z.string().max(300)).max(12).default([]) })).min(1).max(40) });
export const ChapterSchema = z.object({ blocks: z.array(FlowBlock).min(1).max(400) });

export async function stageContent(ctx: GenCtx) {
  const input = await briefInput(ctx.project);
  const { doc, revision } = await loadDocument(ctx.project.id);
  const next = structuredClone(doc);

  if (doc.body.kind === 'flow') {
    const outline = await askJson(ctx, 'outline', input, OutlineSchema, 'Create a chapter outline for this book: titles, a one-paragraph summary each, and key points. Keep it specific to the reader and differentiation.');
    ctx.log?.(`Outline: ${outline.chapters.length} chapters.`);
    const chapters = [];
    for (const [i, ch] of outline.chapters.entries()) {
      if (ctx.signal?.aborted) throw new ProviderError('Cancelled', 'generation', false);
      const body = await askJson(ctx, 'chapter', { ...input, chapter: ch, chapterNumber: i + 1, totalChapters: outline.chapters.length }, ChapterSchema, 'Write this chapter as JSON blocks (paragraph, heading level 2–4, list, quote, sectionBreak). Original, practical, no invented facts or statistics.', 8192);
      chapters.push({ id: `c${i + 1}`, title: ch.title, blocks: body.blocks, notes: [] });
      ctx.log?.(`Chapter ${i + 1}/${outline.chapters.length} written.`);
    }
    next.body = { kind: 'flow', chapters };
  } else {
    if (doc.body.pages.some((p) => p.locked)) {
      ctx.log?.('Body contains locked (approved) pages — skipping AI page regeneration to preserve them.');
      return { skipped: true };
    }
    const plan = await askJson(ctx, 'page-plan', input, PagePlanSchema, `Plan the interior page sequence using ONLY these template ids: ${allowedTemplates.join(', ')}. For guided templates provide one distinct, original prompt per page. Total pages should be close to pageTarget minus front matter. Also write a short "how to use this book" text.`);
    const pages: PageInstanceInput[] = [];
    let n = 0;
    for (const s of plan.sequence) {
      for (let r = 0; r < s.repeat && pages.length < 900; r++) {
        const prompt = s.prompts?.[r];
        pages.push({ id: `ai${++n}`, templateId: s.templateId, fields: prompt ? (s.templateId === 'workbook-exercise' ? { q1: prompt } : { prompt }) : {} });
      }
    }
    next.body = { kind: 'pages', pages: pages.map((p) => ({ fields: {}, elements: null, locked: false, blank: false, templateId: null, ...p })) } as InteriorDocument['body'];
    if (plan.howToUse) {
      const how = next.frontMatter.find((p) => p.templateId === 'how-to-use');
      if (how && !how.locked) how.fields = { ...how.fields, body: plan.howToUse };
      else if (!how) next.frontMatter.push({ id: 'howto', templateId: 'how-to-use', fields: { body: plan.howToUse }, elements: null, locked: false, blank: false });
    }
    ctx.log?.(`Page plan: ${pages.length} body pages.`);
  }
  await saveDocument(ctx.project.id, InteriorDocument.parse(next), revision);
  await prisma.project.update({ where: { id: ctx.project.id }, data: { aiTextGenerated: true } });
  return { pages: next.body.kind === 'pages' ? next.body.pages.length : null, chapters: next.body.kind === 'flow' ? next.body.chapters.length : null };
}

/* ----------------------------------------- Interior ----------------------------------------- */

export async function stageInterior(ctx: GenCtx) {
  const input = await assembleInput(ctx.project, { includeCover: false });
  if (input.format === 'EBOOK') return { pageCount: null };
  const l = layoutDocument(input.document, { format: { format: input.format, trimId: input.trimId, ink: input.ink, paper: input.paper, bleed: input.bleed }, direction: input.direction });
  const errors = l.warnings.filter((w) => w.level === 'error');
  ctx.log?.(`Laid out ${l.pageCount} pages (gutter ${l.margins.insideIn}"); ${errors.length} layout error(s).`);
  return { pageCount: l.pageCount, layoutErrors: errors.length };
}

/* ------------------------------------------- Cover ------------------------------------------ */

export const CoverConceptSchema = z.object({ artPrompt: z.string().min(5).max(1000), palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).default([]), mood: z.string().max(100).default('') });

/**
 * Generates background art with the image provider and a starter design whose title, subtitle,
 * author, and spine text are live, editable text — never rendered by the image model.
 */
export async function stageCover(ctx: GenCtx, opts: { useImage: boolean }) {
  const input = await assembleInput(ctx.project, { includeCover: false });
  const brief = await prisma.productBrief.findUniqueOrThrow({ where: { projectId: ctx.project.id } });
  const format = await prisma.productFormat.findUniqueOrThrow({ where: { projectId: ctx.project.id } });
  const { data: md } = await currentMetadata(ctx.project.id);
  let geom;
  if (input.format === 'EBOOK') geom = ebookCoverGeometry();
  else {
    const l = layoutDocument(input.document, { format: { format: input.format, trimId: input.trimId, ink: input.ink, paper: input.paper, bleed: input.bleed } });
    geom = computeCoverGeometry({ format: input.format, trimId: input.trimId, pageCount: l.pageCount, ink: input.ink, paper: input.paper, direction: input.direction, official: format.officialCover ? OfficialCoverGeometry.parse(format.officialCover) : null });
    if (geom.source === 'UNRESOLVED') {
      ctx.log?.('Hardcover cover geometry needs official KDP calculator values; a front-panel design will be created once they are entered.');
    }
  }
  const design = starterCoverDesign(geom, { title: md.title || brief.workingTitle, subtitle: md.subtitle, author: md.author || brief.authorName, backText: md.description || undefined, themeId: brief.designTheme });
  if (opts.useImage && geom.widthIn > 0) {
    const concept = await askJson(ctx, 'cover-concept', { ...(await briefInput(ctx.project)), theme: brief.designTheme }, CoverConceptSchema, 'Write an art-direction prompt for BACKGROUND ARTWORK ONLY for the front cover. The artwork must contain no text, letters, numbers, logos, or trademarks.');
    const f = geom.panels.front;
    const bleed = geom.bleedIn;
    const wIn = f.w + bleed;
    const hIn = f.h + 2 * bleed;
    const scale = Math.min(1, 2048 / (wIn * 300), 2048 / (hIn * 300));
    const img = await generateImage({ ...ctx, operation: 'cover-art' }, { prompt: `${concept.artPrompt}. No text, no letters, no logos.`, widthPx: Math.round(wIn * 300 * scale), heightPx: Math.round(hIn * 300 * scale), seed: ctx.project.id });
    const size = imageSize(img.bytes)!;
    const key = `ws/${ctx.project.workspaceId}/projects/${ctx.project.id}/assets/cover-art-${Date.now().toString(36)}.${size.mimeType === 'image/png' ? 'png' : 'jpg'}`;
    await getStorage().put(key, img.bytes, size.mimeType);
    const asset = await prisma.asset.create({
      data: { workspaceId: ctx.project.workspaceId, projectId: ctx.project.id, kind: 'IMAGE', filename: 'cover-art', mimeType: size.mimeType, sizeBytes: img.bytes.byteLength, storageKey: key, sha256: sha256(img.bytes), widthPx: size.widthPx, heightPx: size.heightPx, source: 'AI', licenseNote: `AI-generated by ${img.model}. Review provider terms for commercial use.`, meta: { prompt: concept.artPrompt } },
    });
    // Background art spans the front panel into the bleed; text layers stay above it.
    const art: CoverLayerInput = { id: 'cover-art', name: 'Cover art (AI)', type: 'image', anchor: 'front', x: geom.direction === 'RTL' ? -bleed : 0, y: -bleed, w: wIn, h: hIn, assetId: asset.id, fit: 'cover', locked: false };
    design.layers.unshift(art as (typeof design.layers)[number]);
    await prisma.project.update({ where: { id: ctx.project.id }, data: { aiImagesGenerated: true } });
    ctx.log?.(`Cover art generated (${size.widthPx}×${size.heightPx}px).`);
  }
  await prisma.coverDesign.updateMany({ where: { projectId: ctx.project.id }, data: { isActive: false } });
  const cover = await prisma.coverDesign.create({ data: { projectId: ctx.project.id, name: 'Generated cover', design: design as unknown as Prisma.InputJsonValue, isActive: true } });
  return { coverId: cover.id, geometry: { widthIn: geom.widthIn, heightIn: geom.heightIn, spineWidthIn: geom.spineWidthIn, source: geom.source } };
}

/* ----------------------------------------- Metadata ----------------------------------------- */

export const MetadataSuggestionSchema = z.object({
  titles: z.array(z.object({ title: z.string().min(1).max(200), subtitle: z.string().max(200).default('') })).min(1).max(10),
  description: z.string().min(20).max(4000),
  keywords: z.array(z.object({ keyword: z.string().min(1).max(50), rationale: z.string().max(500).default('') })).max(15),
  categories: z.array(z.string().max(300)).max(5).default([]),
});

/** Suggestions are stored separately and only fill empty fields; users edit everything. */
export async function stageMetadata(ctx: GenCtx) {
  const input = await briefInput(ctx.project);
  const s = await askJson(ctx, 'metadata', input, MetadataSuggestionSchema, 'Suggest title/subtitle options, an accurate description (no claims you cannot support, no reviews, no "bestseller"), up to 7 keyword candidates with a rationale each, and 1–3 browse categories. Do not invent search volumes or sales data.');
  const { row, data } = await currentMetadata(ctx.project.id);
  const today = new Date().toISOString().slice(0, 10);
  const next = MetadataDraft.parse({
    ...data,
    subtitle: data.subtitle || s.titles[0]?.subtitle || '',
    description: data.description || s.description,
    categories: data.categories.length ? data.categories : s.categories.slice(0, 3),
    keywords: data.keywords.length
      ? data.keywords
      : s.keywords.slice(0, 7).map((k) => ({ keyword: k.keyword, source: 'AI suggestion (unverified)', recordedAt: today, evidence: `Rationale: ${k.rationale} — No search-volume data; verify with your own research before use.` })),
  });
  if (row) await prisma.metadataDraft.update({ where: { id: row.id }, data: { data: next as unknown as Prisma.InputJsonValue, suggestions: { ...((row.suggestions as object) ?? {}), metadata: s, generatedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
  await prisma.project.update({ where: { id: ctx.project.id }, data: { aiTextGenerated: true } });
  return { keywordCandidates: s.keywords.length, titleOptions: s.titles.length };
}
