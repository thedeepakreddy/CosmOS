/**
 * Backfilling chunk embeddings.
 *
 * Embedding is a separate pass from ingestion on purpose. Ingestion must work
 * with no model configured at all, and embedding is the expensive, failure-prone
 * half — so a source is stored and searchable lexically the moment it is
 * fetched, and gains semantic retrieval whenever the embedding job catches up.
 *
 * Partial progress is kept. A batch that fails halfway leaves the chunks it did
 * embed embedded, so a retry costs only what is left rather than starting over.
 */
import type { ResearchRepository } from "@research-os/persistence";
import type { ModelRouter } from "@research-os/model-router";
import type { Logger } from "@research-os/observability";

export interface EmbedChunksOptions {
  readonly repository: ResearchRepository;
  readonly router: ModelRouter;
  readonly model?: string;
  readonly batchSize?: number;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

export interface EmbedChunksResult {
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
  /** Set when embedding is unavailable entirely, rather than failing per batch. */
  readonly unavailableReason: string | null;
}

export async function embedProjectChunks(projectId: string, options: EmbedChunksOptions): Promise<EmbedChunksResult> {
  const batchSize = options.batchSize ?? 32;
  const chunks = await options.repository.listProjectChunks(projectId);
  const pending = chunks.filter((chunk) => !chunk.embedding?.length);

  if (pending.length === 0) {
    return { embedded: 0, skipped: chunks.length, failed: 0, unavailableReason: null };
  }

  let embedded = 0;
  let failed = 0;

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    options.signal?.throwIfAborted();
    const batch = pending.slice(offset, offset + batchSize);

    try {
      const response = await options.router.embed(
        batch.map((chunk) => chunk.text),
        { ...(options.model ? { model: options.model } : {}), ...(options.signal ? { signal: options.signal } : {}) },
      );

      for (const [index, chunk] of batch.entries()) {
        const vector = response.vectors[index];
        if (!vector) { failed++; continue; }
        await options.repository.setChunkEmbedding(chunk.id, vector, response.model);
        embedded++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // No embedding provider at all is a different fact from a batch that
      // failed, and the caller needs to tell them apart: one is a configuration
      // state, the other is worth retrying.
      if (/No registered provider offers embeddings/.test(message)) {
        return { embedded, skipped: chunks.length - pending.length, failed, unavailableReason: message };
      }
      failed += batch.length;
      options.logger?.warn("Chunk embedding batch failed", { projectId, batchSize: batch.length, error: message });
    }
  }

  return { embedded, skipped: chunks.length - pending.length, failed, unavailableReason: null };
}
