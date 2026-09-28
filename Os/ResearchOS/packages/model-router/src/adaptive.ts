/**
 * Routing that responds to what a run has left.
 *
 * A fixed policy spends the same on the first task as on the last, and a run
 * that exhausts its budget at 80% completion produces nothing — having paid for
 * everything. Adaptive routing trades model strength for reach as a run
 * approaches a ceiling, so it finishes with a weaker answer rather than no
 * answer.
 *
 * Two rules keep this from silently degrading quality:
 *
 *   - **Some work is never downgraded.** Judgment and synthesis decide what the
 *     research concludes. Saving money there buys a cheaper wrong answer.
 *   - **A downgrade is recorded.** The decision carries what it did and why, so
 *     a report can say that some of this run was produced under budget
 *     pressure. A cost saving nobody is told about is a quality regression
 *     nobody can account for.
 */
import type { ModelDescriptor, ModelTaskKind } from "@research-os/contracts";
import { clamp01, round } from "@research-os/shared";

/**
 * Work whose model must not be downgraded, whatever the budget.
 *
 * These decide what the research concludes rather than transforming text
 * somebody else will check. A cheap extraction that is slightly wrong is caught
 * by verification; a cheap judgment that is wrong becomes the answer.
 */
export const PROTECTED_TASK_KINDS: ReadonlySet<ModelTaskKind> = new Set<ModelTaskKind>([
  "judgment",
  "synthesis",
  "verification",
]);

export interface BudgetPressure {
  /** Fraction of the tightest ceiling consumed, in [0,1]. */
  readonly pressure: number;
  /** Set when the caller knows how much work is left, to weigh against it. */
  readonly remainingTasks?: number;
}

export type DowngradeTier = "none" | "prefer_cheaper" | "cheapest_capable";

export interface AdaptiveDecision {
  readonly tier: DowngradeTier;
  readonly protectedKind: boolean;
  /** Human-readable, carried into the report when a downgrade happened. */
  readonly reason: string;
}

/** Below this, routing follows the policy unchanged. */
export const PREFER_CHEAPER_AT = 0.7;
/** Above this, only reach matters: finish with something. */
export const CHEAPEST_CAPABLE_AT = 0.9;

export function decideAdaptiveTier(taskKind: ModelTaskKind, budget: BudgetPressure): AdaptiveDecision {
  const pressure = clamp01(budget.pressure);

  if (PROTECTED_TASK_KINDS.has(taskKind)) {
    return {
      tier: "none",
      protectedKind: true,
      reason: `"${taskKind}" decides what the research concludes and is never downgraded; a cheaper wrong answer costs more than the tokens saved.`,
    };
  }

  if (pressure >= CHEAPEST_CAPABLE_AT) {
    return {
      tier: "cheapest_capable",
      protectedKind: false,
      reason: `${(pressure * 100).toFixed(0)}% of the tightest budget ceiling is used; routing to the cheapest capable model so the run finishes.`,
    };
  }
  if (pressure >= PREFER_CHEAPER_AT) {
    return {
      tier: "prefer_cheaper",
      protectedKind: false,
      reason: `${(pressure * 100).toFixed(0)}% of the tightest budget ceiling is used; preferring a cheaper model for "${taskKind}".`,
    };
  }
  return { tier: "none", protectedKind: false, reason: "Within budget; following the routing policy." };
}

/** Rough per-call cost of a model, for ordering. */
export function estimatedCallCostUsd(descriptor: ModelDescriptor, inputTokens = 4000, outputTokens = 1000): number {
  return round(
    (inputTokens / 1_000_000) * descriptor.inputCostPerMTokUsd +
      (outputTokens / 1_000_000) * descriptor.outputCostPerMTokUsd,
    8,
  );
}

/**
 * Reorders candidates for the chosen tier.
 *
 * `prefer_cheaper` keeps the policy's ordering among models of comparable
 * strength and only moves an expensive one down — a mid-tier model at a tenth
 * the price is a good trade, the weakest model available is usually not.
 * `cheapest_capable` abandons that and takes the cheapest, because at that point
 * the alternative is not finishing.
 */
export function applyAdaptiveTier<T extends { descriptor: ModelDescriptor }>(
  candidates: readonly T[],
  tier: DowngradeTier,
): T[] {
  if (tier === "none" || candidates.length <= 1) return [...candidates];

  if (tier === "cheapest_capable") {
    return [...candidates].sort(
      (a, b) =>
        estimatedCallCostUsd(a.descriptor) - estimatedCallCostUsd(b.descriptor) ||
        a.descriptor.id.localeCompare(b.descriptor.id),
    );
  }

  // prefer_cheaper: value per dollar, with a floor on reasoning so the tier
  // cannot select a model that is cheap because it is barely capable.
  const strongest = Math.max(...candidates.map((candidate) => candidate.descriptor.reasoningTier));
  const floor = strongest * 0.6;

  const eligible = candidates.filter((candidate) => candidate.descriptor.reasoningTier >= floor);
  const pool = eligible.length > 0 ? eligible : candidates;

  return [...pool].sort((a, b) => {
    const costA = estimatedCallCostUsd(a.descriptor);
    const costB = estimatedCallCostUsd(b.descriptor);
    // Free models sort first; otherwise reasoning per dollar.
    const valueA = costA === 0 ? Number.POSITIVE_INFINITY : a.descriptor.reasoningTier / costA;
    const valueB = costB === 0 ? Number.POSITIVE_INFINITY : b.descriptor.reasoningTier / costB;
    return valueB - valueA || a.descriptor.id.localeCompare(b.descriptor.id);
  });
}
