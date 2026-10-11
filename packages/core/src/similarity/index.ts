/**
 * Deterministic similarity utilities used for duplicate detection inside a publisher's own
 * portfolio. Results flag items for human review; they never declare infringement.
 */

const STOP = new Set('a an and the of for to in on with your my our by at from this that is are be or as it its'.split(' '));

export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s: string, dropStopwords = false): string[] {
  const t = normalizeText(s).split(' ').filter(Boolean);
  return dropStopwords ? t.filter((w) => !STOP.has(w)) : t;
}

/** 32-bit FNV-1a with seed — stable across platforms. */
export function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function shingles(text: string, k = 5): Set<string> {
  const t = tokens(text);
  const out = new Set<string>();
  if (t.length === 0) return out;
  if (t.length < k) {
    out.add(t.join(' '));
    return out;
  }
  for (let i = 0; i <= t.length - k; i++) out.add(t.slice(i, i + k).join(' '));
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const MINHASH_SIZE = 128;

/** MinHash signature: compact, storable, and comparable without the source text. */
export function minhash(set: Set<string>, size = MINHASH_SIZE): number[] {
  const sig = new Array<number>(size).fill(0xffffffff);
  for (const s of set) {
    const base = fnv1a(s);
    for (let i = 0; i < size; i++) {
      const h = fnv1a(String(base), (0x9e3779b1 * (i + 1)) >>> 0);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

export function minhashSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Very light English stemming so "Nurses" and "Nurse" compare equal. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** 0..1 similarity for titles: max of token-set Jaccard (sans stopwords) and edit similarity. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  const ta = new Set(tokens(a, true).map(stem));
  const tb = new Set(tokens(b, true).map(stem));
  const tok = ta.size && tb.size ? jaccard(ta, tb) : 0;
  const edit = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  return Math.max(tok, edit);
}

export interface InteriorFingerprint {
  /** MinHash over 5-word shingles of all text. */
  textSig: number[];
  /** MinHash over the sequence of page structures (template ids / element kinds). */
  structureSig: number[];
  textTokenCount: number;
  uniquePageRatio: number;
}

/** Fingerprint pages given their text and a structural key per page. */
export function interiorFingerprint(pages: { text: string; structureKey: string }[]): InteriorFingerprint {
  const allText = pages.map((p) => p.text).join('\n');
  const structure = new Set<string>();
  for (let i = 0; i < pages.length; i++) structure.add(`${i % 7}:${pages[i].structureKey}|${pages[i + 1]?.structureKey ?? ''}`);
  const uniquePages = new Set(pages.map((p) => p.structureKey + '\u0000' + normalizeText(p.text)));
  return {
    textSig: minhash(shingles(allText)),
    structureSig: minhash(structure),
    textTokenCount: tokens(allText).length,
    uniquePageRatio: pages.length ? uniquePages.size / pages.length : 0,
  };
}

export interface SimilarityMatch {
  projectId: string;
  title: string;
  score: number;
  kind: 'title' | 'text' | 'structure';
}

/**
 * Compares a candidate against the portfolio. Thresholds are conservative: anything above
 * them is "needs human review", not a verdict.
 */
export function findSimilar(
  candidate: { title: string; fingerprint?: InteriorFingerprint },
  portfolio: { projectId: string; title: string; fingerprint?: InteriorFingerprint | null }[],
  thresholds = { title: 0.8, text: 0.7, structure: 0.9 },
): SimilarityMatch[] {
  const out: SimilarityMatch[] = [];
  for (const p of portfolio) {
    const ts = titleSimilarity(candidate.title, p.title);
    if (ts >= thresholds.title) out.push({ projectId: p.projectId, title: p.title, score: round2(ts), kind: 'title' });
    if (candidate.fingerprint && p.fingerprint) {
      const txt = minhashSimilarity(candidate.fingerprint.textSig, p.fingerprint.textSig);
      // Text similarity only matters when there is meaningful text to compare.
      if (candidate.fingerprint.textTokenCount > 200 && txt >= thresholds.text) out.push({ projectId: p.projectId, title: p.title, score: round2(txt), kind: 'text' });
      const st = minhashSimilarity(candidate.fingerprint.structureSig, p.fingerprint.structureSig);
      if (st >= thresholds.structure && txt >= 0.5) out.push({ projectId: p.projectId, title: p.title, score: round2(st), kind: 'structure' });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
