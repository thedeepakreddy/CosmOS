/**
 * Budget enforcement.
 *
 * A research run has hard ceilings, and the contract is explicit about what
 * hitting one means: the run stops and says so. It never silently degrades into
 * a shallower answer, because a shallower answer that does not announce itself
 * is indistinguishable from a thorough one and will be read as though it were.
 *
 * Checked *before* dispatching work rather than after. Finding out a budget was
 * exceeded once the money is spent is an audit, not a control.
 */
import type { ResearchBudget } from "@research-os/contracts";

export interface BudgetUsage {
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly tasksCreated: number;
  readonly sourcesDiscovered: number;
  readonly elapsedMs: number;
}

export type BudgetDimension =
  | "maxTokens" | "maxCostUsd" | "maxWallClockMs" | "maxModelCalls"
  | "maxToolCalls" | "maxSources" | "maxTasks";

export interface BudgetVerdict {
  readonly withinBudget: boolean;
  /** Every ceiling that has been reached, not just the first. */
  readonly exceeded: { dimension: BudgetDimension; limit: number; used: number }[];
  /** Fraction of the tightest ceiling consumed, in [0,1]. */
  readonly pressure: number;
  readonly summary: string;
}

export function checkBudget(budget: ResearchBudget, usage: BudgetUsage): BudgetVerdict {
  const dimensions: { dimension: BudgetDimension; limit: number; used: number }[] = [
    { dimension: "maxTokens", limit: budget.maxTokens, used: usage.inputTokens + usage.outputTokens },
    { dimension: "maxCostUsd", limit: budget.maxCostUsd, used: usage.costUsd },
    { dimension: "maxWallClockMs", limit: budget.maxWallClockMs, used: usage.elapsedMs },
    { dimension: "maxModelCalls", limit: budget.maxModelCalls, used: usage.modelCalls },
    { dimension: "maxToolCalls", limit: budget.maxToolCalls, used: usage.toolCalls },
    { dimension: "maxSources", limit: budget.maxSources, used: usage.sourcesDiscovered },
    { dimension: "maxTasks", limit: budget.maxTasks, used: usage.tasksCreated },
  ];

  const exceeded = dimensions.filter((entry) => entry.used >= entry.limit);
  const pressure = dimensions.reduce(
    (highest, entry) => Math.max(highest, entry.limit === 0 ? 1 : Math.min(1, entry.used / entry.limit)),
    0,
  );

  return {
    withinBudget: exceeded.length === 0,
    exceeded,
    pressure: Math.round(pressure * 10_000) / 10_000,
    summary: exceeded.length === 0
      ? `Within budget (${(pressure * 100).toFixed(0)}% of the tightest ceiling used).`
      : exceeded.map((entry) => `${entry.dimension}: used ${round(entry.used)} of ${round(entry.limit)}`).join("; "),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * True when a run is close enough to a ceiling that it should start finishing
 * rather than starting new lines of enquiry.
 *
 * The distinction matters: a run that stops dead at 100% produces no report at
 * all, having spent the entire budget. One that begins synthesising at 85% still
 * spends everything, but ends with something to show for it.
 */
export function shouldWindDown(verdict: BudgetVerdict, threshold = 0.85): boolean {
  return verdict.pressure >= threshold;
}
