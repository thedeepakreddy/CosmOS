import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, UnitInterval } from "./primitives.ts";
import { EvidenceStance } from "./evidence.ts";

export const CLAIM_TYPES = [
  "empirical",
  "causal",
  "correlational",
  "definitional",
  "methodological",
  "normative",
  "predictive",
] as const;
export const ClaimType = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof ClaimType>;

export const CLAIM_STATUSES = [
  "proposed",
  "under_review",
  "supported",
  "contested",
  "refuted",
  "insufficient_evidence",
  "retracted",
] as const;
export const ClaimStatus = z.enum(CLAIM_STATUSES);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const CLAIM_RELATIONS = [
  "supports",
  "contradicts",
  "refines",
  "generalizes",
  "duplicates",
  "depends_on",
  "explains",
] as const;
export const ClaimRelationType = z.enum(CLAIM_RELATIONS);
export type ClaimRelationType = z.infer<typeof ClaimRelationType>;

/**
 * One evidence item's contribution to a claim's confidence.
 *
 * This is the audit record for the confidence calculation: every factor that
 * went into `logOddsDelta` is stored alongside it, so any score can be
 * recomputed by hand and any disagreement can be traced to a specific factor.
 */
export const ConfidenceContribution = z.object({
  evidenceId: idRefSchema("evidence"),
  sourceId: idRefSchema("source"),
  stance: EvidenceStance,
  factors: z.object({
    sourceQuality: UnitInterval,
    relevance: UnitInterval,
    directness: UnitInterval,
    specificity: UnitInterval,
    methodologicalRigor: UnitInterval,
    quoteFidelity: UnitInterval,
    /** 1 = counted in full, 0 = fully redundant with evidence already counted. */
    independenceWeight: UnitInterval,
  }),
  /** Weighted geometric mean of the factors, times the independence discount. */
  weight: UnitInterval,
  /**
   * Signed pseudo-count this item contributes to the posterior: positive adds to
   * alpha, negative to beta. Magnitude equals `weight`.
   */
  pseudoCount: z.number(),
});
export type ConfidenceContribution = z.infer<typeof ConfidenceContribution>;

/**
 * A fully transparent confidence value: `weighted-beta-v1`.
 *
 * Confidence is the mean of a Beta posterior whose pseudo-counts are the
 * independence-discounted weights of the evidence. Every input is stored
 * alongside the result, so any score can be recomputed by hand.
 *
 * No language model ever emits a confidence number. Models assess narrow,
 * checkable properties — is this quote faithful, does this passage address the
 * claim, how rigorous is the design. Those become weights. The score is
 * arithmetic over them.
 */
export const ConfidenceBreakdown = z.object({
  method: z.literal("weighted-beta-v1"),

  /** Prior pseudo-counts before any evidence. Uniform (1, 1) unless overridden. */
  priorAlpha: z.number().positive(),
  priorBeta: z.number().positive(),

  /** Total independence-discounted weight on each side, excluding the prior. */
  supportWeight: z.number().nonnegative(),
  contradictionWeight: z.number().nonnegative(),

  /** Prior plus evidence. The posterior the score and interval are read from. */
  posteriorAlpha: z.number().positive(),
  posteriorBeta: z.number().positive(),

  /** Posterior mean: alpha / (alpha + beta). Strictly inside (0, 1). */
  score: UnitInterval,

  contributions: z.array(ConfidenceContribution),

  supportingCount: z.number().int().nonnegative(),
  contradictingCount: z.number().int().nonnegative(),
  /** Counts after independence discounting — the number that actually matters. */
  effectiveSupportingCount: z.number().nonnegative(),
  effectiveContradictingCount: z.number().nonnegative(),
  distinctSources: z.number().int().nonnegative(),
  distinctDomains: z.number().int().nonnegative(),

  replications: z.number().int().nonnegative(),
  failedReplications: z.number().int().nonnegative(),

  /** Fraction of verification checks that passed. Null when nothing was verified. */
  verificationPassRate: UnitInterval.nullable(),
  /** Judge-assessed agreement across debating agents. Null when no debate ran. */
  agentAgreement: UnitInterval.nullable(),

  /**
   * 95% credible interval of the Beta posterior, widened for agent
   * disagreement. A genuine interval, not a heuristic band.
   */
  uncertaintyInterval: z.tuple([UnitInterval, UnitInterval]),
  /**
   * Named, human-readable sources of uncertainty, recorded by the critic or
   * verification agents. Never invented at report time.
   */
  majorUncertainties: z.array(z.string().max(500)).default([]),

  computedAt: IsoDateTime,
});
export type ConfidenceBreakdown = z.infer<typeof ConfidenceBreakdown>;

export const Claim = z.object({
  id: idSchema("claim"),
  projectId: idSchema("project"),
  questionId: idSchema("question").nullable(),
  hypothesisId: idSchema("hypothesis").nullable(),

  /** The assertion itself: one proposition, independently checkable. */
  statement: z.string().min(1).max(2000),
  /** Conditions under which the claim is asserted to hold. */
  scope: z.string().max(1000).nullable(),
  claimType: ClaimType,
  status: ClaimStatus,

  /** Premises the claim rests on that are not themselves evidenced here. */
  assumptions: z.array(z.string().max(500)).default([]),

  confidence: ConfidenceBreakdown.nullable(),

  /** Agent run that proposed this claim. */
  proposedByRunId: idRefSchema("agentRun").nullable(),
  supersededByClaimId: idRefSchema("claim").nullable(),

  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Claim = z.infer<typeof Claim>;

/** Links a claim to an evidence item, with the stance that link carries. */
export const ClaimEvidenceLink = z.object({
  claimId: idRefSchema("claim"),
  evidenceId: idRefSchema("evidence"),
  stance: EvidenceStance,
  /** Why this evidence bears on this claim. */
  rationale: z.string().max(2000).optional(),
  linkedByRunId: idRefSchema("agentRun").nullable(),
  createdAt: IsoDateTime,
});
export type ClaimEvidenceLink = z.infer<typeof ClaimEvidenceLink>;

export const ClaimRelation = z.object({
  fromClaimId: idRefSchema("claim"),
  toClaimId: idRefSchema("claim"),
  relation: ClaimRelationType,
  rationale: z.string().max(2000).optional(),
  strength: UnitInterval.default(0.5),
  createdByRunId: idRefSchema("agentRun").nullable(),
  createdAt: IsoDateTime,
});
export type ClaimRelation = z.infer<typeof ClaimRelation>;

export const CONTRADICTION_STATUSES = ["open", "investigating", "resolved", "irreconcilable", "false_positive"] as const;
export const ContradictionStatus = z.enum(CONTRADICTION_STATUSES);
export type ContradictionStatus = z.infer<typeof ContradictionStatus>;

export const CONTRADICTION_KINDS = [
  "direct_negation",
  "incompatible_magnitude",
  "incompatible_direction",
  "scope_mismatch",
  "methodological_disagreement",
  "temporal_change",
] as const;
export const ContradictionKind = z.enum(CONTRADICTION_KINDS);
export type ContradictionKind = z.infer<typeof ContradictionKind>;

/**
 * A recorded disagreement. ResearchOS preserves these as first-class objects:
 * a contradiction is a finding, not an error to be averaged away. Resolution
 * requires an explicit explanation and is itself attributable.
 */
export const Contradiction = z.object({
  id: idSchema("contradiction"),
  projectId: idSchema("project"),
  claimIdA: idRefSchema("claim"),
  claimIdB: idRefSchema("claim"),
  kind: ContradictionKind,
  status: ContradictionStatus,
  description: z.string().max(4000),
  /** How severely this undermines downstream conclusions. */
  severity: UnitInterval,
  /** Candidate explanations, retained even after one is selected. */
  candidateExplanations: z.array(z.string().max(2000)).default([]),
  resolution: z.string().max(4000).nullable(),
  resolvedByRunId: idRefSchema("agentRun").nullable(),
  detectedByRunId: idRefSchema("agentRun").nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Contradiction = z.infer<typeof Contradiction>;
