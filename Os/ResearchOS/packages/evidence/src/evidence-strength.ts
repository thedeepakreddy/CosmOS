/**
 * Evidence weight.
 *
 * Six factors decide how much an evidence item counts. They are combined with a
 * *weighted geometric mean* rather than a product or an arithmetic mean, for
 * two reasons:
 *
 *   - A product of six values in [0,1] collapses toward zero (six factors at
 *     0.8 would yield 0.26), which would make all evidence look weak.
 *   - An arithmetic mean lets a fabricated quote be averaged away by five good
 *     scores. A geometric mean cannot: if any factor is zero, the weight is
 *     zero. That veto property is the reason for the choice.
 */
import type { Evidence, EvidenceStance } from "@research-os/contracts";
import { clamp01, round } from "@research-os/shared";

export type WeightFactorName =
  | "sourceQuality"
  | "relevance"
  | "directness"
  | "quoteFidelity"
  | "methodologicalRigor"
  | "specificity";

/**
 * Exponents for the weighted geometric mean. Sum to 1, so the result of all
 * factors being x is exactly x.
 *
 * `quoteFidelity` carries real weight despite being binary in practice: it is
 * the check that the cited passage actually says what the extraction claims,
 * which is the specific failure mode of a language model reading a document.
 */
export const WEIGHT_EXPONENTS: Readonly<Record<WeightFactorName, number>> = {
  sourceQuality: 0.25,
  relevance: 0.2,
  directness: 0.2,
  quoteFidelity: 0.15,
  methodologicalRigor: 0.12,
  specificity: 0.08,
};

/** Values below this are treated as a veto rather than a small number. */
const VETO_THRESHOLD = 0.02;

export interface WeightFactors {
  readonly sourceQuality: number;
  readonly relevance: number;
  readonly directness: number;
  readonly quoteFidelity: number;
  readonly methodologicalRigor: number;
  readonly specificity: number;
}

export function weightFactorsFrom(evidence: Evidence, sourceQuality: number): WeightFactors {
  return {
    sourceQuality: clamp01(sourceQuality),
    relevance: clamp01(evidence.relevance),
    directness: clamp01(evidence.strength.directness),
    quoteFidelity: clamp01(evidence.strength.quoteFidelity),
    methodologicalRigor: clamp01(evidence.strength.methodologicalRigor),
    specificity: clamp01(evidence.strength.specificity),
  };
}

/** Weighted geometric mean of the six factors, in [0,1]. */
export function evidenceWeight(factors: WeightFactors): number {
  let logSum = 0;
  for (const [name, exponent] of Object.entries(WEIGHT_EXPONENTS) as [WeightFactorName, number][]) {
    const value = clamp01(factors[name]);
    // Any factor at (effectively) zero vetoes the item entirely.
    if (value < VETO_THRESHOLD) return 0;
    logSum += exponent * Math.log(value);
  }
  return round(clamp01(Math.exp(logSum)));
}

/**
 * Direction of an evidence item's contribution.
 *
 * `mixed` returns 0 deliberately. Evidence that cuts both ways should not nudge
 * a conclusion in either direction — but it is still recorded, and it widens
 * the uncertainty interval downstream. Averaging it into a net score would hide
 * exactly the disagreement we are trying to preserve.
 */
export function stanceSign(stance: EvidenceStance): -1 | 0 | 1 {
  switch (stance) {
    case "supports":
      return 1;
    case "contradicts":
      return -1;
    case "neutral":
    case "mixed":
      return 0;
  }
}
