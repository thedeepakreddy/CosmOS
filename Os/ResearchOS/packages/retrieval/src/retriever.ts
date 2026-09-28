/**
 * Finding the passages that bear on a question.
 *
 * Hybrid by default: BM25 catches exact terminology — a chemical name, a metric,
 * an author — that embeddings blur, and embeddings catch paraphrase that BM25
 * misses entirely. Research queries need both, and the two are combined by rank
 * fusion rather than by blending scores, because a BM25 score and a cosine
 * similarity are not measured in the same units.
 *
 * With no embedding provider configured, this degrades to lexical-only and says
 * so in the result. Silently returning worse answers is how a system gets
 * trusted for something it is not doing.
 */
import type { SourceChunk } from "@research-os/contracts";
import type { ResearchRepository } from "@research-os/persistence";
import type { ModelRouter } from "@research-os/model-router";
import { clamp01, cosineSimilarity, round } from "@research-os/shared";
import { bm25Search, buildBm25Index, reciprocalRankFusion, type Bm25Index } from "./bm25.ts";

export type RetrievalStrategy = "lexical" | "semantic" | "hybrid";

export interface RetrievalHit {
  readonly chunk: SourceChunk;
  readonly score: number;
  readonly strategy: RetrievalStrategy;
  /** Which query terms the chunk actually contained. Explains a lexical hit. */
  readonly matchedTerms: string[];
  readonly lexicalRank: number | null;
  readonly semanticRank: number | null;
}

export interface RetrievalResult {
  readonly hits: RetrievalHit[];
  /** What actually ran, which may be narrower than what was asked for. */
  readonly strategy: RetrievalStrategy;
  /** Set when the requested strategy could not be used. */
  readonly degradedReason: string | null;
  readonly candidatesConsidered: number;
}

export interface RetrieveOptions {
  readonly projectId: string;
  readonly query: string;
  readonly limit?: number;
  readonly strategy?: RetrievalStrategy;
  /** Restrict to specific sources, for "find more in this paper". */
  readonly sourceIds?: readonly string[];
  readonly maxCandidates?: number;
  readonly signal?: AbortSignal;
}

export interface ChunkRetrieverOptions {
  readonly repository: ResearchRepository;
  /** Absent means lexical-only retrieval, which is a supported configuration. */
  readonly router?: ModelRouter;
  readonly embeddingModel?: string;
  readonly maxCandidates?: number;
}

export class ChunkRetriever {
  readonly #repository: ResearchRepository;
  readonly #router: ModelRouter | undefined;
  readonly #embeddingModel: string | undefined;
  readonly #maxCandidates: number;
  /** Cached per project, rebuilt when the chunk count changes. */
  readonly #indexes = new Map<string, { index: Bm25Index; chunkCount: number }>();

  constructor(options: ChunkRetrieverOptions) {
    this.#repository = options.repository;
    this.#router = options.router;
    this.#embeddingModel = options.embeddingModel;
    this.#maxCandidates = options.maxCandidates ?? 5000;
  }

  /** Drops the cached index, after ingesting new chunks. */
  invalidate(projectId: string): void {
    this.#indexes.delete(projectId);
  }

  async retrieve(options: RetrieveOptions): Promise<RetrievalResult> {
    const limit = options.limit ?? 20;
    const requested = options.strategy ?? "hybrid";

    const allChunks = await this.#repository.listProjectChunks(options.projectId, options.maxCandidates ?? this.#maxCandidates);
    const chunks = options.sourceIds?.length
      ? allChunks.filter((chunk) => options.sourceIds!.includes(chunk.sourceId))
      : allChunks;

    if (chunks.length === 0) {
      return { hits: [], strategy: requested, degradedReason: null, candidatesConsidered: 0 };
    }

    const byId = new Map(chunks.map((chunk) => [chunk.id as string, chunk]));

    const lexicalHits = requested === "semantic"
      ? []
      : bm25Search(this.#indexFor(options.projectId, chunks), options.query, { limit: Math.max(limit * 5, 50) });

    let semanticHits: { id: string; score: number }[] = [];
    let degradedReason: string | null = null;

    if (requested !== "lexical") {
      const embedded = chunks.filter((chunk) => chunk.embedding?.length);
      if (!this.#router) {
        degradedReason = "No model router is configured, so retrieval is lexical only.";
      } else if (embedded.length === 0) {
        degradedReason = "No chunk in this project has an embedding yet, so retrieval is lexical only.";
      } else {
        const queryVector = await this.#embedQuery(options.query, options.signal);
        if (!queryVector) {
          degradedReason = "The embedding provider was unavailable, so retrieval fell back to lexical.";
        } else {
          semanticHits = embedded
            .map((chunk) => ({
              id: chunk.id as string,
              // Cosine is in [-1,1]; mapped to [0,1] so a score is comparable
              // across calls even though fusion only uses the ordering.
              score: clamp01((cosineSimilarity(queryVector, chunk.embedding!) + 1) / 2),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.max(limit * 5, 50));
        }
      }
    }

    const strategy: RetrievalStrategy =
      requested === "lexical" || semanticHits.length === 0
        ? "lexical"
        : lexicalHits.length === 0
          ? "semantic"
          : "hybrid";

    const lexicalRanks = new Map(lexicalHits.map((hit, index) => [hit.id, index]));
    const semanticRanks = new Map(semanticHits.map((hit, index) => [hit.id, index]));
    const matchedTerms = new Map(lexicalHits.map((hit) => [hit.id, hit.matchedTerms]));

    const fused =
      strategy === "hybrid"
        ? reciprocalRankFusion([lexicalHits.map((hit) => hit.id), semanticHits.map((hit) => hit.id)], { limit })
        : strategy === "lexical"
          ? lexicalHits.slice(0, limit).map((hit) => ({ id: hit.id, score: hit.score }))
          : semanticHits.slice(0, limit).map((hit) => ({ id: hit.id, score: hit.score }));

    const hits: RetrievalHit[] = [];
    for (const entry of fused) {
      const chunk = byId.get(entry.id);
      if (!chunk) continue;
      hits.push({
        chunk,
        score: round(entry.score, 6),
        strategy,
        matchedTerms: matchedTerms.get(entry.id) ?? [],
        lexicalRank: lexicalRanks.get(entry.id) ?? null,
        semanticRank: semanticRanks.get(entry.id) ?? null,
      });
    }

    return { hits, strategy, degradedReason, candidatesConsidered: chunks.length };
  }

  #indexFor(projectId: string, chunks: readonly SourceChunk[]): Bm25Index {
    const cached = this.#indexes.get(projectId);
    if (cached && cached.chunkCount === chunks.length) return cached.index;
    const index = buildBm25Index(chunks.map((chunk) => ({ id: chunk.id as string, text: chunk.text })));
    this.#indexes.set(projectId, { index, chunkCount: chunks.length });
    return index;
  }

  async #embedQuery(query: string, signal?: AbortSignal): Promise<number[] | null> {
    if (!this.#router) return null;
    try {
      const response = await this.#router.embed([query], {
        ...(this.#embeddingModel ? { model: this.#embeddingModel } : {}),
        ...(signal ? { signal } : {}),
      });
      return response.vectors[0] ?? null;
    } catch {
      // A retrieval that returns lexical results beats one that throws.
      return null;
    }
  }
}
