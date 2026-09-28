/**
 * The Research Director.
 *
 * Turns a question into a plan: sub-questions, hypotheses, and an ordered set of
 * steps with dependencies. It is the only agent that decides *what research to
 * do*; every other role executes within the frame it sets.
 *
 * Two things it is explicitly asked for that a naive planner omits: falsification
 * criteria on every hypothesis, and an acknowledgement of what would make the
 * question unanswerable. A hypothesis with no falsification criteria is not
 * testable, and a plan that cannot fail is not a plan.
 */
import { z } from "zod";
import { TaskType } from "@research-os/contracts";
import type { AgentContext, AgentDefinition } from "../agent.ts";

export const DirectorPlanOutput = z.object({
  /** Restated so the caller can see how the question was understood. */
  interpretation: z.string().min(1).max(2000),
  objectives: z.array(z.object({
    statement: z.string().min(1).max(2000),
    rationale: z.string().max(2000),
  })).min(1).max(8),
  subQuestions: z.array(z.object({
    text: z.string().min(1).max(2000),
    rationale: z.string().max(2000),
    priority: z.number().int().min(0).max(100),
  })).min(1).max(12),
  hypotheses: z.array(z.object({
    statement: z.string().min(1).max(2000),
    rationale: z.string().max(2000),
    /** What observation would refute this. A hypothesis without one is not testable. */
    falsificationCriteria: z.string().min(1).max(2000),
  })).max(8).default([]),
  strategy: z.string().min(1).max(4000),
  steps: z.array(z.object({
    key: z.string().min(1).max(100),
    type: TaskType,
    description: z.string().max(2000),
    dependsOnKeys: z.array(z.string().max(100)).default([]),
    searchQueries: z.array(z.string().max(500)).default([]),
    priority: z.number().int().min(0).max(100).default(50),
  })).min(1).max(40),
  /** Conditions under which this question cannot be answered from available evidence. */
  unanswerableIf: z.array(z.string().max(1000)).default([]),
});
export type DirectorPlanOutput = z.infer<typeof DirectorPlanOutput>;

export interface DirectorInput {
  readonly question: string;
  readonly description?: string | null;
  /** Lessons from earlier projects, and dead ends already recorded. */
  readonly priorLessons?: readonly string[];
  readonly knownDeadEnds?: readonly string[];
}

export const researchDirector: AgentDefinition<DirectorInput, DirectorPlanOutput> = {
  role: "research_director",
  taskKind: "planning",
  outputSchema: DirectorPlanOutput,
  maxOutputTokens: 4000,

  systemPrompt: (context: AgentContext) => `You are the Research Director.

Decompose a research question into a plan that can be executed by specialist
agents and checked by someone who was not present.

What a good plan does:
- Breaks the question into sub-questions that are independently answerable.
  A sub-question nobody could answer from evidence is not a sub-question.
- States hypotheses with falsification criteria. If no observation could refute
  it, it is a position, not a hypothesis, and it does not belong here.
- Orders steps by dependency, with dependsOnKeys. Evidence extraction depends on
  discovery. Do NOT plan a source.ingest step: ingestion is created
  automatically for each source discovery finds, because only discovery knows
  the URLs. A planned source.ingest has no URL to work on, fails, and strands
  every step that depends on it.
- Says what would make the question unanswerable, before any work is done.
- ALWAYS includes a verification.run step and a claim.score step once any claims
  are produced. Every quotation is checked against the source it cites, and every
  confidence number is computed from evidence — a report without them states
  findings nobody has checked. Both are appended automatically if you omit them,
  but you can place them better than that fallback can.

Depth for this run: ${context.preferences.depth}. A shallow run should produce
fewer, broader steps; an exhaustive one should decompose further and plan for
contradictory evidence explicitly.

Step types available: source.discover, evidence.extract, claim.extract,
claim.link_evidence, claim.score, contradiction.detect, critique.run,
verification.run, experiment.design, report.generate.

source.ingest is deliberately absent from that list — it is scheduled for you.

For source.discover steps, supply concrete searchQueries — the terms a
researcher would actually type, not a restatement of the question.`,

  userPrompt: (input: DirectorInput) => {
    const parts = [`Research question:\n${input.question}`];
    if (input.description) parts.push(`Additional context supplied by the caller:\n${input.description}`);
    if (input.priorLessons?.length) {
      parts.push(
        `Lessons recorded from earlier research in this tenant. Take these into account:\n` +
          input.priorLessons.map((lesson) => `- ${lesson}`).join("\n"),
      );
    }
    if (input.knownDeadEnds?.length) {
      parts.push(
        `Approaches already tried and found not to work. Do not plan these again unless you explain what is different this time:\n` +
          input.knownDeadEnds.map((deadEnd) => `- ${deadEnd}`).join("\n"),
      );
    }
    parts.push("Produce the plan as JSON matching the schema.");
    return parts.join("\n\n");
  },
};
