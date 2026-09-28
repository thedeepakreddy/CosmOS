/**
 * The Synthesizer.
 *
 * Writes the prose of a report from research state that already exists. It is
 * given claims, contradictions and statistics, and is explicitly forbidden from
 * adding anything that is not in them — the report builder assembles the
 * structured parts, and this agent supplies only the connective writing.
 *
 * That division is the point. A synthesiser allowed to introduce facts would be
 * a way for unevidenced assertions to enter a document whose entire value is
 * that every sentence traces to a claim.
 */
import { z } from "zod";
import type { AgentDefinition } from "../agent.ts";
import { numbered } from "../agent.ts";

export const SynthesisOutput = z.object({
  title: z.string().min(1).max(500),
  executiveSummary: z.string().min(1).max(8000),
  /** How the research was actually conducted, from the run log it was given. */
  methodology: z.string().min(1).max(8000),
  /** Why overall confidence is what the arithmetic says it is. */
  confidenceRationale: z.string().min(1).max(4000),
  limitations: z.array(z.string().max(2000)).max(15).default([]),
  unansweredQuestions: z.array(z.string().max(2000)).max(15).default([]),
  recommendedNextResearch: z.array(z.object({
    direction: z.string().max(2000),
    rationale: z.string().max(2000),
    priority: z.number().min(0).max(1),
  })).max(10).default([]),
  sections: z.array(z.object({
    key: z.string().max(100),
    heading: z.string().max(300),
    /** Markdown. Cite claims inline as [claim N] using the indices given. */
    body: z.string().max(20_000),
    claimIndices: z.array(z.number().int().positive()).default([]),
  })).max(12).default([]),
});
export type SynthesisOutput = z.infer<typeof SynthesisOutput>;

export interface SynthesisInput {
  readonly question: string;
  readonly claims: readonly { statement: string; status: string; confidence: number | null; sources: number; uncertainties: readonly string[] }[];
  readonly contradictions: readonly { description: string; status: string; severity: number }[];
  readonly openQuestions: readonly string[];
  readonly criticisms: readonly string[];
  readonly statistics: { sourcesConsidered: number; evidenceItems: number; agentRuns: number };
  readonly overallConfidence: number;
  readonly blockedWork: readonly string[];
}

export const synthesizer: AgentDefinition<SynthesisInput, SynthesisOutput> = {
  role: "synthesizer",
  taskKind: "synthesis",
  outputSchema: SynthesisOutput,
  maxOutputTokens: 8000,

  systemPrompt: () => `You write the prose of a research report.

You are given the research that was done. You may summarise it, organise it and
explain it. You may not add to it. Every factual statement in what you write must
trace to a claim you were given; if you find yourself wanting to mention
something that is not in the material, leave it out — that is the difference
between a report and an essay.

Specifically:
- Do not introduce sources, studies, figures or findings that are not listed.
- Do not upgrade a contested claim into a settled one. If the material says
  "contested", the report says contested.
- Cite claims inline as [claim N] using the indices given, and list the indices
  you used in claimIndices.
- Lead the executive summary with what the research actually found, including
  where it failed to find anything. A summary that reads as confident when the
  research was not is a misrepresentation.
- confidenceRationale explains the number you were given. Do not argue for a
  different one; the number is computed from evidence, not from prose.
- Contradictions go in the report as contradictions. Do not resolve them.
- Work that was blocked is a limitation and must be listed as one.

Suggested sections: background, findings, evidence quality, contradictions,
limitations, conclusion. Adapt to the material — omit a section rather than pad
it.`,

  userPrompt: (input: SynthesisInput) => {
    const claims = input.claims.map(
      (claim) =>
        `${claim.statement}\n  status: ${claim.status}` +
        `, confidence: ${claim.confidence === null ? "not computed" : claim.confidence.toFixed(2)}` +
        `, distinct sources: ${claim.sources}` +
        (claim.uncertainties.length ? `\n  recorded uncertainties: ${claim.uncertainties.join("; ")}` : ""),
    );

    const parts = [
      `Research question:\n${input.question}`,
      `Claims (cite these as [claim N]):\n\n${numbered(claims, "Claim")}`,
    ];

    parts.push(
      input.contradictions.length
        ? `Contradictions — report these as contradictions, do not resolve them:\n${input.contradictions
            .map((item) => `- [${item.status}, severity ${item.severity.toFixed(2)}] ${item.description}`)
            .join("\n")}`
        : "Contradictions: none recorded.",
    );

    if (input.criticisms.length) {
      parts.push(`Unresolved criticism from the skeptic:\n${input.criticisms.map((item) => `- ${item}`).join("\n")}`);
    }
    if (input.openQuestions.length) {
      parts.push(`Questions left open:\n${input.openQuestions.map((item) => `- ${item}`).join("\n")}`);
    }
    if (input.blockedWork.length) {
      parts.push(
        `Work that could not be carried out. These are limitations and must be listed as such:\n${input.blockedWork
          .map((item) => `- ${item}`)
          .join("\n")}`,
      );
    }

    parts.push(
      `Computed overall confidence: ${input.overallConfidence.toFixed(2)}. ` +
        `Sources considered: ${input.statistics.sourcesConsidered}. ` +
        `Evidence items: ${input.statistics.evidenceItems}. ` +
        `Agent runs: ${input.statistics.agentRuns}.`,
      "Write the report as JSON matching the schema.",
    );
    return parts.join("\n\n");
  },
};
