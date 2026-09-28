/**
 * Automated hypothesis generation.
 *
 * Reads what the research has found so far and proposes explanations worth
 * testing. This is the agent that makes a run generative rather than merely
 * confirmatory: without it, research only ever answers the question it was
 * handed, and the interesting result — the one that reframes the question — has
 * no way to enter the system.
 *
 * Every hypothesis must carry falsification criteria. That is not a stylistic
 * preference: a proposition no observation could refute cannot be tested, and
 * generating hypotheses without that constraint produces a list of opinions
 * dressed as a research agenda.
 */
import { z } from "zod";
import type { AgentDefinition } from "../agent.ts";
import { numbered } from "../agent.ts";

export const HypothesisGenerationOutput = z.object({
  hypotheses: z.array(z.object({
    statement: z.string().min(1).max(2000),
    /** Why the evidence so far makes this worth testing. */
    rationale: z.string().min(1).max(4000),
    /** The observation that would refute it. Required — an untestable hypothesis is not one. */
    falsificationCriteria: z.string().min(1).max(2000),
    /** Belief before testing, stated as a band rather than a number. */
    plausibility: z.enum(["speculative", "plausible", "likely"]),
    /** Findings this would explain, by index. */
    explainsClaimIndices: z.array(z.number().int().positive()).default([]),
    /** What would have to be gathered or run to test it. */
    testableBy: z.enum(["further_evidence", "experiment", "reanalysis", "not_testable_here"]),
  })).max(8).default([]),
  /**
   * Explanations considered and set aside, with the reason.
   *
   * Kept because "we thought of that and here is why not" is information, and a
   * later run that rediscovers a discarded idea wastes the same effort twice.
   */
  discarded: z.array(z.object({
    statement: z.string().max(1000),
    whyDiscarded: z.string().max(1000),
  })).max(6).default([]),
});
export type HypothesisGenerationOutput = z.infer<typeof HypothesisGenerationOutput>;

export interface HypothesisGenerationInput {
  readonly question: string;
  readonly claims: readonly { statement: string; status: string; confidence: number | null }[];
  readonly contradictions: readonly string[];
  readonly openQuestions: readonly string[];
  /** Hypotheses already recorded, so the agent does not restate them. */
  readonly existingHypotheses: readonly string[];
  /** Approaches already tried and found not to work. */
  readonly knownDeadEnds: readonly string[];
}

export const hypothesisGenerator: AgentDefinition<HypothesisGenerationInput, HypothesisGenerationOutput> = {
  role: "research_director",
  taskKind: "analysis",
  outputSchema: HypothesisGenerationOutput,
  maxOutputTokens: 4000,

  systemPrompt: () => `You propose hypotheses that would explain what the research has found.

A hypothesis here is a testable proposition, not a summary and not an opinion.
Every one must state what observation would refute it, specifically enough that
someone could check a result against it. If you cannot say what would refute it,
it does not belong in the list — put it in discarded with that as the reason.

What makes a hypothesis worth proposing:
- It explains something the current claims do not, or explains a contradiction
  between two of them.
- It is distinguishable from the explanations already on the table. "Memory
  helps" and "memory is beneficial" are one hypothesis, not two.
- Testing it is within reach: more evidence, an experiment, or a reanalysis of
  what is already held. If none of those would settle it, say so with
  "not_testable_here" rather than proposing work that cannot be done.

An unresolved contradiction is the most productive place to look. Two claims
that cannot both be true mean something is missing from the current picture, and
naming what that might be is more valuable than another confirmation of what is
already believed.

Do not restate hypotheses already recorded, and do not re-propose an approach
already found not to work unless you say what is different this time.

plausibility is a band, not a number: the system computes confidence from
evidence, and a model-asserted probability here would be an unearned one.`,

  userPrompt: (input: HypothesisGenerationInput) => {
    const claims = input.claims.map(
      (claim) => `${claim.statement}\n  status: ${claim.status}, confidence: ${claim.confidence === null ? "not computed" : claim.confidence.toFixed(2)}`,
    );
    const parts = [
      `Research question:\n${input.question}`,
      claims.length > 0
        ? `Claims established so far (referenced by index in explainsClaimIndices):\n\n${numbered(claims, "Claim")}`
        : "No claims have been established yet.",
    ];

    if (input.contradictions.length > 0) {
      parts.push(
        `Unresolved contradictions. These are the most productive place to look:\n${input.contradictions.map((item) => `- ${item}`).join("\n")}`,
      );
    }
    if (input.openQuestions.length > 0) {
      parts.push(`Questions still open:\n${input.openQuestions.map((item) => `- ${item}`).join("\n")}`);
    }
    if (input.existingHypotheses.length > 0) {
      parts.push(
        `Hypotheses already recorded. Do not restate these:\n${input.existingHypotheses.map((item) => `- ${item}`).join("\n")}`,
      );
    }
    if (input.knownDeadEnds.length > 0) {
      parts.push(
        `Approaches already tried and found not to work:\n${input.knownDeadEnds.map((item) => `- ${item}`).join("\n")}`,
      );
    }

    parts.push("Propose hypotheses as JSON matching the schema.");
    return parts.join("\n\n");
  },
};
