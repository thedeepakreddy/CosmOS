/**
 * BM25 over a corpus of chunks.
 *
 * Plain term-overlap scoring has two failure modes that matter for research
 * text, and BM25 exists to fix exactly those:
 *
 *   - **Term saturation.** A chunk that says "memory" forty times is not ten
 *     times more about memory than one that says it four times. `k1` bounds how
 *     much repetition can buy.
 *   - **Length normalisation.** A long chunk contains more terms by accident, so
 *     without `b` the longest chunk in a document wins nearly every query.
 *
 * Kept pure and separate from storage so ranking can be tested exactly and
 * behaves identically regardless of which engine the chunks came from.
 */
import { tokenizeWords } from "@research-os/shared";

/** Term-frequency saturation. 1.2 is the long-standing default and behaves well on prose. */
export const DEFAULT_K1 = 1.2;
/** Length normalisation strength. 0 = ignore length, 1 = fully normalise. */
export const DEFAULT_B = 0.75;

export interface Bm25Document {
  readonly id: string;
  readonly terms: readonly string[];
}

export interface Bm25Index {
  readonly documents: readonly Bm25Document[];
  /** term -> number of documents containing it. */
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly averageLength: number;
  /** id -> term -> count within that document. */
  readonly termCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export function buildBm25Index(documents: readonly { id: string; text: string }[]): Bm25Index {
  const prepared: Bm25Document[] = documents.map((document) => ({ id: document.id, terms: tokenizeWords(document.text) }));

  const documentFrequency = new Map<string, number>();
  const termCounts = new Map<string, Map<string, number>>();
  let totalLength = 0;

  for (const document of prepared) {
    totalLength += document.terms.length;
    const counts = new Map<string, number>();
    for (const term of document.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    termCounts.set(document.id, counts);
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  return {
    documents: prepared,
    documentFrequency,
    averageLength: prepared.length === 0 ? 0 : totalLength / prepared.length,
    termCounts,
  };
}

/**
 * Robertson-Sparck Jones IDF with the +0.5 smoothing.
 *
 * Floored at zero: the unsmoothed form goes negative for a term appearing in
 * more than half the corpus, and a negative contribution would mean a document
 * is *penalised* for containing a word the query asked for.
 */
export function bm25Idf(totalDocuments: number, documentFrequency: number): number {
  return Math.max(0, Math.log(1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5)));
}

export interface Bm25Hit {
  readonly id: string;
  readonly score: number;
  /** Query terms this document actually contained. Useful for explaining a ranking. */
  readonly matchedTerms: string[];
}

export function bm25Search(
  index: Bm25Index,
  query: string,
  options: { k1?: number; b?: number; limit?: number } = {},
): Bm25Hit[] {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;
  const queryTerms = [...new Set(tokenizeWords(query))];
  if (queryTerms.length === 0 || index.documents.length === 0) return [];

  const total = index.documents.length;
  const hits: Bm25Hit[] = [];

  for (const document of index.documents) {
    const counts = index.termCounts.get(document.id);
    if (!counts) continue;

    let score = 0;
    const matchedTerms: string[] = [];
    const lengthRatio = index.averageLength === 0 ? 1 : document.terms.length / index.averageLength;

    for (const term of queryTerms) {
      const frequency = counts.get(term);
      if (!frequency) continue;
      matchedTerms.push(term);
      const idf = bm25Idf(total, index.documentFrequency.get(term) ?? 0);
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * lengthRatio)));
    }

    if (score > 0) hits.push({ id: document.id, score, matchedTerms });
  }

  return hits
    .sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id))
    .slice(0, options.limit ?? 50);
}

/**
 * Reciprocal Rank Fusion.
 *
 * Combines rankings rather than scores, which is the point: a BM25 score and a
 * cosine similarity live on different scales with different distributions, and
 * blending them numerically means inventing a conversion factor that has no
 * justification and quietly decides the result. RRF only asks each ranker where
 * it placed a document, so adding a third retrieval strategy later needs no
 * re-tuning.
 *
 * `k` damps the influence of top positions; 60 is the value from the original
 * paper and is not sensitive.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  options: { k?: number; limit?: number; weights?: readonly number[] } = {},
): { id: string; score: number }[] {
  const k = options.k ?? 60;
  const fused = new Map<string, number>();

  for (const [rankerIndex, ranking] of rankings.entries()) {
    const weight = options.weights?.[rankerIndex] ?? 1;
    for (const [position, id] of ranking.entries()) {
      fused.set(id, (fused.get(id) ?? 0) + weight / (k + position + 1));
    }
  }

  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, options.limit ?? 50);
}
