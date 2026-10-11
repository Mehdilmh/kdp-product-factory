/**
 * Generates every fixture project end to end (interior → cover → exports → preflight) into
 * ./fixtures-out and prints a summary. Usage: npm run fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, reportToHtml, runPipeline, withStarterCover, type FixtureName } from '../src/index';

const out = join(process.cwd(), 'fixtures-out');
mkdirSync(out, { recursive: true });

for (const name of Object.keys(FIXTURES) as FixtureName[]) {
  const base = FIXTURES[name]();
  // Pass 1 determines the final page count; the cover is only generated after that.
  const first = await runPipeline(base, { renderInterior: false, renderCover: false, renderEpub: false });
  const input = withStarterCover(base, first.layout?.pageCount ?? 0, name === 'ebook' ? 'sage' : name === 'hardcover' ? 'industrial' : 'midnight');
  const b = await runPipeline(input);
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  if (b.interiorPdf) writeFileSync(join(dir, 'interior.pdf'), b.interiorPdf);
  if (b.coverPdf) writeFileSync(join(dir, 'cover.pdf'), b.coverPdf);
  if (b.coverSvg) writeFileSync(join(dir, 'cover.svg'), b.coverSvg);
  if (b.ebookCoverPng) writeFileSync(join(dir, 'cover.png'), b.ebookCoverPng);
  if (b.epub) writeFileSync(join(dir, 'book.epub'), b.epub);
  writeFileSync(join(dir, 'preflight.json'), JSON.stringify(b.preflight, null, 2));
  writeFileSync(join(dir, 'preflight.html'), reportToHtml(b.preflight, name));
  const s = b.preflight.summary;
  console.log(
    `${name.padEnd(12)} pages=${String(b.layout?.pageCount ?? '-').padEnd(4)} cover=${b.coverGeometry ? `${b.coverGeometry.widthIn}x${b.coverGeometry.heightIn}in spine=${b.coverGeometry.spineWidthIn}` : '-'}  PASS=${s.PASS} WARN=${s.WARNING} FAIL=${s.FAIL} REVIEW=${s.NEEDS_HUMAN_REVIEW} N/A=${s.NOT_APPLICABLE} blocked=${b.preflight.blocked}`,
  );
  for (const r of b.preflight.results.filter((r) => r.status === 'FAIL' || r.status === 'WARNING' || r.status === 'NEEDS_HUMAN_REVIEW'))
    console.log(`   ${r.status.padEnd(18)} ${r.ruleId.padEnd(16)} ${r.evidence.slice(0, 150)}`);
}
