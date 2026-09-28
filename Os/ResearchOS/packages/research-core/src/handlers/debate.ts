/**
 * Adversarial review of a contested claim.
 *
 * A debate is expensive — several model calls plus a judge — so it is run where
 * it earns its cost: a claim the evidence genuinely splits on, or a contradiction
 * between two claims that cannot both be true. Debating a settled claim spends
 * budget to restate agreement.
 *
 * The verdict feeds back into the confidence calculation as `agentAgreement`,
 * which widens the uncertainty interval rather than moving the score. That
 * direction is deliberate: disagreement among reviewers is a reason to be less
 * certain, not a reason to believe something different.
 */
import { CLAIM_STATUSES, type Claim, type TaskOutcome } from "@research-os/contracts";
import { computeConfidence, deriveClaimStatus } from "@research-os/claims";
import type { TaskContext, TaskHandler } from "@research-os/orchestration";
import { summariseChecks } from "@research-os/verification";
import { newId } from "@research-os/shared";
import { runDebate } from "../debate.ts";
import type { ResearchDeps } from "../deps.ts";
import { agentContextFor, completed, emit } from "./support.ts";

/** Claim statuses where an argument could change the answer. */
const WORTH_DEBATING = new Set<Claim["status"]>(["contested", "under_review", "proposed"]);

export function debateRunHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "debate.run",
    leaseMs: 300_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const input = (task.task.input ?? {}) as { claimId?: string; contradictionId?: string; maxRounds?: number };

      const subject = await resolveSubject(deps, task.projectId, input);
      if (!subject) {
        return completed({
          debated: 0,
          note: "Nothing is contested enough to be worth debating. A debate over a settled claim spends budget to restate agreement.",
        });
      }

      const linked = await deps.store.research.evidenceForClaim(subject.claim.id);
      if (linked.length === 0) {
        // With no evidence there is nothing to argue from, and a debate would
        // reduce to two models asserting at each other.
        return completed({ debated: 0, note: "The subject claim cites no evidence; there is nothing to argue from." });
      }

      // The id is minted here rather than inside `runDebate`, so "started" can
      // name the debate it is announcing instead of a placeholder.
      const debateId = newId("debate");
      await emit(deps, task.projectId, "research.debate.started", {
        debateId,
        topic: subject.topic.slice(0, 500),
        subjectType: subject.kind,
        subjectId: subject.subjectId,
      });

      const debate = await runDebate(
        {
          debateId,
          subjectType: subject.kind,
          subjectId: subject.subjectId,
          topic: subject.topic,
          evidence: linked.map(({ link, evidence }) => ({
            id: evidence.id,
            text: `[${link.stance}] "${evidence.quote}" — ${evidence.interpretation}`,
          })),
          ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
        },
        context,
      );

      const verdict = debate.verdict;
      /* c8 ignore next */
      if (!verdict) return completed({ debated: 1, debateId: debate.id, note: "The debate produced no verdict." });

      // Rescore with the judge's agreement level, which widens the interval.
      const sources = await deps.store.research.findSourcesByIds([
        ...new Set(linked.map(({ evidence }) => evidence.sourceId as string)),
      ]);
      const pairs = linked
        .map(({ evidence }) => ({ evidence, source: sources.get(evidence.sourceId as string) }))
        .filter((pair): pair is { evidence: typeof pair.evidence; source: NonNullable<typeof pair.source> } => Boolean(pair.source));

      const checks = await deps.store.runs.listVerificationChecks(task.projectId, 500);
      const now = deps.clock.isoNow();

      const breakdown = computeConfidence({
        evidence: pairs,
        verification: summariseChecks("claim", subject.claim.id, checks.filter((check) => check.targetId === subject.claim.id)),
        agentAgreement: verdict.agreementLevel,
        majorUncertainties: verdict.residualUncertainties,
        now,
      });

      // The judge rules on the *position*; the score stays arithmetic. A
      // "deny" verdict marks the claim refuted, but the number underneath it is
      // still computed from evidence rather than asserted by the judge.
      const status = verdict.position === "deny"
        ? "refuted"
        : verdict.position === "qualify"
          ? "contested"
          : deriveClaimStatus(breakdown);

      await deps.store.research.updateClaim(
        subject.claim.id,
        { confidence: breakdown, status: CLAIM_STATUSES.includes(status) ? status : "under_review" },
        now,
      );

      await emit(deps, task.projectId, "research.debate.judged", {
        debateId: debate.id,
        position: verdict.position,
        agreementLevel: verdict.agreementLevel,
      });
      await emit(deps, task.projectId, "research.claim.updated", { claimId: subject.claim.id, status });

      return completed({
        debated: 1,
        debateId: debate.id,
        claimId: subject.claim.id,
        position: verdict.position,
        agreementLevel: verdict.agreementLevel,
        rounds: debate.rounds,
        newStatus: status,
        confidence: breakdown.score,
        uncertaintyInterval: breakdown.uncertaintyInterval,
        dissent: verdict.dissent.length,
      });
    },
  };
}

interface DebateSubject {
  readonly kind: "claim" | "contradiction";
  readonly subjectId: string;
  readonly claim: Claim;
  readonly topic: string;
}

/**
 * Chooses what to debate.
 *
 * An explicit id wins. Otherwise the most severe open contradiction, then the
 * most uncertain contested claim — because a claim at 0.5 is the one an argument
 * could actually move, while one at 0.95 is settled and debating it buys little.
 */
async function resolveSubject(
  deps: ResearchDeps,
  projectId: string,
  input: { claimId?: string; contradictionId?: string },
): Promise<DebateSubject | null> {
  if (input.claimId) {
    const claim = await deps.store.research.findClaim(input.claimId);
    return claim ? { kind: "claim", subjectId: claim.id, claim, topic: claim.statement } : null;
  }

  const contradictions = await deps.store.research.listContradictions(projectId, "open");
  if (input.contradictionId ?? contradictions.length > 0) {
    const contradiction = input.contradictionId
      ? contradictions.find((item) => item.id === input.contradictionId)
      : [...contradictions].sort((a, b) => b.severity - a.severity)[0];

    if (contradiction) {
      const claimA = await deps.store.research.findClaim(contradiction.claimIdA);
      const claimB = await deps.store.research.findClaim(contradiction.claimIdB);
      if (claimA) {
        return {
          kind: "contradiction",
          subjectId: contradiction.id,
          claim: claimA,
          topic: `${claimA.statement}\n\nThis conflicts with: ${claimB?.statement ?? "another recorded claim"}\n\nRecorded conflict: ${contradiction.description}`,
        };
      }
    }
  }

  const claims = await deps.store.research.listClaims(projectId, { limit: 200 });
  const candidates = claims
    .filter((claim) => WORTH_DEBATING.has(claim.status) && claim.confidence !== null)
    // Most uncertain first: the claim an argument could actually move.
    .sort((a, b) => Math.abs((a.confidence?.score ?? 0.5) - 0.5) - Math.abs((b.confidence?.score ?? 0.5) - 0.5));

  const chosen = candidates[0];
  return chosen ? { kind: "claim", subjectId: chosen.id, claim: chosen, topic: chosen.statement } : null;
}
