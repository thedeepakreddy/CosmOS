/**
 * Question decomposition, hypothesis generation and research evolution.
 *
 * The three handlers that make a run generative rather than merely executing a
 * plan written before anything was known. Each reads what the research has
 * found and adds to the work: a question that arose, an explanation worth
 * testing, a direction for next time.
 *
 * Evolution is also where failure memory is written. A dead end recorded here
 * is read by the next run's planner before it plans, which is the mechanism
 * that stops the same unproductive approach being tried repeatedly.
 */
import {
  FailureRecord, Hypothesis, ResearchQuestion, type TaskOutcome,
} from "@research-os/contracts";
import type { TaskContext, TaskHandler } from "@research-os/orchestration";
import { newId } from "@research-os/shared";
import { runAgent } from "../agent.ts";
import { evolutionAgent } from "../agents/evolution.ts";
import { hypothesisGenerator } from "../agents/hypothesis-generator.ts";
import { questionDecomposer } from "../agents/question-decomposer.ts";
import type { ResearchDeps } from "../deps.ts";
import { agentContextFor, completed, emit } from "./support.ts";

export function questionDecomposeHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "question.decompose",
    leaseMs: 120_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const project = await deps.store.projects.findById(task.projectId);
      /* c8 ignore next */
      if (!project) return { kind: "failed", errorCode: "not_found", errorMessage: "Project vanished.", retryable: false };

      const input = (task.task.input ?? {}) as { questionId?: string; question?: string };
      const existing = await deps.store.projects.listQuestions(task.projectId);
      const parent = input.questionId ? existing.find((question) => question.id === input.questionId) : undefined;
      const parentText = input.question ?? parent?.text ?? project.originalQuestion;

      const claims = await deps.store.research.listClaims(task.projectId, { limit: 100 });

      const result = await runAgent(
        questionDecomposer,
        {
          parentQuestion: parentText,
          overallQuestion: project.originalQuestion,
          establishedClaims: claims
            .filter((claim) => claim.status === "supported" || claim.status === "refuted")
            .map((claim) => claim.statement),
          existingQuestions: existing.map((question) => question.text),
        },
        context,
      );

      if (result.output.alreadyAtomic || result.output.subQuestions.length === 0) {
        return completed({ added: 0, alreadyAtomic: true, notes: result.output.notes });
      }

      const now = deps.clock.isoNow();
      const questions = result.output.subQuestions
        // A sub-question nobody could answer wastes a full research cycle to
        // discover that. Recorded as deferred rather than queued.
        .map((sub) =>
          ResearchQuestion.parse({
            id: newId("question"),
            projectId: task.projectId,
            parentQuestionId: parent?.id ?? null,
            text: sub.text,
            // `emergent` rather than `sub`, so a reader can tell which parts of
            // the enquiry were planned and which the evidence forced.
            kind: "emergent",
            status: sub.likelyAnswerable === "unanswerable" ? "unanswerable" : "open",
            rationale: `${sub.rationale} (${sub.contributesBy})`,
            priority: sub.priority,
            answerClaimIds: [],
            createdAt: now,
            updatedAt: now,
          }),
        );

      await deps.store.projects.addQuestions(questions);
      for (const question of questions) {
        await emit(deps, task.projectId, "research.question.added", {
          questionId: question.id, text: question.text, kind: question.kind,
        });
      }

      return completed({
        added: questions.length,
        unanswerable: result.output.subQuestions.filter((sub) => sub.likelyAnswerable === "unanswerable").length,
        questionIds: questions.map((question) => question.id),
      });
    },
  };
}

export function hypothesisGenerateHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "hypothesis.generate",
    leaseMs: 120_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const project = await deps.store.projects.findById(task.projectId);
      /* c8 ignore next */
      if (!project) return { kind: "failed", errorCode: "not_found", errorMessage: "Project vanished.", retryable: false };

      const [claims, contradictions, questions, existing, deadEnds] = await Promise.all([
        deps.store.research.listClaims(task.projectId, { limit: 100 }),
        deps.store.research.listContradictions(task.projectId),
        deps.store.projects.listQuestions(task.projectId),
        deps.store.projects.listHypotheses(task.projectId),
        deps.store.runs.transferableFailures(task.projectId, 10),
      ]);

      const result = await runAgent(
        hypothesisGenerator,
        {
          question: project.originalQuestion,
          claims: claims.map((claim) => ({
            statement: claim.statement,
            status: claim.status,
            confidence: claim.confidence?.score ?? null,
          })),
          contradictions: contradictions
            .filter((item) => item.status === "open" || item.status === "investigating")
            .map((item) => item.description),
          openQuestions: questions.filter((question) => question.status === "open").map((question) => question.text),
          existingHypotheses: existing.map((hypothesis) => hypothesis.statement),
          knownDeadEnds: deadEnds.map((failure) => `${failure.approach} — ${failure.reason}`),
        },
        context,
      );

      const now = deps.clock.isoNow();
      // The plausibility band becomes a prior. A model-asserted probability
      // would be an unearned number; a band mapped to a fixed prior is a stated
      // convention anyone can check.
      const priorFor = (band: "speculative" | "plausible" | "likely"): number =>
        band === "likely" ? 0.6 : band === "plausible" ? 0.4 : 0.25;

      const hypotheses = result.output.hypotheses.map((proposed) =>
        Hypothesis.parse({
          id: newId("hypothesis"),
          projectId: task.projectId,
          questionId: null,
          statement: proposed.statement,
          rationale: proposed.rationale,
          status: "proposed",
          falsificationCriteria: proposed.falsificationCriteria,
          priorConfidence: priorFor(proposed.plausibility),
          posteriorConfidence: null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      if (hypotheses.length > 0) await deps.store.projects.addHypotheses(hypotheses);
      for (const hypothesis of hypotheses) {
        await emit(deps, task.projectId, "research.hypothesis.created", {
          hypothesisId: hypothesis.id, statement: hypothesis.statement,
        });
      }

      return completed({
        generated: hypotheses.length,
        hypothesisIds: hypotheses.map((hypothesis) => hypothesis.id),
        testableByExperiment: result.output.hypotheses.filter((item) => item.testableBy === "experiment").length,
        discarded: result.output.discarded,
      });
    },
  };
}

export function evolutionDeriveHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "evolution.derive",
    leaseMs: 180_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const project = await deps.store.projects.findById(task.projectId);
      /* c8 ignore next */
      if (!project) return { kind: "failed", errorCode: "not_found", errorMessage: "Project vanished.", retryable: false };

      const [claims, contradictions, questions, findings, checks] = await Promise.all([
        deps.store.research.listClaims(task.projectId, { limit: 200 }),
        deps.store.research.listContradictions(task.projectId),
        deps.store.projects.listQuestions(task.projectId),
        deps.store.runs.listFindings(task.projectId, { status: "open" }),
        deps.store.runs.listVerificationChecks(task.projectId, 500),
      ]);

      const blockedWork = (await deps.store.tasks.list(task.projectId, { status: "failed", limit: 100 }))
        .filter((failed) => (failed.errorMessage ?? "").startsWith("BLOCKED:"))
        .map((failed) => `${failed.type}: ${(failed.errorMessage ?? "").replace(/^BLOCKED:\s*/, "")}`);

      const result = await runAgent(
        evolutionAgent,
        {
          question: project.originalQuestion,
          claims: claims.map((claim) => ({
            statement: claim.statement,
            status: claim.status,
            confidence: claim.confidence?.score ?? null,
          })),
          contradictions: contradictions.map((item) => ({ description: item.description, status: item.status })),
          openQuestions: questions.filter((question) => question.status === "open").map((question) => question.text),
          criticisms: findings.map((finding) => finding.description),
          blockedWork,
          verificationFailures: checks
            .filter((check) => check.outcome === "failed")
            .map((check) => `${check.checkType}: ${check.detail}`),
        },
        context,
      );

      const now = deps.clock.isoNow();

      const emergent = result.output.emergentQuestions.map((question) =>
        ResearchQuestion.parse({
          id: newId("question"),
          projectId: task.projectId,
          parentQuestionId: null,
          text: question.text,
          kind: "emergent",
          status: "open",
          rationale: question.whyItArose,
          priority: question.priority,
          answerClaimIds: [],
          createdAt: now,
          updatedAt: now,
        }),
      );

      /*
       * Dead ends go to failure memory, where the next run's planner reads them
       * before planning. This is the whole mechanism behind not repeating a
       * failed approach.
       *
       * Deduplicated first. Evolution runs at the end of every cycle, and a run
       * that hits the same wall three times would record it three times — after
       * which the planner reads one lesson repeatedly and the genuinely distinct
       * dead ends are crowded out of its limit.
       */
      const failures: FailureRecord[] = [];
      // Within the batch as well as against the database: both copies of a
      // repeated dead end are written at the end, so neither would see the
      // other in a stored-only check.
      const seenThisBatch = new Set<string>();
      let duplicates = 0;

      for (const deadEnd of result.output.deadEnds) {
        const kind = classifyDeadEnd(deadEnd.approach, deadEnd.reason);
        const key = `${kind}|${deadEnd.approach.trim().toLowerCase()}`;
        if (seenThisBatch.has(key) || await deps.store.runs.hasSimilarFailure(task.projectId, kind, deadEnd.approach)) {
          duplicates++;
          continue;
        }
        seenThisBatch.add(key);
        failures.push(
          FailureRecord.parse({
            id: newId("failure"),
            projectId: task.projectId,
            kind,
            approach: deadEnd.approach,
            reason: deadEnd.reason,
            lesson: deadEnd.lesson,
            context: { derivedFromRunId: result.runId },
            transferable: deadEnd.transferable,
            recordedByRunId: result.runId,
            createdAt: now,
          }),
        );
      }

      await deps.store.transaction(async (tx) => {
        if (emergent.length > 0) await tx.projects.addQuestions(emergent);
        for (const failure of failures) await tx.runs.addFailure(failure);
      });

      // Directions worth pursuing are remembered as lessons, so a later project
      // on a related question starts from them.
      if (deps.memory && result.output.nextDirections.length > 0) {
        for (const direction of result.output.nextDirections.slice(0, 3)) {
          await deps.memory.rememberLesson(
            task.projectId,
            `direction:${direction.direction.slice(0, 60)}`,
            `${direction.direction} — ${direction.rationale}`,
            ["next-direction"],
          );
        }
      }

      for (const question of emergent) {
        await emit(deps, task.projectId, "research.question.added", {
          questionId: question.id, text: question.text, kind: question.kind,
        });
      }
      await emit(deps, task.projectId, "research.evolution.derived", {
        emergentQuestions: emergent.length,
        deadEndsRecorded: failures.length,
        nextDirections: result.output.nextDirections.length,
      });

      return completed({
        summary: result.output.summary,
        emergentQuestions: emergent.length,
        deadEndsRecorded: failures.length,
        deadEndsAlreadyKnown: duplicates,
        nextDirections: result.output.nextDirections,
        heldUp: result.output.heldUp.length,
        revised: result.output.revised.length,
      });
    },
  };
}

/**
 * Sorts a dead end into the failure taxonomy.
 *
 * Keyword matching rather than another model call: the categories are coarse,
 * the cost of a wrong one is low, and spending a model call to classify the
 * output of a model call is the kind of thing that quietly doubles a budget.
 */
function classifyDeadEnd(approach: string, reason: string): FailureRecord["kind"] {
  const text = `${approach} ${reason}`.toLowerCase();
  if (/\b(experiment|trial|run failed|did not converge)\b/.test(text)) return "failed_experiment";
  if (/\b(hypothesis|refuted|disproven)\b/.test(text)) return "rejected_hypothesis";
  if (/\b(tool|executor|search|fetch|blocked|not configured|unavailable)\b/.test(text)) return "tool_limitation";
  if (/\b(paywall|subscription|inaccessible|unreliable|retracted)\b/.test(text)) return "unreliable_source";
  if (/\b(pipeline|parse|ingest|broken)\b/.test(text)) return "broken_pipeline";
  return "dead_end_approach";
}
