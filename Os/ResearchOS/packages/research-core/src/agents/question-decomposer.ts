/**
 * Breaking a question into answerable parts.
 *
 * Distinct from the Director's initial plan: this runs *during* a research run,
 * when a finding has opened a question nobody asked at the start. That is how
 * research actually goes, and a system that can only decompose once is a system
 * that cannot follow what it finds.
 *
 * Questions produced here are `emergent` rather than `sub`, so a reader can tell
 * which parts of the enquiry were planned and which the evidence forced.
 */
import { z } from "zod";
import type { AgentDefinition } from "../agent.ts";

export const QuestionDecompositionOutput = z.object({
  subQuestions: z.array(z.object({
    text: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(2000),
    /** Higher means more worth answering next. */
    priority: z.number().int().min(0).max(100),
    /** What answering it would settle about the parent question. */
    contributesBy: z.string().max(1000),
    /** Whether existing evidence might already answer it. */
    likelyAnswerable: z.enum(["from_existing_evidence", "needs_new_sources", "needs_experiment", "unanswerable"]),
  })).max(10).default([]),
  /** Stated when the question is already atomic and should not be split. */
  alreadyAtomic: z.boolean().default(false),
  notes: z.string().max(2000).default(""),
});
export type QuestionDecompositionOutput = z.infer<typeof QuestionDecompositionOutput>;

export interface QuestionDecompositionInput {
  readonly parentQuestion: string;
  readonly overallQuestion: string;
  /** What is already known, so the decomposition does not re-ask settled things. */
  readonly establishedClaims: readonly string[];
  readonly existingQuestions: readonly string[];
}

export const questionDecomposer: AgentDefinition<QuestionDecompositionInput, QuestionDecompositionOutput> = {
  role: "research_director",
  taskKind: "planning",
  outputSchema: QuestionDecompositionOutput,
  maxOutputTokens: 3000,

  systemPrompt: () => `You break a research question into parts that can be answered independently.

A good sub-question can be answered by looking at evidence, on its own, without
first answering the others. A bad one is a restatement of the parent with
different words, or a step in a method rather than a question about the world.

Judge answerability honestly:
- from_existing_evidence: the material already gathered probably settles it.
- needs_new_sources: it is answerable, but not from what is held.
- needs_experiment: only a measurement would settle it.
- unanswerable: no evidence could settle it as posed. Say so rather than
  producing a question that will waste a run.

If the question is already atomic, set alreadyAtomic and return none. Splitting
an atomic question produces sub-questions that are all the same question, and
each one then costs a full research cycle to answer identically.

Do not re-ask what the established claims already answer, and do not duplicate a
question already on the list.`,

  userPrompt: (input: QuestionDecompositionInput) => {
    const parts = [
      `Overall research question:\n${input.overallQuestion}`,
      `Question to decompose:\n${input.parentQuestion}`,
    ];
    if (input.establishedClaims.length > 0) {
      parts.push(
        `Already established — do not re-ask these:\n${input.establishedClaims.map((claim) => `- ${claim}`).join("\n")}`,
      );
    }
    if (input.existingQuestions.length > 0) {
      parts.push(
        `Questions already being pursued:\n${input.existingQuestions.map((question) => `- ${question}`).join("\n")}`,
      );
    }
    parts.push("Decompose as JSON matching the schema.");
    return parts.join("\n\n");
  },
};
