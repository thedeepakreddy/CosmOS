/**
 * The Critic / Skeptic.
 *
 * Attacks the research rather than the researcher: weak reasoning, alternative
 * explanations, confirmation bias, evidence that should exist and does not.
 *
 * It is prompted for *resolution criteria* on every finding. A critique that
 * cannot be resolved is a complaint — it stops the run without telling anyone
 * how to proceed — and the difference between the two is what makes this agent
 * useful rather than obstructive.
 */
import { z } from "zod";
import { FindingKind } from "@research-os/contracts";
import type { AgentDefinition } from "../agent.ts";
import { numbered } from "../agent.ts";

export const CritiqueOutput = z.object({
  findings: z.array(z.object({
    kind: FindingKind,
    /** Index of the claim this concerns, or 0 for the research as a whole. */
    targetIndex: z.number().int().nonnegative(),
    description: z.string().min(1).max(4000),
    /** What would settle this. A critique without one is a complaint. */
    resolutionCriteria: z.string().min(1).max(2000),
    severity: z.number().min(0).max(1),
  })).max(20).default([]),
  /** Explanations of the evidence other than the one the claims assume. */
  alternativeExplanations: z.array(z.string().max(2000)).max(8).default([]),
  /** Evidence that would exist if the conclusion were true, and has not been found. */
  missingEvidence: z.array(z.string().max(1000)).max(10).default([]),
  /** Stated plainly when the research holds up, so agreement is informative too. */
  overallAssessment: z.string().min(1).max(4000),
});
export type CritiqueOutput = z.infer<typeof CritiqueOutput>;

export interface CritiqueInput {
  readonly question: string;
  readonly claims: readonly { statement: string; confidence: number | null; evidenceCount: number; sourceCount: number }[];
  readonly sourcesConsidered: number;
}

export const skeptic: AgentDefinition<CritiqueInput, CritiqueOutput> = {
  role: "skeptic",
  taskKind: "critique",
  outputSchema: CritiqueOutput,
  maxOutputTokens: 4000,

  systemPrompt: () => `You are the Skeptic. Your job is to find what is wrong with this
research before a reader does.

Look for:
- Claims that outrun their evidence — universal statements from a handful of
  studies, causal claims from correlational evidence, a conclusion that would
  need data nobody gathered.
- Alternative explanations the claims do not address. If the same evidence is
  equally consistent with a different story, say what that story is.
- Confirmation bias: evidence gathered only where the answer was expected,
  sources that all originate from the same group, contradicting work not sought.
- Missing evidence: if the conclusion were true, what else would we expect to
  see? Has anyone looked?
- Reliance on a single source, or on several sources that are not independent.

Every finding needs resolutionCriteria: what specifically would settle it. "More
research is needed" is not a criterion. "A study with a control group and n>200"
is.

Severity is how much this undermines the conclusion, not how confident you are
that it is a problem.

If the research holds up, say so and say why. Manufactured criticism wastes the
run and teaches everyone to ignore you.`,

  userPrompt: (input: CritiqueInput) => {
    const claims = input.claims.map(
      (claim) =>
        `${claim.statement}\n  confidence: ${claim.confidence === null ? "not yet computed" : claim.confidence.toFixed(2)}` +
        `, evidence items: ${claim.evidenceCount}, distinct sources: ${claim.sourceCount}`,
    );
    return [
      `Research question:\n${input.question}`,
      `Sources considered in total: ${input.sourcesConsidered}`,
      `Claims (targetIndex refers to these; use 0 for the research as a whole):\n\n${numbered(claims, "Claim")}`,
      "Critique this research as JSON matching the schema.",
    ].join("\n\n");
  },
};
