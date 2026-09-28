import { z } from "zod";
import { idSchema, IsoDateTime, Metadata, UnitInterval } from "./primitives.ts";

export const SOURCE_TYPES = [
  "peer_reviewed_article",
  "preprint",
  "conference_paper",
  "book",
  "technical_report",
  "documentation",
  "dataset",
  "code_repository",
  "web_page",
  "news_article",
  "blog_post",
  "forum_post",
  "social_media",
  "patent",
  "standard",
  "internal_document",
  "user_supplied",
  "unknown",
] as const;
export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

export const SOURCE_STATUSES = ["discovered", "fetching", "fetched", "parsed", "indexed", "failed", "skipped"] as const;
export const SourceStatus = z.enum(SOURCE_STATUSES);
export type SourceStatus = z.infer<typeof SourceStatus>;

/**
 * Source quality as a rubric, not a number.
 *
 * Each dimension is recorded separately with the signal that produced it, so a
 * quality score can always be explained and re-derived. Dimensions come from
 * two places: deterministic signals (source type, presence of a DOI, venue,
 * recency) and an explicit model assessment that is stored as an assessment
 * with provenance — never as an unattributed number.
 */
export const SourceQualityDimensions = z.object({
  /** Venue and publication process: peer review, editorial standards. */
  venue: UnitInterval,
  /** Is the method described well enough to be checked or repeated? */
  methodologyTransparency: UnitInterval,
  /** Does it present primary data, or restate someone else's? */
  primacy: UnitInterval,
  /** Corroboration by other independent sources. */
  corroboration: UnitInterval,
  /** Time decay, relative to how fast the field moves. */
  recency: UnitInterval,
  /** Declared funding, affiliations, or evident agenda. */
  independence: UnitInterval,
  /** Citation footprint or equivalent reputational signal, where available. */
  standing: UnitInterval,
});
export type SourceQualityDimensions = z.infer<typeof SourceQualityDimensions>;

export const SOURCE_QUALITY_DIMENSIONS = [
  "venue",
  "methodologyTransparency",
  "primacy",
  "corroboration",
  "recency",
  "independence",
  "standing",
] as const satisfies readonly (keyof SourceQualityDimensions)[];
export const SourceQualityDimensionName = z.enum(SOURCE_QUALITY_DIMENSIONS);
export type SourceQualityDimensionName = z.infer<typeof SourceQualityDimensionName>;

export const QualitySignal = z.object({
  dimension: SourceQualityDimensionName,
  /** How this dimension's value was arrived at. */
  basis: z.enum(["deterministic_rule", "model_assessment", "external_metric", "user_override"]),
  detail: z.string().max(1000),
  value: UnitInterval,
});
export type QualitySignal = z.infer<typeof QualitySignal>;

export const SourceQuality = z.object({
  dimensions: SourceQualityDimensions,
  /** Weighted aggregate. Recomputed from dimensions; never stored independently. */
  score: UnitInterval,
  signals: z.array(QualitySignal),
  assessedAt: IsoDateTime,
  /** Present when a dimension came from a model; identifies which run. */
  assessedByRunId: z.string().nullable(),
});
export type SourceQuality = z.infer<typeof SourceQuality>;

export const Source = z.object({
  id: idSchema("source"),
  projectId: idSchema("project"),
  url: z.string().max(2000).nullable(),
  doi: z.string().max(200).nullable(),
  title: z.string().min(1).max(1000),
  authors: z.array(z.string().max(300)).default([]),
  publisher: z.string().max(300).nullable(),
  publishedAt: IsoDateTime.nullable(),
  sourceType: SourceType,
  status: SourceStatus,
  /** Registrable domain — the default proxy for independence grouping. */
  domain: z.string().max(253).nullable(),
  /** Hash of normalised content, used to deduplicate across discovery paths. */
  contentHash: z.string().max(64).nullable(),
  /** Key in object storage for the raw artifact, when retained. */
  storageKey: z.string().max(500).nullable(),
  retrievedAt: IsoDateTime.nullable(),
  quality: SourceQuality.nullable(),
  /** Which agent or tool surfaced this source. */
  discoveredBy: z.string().max(200).nullable(),
  failureReason: z.string().max(2000).nullable(),
  metadata: Metadata.default({}),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Source = z.infer<typeof Source>;

/** A parsed source, normalised to text plus structure. */
export const SourceDocument = z.object({
  id: idSchema("document"),
  projectId: idSchema("project"),
  sourceId: idSchema("source"),
  title: z.string().max(1000),
  text: z.string(),
  /** Detected sections, used to build human-meaningful citation locators. */
  sections: z
    .array(z.object({ heading: z.string().max(500), startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative() }))
    .default([]),
  language: z.string().max(16).nullable(),
  tokenCount: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
});
export type SourceDocument = z.infer<typeof SourceDocument>;

/** A retrievable span. Chunks are the unit that evidence quotes point at. */
export const SourceChunk = z.object({
  id: idSchema("chunk"),
  projectId: idSchema("project"),
  sourceId: idSchema("source"),
  documentId: idSchema("document"),
  position: z.number().int().nonnegative(),
  text: z.string(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  /** Human-readable pointer, e.g. "§3.2" or "p. 14". */
  locator: z.string().max(200).nullable(),
  tokenCount: z.number().int().nonnegative(),
  /** Null until the embedding job runs; retrieval falls back to lexical search. */
  embedding: z.array(z.number()).nullable(),
  embeddingModel: z.string().max(200).nullable(),
  createdAt: IsoDateTime,
});
export type SourceChunk = z.infer<typeof SourceChunk>;
