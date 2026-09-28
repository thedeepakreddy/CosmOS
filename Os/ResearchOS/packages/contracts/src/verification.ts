import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, UnitInterval } from "./primitives.ts";

/**
 * Verification.
 *
 * Checks are deliberately narrow and mostly mechanical — does this quote appear
 * in the source it cites, does this arithmetic hold, do these two claims
 * conflict. Narrow checks can be trusted; a general "is this correct?" check
 * cannot.
 */

export const VERIFICATION_CHECK_TYPES = [
  /** Does the quoted text actually appear in the cited chunk? */
  "citation_fidelity",
  /** Does the cited source exist and resolve? */
  "citation_resolvable",
  /** Do numbers stated in a claim match the evidence they cite? */
  "numeric_consistency",
  /** Does arithmetic in an analysis check out? */
  "arithmetic",
  /** Do any two accepted claims contradict each other? */
  "internal_consistency",
  /** Is the claim's scope supported by the evidence's scope? */
  "scope_support",
  /** Does an experiment's recorded environment permit a re-run? */
  "reproducibility",
  /** Is the claim traceable to at least one evidence item? */
  "evidence_traceability",
] as const;
export const VerificationCheckType = z.enum(VERIFICATION_CHECK_TYPES);
export type VerificationCheckType = z.infer<typeof VerificationCheckType>;

export const VERIFICATION_OUTCOMES = ["passed", "failed", "inconclusive", "not_applicable"] as const;
export const VerificationOutcome = z.enum(VERIFICATION_OUTCOMES);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

export const VerificationCheck = z.object({
  id: idSchema("verification"),
  projectId: idSchema("project"),
  checkType: VerificationCheckType,
  targetType: z.enum(["claim", "evidence", "experiment", "report", "analysis"]),
  targetId: z.string().max(64),
  outcome: VerificationOutcome,
  /** What was compared, and what was found. Mechanical checks state both sides. */
  detail: z.string().max(4000),
  /** How much this check's result should move confidence, in [0,1]. */
  weight: UnitInterval.default(1),
  /** Provider used, when the check needed a model. Recorded to prove independence. */
  verifierProvider: z.string().max(100).nullable(),
  verifiedByRunId: idRefSchema("agentRun").nullable(),
  createdAt: IsoDateTime,
});
export type VerificationCheck = z.infer<typeof VerificationCheck>;

export const VerificationSummary = z.object({
  targetType: z.string().max(50),
  targetId: z.string().max(64),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  passRate: UnitInterval.nullable(),
  failedCheckTypes: z.array(VerificationCheckType).default([]),
});
export type VerificationSummary = z.infer<typeof VerificationSummary>;
