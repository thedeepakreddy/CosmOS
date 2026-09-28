/**
 * Research evolution.
 *
 * At the end of a cycle, this reads what changed and says what it means: which
 * findings held, which were overturned, what is now open that was not before,
 * and where the next run should start.
 *
 * The output that matters most is `nextDirections`. Research produces questions
 * as well as answers, and a system that discards them makes every run start from
 * the original question — which is how the same ground gets covered repeatedly
 * while the frontier never moves.
 */
import { z } from "zod";
import type { AgentDefinition } from "../agent.ts";
import { numbered } from "../agent.ts";

export const EvolutionOutput = z.object({
  /** How understanding changed this cycle, in one paragraph. */
  summary: z.string().min(1).max(4000),
  /** Findings that survived scrutiny, by claim index. */
  heldUp: z.array(z.number().int().positive()).default([]),
  /** Findings that were weakened or overturned, with what did it. */
  revised: z.array(z.object({
    claimIndex: z.number().int().positive(),
    whatChanged: z.string().max(2000),
  })).max(10).default([]),
  /** Questions the findings opened that nobody asked at the start. */
  emergentQuestions: z.array(z.object({
    text: z.string().min(1).max(2000),
    whyItArose: z.string().max(2000),
    priority: z.number().int().min(0).max(100),
  })).max(10).default([]),
  /** Where a next run should begin, most valuable first. */
  nextDirections: z.array(z.object({
    direction: z.string().min(1).max(2000),
    rationale: z.string().max(2000),
    /** What a reader would learn that they do not know now. */
    expectedValue: z.string().max(1000),
    priority: z.number().min(0).max(1),
  })).max(8).default([]),
  /**
   * Approaches that did not work, so a later run does not repeat them.
   *
   * Written into failure memory. `transferable` marks the ones that generalise
   * past this project — a source that is paywalled is everyone's problem, a
   * local path that was wrong is nobody else's.
   */
  deadEnds: z.array(z.object({
    approach: z.string().min(1).max(2000),
    reason: z.string().min(1).max(4000),
    lesson: z.string().max(2000).nullable().default(null),
    transferable: z.boolean(),
  })).max(8).default([]),
});
export type EvolutionOutput = z.infer<typeof EvolutionOutput>;

export interface EvolutionInput {
  readonly question: string;
  readonly claims: readonly { statement: string; status: string; confidence: number | null }[];
  readonly contradictions: readonly { description: string; status: string }[];
  readonly openQuestions: readonly string[];
  readonly criticisms: readonly string[];
  /** Tasks that could not be carried out, and why. */
  readonly blockedWork: readonly string[];
  /** Verification failures, which are evidence about the research itself. */
  readonly verificationFailures: readonly string[];
}

export const evolutionAgent: AgentDefinition<EvolutionInput, EvolutionOutput> = {
  role: "research_director",
  taskKind: "synthesis",
  outputSchema: EvolutionOutput,
  maxOutputTokens: 4000,

  systemPrompt: () => `You record how understanding changed during this research cycle.

Three things to produce, in order of how much they matter:

1. **What is now open that was not before.** A finding usually raises a question.
   Name those questions — they are the frontier, and the next run starts there
   rather than at the original question.

2. **Where to go next, and what it would buy.** Not "more research is needed":
   say what would be learned that is not known now. A direction whose value you
   cannot state is not worth carrying forward.

3. **What did not work.** Be specific: the approach, why it failed, and the
   lesson if there is one. Mark it transferable when it would apply to a
   different project — a source that requires a subscription is everyone's
   problem; a local misconfiguration is nobody else's. This is written to
   failure memory and read by future runs before they plan, so an inaccurate
   entry here actively misleads later work.

Also say plainly which findings held up and which were weakened. A claim that
was undermined by criticism or by a failed verification check is a result, not
an embarrassment, and recording it is what stops it quietly persisting.

Work that was blocked is a dead end of the tool kind: record it, because a run
that cannot search the web will fail the same way tomorrow unless someone knows.`,

  userPrompt: (input: EvolutionInput) => {
    const claims = input.claims.map(
      (claim) => `${claim.statement}\n  status: ${claim.status}, confidence: ${claim.confidence === null ? "not computed" : claim.confidence.toFixed(2)}`,
    );
    const parts = [
      `Research question:\n${input.question}`,
      claims.length > 0
        ? `Claims, referenced by index:\n\n${numbered(claims, "Claim")}`
        : "No claims were established.",
    ];

    if (input.contradictions.length > 0) {
      parts.push(
        `Contradictions:\n${input.contradictions.map((item) => `- [${item.status}] ${item.description}`).join("\n")}`,
      );
    }
    if (input.criticisms.length > 0) {
      parts.push(`Unresolved criticism:\n${input.criticisms.map((item) => `- ${item}`).join("\n")}`);
    }
    if (input.verificationFailures.length > 0) {
      parts.push(
        `Verification checks that failed. These are evidence about the research itself:\n${input.verificationFailures.map((item) => `- ${item}`).join("\n")}`,
      );
    }
    if (input.openQuestions.length > 0) {
      parts.push(`Questions still open:\n${input.openQuestions.map((item) => `- ${item}`).join("\n")}`);
    }
    if (input.blockedWork.length > 0) {
      parts.push(
        `Work that could not be carried out. Record these as dead ends of the tool kind:\n${input.blockedWork.map((item) => `- ${item}`).join("\n")}`,
      );
    }

    parts.push("Record how understanding changed, as JSON matching the schema.");
    return parts.join("\n\n");
  },
};
