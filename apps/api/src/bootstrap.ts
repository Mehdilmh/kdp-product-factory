import { createHash } from 'node:crypto';
import { RULES, SEED_MODELS } from '@kdp/core';
import type { Prisma } from '@prisma/client';
import { syncRules } from './app';
import { prisma } from './db';
import { ensureCatalog, MOCK_MODELS } from './services/image-catalog';

const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/**
 * One-time data setup per deployment: mirrors the rules registry and seeds the model catalog.
 * Skipped when the stored fingerprint matches, so serverless cold starts stay fast.
 */
export async function bootstrap(opts: { force?: boolean } = {}) {
  const want = {
    rules: fingerprint(RULES.map((r) => [r.id, r.version, r.title, r.severity, r.blocking, r.source, r.sourceVerification, r.lastVerified])),
    catalog: fingerprint([SEED_MODELS, MOCK_MODELS.map((m) => [m.endpointId, m.displayName])]),
  };
  const row = await prisma.systemState.findUnique({ where: { key: 'bootstrap' } });
  const have = (row?.value ?? {}) as Partial<typeof want>;
  if (opts.force || have.rules !== want.rules) await syncRules();
  if (opts.force || have.catalog !== want.catalog) await ensureCatalog();
  if (opts.force || have.rules !== want.rules || have.catalog !== want.catalog)
    await prisma.systemState.upsert({ where: { key: 'bootstrap' }, create: { key: 'bootstrap', value: want as Prisma.InputJsonValue }, update: { value: want as Prisma.InputJsonValue } });
}
