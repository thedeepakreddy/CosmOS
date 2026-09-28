/**
 * The debate engine.
 *
 * When a claim is contested, an advocate and a skeptic argue it in rounds and a
 * judge rules. Three design choices make this adversarial rather than theatrical:
 *
 *   - **Turns are structured artifacts, not chat messages.** A turn carries a
 *     position, an argument, the evidence it cites and the specific points it
 *     rebuts. That is what lets the judge weigh "cited three sources" against
 *     "asserted confidently", and what lets the record be audited afterwards.
 *   - **The judge is routed to a different provider where one exists.** A model
 *     reviewing its own reasoning tends to repeat it rather than catch it. Where
 *     no second provider is configured the debate still runs, and the verdict
 *     records that it was self-reviewed.
 *   - **Dissent is preserved.** "Three of four agreed" is different information
 *     from "all agreed", and deleting the minority destroys it.
 */
import { z } from "zod";
import type { AgentRole, Debate, DebatePosition, DebateTurn, DebateVerdict } from "@research-os/contracts";
import { newId } from "@research-os/shared";
import { runAgent, type AgentContext, type AgentDefinition } from "./agent.ts";
import { judge } from "./agents/judge.ts";
import { numbered } from "./agent.ts";

export const DebateTurnOutput = z.object({
  position: z.enum(["affirm", "deny", "qualify", "abstain"]),
  argument: z.string().min(1).max(8000),
  /** Evidence indices from the prompt. An argument citing none is weighted down. */
  citedEvidenceIndices: z.array(z.number().int().positive()).default([]),
  /** Specific earlier turns this rebuts, by round. */
  rebutsRounds: z.array(z.number().int().nonnegative()).default([]),
});
export type DebateTurnOutput = z.infer<typeof DebateTurnOutput>;

interface DebatantInput {
  readonly topic: string;
  readonly evidence: readonly string[];
  readonly priorTurns: readonly { round: number; role: string; position: string; argument: string }[];
  readonly instruction: string;
}

/** One debatant. The stance is supplied per call, so the same definition serves both sides. */
function debatant(role: AgentRole): AgentDefinition<DebatantInput, DebateTurnOutput> {
  return {
    role,
    taskKind: "critique",
    outputSchema: DebateTurnOutput,
    maxOutputTokens: 3000,
    systemPrompt: () => `You are arguing a position in a structured research debate.

Argue from the evidence you are given, by index. An argument that cites no
evidence is recorded as citing none, and the judge weighs it accordingly — so
asserting confidently is strictly worse than citing something.

Engage with what the other side actually said. Name the rounds you are rebutting
and address their strongest point, not their weakest.

If the evidence does not support the position you were asked to argue, say so and
choose "qualify" or "abstain". Arguing a position the evidence contradicts wastes
the debate and misleads the judge, whose job is to find what is true rather than
who argued better.`,
    userPrompt: (input: DebatantInput) => {
      const parts = [
        `Matter under debate:\n${input.topic}`,
        `Your role in this round:\n${input.instruction}`,
        `Evidence available (cite by index):\n\n${numbered([...input.evidence], "Evidence")}`,
      ];
      if (input.priorTurns.length > 0) {
        parts.push(
          `Arguments so far:\n\n${input.priorTurns
            .map((turn) => `Round ${turn.round} — ${turn.role} (${turn.position}):\n${turn.argument}`)
            .join("\n\n")}`,
        );
      }
      parts.push("Make your argument as JSON matching the schema.");
      return parts.join("\n\n");
    },
  };
}

export interface DebateOptions {
  readonly subjectType: Debate["subjectType"];
  readonly subjectId: string;
  readonly topic: string;
  /** Evidence quotes, in the order the debatants will cite them by index. */
  readonly evidence: readonly { id: string; text: string }[];
  readonly maxRounds?: number;
  /** Supplied when the caller needs the id before the debate runs, to announce it. */
  readonly debateId?: string;
}

/**
 * Runs a debate to a verdict.
 *
 * Rounds stop early when both sides land on the same position: continuing would
 * spend a model call to restate agreement, and the judge has what it needs.
 */
export async function runDebate(options: DebateOptions, context: AgentContext): Promise<Debate> {
  const maxRounds = options.maxRounds ?? 2;
  const now = context.clock.isoNow();
  const evidenceTexts = options.evidence.map((item) => item.text);

  const turns: DebateTurn[] = [];
  const transcript: { round: number; role: string; position: string; argument: string }[] = [];
  let advocateProvider: string | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    const sides: { role: AgentRole; instruction: string }[] = [
      {
        role: "evidence_agent",
        instruction: round === 1
          ? "Argue that the evidence supports this claim. Cite the strongest evidence you have."
          : "Respond to the objections raised. Concede any point that stands.",
      },
      {
        role: "skeptic",
        instruction: round === 1
          ? "Argue that the evidence does not support this claim, or supports it only under narrower conditions."
          : "Respond to the defence. Press any objection that was not answered.",
      },
    ];

    const positionsThisRound: DebatePosition[] = [];

    for (const side of sides) {
      const result = await runAgent(
        debatant(side.role),
        { topic: options.topic, evidence: evidenceTexts, priorTurns: transcript, instruction: side.instruction },
        context,
      );
      if (side.role === "evidence_agent" && !advocateProvider) advocateProvider = result.provider;

      const citedEvidenceIds = result.output.citedEvidenceIndices
        .map((index) => options.evidence[index - 1]?.id)
        .filter((id): id is string => Boolean(id));

      turns.push({
        round,
        role: side.role,
        runId: result.runId,
        position: result.output.position,
        argument: result.output.argument,
        citedEvidenceIds,
        rebuts: result.output.rebutsRounds.map((rebutRound) => ({ round: rebutRound, role: side.role })),
        createdAt: context.clock.isoNow(),
      } as DebateTurn);

      transcript.push({ round, role: side.role, position: result.output.position, argument: result.output.argument });
      positionsThisRound.push(result.output.position);
    }

    // Both sides landing on the same position means the disagreement is over.
    // Another round would spend a model call restating agreement, and the judge
    // already has what it needs.
    if (new Set(positionsThisRound).size === 1) {
      context.logger.info("Debate converged early", { round, position: positionsThisRound[0] });
      break;
    }
  }

  // The judge is routed away from whoever argued in favour, where a second
  // provider exists. `decision.independent` records whether that succeeded.
  const ruling = await runAgent(
    judge,
    {
      topic: options.topic,
      turns: turns.map((turn) => ({
        round: turn.round,
        role: turn.role,
        position: turn.position,
        argument: turn.argument,
        citedEvidenceCount: turn.citedEvidenceIds.length,
      })),
    },
    context,
    { ...(advocateProvider ? { excludeProvider: advocateProvider } : {}) },
  );

  const verdict: DebateVerdict = {
    position: ruling.output.position,
    reasoning: ruling.output.reasoning,
    decidingFactors: ruling.output.decidingFactors,
    dissent: ruling.output.dissent.map((entry) => ({
      role: (entry.roleName === "skeptic" ? "skeptic" : "evidence_agent") as AgentRole,
      position: entry.position,
      whyRejected: entry.whyRejected,
    })),
    agreementLevel: ruling.output.agreementLevel,
    residualUncertainties: [
      ...ruling.output.residualUncertainties,
      // Recorded as an uncertainty rather than buried in a log: a verdict
      // reached without a second opinion is a weaker result, and the report
      // should be able to say so.
      ...(ruling.decision.independenceRequested && !ruling.decision.independent
        ? ["The verdict was reached by the same provider that argued in favour; no independent judge was available."]
        : []),
    ],
    judgedByRunId: ruling.runId,
    judgedAt: context.clock.isoNow(),
  } as DebateVerdict;

  const debate: Debate = {
    id: options.debateId ?? newId("debate"),
    projectId: context.projectId,
    subjectType: options.subjectType,
    subjectId: options.subjectId,
    topic: options.topic,
    status: "judged",
    rounds: Math.max(...turns.map((turn) => turn.round), 0),
    maxRounds,
    turns,
    verdict,
    createdAt: now,
    updatedAt: context.clock.isoNow(),
  } as Debate;

  await context.store.runs.saveDebate(debate);
  return debate;
}
