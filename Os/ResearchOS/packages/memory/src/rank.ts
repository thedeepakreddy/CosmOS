/**
 * Ranking memories.
 *
 * Kept pure and out of SQL on purpose: the database narrows to a candidate set
 * using filters it can index, and the ordering happens here. That way ranking
 * behaves identically on SQLite and Postgres, and it can be tested exhaustively
 * without a database — which matters, because "why did it not recall that?" is
 * otherwise one of the hardest questions to answer about a memory system.
 *
 * Lexical scoring is term coverage weighted by inverse document frequency over
 * the candidate set. A term appearing in every candidate carries no information
 * and is scored accordingly; a rare term that matches is what should pull a
 * memory to the top.
 */
import type { MemoryQuery, MemoryRecord, MemorySearchHit } from "@research-os/contracts";
import { clamp01, cosineSimilarity, round, tokenizeWords } from "@research-os/shared";

/** Salience halves over this many days when nothing reinforces it. */
export const DEFAULT_SALIENCE_HALF_LIFE_DAYS = 30;

/**
 * Age discount applied to ranking.
 *
 * Floored rather than allowed to reach zero: an old memory should sort below a
 * fresh one, but it must stay retrievable. The contract is explicit that
 * salience ranks results and never hides them, and a decay that reached zero
 * would quietly do the hiding.
 */
export function recencyFactor(ageMs: number, halfLifeDays = DEFAULT_SALIENCE_HALF_LIFE_DAYS, floor = 0.2): number {
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / 86_400_000;
  return clamp01(floor + (1 - floor) * 0.5 ** (ageDays / halfLifeDays));
}

export function inverseDocumentFrequency(documents: readonly (readonly string[])[]): Map<string, number> {
  const total = documents.length || 1;
  const counts = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, count] of counts) {
    // +1 inside the log keeps this positive even for a term in every document.
    idf.set(term, Math.log(1 + total / count));
  }
  return idf;
}

/** Fraction of the query's information content that this document covers. */
export function lexicalScore(queryTerms: readonly string[], documentTerms: readonly string[], idf: Map<string, number>): number {
  if (queryTerms.length === 0) return 0;
  const present = new Set(documentTerms);
  let matched = 0;
  let possible = 0;
  for (const term of new Set(queryTerms)) {
    const weight = idf.get(term) ?? Math.log(2);
    possible += weight;
    if (present.has(term)) matched += weight;
  }
  return possible === 0 ? 0 : clamp01(matched / possible);
}

export interface RankOptions {
  readonly now: string;
  /** Embedding of the query text, when one could be computed. */
  readonly queryEmbedding?: readonly number[] | undefined;
  readonly halfLifeDays?: number;
  /** Weight of the lexical component in hybrid mode. */
  readonly lexicalWeight?: number;
}

/**
 * Scores and orders candidates.
 *
 * `mode` decides which signals count. `auto` means "semantic if we have a query
 * embedding and the records carry one, hybrid where both are available,
 * otherwise lexical" — so a deployment with no embedding model degrades to
 * keyword search rather than returning nothing.
 */
export function rankMemories(
  query: MemoryQuery,
  candidates: readonly MemoryRecord[],
  options: RankOptions,
): MemorySearchHit[] {
  const nowMs = Date.parse(options.now);
  const halfLife = options.halfLifeDays ?? DEFAULT_SALIENCE_HALF_LIFE_DAYS;
  const lexicalWeight = options.lexicalWeight ?? 0.4;

  // An exact-reference or key query is answered by filtering, not similarity:
  // the caller asked for a specific thing, and ranking it by prose overlap
  // would be a worse answer than the one they asked for.
  const exactRequested =
    query.mode === "exact" || (query.text === undefined && (query.referenceIds.length > 0 || query.keyPrefix !== undefined));

  if (exactRequested) {
    return candidates
      .map((record) => ({
        record,
        score: round(record.salience * recencyFactor(nowMs - Date.parse(record.createdAt), halfLife), 6),
        matchedBy: "exact" as const,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit);
  }

  const queryTerms = tokenizeWords(query.text ?? "");
  const documents = candidates.map((record) => tokenizeWords(record.searchText));
  const idf = inverseDocumentFrequency(documents);

  const canSemantic = Boolean(options.queryEmbedding?.length);
  const hits: MemorySearchHit[] = [];

  for (const [index, record] of candidates.entries()) {
    const terms = documents[index] ?? [];
    const lexical = lexicalScore(queryTerms, terms, idf);
    const semantic =
      canSemantic && record.embedding?.length
        ? clamp01((cosineSimilarity(options.queryEmbedding!, record.embedding) + 1) / 2)
        : null;

    let relevance: number;
    let matchedBy: MemorySearchHit["matchedBy"];

    if (query.mode === "lexical" || semantic === null) {
      relevance = lexical;
      matchedBy = "lexical";
    } else if (query.mode === "semantic") {
      relevance = semantic;
      matchedBy = "semantic";
    } else {
      relevance = lexicalWeight * lexical + (1 - lexicalWeight) * semantic;
      matchedBy = "hybrid";
    }

    // Relevance dominates; salience and recency break ties among comparably
    // relevant memories rather than overriding what was asked for.
    const recency = recencyFactor(nowMs - Date.parse(record.createdAt), halfLife);
    const score = round(relevance * (0.7 + 0.3 * record.salience * recency), 6);
    hits.push({ record, score, matchedBy });
  }

  return hits
    .filter((hit) => hit.score > 0 || queryTerms.length === 0)
    .sort((a, b) => b.score - a.score || b.record.salience - a.record.salience)
    .slice(0, query.limit);
}
