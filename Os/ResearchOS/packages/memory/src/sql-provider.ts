/**
 * MemoryProvider over the SQL memory repository.
 *
 * Two responsibilities the repository deliberately left here: computing the
 * embedding (which needs a model the persistence layer must not know about),
 * and ranking (which must behave identically on both engines). Everything else
 * is delegation.
 *
 * Storing is an upsert on `(key, projectId)`. Re-remembering something updates
 * it rather than appending a near-duplicate — a memory store that accumulates
 * five slightly different versions of the same fact is worse than one that
 * keeps the latest, because retrieval then has to arbitrate between them.
 */
import type {
  MemoryLink, MemoryQuery, MemoryRecord, MemorySearchHit, MemoryUpdate,
} from "@research-os/contracts";
import { MemoryQuery as MemoryQuerySchema } from "@research-os/contracts";
import type { MemoryRepository } from "@research-os/persistence";
import { newId, systemClock, truncate, type Clock } from "@research-os/shared";
import type { Embedder, MemoryProvider, StoreMemoryInput } from "./provider.ts";
import { rankMemories } from "./rank.ts";

export interface SqlMemoryProviderOptions {
  readonly repository: MemoryRepository;
  readonly clock?: Clock;
  /** Absent means lexical retrieval only, which is a supported configuration. */
  readonly embedder?: Embedder;
  /** How many rows to pull before ranking. Wider than the limit, so ranking has choices. */
  readonly candidateMultiplier?: number;
  readonly maxCandidates?: number;
}

export class SqlMemoryProvider implements MemoryProvider {
  readonly name = "sql";
  readonly #repository: MemoryRepository;
  readonly #clock: Clock;
  readonly #embedder: Embedder | undefined;
  readonly #candidateMultiplier: number;
  readonly #maxCandidates: number;

  constructor(options: SqlMemoryProviderOptions) {
    this.#repository = options.repository;
    this.#clock = options.clock ?? systemClock;
    this.#embedder = options.embedder;
    this.#candidateMultiplier = options.candidateMultiplier ?? 8;
    this.#maxCandidates = options.maxCandidates ?? 500;
  }

  async store(input: StoreMemoryInput): Promise<MemoryRecord> {
    const now = this.#clock.isoNow();
    const searchText = input.searchText ?? renderSearchText(input.content);
    const existing = await this.#repository.findByKey(input.key, input.scope.projectId);

    const embedding = await this.#embed(searchText);

    const record: MemoryRecord = {
      id: existing?.id ?? newId("memory"),
      layer: input.layer,
      scope: input.scope,
      key: input.key,
      content: input.content,
      searchText,
      embedding,
      embeddingModel: embedding ? (this.#embedder?.model ?? null) : null,
      salience: input.salience ?? existing?.salience ?? 0.5,
      referenceIds: [...(input.referenceIds ?? [])],
      tags: [...(input.tags ?? [])],
      metadata: input.metadata ?? {},
      expiresAt: input.expiresAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastAccessedAt: existing?.lastAccessedAt ?? null,
      accessCount: existing?.accessCount ?? 0,
    } as MemoryRecord;

    await this.#repository.store(record);
    return record;
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const record = await this.#repository.findById(id);
    if (record) await this.#repository.touch(id, this.#clock.isoNow());
    return record;
  }

  async getByKey(key: string, projectId: string | null): Promise<MemoryRecord | undefined> {
    return this.#repository.findByKey(key, projectId);
  }

  async search(query: MemoryQuery): Promise<MemorySearchHit[]> {
    const parsed = MemoryQuerySchema.parse(query);
    const now = this.#clock.isoNow();

    const candidates = await this.#repository.candidates(
      parsed,
      now,
      Math.min(this.#maxCandidates, parsed.limit * this.#candidateMultiplier),
    );
    if (candidates.length === 0) return [];

    // Only embed the query when semantic ranking could actually be used. An
    // embedding call for a lexical search is a model call bought for nothing.
    const wantsSemantic = parsed.mode !== "lexical" && parsed.mode !== "exact";
    const queryEmbedding =
      wantsSemantic && parsed.text ? ((await this.#embed(parsed.text)) ?? undefined) : undefined;

    const hits = rankMemories(parsed, candidates, { now, queryEmbedding: queryEmbedding ?? undefined });

    // Recording a read is what lets salience reflect use rather than only age.
    // Failing to record it must never fail the read.
    await Promise.allSettled(hits.map(async (hit) => this.#repository.touch(hit.record.id, now)));
    return hits;
  }

  async update(id: string, patch: MemoryUpdate): Promise<MemoryRecord | undefined> {
    const now = this.#clock.isoNow();
    const fields: Record<string, unknown> = { ...patch };

    // A changed searchText invalidates the stored embedding, so it is recomputed
    // rather than left describing text that is no longer there.
    if (patch.searchText !== undefined) {
      const embedding = await this.#embed(patch.searchText);
      if (embedding) {
        fields["embedding"] = embedding;
        fields["embeddingModel"] = this.#embedder?.model ?? null;
      }
    }

    await this.#repository.update(id, fields, now);
    return this.#repository.findById(id);
  }

  async forget(id: string): Promise<void> {
    await this.#repository.delete(id);
  }

  async link(link: MemoryLink): Promise<void> {
    await this.#repository.link(link);
  }

  async linksFrom(memoryId: string): Promise<MemoryLink[]> {
    return this.#repository.linksFrom(memoryId);
  }

  async purgeExpired(): Promise<number> {
    return this.#repository.purgeExpired(this.#clock.isoNow());
  }

  /** Returns null when no embedder is configured, or when embedding fails. */
  async #embed(text: string): Promise<number[] | null> {
    if (!this.#embedder || !text.trim()) return null;
    try {
      const [vector] = await this.#embedder.embed([text]);
      return vector ?? null;
    } catch {
      // An embedding failure degrades retrieval to lexical. It must not stop a
      // memory being written — losing the memory is the worse outcome.
      return null;
    }
  }
}

/** Renders arbitrary content into the text retrieval matches against. */
export function renderSearchText(content: unknown): string {
  if (typeof content === "string") return truncate(content, 8000);
  if (content === null || content === undefined) return "";
  if (typeof content !== "object") return String(content);

  const parts: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || parts.length > 200) return;
    if (typeof value === "string") parts.push(value);
    else if (typeof value === "number" || typeof value === "boolean") parts.push(String(value));
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        parts.push(key);
        walk(nested, depth + 1);
      }
    }
  };
  walk(content, 0);
  return truncate(parts.join(" "), 8000);
}
