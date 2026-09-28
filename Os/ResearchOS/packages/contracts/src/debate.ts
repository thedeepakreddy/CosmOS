import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, UnitInterval } from "./primitives.ts";
import { AgentRole } from "./agent.ts";

/**
 * Adversarial research.
 *
 * A debate is run when agents disagree about a claim or hypothesis. The output
 * is a judged verdict *plus* the full record of positions — the minority view is
 * never discarded, because "three of four agents agreed" is materially
 * different information from "all agents agreed".
 */
export const DEBATE_STATUSES = ["open", "in_progress", "judged", "abandoned"] as const;
export const DebateStatus = z.enum(DEBATE_STATUSES);
export type DebateStatus = z.infer<typeof DebateStatus>;

export const DEBATE_POSITIONS = ["affirm", "deny", "qualify", "abstain"] as const;
export const DebatePosition = z.enum(DEBATE_POSITIONS);
export type DebatePosition = z.infer<typeof DebatePosition>;

export const DebateTurn = z.object({
  round: z.number().int().nonnegative(),
  role: AgentRole,
  runId: idRefSchema("agentRun").nullable(),
  position: DebatePosition,
  argument: z.string().min(1).max(8000),
  /** Evidence the turn actually cites. Arguments without citations are weighted down by the judge. */
  citedEvidenceIds: z.array(idRefSchema("evidence")).default([]),
  /** Specific points in earlier turns this turn rebuts. */
  rebuts: z.array(z.object({ round: z.number().int().nonnegative(), role: AgentRole })).default([]),
  createdAt: IsoDateTime,
});
export type DebateTurn = z.infer<typeof DebateTurn>;

/**
 * The judge's ruling.
 *
 * The judge is explicitly instructed not to average positions. It weighs
 * evidence strength, methodology and source reliability, and must record which
 * of those drove the verdict.
 */
export const DebateVerdict = z.object({
  position: DebatePosition,
  reasoning: z.string().min(1).max(8000),
  /** Which considerations decided it, with the weight the judge gave each. */
  decidingFactors: z.array(
    z.object({
      factor: z.enum([
        "evidence_strength",
        "source_reliability",
        "methodology",
        "replication",
        "internal_consistency",
        "scope_fit",
        "recency",
      ]),
      weight: UnitInterval,
      note: z.string().max(1000),
    }),
  ),
  /** Positions the judge rejected, and why. Preserved rather than dropped. */
  dissent: z.array(z.object({ role: AgentRole, position: DebatePosition, whyRejected: z.string().max(2000) })).default([]),
  /** Judge's read on how aligned the participants were, in [0,1]. Feeds the confidence breakdown. */
  agreementLevel: UnitInterval,
  /** Uncertainties the judge wants carried into the final report. */
  residualUncertainties: z.array(z.string().max(500)).default([]),
  judgedByRunId: idRefSchema("agentRun").nullable(),
  judgedAt: IsoDateTime,
});
export type DebateVerdict = z.infer<typeof DebateVerdict>;

export const Debate = z.object({
  id: idSchema("debate"),
  projectId: idSchema("project"),
  subjectType: z.enum(["claim", "hypothesis", "contradiction"]),
  subjectId: z.string().max(64),
  topic: z.string().min(1).max(2000),
  status: DebateStatus,
  rounds: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  turns: z.array(DebateTurn).default([]),
  verdict: DebateVerdict.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Debate = z.infer<typeof Debate>;
