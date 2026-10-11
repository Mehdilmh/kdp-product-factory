/**
 * Seeds a demo account with the five fixture projects.
 *   npm run db:seed            (uses DATABASE_URL)
 * Demo login: demo@kdp-factory.local / demo-password-123
 */
import { FIXTURES, type FixtureName } from '@kdp/core';
import { loadConfig } from '../src/config';
import { prisma } from '../src/db';
import { hashPassword } from '../src/lib/crypto';
import { importFixture } from '../src/services/fixtures-import';
import { syncRules } from '../src/app';

loadConfig();
const email = 'demo@kdp-factory.local';
const password = 'demo-password-123';

await syncRules();
let user = await prisma.user.findUnique({ where: { email }, include: { memberships: true } });
if (!user) {
  user = await prisma.user.create({
    data: { email, name: 'Demo Publisher', passwordHash: await hashPassword(password), memberships: { create: { role: 'OWNER', workspace: { create: { name: 'Demo Press' } } } } },
    include: { memberships: true },
  });
}
const ws = user.memberships[0].workspaceId;
const existing = await prisma.project.count({ where: { workspaceId: ws } });
if (existing === 0) {
  for (const name of Object.keys(FIXTURES) as FixtureName[]) {
    const p = await importFixture(ws, user.id, name);
    console.log(`Imported fixture ${name}: ${p.title} (${p.id})`);
  }
}
console.log(`\nDemo login: ${email} / ${password}`);
await prisma.$disconnect();
