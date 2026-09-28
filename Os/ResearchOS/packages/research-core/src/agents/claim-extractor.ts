/**
 * The Claim Extraction Agent.
 *
 * Turns evidence into atomic claims. "Atomic" is the whole job: a claim that
 * bundles three assertions cannot be supported, refuted or scored, because the
 * evidence will bear on the parts differently. Splitting them is what makes
 * everything downstream possible.
 *
 * It also names assumptions. A claim that only holds given something unstated is
 * a claim whose scope is wrong, and surfacing that is cheaper here than
 * discovering it in review.
 */
import { z } from "zod";
import { ClaimType, EvidenceStance } from "@research-os/contracts";
import type { AgentDefinition } from "../agent.ts";
import { numbered } from "../agent.ts";

export const ClaimExtractionOutput = z.object({
  claims: z.array(z.object({
    statement: z.string().min(1).max(2000),
    claimType: ClaimType,
    /** Conditions under which the claim is asserted to hold. */
    scope: z.string().max(1000).nullable().default(null),
    /** Premises this rests on that the evidence does not itself establish. */
    assumptions: z.array(z.string().max(500)).max(6).default([]),
    /** Evidence indices from the prompt, with how each bears on the claim. */
    evidence: z.array(z.object({
      evidenceIndex: z.number().int().positive(),
      stance: EvidenceStance,
      rationale: z.string().max(1000),
    })).min(1),
  })).max(15).default([]),
  /** Statements in the evidence that could not be turned into a supportable claim. */
  unsupportable: z.array(z.string().max(1000)).default([]),
});
export type ClaimExtractionOutput = z.infer<typeof ClaimExtractionOutput>;

export interface ClaimExtractionInput {
  readonly question: string;
  readonly evidence: readonly { quote: string; interpretation: string; sourceTitle: string; stance: string }[];
}

export const claimExtractor: AgentDefinition<ClaimExtractionInput, ClaimExtractionOutput> = {
  role: "claim_extractor",
  taskKind: "extraction",
  outputSchema: ClaimExtractionOutput,
  maxOutputTokens: 4000,
  temperature: 0,

  systemPrompt: () => `You turn evidence into atomic claims.

A claim is atomic when it asserts exactly one thing that could be independently
checked. "Persistent memory improves recall and reduces latency" is two claims,
and must be split — evidence will bear on the halves differently, and a bundled
claim can be neither supported nor refuted cleanly.

Every claim must cite at least one evidence item by index, with the stance that
item takes toward it. Evidence that contradicts the claim is cited too: a claim
that only cites what agrees with it is the failure mode this system exists to
prevent.

Name assumptions explicitly. If a claim holds only given something the evidence
does not establish — a population, a time period, a definition — that belongs in
assumptions or in scope, not left implicit in the sentence.

Do not assert confidence. The system computes it from evidence weight and
independence.

If the evidence supports no claim you would be willing to defend, return none and
list what you could not support. That is a finding, not a failure.`,

  userPrompt: (input: ClaimExtractionInput) => {
    const items = input.evidence.map(
      (item) => `Source: ${item.sourceTitle}\nStance recorded by extraction: ${item.stance}\nQuote: "${item.quote}"\nInterpretation: ${item.interpretation}`,
    );
    return [
      `Question being investigated:\n${input.question}`,
      `Evidence:\n\n${numbered(items, "Evidence")}`,
      "Extract atomic claims as JSON matching the schema. evidenceIndex refers to the numbered evidence above.",
    ].join("\n\n");
  },
};
