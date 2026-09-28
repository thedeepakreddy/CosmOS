/**
 * Did the result hold up when it was run again?
 *
 * A single run is an anecdote. Replication turns it into evidence, and the
 * spread across runs is itself a finding: an experiment whose metric moves by
 * 40% between identical runs has told you something important about the
 * measurement, not about the hypothesis.
 *
 * Pure arithmetic over recorded runs. No model is asked whether something
 * replicated — that question has an arithmetic answer and inventing a
 * judgement for it would be exactly the kind of unearned confidence the rest of
 * the system works to avoid.
 */
import type { ExperimentRun, ReplicationSummary } from "@research-os/contracts";
import { clamp01, round } from "@research-os/shared";

export interface ReplicationOptions {
  /**
   * How far a metric may move and still count as the same result, as a fraction
   * of the baseline. 10% by default: loose enough for stochastic runs, tight
   * enough that a materially different number is not waved through.
   */
  readonly relativeTolerance?: number;
  /** Absolute floor, so metrics near zero do not fail on rounding noise. */
  readonly absoluteTolerance?: number;
}

export interface MetricSpread {
  readonly mean: number;
  readonly stdDev: number;
  readonly min: number;
  readonly max: number;
}

export function metricSpread(values: readonly number[]): MetricSpread | null {
  if (values.length === 0) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return {
    mean: round(mean, 6),
    stdDev: round(Math.sqrt(variance), 6),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Two metric sets agree when every shared metric is within tolerance. */
export function metricsMatch(
  baseline: Record<string, number>,
  candidate: Record<string, number>,
  options: ReplicationOptions = {},
): boolean {
  const relative = options.relativeTolerance ?? 0.1;
  const absolute = options.absoluteTolerance ?? 1e-9;

  const shared = Object.keys(baseline).filter((key) => key in candidate);
  // No shared metric means there is nothing to compare — which is not a match.
  // Treating it as one would let an experiment that emitted nothing "replicate".
  if (shared.length === 0) return false;

  return shared.every((key) => {
    const a = baseline[key];
    const b = candidate[key];
    if (a === undefined || b === undefined) return false;
    const allowed = Math.max(absolute, Math.abs(a) * relative);
    return Math.abs(a - b) <= allowed;
  });
}

/**
 * Summarises every run of one experiment.
 *
 * The first successful run is the baseline; later successful runs either
 * reproduce it or do not. `reproducibilityScore` is the fraction of replication
 * attempts that matched — and is 0, not 1, when there was only one run. One run
 * is not evidence of reproducibility; it is the absence of evidence either way,
 * and a score of 1 would present that absence as a strong result.
 */
export function summariseReplication(
  experimentId: string,
  runs: readonly ExperimentRun[],
  options: ReplicationOptions = {},
): ReplicationSummary {
  const ordered = [...runs].sort((a, b) => a.attempt - b.attempt);
  const successful = ordered.filter((run) => run.status === "succeeded");

  const byMetric = new Map<string, number[]>();
  for (const run of successful) {
    for (const [key, value] of Object.entries(run.metrics)) {
      if (!Number.isFinite(value)) continue;
      const values = byMetric.get(key) ?? [];
      values.push(value);
      byMetric.set(key, values);
    }
  }

  const metricVariance: Record<string, MetricSpread> = {};
  for (const [key, values] of byMetric) {
    const spread = metricSpread(values);
    if (spread) metricVariance[key] = spread;
  }

  const baseline = successful[0];
  let replications = 0;
  let failedReplications = 0;
  if (baseline) {
    for (const run of successful.slice(1)) {
      if (metricsMatch(baseline.metrics, run.metrics, options)) replications++;
      else failedReplications++;
    }
  }

  const attempts = replications + failedReplications;
  return {
    experimentId,
    totalRuns: ordered.length,
    successfulRuns: successful.length,
    replications,
    failedReplications,
    metricVariance,
    reproducibilityScore: attempts === 0 ? 0 : clamp01(round(replications / attempts, 4)),
  };
}

/**
 * How many independent confirmations a claim may draw on.
 *
 * Only *matched* replications count. A run that produced a different number is
 * not a second confirmation of the first — it is a disagreement, and the
 * confidence calculation should see it as one.
 */
export function replicationCounts(summary: ReplicationSummary): { replications: number; failedReplications: number } {
  return { replications: summary.replications, failedReplications: summary.failedReplications };
}
