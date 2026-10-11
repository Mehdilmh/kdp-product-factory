import { describe, expect, it } from 'vitest';
import { checkMetadata, findSimilar, interiorFingerprint, isbnValid, jaccard, MetadataDraft, type MetadataDraftInput, minhash, minhashSimilarity, shingles, titleSimilarity, titlesConsistent } from '../src/index';

const md = (o: Partial<MetadataDraftInput> = {}) => MetadataDraft.parse({ title: 'Quiet Mornings', author: 'Ava', description: 'A journal.', ...o });

describe('metadata validation', () => {
  it('passes clean metadata', () => {
    expect(checkMetadata(md()).filter((f) => f.status === 'FAIL')).toEqual([]);
  });
  it('fails promotional words and over-long titles', () => {
    expect(checkMetadata(md({ title: 'Bestselling Journal #1' })).filter((f) => f.status === 'FAIL').length).toBeGreaterThanOrEqual(2);
    expect(checkMetadata(md({ title: 'x'.repeat(150), subtitle: 'y'.repeat(60) })).some((f) => f.message.includes('200'))).toBe(true);
  });
  it('sends ambiguous terms to human review, not automatic failure', () => {
    const f = checkMetadata(md({ title: 'Stress-Free Kindle Journal' }));
    expect(f.some((x) => x.status === 'NEEDS_HUMAN_REVIEW' && x.message.includes('kindle'))).toBe(true);
    expect(f.some((x) => x.message.includes('"free"'))).toBe(false);
  });
  it('detects keyword stuffing, keyword limits, and missing evidence', () => {
    const f = checkMetadata(md({ subtitle: 'journal journal journal, notebook, diary, planner, log', keywords: Array.from({ length: 8 }, (_, i) => ({ keyword: `kw ${i}` })) }));
    expect(f.some((x) => x.message.includes('stuffing'))).toBe(true);
    expect(f.some((x) => x.message.includes('7 keyword'))).toBe(true);
    expect(f.some((x) => x.message.includes('no recorded source'))).toBe(true);
  });
  it('flags unsupported claims and bad HTML in descriptions', () => {
    const f = checkMetadata(md({ description: '<script>x</script> This journal cures anxiety. Guaranteed results!' }));
    expect(f.some((x) => x.field === 'description' && x.status === 'FAIL')).toBe(true);
    expect(f.filter((x) => x.status === 'NEEDS_HUMAN_REVIEW').length).toBeGreaterThanOrEqual(2);
  });
  it('validates ISBN checksums and never accepts invented ones', () => {
    expect(isbnValid('978-0-306-40615-7')).toBe(true);
    expect(isbnValid('0-306-40615-2')).toBe(true);
    expect(isbnValid('978-0-306-40615-8')).toBe(false);
    expect(checkMetadata(md({ isbn: '9781234567890' })).some((x) => x.field === 'isbn' && x.status === 'FAIL')).toBe(true);
  });
  it('checks cover/metadata title consistency', () => {
    expect(titlesConsistent('Quiet Mornings', 'QUIET MORNINGS\nA journal')).toBe(true);
    expect(titlesConsistent('Quiet Mornings', 'Loud Evenings')).toBe(false);
  });
});

describe('duplicate detection', () => {
  it('scores near-identical titles highly and unrelated titles low', () => {
    expect(titleSimilarity('Nurse Gratitude Journal', 'Gratitude Journal for Nurses')).toBeGreaterThan(0.5);
    expect(titleSimilarity('Quiet Mornings', 'Quiet Mornings!')).toBeGreaterThan(0.9);
    expect(titleSimilarity('Quiet Mornings', 'Workshop Maintenance Log')).toBeLessThan(0.3);
  });
  it('MinHash approximates Jaccard similarity', () => {
    const a = shingles('the cat sat on the mat and looked out of the window at the rain '.repeat(5));
    const b = shingles('the cat sat on the mat and looked out of the window at the snow '.repeat(5));
    const est = minhashSimilarity(minhash(a), minhash(b));
    expect(Math.abs(est - jaccard(a, b))).toBeLessThan(0.15);
  });
  it('flags a near-identical interior in the portfolio but not a distinct one', () => {
    const pages = (prefix: string) => Array.from({ length: 60 }, (_, i) => ({ text: `${prefix} reflect on day ${i} with gratitude and calm notes about the morning routine and small wins`, structureKey: i % 2 ? 'lined' : 'guided' }));
    const a = interiorFingerprint(pages('Please'));
    const b = interiorFingerprint(pages('Please'));
    const c = interiorFingerprint(Array.from({ length: 60 }, (_, i) => ({ text: `Inspect machine ${i * 7} for torque, wear, lubrication, and guard placement before every shift`, structureKey: 'log' })));
    const matches = findSimilar({ title: 'Morning Calm Journal', fingerprint: a }, [
      { projectId: 'b', title: 'Calm Morning Journal', fingerprint: b },
      { projectId: 'c', title: 'Machine Log', fingerprint: c },
    ]);
    expect(matches.filter((m) => m.projectId === 'b').map((m) => m.kind).sort()).toEqual(['structure', 'text', 'title']);
    expect(matches.some((m) => m.projectId === 'c')).toBe(false);
  });
});
