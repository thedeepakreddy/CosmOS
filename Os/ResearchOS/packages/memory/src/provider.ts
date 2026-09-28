/**
 * The MemoryProvider port.
 *
 * Deliberately generic. ResearchOS ships a SQL adapter today, but the whole
 * reason this is a port rather than a class is that a shared memory service is
 * intended to satisfy it later — so nothing here names a research concept that
 * a general memory system could not represent. Layers, scopes, keys and links;
 * no claims, no evidence, no sources.
 *
 * One thing this port does *not* own: failure memory. Failed approaches are
 * already a first-class table with its own repository and its own cross-project
 * query, and reimplementing them here would create two answers to "what have we
 * already tried?". Memory may index them; it is not their system of record.
 */
import type {
  MemoryLayer, MemoryLink, MemoryQuery, MemoryRecord, MemoryScope, MemorySearchHit, MemoryUpdate,
} from "@research-os/contracts";

export interface StoreMemoryInput {
  readonly layer: MemoryLayer;
  readonly scope: MemoryScope;
  readonly key: string;
  readonly content: unknown;
  /** Text used for retrieval. Derived from content when omitted. */
  readonly searchText?: string;
  readonly salience?: number;
  readonly referenceIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: string | null;
}

export interface MemoryProvider {
  readonly name: string;
  /** Upserts by key within scope: re-remembering something updates it rather than duplicating. */
  store(input: StoreMemoryInput): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  getByKey(key: string, projectId: string | null): Promise<MemoryRecord | undefined>;
  search(query: MemoryQuery): Promise<MemorySearchHit[]>;
  update(id: string, patch: MemoryUpdate): Promise<MemoryRecord | undefined>;
  forget(id: string): Promise<void>;
  link(link: MemoryLink): Promise<void>;
  linksFrom(memoryId: string): Promise<MemoryLink[]>;
  /** Removes expired records. Returns how many. */
  purgeExpired(): Promise<number>;
}

/**
 * The embedding capability memory needs, declared structurally.
 *
 * `memory` is layer 4 and `model-router` is layer 3, so importing the router
 * would be legal — but it would also make an embedding provider a hard
 * requirement of remembering anything. Declaring the one method here keeps
 * memory usable with no model configured at all, falling back to lexical search.
 */
export interface Embedder {
  readonly model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}
