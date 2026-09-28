import { z } from "zod";
import { idSchema, IsoDateTime, Metadata, TenantId, UnitInterval } from "./primitives.ts";

/**
 * Memory contracts — deliberately generic.
 *
 * These describe a memory *substrate*, not research memory specifically. That
 * is the point: ResearchOS ships its own adapter today, but the same interface
 * is intended to be satisfied by a shared MemoryOS later, so that a family of
 * applications can read and write one memory store. Nothing here names
 * ResearchOS concepts that a general memory system could not represent.
 */

export const MEMORY_LAYERS = [
  /** Scoped to one in-flight run; discarded when the run ends. */
  "working",
  /** Everything learned about a specific research project. */
  "project",
  /** Sources, documents, citations, extracted passages. */
  "evidence",
  /** Validated and unvalidated claims. */
  "claim",
  /** Experiment setup, environment, parameters, results. */
  "experiment",
  /** Failed approaches, rejected hypotheses, known limitations. */
  "failure",
  /** Caller preferences. Never mixed with research knowledge. */
  "preference",
] as const;
export const MemoryLayer = z.enum(MEMORY_LAYERS);
export type MemoryLayer = z.infer<typeof MemoryLayer>;

/**
 * Scope controls visibility and lifetime. A `tenant`-scoped memory outlives the
 * project that produced it, which is how a failure recorded in one project can
 * warn a later one.
 */
export const MemoryScope = z.object({
  tenantId: TenantId.nullable(),
  projectId: z.string().max(64).nullable(),
  /** Owning application, when a memory should not leak across products. */
  application: z.string().max(64).nullable(),
  visibility: z.enum(["run", "project", "tenant", "global"]).default("project"),
});
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryRecord = z.object({
  id: idSchema("memory"),
  layer: MemoryLayer,
  scope: MemoryScope,
  /** Short retrieval handle, e.g. "hypothesis:persistent-memory-improves-recall". */
  key: z.string().min(1).max(500),
  /** The memory itself. Structured where possible; text is allowed but discouraged. */
  content: z.unknown(),
  /** Text rendering used for lexical and semantic retrieval. */
  searchText: z.string(),
  embedding: z.array(z.number()).nullable(),
  embeddingModel: z.string().max(200).nullable(),
  /** Decays with age unless reinforced; used to rank retrieval, never to hide data. */
  salience: UnitInterval.default(0.5),
  /** Ids of entities this memory is about, for exact lookups. */
  referenceIds: z.array(z.string().max(64)).default([]),
  tags: z.array(z.string().max(100)).default([]),
  metadata: Metadata.default({}),
  expiresAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastAccessedAt: IsoDateTime.nullable(),
  accessCount: z.number().int().nonnegative().default(0),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;

export const MEMORY_LINK_TYPES = [
  "derived_from",
  "supports",
  "contradicts",
  "supersedes",
  "relates_to",
  "part_of",
] as const;
export const MemoryLinkType = z.enum(MEMORY_LINK_TYPES);
export type MemoryLinkType = z.infer<typeof MemoryLinkType>;

export const MemoryLink = z.object({
  fromMemoryId: z.string().max(64),
  toMemoryId: z.string().max(64),
  type: MemoryLinkType,
  weight: UnitInterval.default(0.5),
  createdAt: IsoDateTime,
});
export type MemoryLink = z.infer<typeof MemoryLink>;

export const MemoryQuery = z.object({
  /** Free text. Triggers semantic search when an embedder is configured, lexical otherwise. */
  text: z.string().max(4000).optional(),
  layers: z.array(MemoryLayer).default([]),
  scope: MemoryScope.partial().optional(),
  tags: z.array(z.string().max(100)).default([]),
  referenceIds: z.array(z.string().max(64)).default([]),
  keyPrefix: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(200).default(20),
  minSalience: UnitInterval.optional(),
  /** Search strategy. `auto` picks semantic when embeddings exist for the layer. */
  mode: z.enum(["auto", "lexical", "semantic", "hybrid", "exact"]).default("auto"),
});
export type MemoryQuery = z.infer<typeof MemoryQuery>;

export const MemorySearchHit = z.object({
  record: MemoryRecord,
  score: z.number(),
  /** Which retrieval path matched, so ranking behaviour is inspectable. */
  matchedBy: z.enum(["lexical", "semantic", "exact", "hybrid"]),
});
export type MemorySearchHit = z.infer<typeof MemorySearchHit>;

/** Fields a caller may change on an existing memory. Identity and layer are immutable. */
export const MemoryUpdate = z.object({
  content: z.unknown().optional(),
  searchText: z.string().optional(),
  salience: UnitInterval.optional(),
  tags: z.array(z.string().max(100)).optional(),
  metadata: Metadata.optional(),
  expiresAt: IsoDateTime.nullable().optional(),
  referenceIds: z.array(z.string().max(64)).optional(),
});
export type MemoryUpdate = z.infer<typeof MemoryUpdate>;
