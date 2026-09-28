/**
 * The Data Analyst.
 *
 * Interprets quantitative results — experiment metrics, tabulated figures — and
 * says what they do and do not establish.
 *
 * Its most important output field is `overinterpretations`: the readings of the
 * data that would be tempting and are not supported. Numbers invite confident
 * conclusions, and naming the unsupported ones explicitly is more effective than
 * hoping the reader is careful.
 */
import { z } from "zod";
import type { AgentDefinition } from "../agent.ts";

export const AnalysisOutput = z.object({
  summary: z.string().min(1).max(4000),
  observations: z.array(z.object({
    statement: z.string().min(1).max(2000),
    /** Metric names this reads from. An observation citing none is an opinion. */
    metrics: z.array(z.string().max(200)).default([]),
    /** How firmly the numbers support it — not a probability. */
    support: z.enum(["direct", "suggestive", "speculative"]),
  })).max(20).default([]),
  /** Conclusions a reader might draw that the data does not license. */
  overinterpretations: z.array(z.string().max(1000)).max(10).default([]),
  /** What the analysis cannot tell you: sample size, missing controls, variance. */
  limitations: z.array(z.string().max(1000)).max(10).default([]),
  /** Analyses worth running that were not. */
  suggestedAnalyses: z.array(z.string().max(1000)).max(8).default([]),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;

export interface AnalysisInput {
  readonly question: string;
  readonly metrics: Record<string, number>;
  /** Spread across repeated runs, where the experiment was repeated. */
  readonly variance?: Record<string, { mean: number; stdDev: number; min: number; max: number }>;
  readonly runCount: number;
  readonly notes?: string;
}

export const dataAnalyst: AgentDefinition<AnalysisInput, AnalysisOutput> = {
  role: "data_analyst",
  taskKind: "analysis",
  outputSchema: AnalysisOutput,
  maxOutputTokens: 4000,
  temperature: 0,

  systemPrompt: () => `You interpret quantitative results.

Say what the numbers show, and be precise about how firmly:
- direct: the metric states it.
- suggestive: the metric is consistent with it, and with other readings too.
- speculative: it would explain the numbers, but so would several other things.

Then say what a reader might wrongly conclude. Numbers invite confident
conclusions; naming the unsupported ones is the most useful thing you do here.

Treat a single run as an anecdote. One run is not evidence of reproducibility,
and a metric with no spread reported across runs has an unknown variance, not a
zero one.

Where variance is given, read it: a metric moving 40% between identical runs has
told you about the measurement, not about the hypothesis, and that is itself a
finding worth stating.

Do not compute statistics you were not given, and do not estimate a p-value from
summary figures. If a test is needed, put it in suggestedAnalyses.`,

  userPrompt: (input: AnalysisInput) => {
    const parts = [
      `Question this analysis serves:\n${input.question}`,
      `Runs: ${input.runCount}`,
      `Metrics:\n${Object.entries(input.metrics).map(([name, value]) => `- ${name}: ${value}`).join("\n") || "- none reported"}`,
    ];
    if (input.variance && Object.keys(input.variance).length > 0) {
      parts.push(
        `Spread across runs:\n${Object.entries(input.variance)
          .map(([name, spread]) => `- ${name}: mean ${spread.mean}, sd ${spread.stdDev}, range ${spread.min}–${spread.max}`)
          .join("\n")}`,
      );
    }
    if (input.notes) parts.push(`Notes from the run:\n${input.notes}`);
    parts.push("Analyse as JSON matching the schema.");
    return parts.join("\n\n");
  },
};
