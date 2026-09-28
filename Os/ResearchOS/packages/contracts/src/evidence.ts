import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, UnitInterval } from "./primitives.ts";

/** How a piece of evidence bears on a claim. `mixed` is a real, preserved outcome. */
export const EVIDENCE_STANCES = ["supports", "contradicts", "neutral", "mixed"] as const;
export const EvidenceStance = z.enum(EVIDENCE_STANCES);
export type EvidenceStance = z.infer<typeof EvidenceStance>;

/**
 * The inputs to an evidence item's weight. Each is independently assessable and
 * independently auditable; the aggregate weight is a pure function of them.
 */
export const EvidenceStrength = z.object({
  /** Does the passage address the claim itself, or something adjacent? */
  directness: UnitInterval,
  /** How specific is the finding — a measured effect, or a passing remark? */
  specificity: UnitInterval,
  /** Study design / sample strength where applicable. */
  methodologicalRigor: UnitInterval,
  /** Does the cited passage actually say what the extraction claims? */
  quoteFidelity: UnitInterval,
});
export type EvidenceStrength = z.infer<typeof EvidenceStrength>;

export const Evidence = z.object({
  id: idSchema("evidence"),
  projectId: idSchema("project"),
  sourceId: idSchema("source"),
  chunkIds: z.array(idRefSchema("chunk")).default([]),
  /** Verbatim passage. Verification re-checks this against the chunk text. */
  quote: z.string().min(1).max(8000),
  locator: z.string().max(200).nullable(),
  /** The agent's reading of what the quote establishes. */
  interpretation: z.string().max(4000),
  stance: EvidenceStance,
  strength: EvidenceStrength,
  /** Relevance to the question that prompted extraction. */
  relevance: UnitInterval,
  /** Agent run that produced this. Every evidence item is attributable. */
  extractedByRunId: idRefSchema("agentRun").nullable(),
  /** Set by the verification agent once the quote has been checked. */
  verifiedAt: IsoDateTime.nullable(),
  verificationPassed: z.boolean().nullable(),
  createdAt: IsoDateTime,
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * Evidence items that are not statistically independent — same authors, same
 * underlying dataset, one restating another. Recorded explicitly so the
 * confidence calculation can discount them instead of double-counting.
 */
export const INDEPENDENCE_RELATIONS = ["same_source", "same_authors", "same_dataset", "derived_from", "same_publisher"] as const;
export const IndependenceRelation = z.enum(INDEPENDENCE_RELATIONS);
export type IndependenceRelation = z.infer<typeof IndependenceRelation>;

export const EvidenceCorrelation = z.object({
  evidenceIdA: idRefSchema("evidence"),
  evidenceIdB: idRefSchema("evidence"),
  relation: IndependenceRelation,
  /** 0 = fully independent, 1 = fully redundant. */
  correlation: UnitInterval,
  detail: z.string().max(1000).optional(),
});
export type EvidenceCorrelation = z.infer<typeof EvidenceCorrelation>;
