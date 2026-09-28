/**
 * The Reviewer / Judge.
 *
 * Adjudicates a debate and decides what the research currently supports. It is
 * the only agent permitted to settle a disagreement, and it is explicitly
 * forbidden from doing so by averaging.
 *
 * Its contract requires `decidingFactors` and preserves `dissent`. Both are
 * deliberate: a verdict whose reasoning is not recorded cannot be challenged,
 * and a minority position that is deleted takes with it the information that
 * there *was* a minority — which is materially different from unanimity.
 */
import { z } from "zod";
import { DebatePosition } from "@research-os/contracts";
import type { AgentDefinition } from "../agent.ts";
import { numbered } from "../agent.ts";

export const JudgementOutput = z.object({
  position: DebatePosition,
  reasoning: z.string().min(1).max(8000),
  decidingFactors: z.array(z.object({
    factor: z.enum([
      "evidence_strength", "source_reliability", "methodology", "replication",
      "internal_consistency", "scope_fit", "recency",
    ]),
    weight: z.number().min(0).max(1),
    note: z.string().max(1000),
  })).min(1),
  /** Rejected positions, kept with the reason. Never dropped. */
  dissent: z.array(z.object({
    roleName: z.string().max(50),
    position: DebatePosition,
    whyRejected: z.string().max(2000),
  })).default([]),
  /** How aligned the participants were. Feeds the width of the confidence interval. */
  agreementLevel: z.number().min(0).max(1),
  residualUncertainties: z.array(z.string().max(500)).max(10).default([]),
});
export type JudgementOutput = z.infer<typeof JudgementOutput>;

export interface JudgementInput {
  readonly topic: string;
  readonly turns: readonly { round: number; role: string; position: string; argument: string; citedEvidenceCount: number }[];
}

export const judge: AgentDefinition<JudgementInput, JudgementOutput> = {
  role: "judge",
  taskKind: "judgment",
  outputSchema: JudgementOutput,
  maxOutputTokens: 4000,

  systemPrompt: () => `You are the Judge. You decide what the evidence currently supports.

Do not average positions. Three agents agreeing does not outweigh one agent with
a decisive piece of evidence, and a split vote is not a reason to answer
"qualify". Weigh:
- evidence strength: is it measured, or asserted?
- source reliability: peer review, primary data, independence.
- methodology: design, sample, controls.
- replication: has anyone reproduced it?
- internal consistency: does the position contradict something already accepted?
- scope fit: does the evidence cover the range the claim asserts?
- recency: has the field moved?

Record which factors actually decided it, with the weight you gave each. A
verdict whose reasoning is not recorded cannot be challenged later, which makes
it worthless.

Preserve dissent. For every position you rejected, say why. Deleting a minority
view destroys the information that there was one.

An argument citing no evidence carries less weight than one that does — say so
explicitly when it affects the outcome.

agreementLevel is how aligned the participants were, independent of who was
right. It widens or narrows the reported uncertainty, so report it honestly:
a unanimous panel that is wrong should still read as unanimous.

"abstain" is available and is the correct verdict when the evidence genuinely
does not settle the question. Use it rather than manufacturing a decision.`,

  userPrompt: (input: JudgementInput) => {
    const turns = input.turns.map(
      (turn) =>
        `Round ${turn.round} — ${turn.role} (position: ${turn.position}, evidence cited: ${turn.citedEvidenceCount})\n${turn.argument}`,
    );
    return [
      `Matter under debate:\n${input.topic}`,
      `Arguments:\n\n${numbered(turns, "Turn")}`,
      "Deliver your verdict as JSON matching the schema.",
    ].join("\n\n");
  },
};
