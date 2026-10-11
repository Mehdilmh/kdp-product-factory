import { InteriorDocument, PageInstance, PageTemplate, type PageElement } from '@kdp/core';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { badRequest, conflict, notFound } from '../lib/errors';

type Section = 'front' | 'body' | 'back';

/** Assemble the typed interior document from normalized rows (+ workspace templates). */
export async function loadDocument(projectId: string): Promise<{ doc: InteriorDocument; revision: number }> {
  const row = await prisma.interiorDocument.findUnique({ where: { projectId }, include: { pages: { orderBy: [{ section: 'asc' }, { position: 'asc' }] } } });
  if (!row) throw notFound('Interior document');
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { workspaceId: true } });
  const templates = await prisma.pageTemplate.findMany({ where: { workspaceId: project.workspaceId } });
  const toInstance = (p: (typeof row.pages)[number]) =>
    PageInstance.parse({ id: p.key, templateId: p.templateId, fields: p.fields, elements: p.elements ?? null, locked: p.locked, blank: p.blank });
  const by = (s: Section) => row.pages.filter((p) => p.section === s).map(toInstance);
  const doc = InteriorDocument.parse({
    settings: row.settings,
    frontMatter: by('front'),
    body: row.bodyKind === 'flow' ? { kind: 'flow', chapters: row.chapters ?? [] } : { kind: 'pages', pages: by('body') },
    backMatter: by('back'),
    templates: templates.map((t) => PageTemplate.parse({ ...(t.definition as object), id: t.key, name: t.name, kind: t.kind, category: t.category, version: t.version })),
  });
  return { doc, revision: row.revision };
}

/**
 * Persist a full document. `expectedRevision` provides optimistic concurrency: a stale editor
 * gets 409 instead of overwriting someone else's changes.
 */
export async function saveDocument(projectId: string, input: unknown, expectedRevision: number | null): Promise<number> {
  const doc = InteriorDocument.parse(input);
  return prisma.$transaction(async (tx) => {
    const row = await tx.interiorDocument.findUnique({ where: { projectId } });
    if (!row) throw notFound('Interior document');
    if (expectedRevision !== null && row.revision !== expectedRevision) throw conflict(`Document changed since you loaded it (revision ${row.revision}, yours ${expectedRevision}). Reload to continue.`, { revision: row.revision });
    await tx.pageInstance.deleteMany({ where: { documentId: row.id } });
    const rows: Prisma.PageInstanceCreateManyInput[] = [];
    const push = (section: Section, pages: PageInstance[]) =>
      pages.forEach((p, position) =>
        rows.push({
          key: p.id,
          documentId: row.id,
          section,
          position,
          templateId: p.templateId,
          fields: p.fields as Prisma.InputJsonValue,
          elements: p.elements ? (p.elements as unknown as Prisma.InputJsonValue) : undefined,
          locked: p.locked,
          blank: p.blank,
        }),
      );
    const keys = [...doc.frontMatter, ...(doc.body.kind === 'pages' ? doc.body.pages : []), ...doc.backMatter].map((p) => p.id);
    if (new Set(keys).size !== keys.length) throw badRequest('Page ids must be unique within a document.');
    push('front', doc.frontMatter);
    if (doc.body.kind === 'pages') push('body', doc.body.pages);
    push('back', doc.backMatter);
    if (rows.length) await tx.pageInstance.createMany({ data: rows });
    const updated = await tx.interiorDocument.update({
      where: { id: row.id },
      data: {
        settings: doc.settings as unknown as Prisma.InputJsonValue,
        bodyKind: doc.body.kind,
        chapters: doc.body.kind === 'flow' ? (doc.body.chapters as unknown as Prisma.InputJsonValue) : undefined,
        revision: { increment: 1 },
      },
    });
    await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
    return updated.revision;
  });
}

const sectionPages = (doc: InteriorDocument, section: Section): PageInstance[] => {
  if (section === 'front') return doc.frontMatter;
  if (section === 'back') return doc.backMatter;
  if (doc.body.kind !== 'pages') throw badRequest('This book uses flowing chapters; edit chapters instead of pages.');
  return doc.body.pages;
};

let idCounter = 0;
const newId = () => `pg${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function lockedElementsUnchanged(before: PageElement[], after: PageElement[]) {
  const walk = (els: PageElement[], out: Map<string, string>) => {
    for (const e of els) {
      if (e.locked) out.set(e.id, JSON.stringify(e));
      if (e.type === 'columns') e.columns.forEach((c) => walk(c.elements, out));
    }
    return out;
  };
  const a = walk(before, new Map());
  const b = walk(after, new Map());
  for (const [id, json] of a) if (b.get(id) !== json) return id;
  return null;
}

export type PageOp =
  | { op: 'add'; section: Section; at?: number; templateId: string | null; fields?: Record<string, string | number | boolean> }
  | { op: 'remove'; section: Section; pageId: string }
  | { op: 'duplicate'; section: Section; pageId: string; count?: number }
  | { op: 'move'; section: Section; pageId: string; to: number }
  | { op: 'update'; section: Section; pageId: string; fields?: Record<string, string | number | boolean>; elements?: unknown[] | null; templateId?: string | null }
  | { op: 'lock'; section: Section; pageId: string; locked: boolean }
  | { op: 'sequence'; section: Section; at?: number; templateIds: string[]; repeat: number; fieldsList?: Record<string, string | number | boolean>[] };

/** Applies an editing operation in memory, enforcing locks. Returns the changed document. */
export function applyPageOp(doc: InteriorDocument, op: PageOp): InteriorDocument {
  const next = structuredClone(doc);
  const pages = sectionPages(next, op.section);
  const idx = 'pageId' in op ? pages.findIndex((p) => p.id === op.pageId) : -1;
  if ('pageId' in op && idx < 0) throw notFound('Page');
  const target = idx >= 0 ? pages[idx] : null;
  const total = next.frontMatter.length + (next.body.kind === 'pages' ? next.body.pages.length : 0) + next.backMatter.length;
  switch (op.op) {
    case 'add': {
      if (total >= 1000) throw badRequest('Page limit reached (1000).');
      pages.splice(op.at ?? pages.length, 0, PageInstance.parse({ id: newId(), templateId: op.templateId, fields: op.fields ?? {} }));
      break;
    }
    case 'remove':
      if (target!.locked) throw conflict('Page is locked. Unlock it before removing.');
      pages.splice(idx, 1);
      break;
    case 'duplicate': {
      const n = Math.min(op.count ?? 1, 500);
      if (total + n > 1000) throw badRequest('Page limit reached (1000).');
      const copies = Array.from({ length: n }, () => ({ ...structuredClone(target!), id: newId(), locked: false }));
      pages.splice(idx + 1, 0, ...copies);
      break;
    }
    case 'move': {
      const [p] = pages.splice(idx, 1);
      pages.splice(Math.max(0, Math.min(op.to, pages.length)), 0, p);
      break;
    }
    case 'update': {
      if (target!.locked) throw conflict('Page is locked. Unlock it before editing.');
      if (op.fields) target!.fields = { ...target!.fields, ...op.fields };
      if (op.templateId !== undefined) target!.templateId = op.templateId;
      if (op.elements !== undefined) {
        const parsed = op.elements === null ? null : PageInstance.shape.elements.parse(op.elements);
        const before = target!.elements ?? [];
        const lockedChanged = lockedElementsUnchanged(before, parsed ?? []);
        if (lockedChanged) throw conflict(`Element "${lockedChanged}" is locked (approved) and cannot be changed.`);
        target!.elements = parsed;
      }
      break;
    }
    case 'lock':
      target!.locked = op.locked;
      break;
    case 'sequence': {
      const n = op.templateIds.length * op.repeat;
      if (n < 1 || total + n > 1000) throw badRequest('Sequence would exceed the 1000-page limit.');
      const seq: PageInstance[] = [];
      for (let r = 0; r < op.repeat; r++)
        op.templateIds.forEach((t, i) => seq.push(PageInstance.parse({ id: newId(), templateId: t, fields: op.fieldsList?.[(r * op.templateIds.length + i) % (op.fieldsList.length || 1)] ?? {} })));
      pages.splice(op.at ?? pages.length, 0, ...seq);
      break;
    }
  }
  return InteriorDocument.parse(next);
}
