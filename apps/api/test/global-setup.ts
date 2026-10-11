import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/kdp_factory_test';
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  return () => rmSync('./storage-test', { recursive: true, force: true });
}
