/**
 * Claim confidence: `weighted-beta-v1`.
 *
 * The rule this module exists to enforce is that no language model ever emits a
 * confidence number. Models assess narrow, checkable properties — is this quote
 * faithful, does this passage address the claim, how rigorous is the design.
 * Those assessments become weights. The confidence value is arithmetic over
 * them, computed here, and shipped with every input that produced it.
 *
 * ## Why a Beta posterior
 *
 * Each independence-discounted evidence item is a fractional pseudo-observation:
 * supporting evidence adds to alpha, contradicting to beta. Confidence is the
 * posterior mean, and the uncertainty interval is a real credible interval from
 * the same posterior.
 *
 * This shape was chosen after an accumulate-log-odds model failed on two
 * properties that matter more than elegance:
 *
 *   - **Ratio sensitivity.** Summed log-odds saturate, so 17-for/5-against
 *     scored the same as 17-for/0-against. A Beta posterior reads the balance,
 *     so dissent always registers.
 *   - **Penalties that cannot be swamped.** Under saturation, a failed
 *     replication against a large pile of support changed nothing. Here every
 *     contrary observation raises beta and therefore always lowers the score.
 *
 * Three further properties fall out for free:
 *
 *   - Confidence is strictly inside (0,1). Research does not produce certainty,
 *     and a system that reports it is lying about what it knows.
 *   - Thin evidence stays near the prior, because the prior pseudo-counts
 *     dominate until real evidence accumulates.
 *   - Diminishing returns are automatic: the twentieth corroborating source
 *     moves the number far less than the second.
 *
 * ## Known limitation
 *
 * The posterior reads the evidence that was *found*. Absence of contradicting
 * evidence is not evidence of absence, so a shallow search that turned up only
 * agreement will score high. That hazard is addressed outside this function —
 * the skeptic agent is tasked with actively seeking disconfirming evidence, and
 * a claim with no contradicting evidence and no critique carries an explicit
 * uncertainty note. It is a real limitation and is documented as one rather
 * than hidden behind a fudge factor.
 */
import type {
  ConfidenceBreakdown,
  ConfidenceContribution,
  Evidence,
  Source,
  VerificationSummary,
} from "@research-os/contracts";
import {
  computeIndependence,
  evidenceWeight,
  stanceSign,
  weightFactorsFrom,
  type EvidenceWithSource,
} from "@research-os/evidence";
import { clamp01, round } from "@research-os/shared";
import { betaCredibleInterval, betaMean } from "./beta.ts";

/**
 * Total pseudo-count of the default prior. At 2 (a uniform Beta(1,1)) a single
 * strong source lands near 0.65 rather than near 1 — evidence has to accumulate
 * before the number means much.
 */
export const DEFAULT_PRIOR_STRENGTH = 2;

/** A successful replication is worth about one strong literature source. */
export const REPLICATION_EVIDENCE_UNITS = 1;

/**
 * A failed replication counts for more than twice a successful one.
 *
 * This is the falsification asymmetry, and it is the most important weighting
 * in the model. A successful replication is only *consistent with* the original
 * result — weak confirmation, since a result that replicates can still be wrong
 * for a reason neither run tested. A failed replication under comparable
 * conditions is direct evidence against the finding.
 */
export const FAILED_REPLICATION_EVIDENCE_UNITS = 2.2;

/** Each failed verification check (a quote not in its source, arithmetic that does not hold). */
export const FAILED_VERIFICATION_EVIDENCE_UNITS = 1;

/** How much total agent disagreement widens the interval on each side. */
export const MAX_DISAGREEMENT_WIDENING = 0.15;

export interface ConfidenceInput {
  /** Evidence linked to the claim, each paired with its source. */
  readonly evidence: readonly { evidence: Evidence; source: Source }[];
  /** Prior belief in [0,1]. Defaults to 0.5 (no prior information). */
  readonly prior?: number;
  /** Pseudo-count weight of the prior. Higher means more evidence is needed to move it. */
  readonly priorStrength?: number;
  readonly replications?: number;
  readonly failedReplications?: number;
  readonly verification?: VerificationSummary | null;
  /** Judge-assessed agreement from a debate, in [0,1]. */
  readonly agentAgreement?: number | null;
  /** Named uncertainties recorded by the critic or verifier. Never invented here. */
  readonly majorUncertainties?: readonly string[];
  readonly now: string;
}

/**
 * Computes a claim's confidence and the complete record of how it was reached.
 *
 * Deterministic: identical input always produces an identical breakdown, which
 * is what makes the scoring rules regression-testable.
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceBreakdown {
  const prior = clamp01(input.prior ?? 0.5);
  const priorStrength = Math.max(0.1, input.priorStrength ?? DEFAULT_PRIOR_STRENGTH);
  // A prior of exactly 0 or 1 would produce a degenerate Beta; bound the
  // pseudo-counts away from zero.
  const priorAlpha = Math.max(1e-3, prior * priorStrength);
  const priorBeta = Math.max(1e-3, (1 - prior) * priorStrength);

  // 1. Raw weight per evidence item, before redundancy is accounted for.
  const weighted: EvidenceWithSource[] = input.evidence.map(({ evidence, source }) => ({
    evidence,
    source,
    weight: evidenceWeight(weightFactorsFrom(evidence, source.quality?.score ?? 0.3)),
  }));

  // 2. Discount items that are not independent of stronger items already counted.
  const independence = computeIndependence(weighted);

  // 3. Convert each item into a signed pseudo-count.
  const contributions: ConfidenceContribution[] = [];
  let supportWeight = 0;
  let contradictionWeight = 0;
  let supportingCount = 0;
  let contradictingCount = 0;

  for (const item of weighted) {
    const independenceWeight = independence.weights.get(item.evidence.id) ?? 0;
    const factors = weightFactorsFrom(item.evidence, item.source.quality?.score ?? 0.3);
    const sign = stanceSign(item.evidence.stance);
    const effectiveWeight = item.weight * independenceWeight;

    if (sign > 0) {
      supportWeight += effectiveWeight;
      supportingCount++;
    } else if (sign < 0) {
      contradictionWeight += effectiveWeight;
      contradictingCount++;
    }

    contributions.push({
      evidenceId: item.evidence.id,
      sourceId: item.evidence.sourceId,
      stance: item.evidence.stance,
      factors: { ...factors, independenceWeight },
      weight: round(effectiveWeight),
      pseudoCount: round(sign * effectiveWeight, 6),
    });
  }

  const effectiveSupportingCount = supportWeight;
  const effectiveContradictingCount = contradictionWeight;

  // 4. Experimental replication, weighted asymmetrically.
  const replications = input.replications ?? 0;
  const failedReplications = input.failedReplications ?? 0;
  supportWeight += replications * REPLICATION_EVIDENCE_UNITS;
  contradictionWeight += failedReplications * FAILED_REPLICATION_EVIDENCE_UNITS;

  // 5. Failed verification checks count directly against the claim.
  const verification = input.verification ?? null;
  if (verification && verification.failed > 0) {
    contradictionWeight += verification.failed * FAILED_VERIFICATION_EVIDENCE_UNITS;
  }

  const posteriorAlpha = priorAlpha + supportWeight;
  const posteriorBeta = priorBeta + contradictionWeight;
  const score = clamp01(betaMean(posteriorAlpha, posteriorBeta));

  // 6. Uncertainty. The credible interval already reflects evidence volume and
  //    balance. Agent disagreement is epistemic uncertainty the counts cannot
  //    see, so it widens the interval — it never moves the score.
  const agentAgreement = input.agentAgreement ?? null;
  const [rawLow, rawHigh] = betaCredibleInterval(posteriorAlpha, posteriorBeta, 0.95);
  const disagreement = agentAgreement === null ? 0 : 1 - clamp01(agentAgreement);
  const widening = disagreement * MAX_DISAGREEMENT_WIDENING;

  return {
    method: "weighted-beta-v1",
    priorAlpha: round(priorAlpha, 6),
    priorBeta: round(priorBeta, 6),
    supportWeight: round(supportWeight, 6),
    contradictionWeight: round(contradictionWeight, 6),
    posteriorAlpha: round(posteriorAlpha, 6),
    posteriorBeta: round(posteriorBeta, 6),
    score: round(score),
    contributions,
    supportingCount,
    contradictingCount,
    effectiveSupportingCount: round(effectiveSupportingCount),
    effectiveContradictingCount: round(effectiveContradictingCount),
    distinctSources: independence.distinctSources,
    distinctDomains: independence.distinctDomains,
    replications,
    failedReplications,
    verificationPassRate: verification?.passRate ?? null,
    agentAgreement,
    uncertaintyInterval: [round(clamp01(rawLow - widening)), round(clamp01(rawHigh + widening))],
    majorUncertainties: [...(input.majorUncertainties ?? [])],
    computedAt: input.now,
  };
}

/**
 * Renders a breakdown as the summary a reader actually wants — the shape the
 * report and the UI both display.
 */
export function summariseConfidence(breakdown: ConfidenceBreakdown): string {
  const [low, high] = breakdown.uncertaintyInterval;
  const lines = [
    `Supporting sources: ${breakdown.supportingCount} (effective ${breakdown.effectiveSupportingCount})`,
    `Contradicting sources: ${breakdown.contradictingCount} (effective ${breakdown.effectiveContradictingCount})`,
    `Distinct sources: ${breakdown.distinctSources} across ${breakdown.distinctDomains} domain(s)`,
    `Replicated experiments: ${breakdown.replications}`,
    `Failed replications: ${breakdown.failedReplications}`,
    `Confidence: ${breakdown.score.toFixed(2)} (95% credible interval ${low.toFixed(2)}–${high.toFixed(2)})`,
  ];
  if (breakdown.verificationPassRate !== null) {
    lines.push(`Verification pass rate: ${(breakdown.verificationPassRate * 100).toFixed(0)}%`);
  }
  if (breakdown.agentAgreement !== null) {
    lines.push(`Agent agreement: ${breakdown.agentAgreement.toFixed(2)}`);
  }
  for (const uncertainty of breakdown.majorUncertainties) {
    lines.push(`Major uncertainty: ${uncertainty}`);
  }
  return lines.join("\n");
}
