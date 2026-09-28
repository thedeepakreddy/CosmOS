/**
 * Linking newly-arrived evidence to existing claims, and parking on an external
 * capability.
 *
 * `claim.link_evidence` exists because research is not a single pass. Evidence
 * found in a later cycle bears on claims made in an earlier one, and without
 * this the second source for a claim never reaches it — leaving a claim that
 * looks thinly supported when the support is sitting in the same project.
 *
 * `executor.request` is the park-and-resume half of the executor protocol: the
 * task releases its lease and waits, rather than holding a worker slot while
 * something else does the work.
 */
import { ClaimEvidenceLink, type TaskOutcome } from "@research-os/contracts";
import type { TaskContext, TaskHandler } from "@research-os/orchestration";
import { jaccardSimilarity, tokenizeWords } from "@research-os/shared";
import type { ResearchDeps } from "../deps.ts";
import { blocked, completed, emit } from "./support.ts";

/**
 * Word overlap above which evidence is considered to bear on a claim.
 *
 * Deliberately a mechanical shortlist rather than a model judgement. The model
 * decides *stance* — whether the evidence supports or contradicts — which is the
 * part that needs reading. Deciding *relevance* is a retrieval problem, and
 * spending a model call per (claim, evidence) pair would cost quadratically for
 * a judgement a similarity score makes adequately.
 */
const RELEVANCE_THRESHOLD = 0.12;

export function claimLinkEvidenceHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "claim.link_evidence",
    leaseMs: 120_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const [claims, evidence, existing] = await Promise.all([
        deps.store.research.listClaims(task.projectId, { limit: 300 }),
        deps.store.research.listEvidence(task.projectId, { limit: 1000 }),
        deps.store.research.listEvidenceLinks(task.projectId),
      ]);

      if (claims.length === 0 || evidence.length === 0) {
        return completed({ linked: 0, note: "Nothing to link yet." });
      }

      const alreadyLinked = new Set(existing.map((link) => `${link.claimId}|${link.evidenceId}`));
      const now = deps.clock.isoNow();
      const newLinks: ClaimEvidenceLink[] = [];

      for (const claim of claims) {
        const claimTerms = tokenizeWords(`${claim.statement} ${claim.scope ?? ""}`);

        for (const item of evidence) {
          if (alreadyLinked.has(`${claim.id}|${item.id}`)) continue;

          const similarity = jaccardSimilarity(claimTerms, tokenizeWords(`${item.quote} ${item.interpretation}`));
          if (similarity < RELEVANCE_THRESHOLD) continue;

          newLinks.push(
            ClaimEvidenceLink.parse({
              claimId: claim.id,
              evidenceId: item.id,
              // The stance recorded at extraction is carried over. It was
              // assessed by an agent that had read the passage; re-deciding it
              // here from word overlap would be a worse judgement.
              stance: item.stance,
              rationale: `Linked by overlap (${similarity.toFixed(2)}) between the claim and the evidence text.`,
              linkedByRunId: null,
              createdAt: now,
            }),
          );
        }
      }

      if (newLinks.length > 0) await deps.store.research.linkEvidence(newLinks);
      for (const link of newLinks) {
        await emit(deps, task.projectId, "research.evidence.linked", {
          claimId: link.claimId, evidenceId: link.evidenceId, stance: link.stance,
        });
      }

      return completed({
        linked: newLinks.length,
        claimsConsidered: claims.length,
        evidenceConsidered: evidence.length,
        // Rescoring is a separate task: linking changes the inputs to
        // confidence, and the score should be recomputed by the handler that
        // owns it rather than duplicated here.
        rescoreRequired: newLinks.length > 0,
      });
    },
  };
}

export function executorRequestHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "executor.request",
    leaseMs: 60_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      if (!deps.tools) {
        return blocked("external capability request", "no tool registry is configured");
      }

      const input = (task.task.input ?? {}) as { toolId?: string; capability?: string; payload?: unknown; timeoutMs?: number };
      if (!input.toolId) {
        return { kind: "failed", errorCode: "validation_failed", errorMessage: "executor.request requires a toolId.", retryable: false };
      }

      const descriptor = deps.tools.listAll().find((tool) => tool.id === input.toolId);
      if (!descriptor) {
        return blocked(
          `tool "${input.toolId}"`,
          "no provider serves it. Attach an executor advertising the capability, or remove this step from the plan.",
        );
      }

      const project = await deps.store.projects.findById(task.projectId);
      /* c8 ignore next */
      if (!project) return { kind: "failed", errorCode: "not_found", errorMessage: "Project vanished.", retryable: false };

      const outcome = await deps.tools.call(
        input.toolId,
        input.payload ?? {},
        {
          projectId: task.projectId,
          taskId: task.task.id,
          policy: {
            allowedToolIds: [descriptor.id],
            allowedCapabilities: [descriptor.capability],
            maxRiskLevel: descriptor.riskLevel,
            allowedDomains: [...project.preferences.preferredDomains],
            blockedDomains: [...project.preferences.blockedDomains],
            allowedPathRoots: [],
            maxCallsPerTask: 5,
            maxConcurrentCalls: 2,
            metadata: {},
          },
          signal: task.signal,
        },
        input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
      );

      if (outcome.status === "succeeded") {
        return completed({ toolId: input.toolId, output: outcome.output, durationMs: outcome.durationMs });
      }

      return {
        kind: "failed",
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        // A denial or a missing capability will not resolve itself; a timeout
        // might.
        retryable: outcome.status === "timed_out",
      };
    },
  };
}
