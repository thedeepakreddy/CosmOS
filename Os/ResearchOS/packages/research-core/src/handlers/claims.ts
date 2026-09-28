/**
 * Claim extraction, scoring, contradiction detection and verification.
 *
 * The scoring handler is where the system's central commitment lives: no model
 * ever produces a confidence number. Models assess narrow, checkable properties
 * — is this quote faithful, how rigorous is the design, does this passage
 * address the claim — and those become weights. The score is arithmetic over
 * them, recomputed from stored inputs, and reproducible by hand.
 */
import {
  Claim, ClaimEvidenceLink, Contradiction, CritiqueFinding, type TaskOutcome,
} from "@research-os/contracts";
import { computeConfidence, contradictionSeverity, deriveClaimStatus, detectContradictionCandidates } from "@research-os/claims";
import type { TaskContext, TaskHandler } from "@research-os/orchestration";
import { hasBlockingFailure, summariseChecks, verifyClaim, verifyEvidence } from "@research-os/verification";
import { newId } from "@research-os/shared";
import { runAgent } from "../agent.ts";
import { claimExtractor } from "../agents/claim-extractor.ts";
import { skeptic } from "../agents/skeptic.ts";
import type { ResearchDeps } from "../deps.ts";
import { agentContextFor, completed, emit } from "./support.ts";

export function claimExtractHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "claim.extract",
    leaseMs: 180_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const project = await deps.store.projects.findById(task.projectId);
      /* c8 ignore next */
      if (!project) return { kind: "failed", errorCode: "not_found", errorMessage: "Project vanished.", retryable: false };

      const evidence = await deps.store.research.listEvidence(task.projectId, { limit: 60 });
      if (evidence.length === 0) {
        return completed({ claims: 0, note: "No evidence has been extracted yet; there is nothing to make claims from." });
      }

      const sources = await deps.store.research.findSourcesByIds([...new Set(evidence.map((item) => item.sourceId as string))]);

      const result = await runAgent(
        claimExtractor,
        {
          question: project.originalQuestion,
          evidence: evidence.map((item) => ({
            quote: item.quote,
            interpretation: item.interpretation,
            sourceTitle: sources.get(item.sourceId as string)?.title ?? "Unknown source",
            stance: item.stance,
          })),
        },
        context,
      );

      const now = deps.clock.isoNow();
      const claims: Claim[] = [];
      const links: ClaimEvidenceLink[] = [];

      for (const proposed of result.output.claims) {
        const cited = proposed.evidence
          .map((reference) => ({ reference, item: evidence[reference.evidenceIndex - 1] }))
          .filter((entry): entry is { reference: typeof entry.reference; item: NonNullable<typeof entry.item> } => Boolean(entry.item));

        // A claim whose every citation was invented has nothing behind it and
        // is discarded rather than stored as an unsupported assertion.
        if (cited.length === 0) {
          task.logger.warn("Claim discarded: every cited evidence index was out of range", { statement: proposed.statement });
          continue;
        }

        const claim = Claim.parse({
          id: newId("claim"),
          projectId: task.projectId,
          questionId: null,
          hypothesisId: null,
          statement: proposed.statement,
          scope: proposed.scope,
          claimType: proposed.claimType,
          status: "proposed",
          assumptions: proposed.assumptions,
          confidence: null,
          proposedByRunId: result.runId,
          supersededByClaimId: null,
          createdAt: now,
          updatedAt: now,
        });
        claims.push(claim);

        for (const entry of cited) {
          links.push(
            ClaimEvidenceLink.parse({
              claimId: claim.id,
              evidenceId: entry.item.id,
              stance: entry.reference.stance,
              rationale: entry.reference.rationale,
              linkedByRunId: result.runId,
              createdAt: now,
            }),
          );
        }
      }

      await deps.store.transaction(async (tx) => {
        for (const claim of claims) await tx.research.addClaim(claim);
        if (links.length > 0) await tx.research.linkEvidence(links);
      });

      for (const claim of claims) {
        await emit(deps, task.projectId, "research.claim.created", {
          claimId: claim.id, statement: claim.statement, claimType: claim.claimType,
        });
      }

      return completed({
        claims: claims.length,
        claimIds: claims.map((claim) => claim.id),
        unsupportable: result.output.unsupportable,
      });
    },
  };
}

/**
 * Scores every claim in the project.
 *
 * Verification runs first and feeds the score: a claim whose quote could not be
 * found in its source must not read as well-evidenced. That ordering is the
 * whole reason the two are in one handler.
 */
export function claimScoreHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "claim.score",
    leaseMs: 120_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const now = deps.clock.isoNow();
      const claims = await deps.store.research.listClaims(task.projectId, { limit: 500 });
      if (claims.length === 0) return completed({ scored: 0 });

      const allEvidence = await deps.store.research.listEvidence(task.projectId, { limit: 1000 });
      const sources = await deps.store.research.findSourcesByIds([...new Set(allEvidence.map((item) => item.sourceId as string))]);
      const checks = await deps.store.runs.listVerificationChecks(task.projectId, 1000);

      let scored = 0;
      const blocked: string[] = [];

      for (const claim of claims) {
        const linked = await deps.store.research.evidenceForClaim(claim.id);
        const pairs = linked
          .map(({ evidence }) => ({ evidence, source: sources.get(evidence.sourceId as string) }))
          .filter((pair): pair is { evidence: typeof pair.evidence; source: NonNullable<typeof pair.source> } => Boolean(pair.source));

        const claimChecks = checks.filter((check) => check.targetId === claim.id);
        const evidenceChecks = checks.filter((check) => linked.some(({ evidence }) => evidence.id === check.targetId));
        const relevant = [...claimChecks, ...evidenceChecks];

        const summary = summariseChecks("claim", claim.id, claimChecks);
        const breakdown = computeConfidence({
          evidence: pairs,
          verification: summary.total > 0 ? summary : null,
          majorUncertainties: relevant.filter((check) => check.outcome === "failed").map((check) => check.detail),
          now,
        });

        // A failed citation-fidelity or traceability check is not a
        // consideration to be weighed — it invalidates the finding.
        const blockedByVerification = hasBlockingFailure(relevant);
        const status = blockedByVerification ? "insufficient_evidence" : deriveClaimStatus(breakdown);
        if (blockedByVerification) blocked.push(claim.id);

        await deps.store.research.updateClaim(claim.id, { confidence: breakdown, status }, now);
        await emit(deps, task.projectId, "research.claim.scored", {
          claimId: claim.id,
          confidence: breakdown.score,
          supporting: breakdown.supportingCount,
          contradicting: breakdown.contradictingCount,
        });
        scored++;
      }
      return completed({ scored, blockedByVerification: blocked });
    },
  };
}

export function verificationHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "verification.run",
    leaseMs: 120_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = { projectId: task.projectId, now: deps.clock.isoNow(), runId: null };
      const evidence = await deps.store.research.listEvidence(task.projectId, { limit: 500 });
      const claims = await deps.store.research.listClaims(task.projectId, { limit: 500 });
      const links = await deps.store.research.listEvidenceLinks(task.projectId);

      const checks = [];

      for (const item of evidence) {
        // Checked against the chunks it names, which is what makes a quote
        // verifiable at all.
        const chunks = await deps.store.research.findChunks(item.chunkIds as string[]);
        const evidenceChecks = verifyEvidence(item, chunks, context);
        checks.push(...evidenceChecks);

        const passed = evidenceChecks.find((check) => check.checkType === "citation_fidelity");
        if (passed && passed.outcome !== "inconclusive") {
          await deps.store.research.markEvidenceVerified(item.id, passed.outcome === "passed", context.now);
        }
      }

      for (const claim of claims) {
        const linked = await deps.store.research.evidenceForClaim(claim.id);
        checks.push(
          ...verifyClaim(
            {
              claim,
              evidence: linked.map(({ evidence: item }) => item),
              acceptedClaims: claims.filter((other) => other.id !== claim.id),
              evidenceLinks: links,
            },
            context,
          ),
        );
      }

      if (checks.length > 0) await deps.store.runs.addVerificationChecks(checks);

      const failed = checks.filter((check) => check.outcome === "failed").length;
      // Reported against the project: this handler checks the whole of it, and
      // the per-target detail is in the stored checks.
      await emit(deps, task.projectId, "research.verification.completed", {
        targetType: "project",
        targetId: task.projectId,
        passed: checks.filter((check) => check.outcome === "passed").length,
        failed,
      });

      return completed({
        checks: checks.length,
        passed: checks.filter((check) => check.outcome === "passed").length,
        failed,
        inconclusive: checks.filter((check) => check.outcome === "inconclusive").length,
      });
    },
  };
}

export function contradictionDetectHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "contradiction.detect",
    leaseMs: 60_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const claims = await deps.store.research.listClaims(task.projectId, { limit: 500 });
      const links = await deps.store.research.listEvidenceLinks(task.projectId);
      const candidates = detectContradictionCandidates(claims, links);
      const now = deps.clock.isoNow();

      const existing = await deps.store.research.listContradictions(task.projectId);
      const alreadyKnown = new Set(existing.map((item) => pairKey(item.claimIdA, item.claimIdB)));

      const byId = new Map(claims.map((claim) => [claim.id as string, claim]));
      const created: Contradiction[] = [];

      for (const candidate of candidates) {
        if (alreadyKnown.has(pairKey(candidate.claimIdA, candidate.claimIdB))) continue;
        const claimA = byId.get(candidate.claimIdA);
        const claimB = byId.get(candidate.claimIdB);
        /* c8 ignore next */
        if (!claimA || !claimB) continue;

        const contradiction = Contradiction.parse({
          id: newId("contradiction"),
          projectId: task.projectId,
          claimIdA: candidate.claimIdA,
          claimIdB: candidate.claimIdB,
          kind: candidate.kind,
          status: "open",
          // The observable fact that triggered the candidate, not a narrative.
          // Severity weighs both claims' confidence: two confident claims in
          // conflict is a serious problem, one confident and one not is
          // probably just the weak one being wrong.
          description: candidate.evidence,
          severity: contradictionSeverity(claimA, claimB, candidate.signalStrength),
          candidateExplanations: [],
          resolution: null,
          resolvedByRunId: null,
          detectedByRunId: null,
          createdAt: now,
          updatedAt: now,
        });
        await deps.store.research.addContradiction(contradiction);
        created.push(contradiction);
      }

      for (const contradiction of created) {
        await emit(deps, task.projectId, "research.contradiction.detected", {
          contradictionId: contradiction.id,
          claimIdA: contradiction.claimIdA,
          claimIdB: contradiction.claimIdB,
          severity: contradiction.severity,
        });
      }
      return completed({ detected: created.length, alreadyKnown: alreadyKnown.size });
    },
  };
}

const pairKey = (a: string, b: string): string => [a, b].sort().join("|");

export function critiqueHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "critique.run",
    leaseMs: 180_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const project = await deps.store.projects.findById(task.projectId);
      /* c8 ignore next */
      if (!project) return { kind: "failed", errorCode: "not_found", errorMessage: "Project vanished.", retryable: false };

      const claims = await deps.store.research.listClaims(task.projectId, { limit: 100 });
      if (claims.length === 0) {
        return completed({ findings: 0, note: "No claims to critique yet." });
      }

      const sources = await deps.store.research.listSources(task.projectId, { limit: 500 });
      const summaries = [];
      for (const claim of claims) {
        const linked = await deps.store.research.evidenceForClaim(claim.id);
        summaries.push({
          statement: claim.statement,
          confidence: claim.confidence?.score ?? null,
          evidenceCount: linked.length,
          sourceCount: new Set(linked.map(({ evidence }) => evidence.sourceId as string)).size,
        });
      }

      const result = await runAgent(
        skeptic,
        { question: project.originalQuestion, claims: summaries, sourcesConsidered: sources.length },
        context,
      );

      const now = deps.clock.isoNow();
      const findings = result.output.findings.map((finding) =>
        CritiqueFinding.parse({
          id: newId("finding"),
          projectId: task.projectId,
          kind: finding.kind,
          status: "open",
          // targetIndex 0 means the research as a whole, which has no row to
          // point at — recorded against the project itself.
          targetType: finding.targetIndex === 0 ? "project" : "claim",
          targetId: finding.targetIndex === 0 ? task.projectId : (claims[finding.targetIndex - 1]?.id ?? task.projectId),
          description: finding.description,
          resolutionCriteria: finding.resolutionCriteria,
          severity: finding.severity,
          raisedByRunId: result.runId,
          resolvedByRunId: null,
          resolution: null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      if (findings.length > 0) await deps.store.runs.addFindings(findings);
      for (const finding of findings) {
        // A critique of the project as a whole has no claim to attach to; those
        // are recorded but not emitted as a claim challenge.
        if (finding.targetType !== "claim") continue;
        await emit(deps, task.projectId, "research.claim.challenged", {
          claimId: finding.targetId, findingId: finding.id, kind: finding.kind, severity: finding.severity,
        });
      }

      return completed({
        findings: findings.length,
        alternativeExplanations: result.output.alternativeExplanations,
        missingEvidence: result.output.missingEvidence,
        overallAssessment: result.output.overallAssessment,
      });
    },
  };
}
