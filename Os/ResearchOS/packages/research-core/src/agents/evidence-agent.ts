/**
 * The Evidence Agent.
 *
 * Reads retrieved passages and extracts evidence: a verbatim quote, what it
 * establishes, and how strongly. It is the agent most able to damage the system
 * by being sloppy, because everything downstream treats its output as fact about
 * a source.
 *
 * So its contract separates the two things agents habitually merge: `quote` is
 * what the source says and is checked character by character, `interpretation` is
 * what the agent thinks it means and is never checked against anything. Keeping
 * them in separate fields is what makes the check possible at all.
 */
import { z } from "zod";
import { EvidenceStance } from "@research-os/contracts";
import type { AgentDefinition } from "../agent.ts";
import { numbered } from "../agent.ts";

export const EvidenceExtractionOutput = z.object({
  items: z.array(z.object({
    /** 1-based index of the passage this came from, as presented in the prompt. */
    passageIndex: z.number().int().positive(),
    /** Verbatim. Mechanically checked against the passage. */
    quote: z.string().min(1).max(4000),
    /** What the agent reads this as establishing. Never checked — kept separate for that reason. */
    interpretation: z.string().min(1).max(2000),
    stance: EvidenceStance,
    relevance: z.number().min(0).max(1),
    strength: z.object({
      directness: z.number().min(0).max(1),
      specificity: z.number().min(0).max(1),
      methodologicalRigor: z.number().min(0).max(1),
      quoteFidelity: z.number().min(0).max(1),
    }),
  })).max(20).default([]),
  /** Stated rather than silently omitted when the passages do not address the question. */
  notes: z.string().max(2000).default(""),
});
export type EvidenceExtractionOutput = z.infer<typeof EvidenceExtractionOutput>;

export interface EvidenceInput {
  readonly question: string;
  readonly passages: readonly { text: string; sourceTitle: string; locator: string | null }[];
}

export const evidenceAgent: AgentDefinition<EvidenceInput, EvidenceExtractionOutput> = {
  role: "evidence_agent",
  taskKind: "extraction",
  outputSchema: EvidenceExtractionOutput,
  maxOutputTokens: 4000,
  temperature: 0,

  systemPrompt: () => `You extract evidence from source passages.

For each passage that genuinely bears on the question, produce one evidence item.

The two fields that matter most:
- quote: copied character for character from the passage. Not tidied, not
  shortened, not corrected. Use "..." only to elide, and only between fragments
  that appear in the passage in that order. This is checked mechanically against
  the passage text; a paraphrase here is recorded as a verification failure
  against the run.
- interpretation: your reading of what the quote establishes. This is where
  inference belongs. Never put inference in the quote.

Scoring guidance:
- relevance: does this passage address the question asked, or something adjacent?
- directness: does it speak to the question itself, or to a proxy for it?
- specificity: a measured effect with numbers scores high; a passing remark low.
- methodologicalRigor: study design and sample where stated. If the passage
  describes no method, score this low rather than guessing.
- quoteFidelity: your own confidence that you copied it exactly.

stance describes how the passage bears on the question: supports, contradicts,
neutral, or mixed. "mixed" is a real answer — use it rather than picking a side.

If none of the passages address the question, return no items and say so in
notes. An empty result that is honest is worth more than a stretched one.`,

  userPrompt: (input: EvidenceInput) => {
    const passages = input.passages.map(
      (passage) => `Source: ${passage.sourceTitle}${passage.locator ? ` (${passage.locator})` : ""}\n${passage.text}`,
    );
    return [
      `Question this evidence should address:\n${input.question}`,
      `Passages:\n\n${numbered(passages, "Passage")}`,
      "Extract evidence as JSON matching the schema. passageIndex refers to the numbered passages above.",
    ].join("\n\n");
  },
};
