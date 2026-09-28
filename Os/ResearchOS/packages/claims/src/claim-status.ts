/**
 * Deriving a claim's status from its evidence.
 *
 * Status is a function of the confidence breakdown, not a separate judgement.
 * Keeping it derived means status and confidence can never disagree — a claim
 * cannot be marked `supported` while its number says 0.3.
 */
import type { ClaimStatus, ConfidenceBreakdown } from "@research-os/contracts";

export const STATUS_THRESHOLDS = {
  /** At or above this, with no serious opposition, a claim is supported. */
  supported: 0.7,
  /** At or below this, the evidence points the other way. */
  refuted: 0.3,
  /**
   * Minimum effective (independence-discounted) evidence weight before any
   * verdict beyond "insufficient" is available.
   *
   * Set above 1 on purpose: a single source, however excellent, cannot settle a
   * research question. Reaching this floor requires corroboration from at least
   * one genuinely independent second source.
   */
  minEffectiveEvidence: 1.5,
  /**
   * Fraction of total effective weight on the minority side that makes a claim
   * contested rather than settled. A fifth of the evidence disagreeing is not
   * noise.
   */
  contestedMinorityShare: 0.2,
} as const;

export function deriveClaimStatus(breakdown: ConfidenceBreakdown | null): ClaimStatus {
  if (!breakdown) return "proposed";

  const support = breakdown.effectiveSupportingCount;
  const contradiction = breakdown.effectiveContradictingCount;
  const total = support + contradiction;

  if (total < STATUS_THRESHOLDS.minEffectiveEvidence && breakdown.replications === 0 && breakdown.failedReplications === 0) {
    return "insufficient_evidence";
  }

  const minorityShare = total > 0 ? Math.min(support, contradiction) / total : 0;
  if (minorityShare >= STATUS_THRESHOLDS.contestedMinorityShare) return "contested";

  if (breakdown.score >= STATUS_THRESHOLDS.supported) return "supported";
  if (breakdown.score <= STATUS_THRESHOLDS.refuted) return "refuted";
  return "under_review";
}

/**
 * Human-readable reason for the status. Shown alongside the status everywhere
 * it appears, so a reader never has to guess why a claim landed where it did.
 */
export function explainClaimStatus(status: ClaimStatus, breakdown: ConfidenceBreakdown | null): string {
  if (!breakdown) return "No evidence has been linked to this claim yet.";
  const support = breakdown.effectiveSupportingCount.toFixed(2);
  const contradiction = breakdown.effectiveContradictingCount.toFixed(2);

  switch (status) {
    case "supported":
      return `Confidence ${breakdown.score.toFixed(2)} from ${support} effective supporting evidence against ${contradiction} contradicting, across ${breakdown.distinctSources} distinct source(s).`;
    case "refuted":
      return `Confidence ${breakdown.score.toFixed(2)}: contradicting evidence (${contradiction} effective) outweighs support (${support}).`;
    case "contested":
      return `Evidence is genuinely split — ${support} effective supporting against ${contradiction} contradicting. Recorded as contested rather than averaged.`;
    case "insufficient_evidence":
      return `Not enough independent evidence to judge: ${breakdown.distinctSources} distinct source(s), ${breakdown.effectiveSupportingCount.toFixed(2)} effective supporting weight.`;
    case "under_review":
      return `Confidence ${breakdown.score.toFixed(2)} sits between the supported and refuted thresholds; more evidence would move it.`;
    case "proposed":
      return "Proposed but not yet evaluated.";
    case "retracted":
      return "Withdrawn after review.";
  }
}
