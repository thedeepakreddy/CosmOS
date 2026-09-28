/**
 * The Experiment Agent.
 *
 * Designs an experiment that would settle a hypothesis: what to run, what would
 * count as confirmation, and — the field most often missing — what result would
 * refute it.
 *
 * The code it writes is executed by a runner that may have no sandbox, so the
 * prompt is explicit about what the code may do. That is defence in depth: the
 * runner enforces the boundary regardless, but an agent that was never asked to
 * write a network call is less likely to write one.
 */
import { z } from "zod";
import { ExperimentRuntime } from "@research-os/contracts";
import type { AgentDefinition } from "../agent.ts";

export const ExperimentDesignOutput = z.object({
  title: z.string().min(1).max(500),
  /** What this would show, and how. */
  design: z.string().min(1).max(8000),
  expectedOutcome: z.string().min(1).max(4000),
  /** The result that would refute the hypothesis. Required. */
  falsificationCriteria: z.string().min(1).max(2000),
  runtime: ExperimentRuntime,
  code: z.string().min(1).max(100_000),
  /** Pinned specifiers, e.g. "numpy==1.26.4". Unpinned is not reproducible. */
  dependencies: z.array(z.string().max(200)).max(30).default([]),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Metrics the code emits, so the analyst knows what to expect. */
  expectedMetrics: z.array(z.string().max(200)).max(20).default([]),
  /** What this design cannot establish, stated before it is run. */
  limitations: z.array(z.string().max(1000)).max(10).default([]),
});
export type ExperimentDesignOutput = z.infer<typeof ExperimentDesignOutput>;

export interface ExperimentDesignInput {
  readonly hypothesis: string;
  readonly falsificationCriteria?: string | null;
  readonly availableRuntimes: readonly string[];
  readonly availableData?: string | null;
  readonly networkAllowed: boolean;
}

export const experimenter: AgentDefinition<ExperimentDesignInput, ExperimentDesignOutput> = {
  role: "experimenter",
  taskKind: "coding",
  outputSchema: ExperimentDesignOutput,
  maxOutputTokens: 8000,
  temperature: 0,

  systemPrompt: () => `You design a computational experiment that would settle a hypothesis.

Requirements:
- State what result would refute the hypothesis, specifically enough that
  someone could check it against the output. An experiment that cannot fail
  establishes nothing.
- Write code that runs unattended and terminates. No prompts, no interactive
  input, no indefinite loops.
- Emit results on marker lines:
  RESEARCHOS_METRIC {"metric_name": 0.87}
  Only marker lines are read as data. Anything else you print is a log.
- Pin every dependency to an exact version. An unpinned dependency makes the
  result unreproducible, which for research purposes makes it not a result.
- Set and record a random seed if anything is stochastic.
- Generate or construct your own input data unless data was provided. Say in
  limitations that the data is synthetic — a result on invented data establishes
  something about the code, not about the world.

The code runs in a restricted environment: no network unless explicitly allowed,
no access to the host's environment variables, a fresh empty working directory,
and a wall-clock timeout. Write code that works within that.

Node experiments are written to a .mjs file, so use ESM import, not require.`,

  userPrompt: (input: ExperimentDesignInput) => {
    const parts = [
      `Hypothesis to test:\n${input.hypothesis}`,
      input.falsificationCriteria
        ? `Falsification criteria already recorded for this hypothesis:\n${input.falsificationCriteria}`
        : "No falsification criteria have been recorded. Supply them.",
      `Runtimes available: ${input.availableRuntimes.join(", ") || "none"}`,
      `Network access: ${input.networkAllowed ? "permitted" : "not permitted — the code must not make network calls"}`,
    ];
    parts.push(
      input.availableData
        ? `Data available to the experiment:\n${input.availableData}`
        : "No dataset is available. Construct synthetic data in the code and record that as a limitation.",
    );
    parts.push("Design the experiment as JSON matching the schema.");
    return parts.join("\n\n");
  },
};
