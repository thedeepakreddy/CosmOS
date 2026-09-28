/**
 * Metrics and cost accounting.
 *
 * Token and dollar spend are first-class research state, not an afterthought:
 * the orchestrator enforces budgets from these numbers, and every research
 * report publishes what it cost to produce.
 */
import type { ModelUsage } from "@research-os/contracts";
import { round } from "@research-os/shared";

export interface CounterSnapshot {
  readonly name: string;
  readonly value: number;
  readonly labels: Readonly<Record<string, string>>;
}

export interface UsageTotals {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
}

export function emptyUsage(): UsageTotals {
  return { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
}

export function addUsage(totals: UsageTotals, usage: ModelUsage): UsageTotals {
  return {
    modelCalls: totals.modelCalls + 1,
    toolCalls: totals.toolCalls,
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cachedInputTokens: totals.cachedInputTokens + usage.cachedInputTokens,
    costUsd: round(totals.costUsd + usage.costUsd, 6),
  };
}

export function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    modelCalls: a.modelCalls + b.modelCalls,
    toolCalls: a.toolCalls + b.toolCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    costUsd: round(a.costUsd + b.costUsd, 6),
  };
}

/**
 * Cost from provider-reported usage and published rates.
 *
 * Cached reads are billed at a fraction of the input rate; when a provider does
 * not publish a separate cached rate we fall back to the full input rate, which
 * over-estimates rather than under-estimates. A budget that errs toward
 * stopping early is the safe direction.
 */
export interface PricingRates {
  readonly inputCostPerMTokUsd: number;
  readonly outputCostPerMTokUsd: number;
  /**
   * `| undefined` is explicit so that a `ModelDescriptor` — where these are
   * `.optional()` zod fields and therefore carry an explicit `undefined` — can
   * be passed straight in under `exactOptionalPropertyTypes`. A descriptor is
   * the natural source of rates, and requiring callers to strip the key first
   * would be friction with no safety gained.
   */
  readonly cachedInputCostPerMTokUsd?: number | undefined;
  readonly cacheWriteCostPerMTokUsd?: number | undefined;
}

export function computeCostUsd(
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number },
  rates: PricingRates,
): number {
  const million = 1_000_000;
  const cachedRate = rates.cachedInputCostPerMTokUsd ?? rates.inputCostPerMTokUsd;
  const cacheWriteRate = rates.cacheWriteCostPerMTokUsd ?? rates.inputCostPerMTokUsd * 1.25;
  const cost =
    (usage.inputTokens / million) * rates.inputCostPerMTokUsd +
    (usage.outputTokens / million) * rates.outputCostPerMTokUsd +
    ((usage.cachedInputTokens ?? 0) / million) * cachedRate +
    ((usage.cacheWriteTokens ?? 0) / million) * cacheWriteRate;
  return round(cost, 8);
}

/** `| undefined` is explicit because `exactOptionalPropertyTypes` is on. */
export interface HistogramSummary {
  count: number;
  p50?: number | undefined;
  p95?: number | undefined;
  max?: number | undefined;
}

/** Minimal in-process counter/histogram registry. */
export class MetricsRegistry {
  readonly #counters = new Map<string, number>();
  readonly #histograms = new Map<string, number[]>();

  #key(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
    return entries.length ? `${name}{${entries.map(([k, v]) => `${k}="${v}"`).join(",")}}` : name;
  }

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.#key(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + by);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.#key(name, labels);
    const values = this.#histograms.get(key);
    if (values) values.push(value);
    else this.#histograms.set(key, [value]);
  }

  counter(name: string, labels: Record<string, string> = {}): number {
    return this.#counters.get(this.#key(name, labels)) ?? 0;
  }

  /** Percentile over observed values. Linear interpolation, sorted on read. */
  percentile(name: string, p: number, labels: Record<string, string> = {}): number | undefined {
    const values = this.#histograms.get(this.#key(name, labels));
    if (!values || values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  }

  snapshot(): { counters: CounterSnapshot[]; histograms: Record<string, HistogramSummary> } {
    const counters: CounterSnapshot[] = [...this.#counters].map(([key, value]) => ({ name: key, value, labels: {} }));
    const histograms: Record<string, HistogramSummary> = {};
    for (const [key, values] of this.#histograms) {
      const sorted = [...values].sort((a, b) => a - b);
      histograms[key] = {
        count: sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted[sorted.length - 1],
      };
    }
    return { counters, histograms };
  }

  reset(): void {
    this.#counters.clear();
    this.#histograms.clear();
  }
}
