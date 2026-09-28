/**
 * The planning handler.
 *
 * Runs the Research Director and turns its plan into rows: objectives,
 * sub-questions, hypotheses, a stored plan document, and the follow-up tasks
 * that carry out the work.
 *
 * Two details that make the difference between a plan and a to-do list:
 *
 *   - **Prior lessons and known dead ends are loaded before planning.** A system
 *     that cannot remember what already failed will plan it again, which is
 *     what failure memory exists to prevent.
 *   - **Step keys are resolved to real task ids before the tasks are created.**
 *     The director names dependencies by key; the queue needs ids. Resolving in
 *     between is what makes the plan a DAG the scheduler can actually walk.
 */
import { Hypothesis, Objective, ResearchPlan, ResearchQuestion, Task, type TaskOutcome } from "@research-os/contracts";
import type { TaskContext, TaskHandler } from "@research-os/orchestration";
import { newId } from "@research-os/shared";
import { runAgent } from "../agent.ts";
import { researchDirector, type DirectorPlanOutput } from "../agents/research-director.ts";
import type { ResearchDeps } from "../deps.ts";
import { agentContextFor, completed, emit } from "./support.ts";

export function planCreateHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "plan.create",
    leaseMs: 180_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const project = await deps.store.projects.findById(task.projectId);
      /* c8 ignore next */
      if (!project) return { kind: "failed", errorCode: "not_found", errorMessage: "Project vanished.", retryable: false };

      // What we already know not to try. Both are advisory input to the
      // director, never constraints it cannot override with a reason.
      const priorLessons = deps.memory
        ? (await deps.memory.recallLessons(project.originalQuestion, 8)).map(
            (hit) => String((hit.record.content as { lesson?: string }).lesson ?? hit.record.searchText),
          )
        : [];
      const knownDeadEnds = (await deps.store.runs.transferableFailures(task.projectId, 10)).map(
        (failure) => `${failure.approach} — ${failure.reason}${failure.lesson ? ` (lesson: ${failure.lesson})` : ""}`,
      );

      const result = await runAgent(
        researchDirector,
        {
          question: project.originalQuestion,
          description: project.description,
          priorLessons,
          knownDeadEnds,
        },
        context,
      );
      const plan = result.output;
      const now = deps.clock.isoNow();

      // Parsed rather than cast: this is model output on its way into the
      // database, and the schema is the last place it can be checked.
      const objectives = plan.objectives.map((objective, index) =>
        Objective.parse({
          id: newId("objective"),
          projectId: task.projectId,
          statement: objective.statement,
          rationale: objective.rationale,
          position: index,
          createdAt: now,
        }),
      );

      const questions = plan.subQuestions.map((question) =>
        ResearchQuestion.parse({
          id: newId("question"),
          projectId: task.projectId,
          parentQuestionId: null,
          text: question.text,
          kind: "sub",
          status: "open",
          rationale: question.rationale,
          priority: question.priority,
          answerClaimIds: [],
          createdAt: now,
          updatedAt: now,
        }),
      );

      const hypotheses = plan.hypotheses.map((hypothesis) =>
        Hypothesis.parse({
          id: newId("hypothesis"),
          projectId: task.projectId,
          questionId: null,
          statement: hypothesis.statement,
          rationale: hypothesis.rationale,
          status: "proposed",
          falsificationCriteria: hypothesis.falsificationCriteria,
          priorConfidence: null,
          posteriorConfidence: null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      /*
       * Verification and scoring are not the director's to skip.
       *
       * ResearchOS's claim is that every quotation is checked against the
       * source it cites and every confidence number is computed from evidence.
       * A plan that omits `verification.run` or `claim.score` does not produce
       * a faster answer — it produces a report whose findings carry confidence
       * 0 and an evaluation blocked with "nothing was verified". A live model
       * omitted both, and the result looked authoritative while resting on
       * nothing checked.
       *
       * So the director decides *what research to do*; these two are a system
       * invariant and are appended when absent. The prompt asks for them too,
       * because a model that plans them itself places them better than this
       * can — but the guarantee cannot depend on the model complying.
       */
      const steps = withRequiredIntegritySteps(plan.steps);

      // Keys are assigned ids first, so a step can depend on one declared after
      // it — the director writes a graph, not an ordered list.
      const idByKey = new Map(steps.map((step) => [step.key, newId("task")]));

      const followUps = steps.map((step) =>
        Task.parse({
          id: idByKey.get(step.key),
          projectId: task.projectId,
          type: step.type,
          status: "pending",
          priority: step.priority,
          dependsOn: step.dependsOnKeys.map((key) => idByKey.get(key)).filter((id) => id !== undefined),
          input: {
            description: step.description,
            searchQueries: step.searchQueries,
            questionIds: questions.map((question) => question.id),
          },
          output: null,
          leasedBy: null,
          leaseExpiresAt: null,
          runAfter: now,
          awaitingRequestId: null,
          errorCode: null,
          errorMessage: null,
          traceId: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
        }),
      );

      await deps.store.transaction(async (tx) => {
        await tx.projects.addObjectives(objectives);
        await tx.projects.addQuestions(questions);
        await tx.projects.addHypotheses(hypotheses);
        await tx.projects.savePlan(
          ResearchPlan.parse({
            projectId: task.projectId,
            version: await tx.projects.nextPlanVersion(task.projectId),
            summary: plan.interpretation,
            strategy: plan.strategy,
            steps: steps.map((step) => ({
              key: step.key,
              type: step.type,
              description: step.description,
              dependsOnKeys: step.dependsOnKeys,
              input: { searchQueries: step.searchQueries },
              priority: step.priority,
            })),
            createdByRunId: result.runId,
            createdAt: now,
          }),
        );
      });

      const planVersion = (await deps.store.projects.latestPlan(task.projectId))?.version ?? 1;
      await emit(deps, task.projectId, "research.plan.created", {
        version: planVersion,
        stepCount: steps.length,
        summary: plan.interpretation,
      });
      // One event per entity: a client rendering the plan wants to add each
      // question and hypothesis as it arrives, not re-fetch on a count.
      for (const question of questions) {
        await emit(deps, task.projectId, "research.question.added", {
          questionId: question.id, text: question.text, kind: question.kind,
        });
      }
      for (const hypothesis of hypotheses) {
        await emit(deps, task.projectId, "research.hypothesis.created", {
          hypothesisId: hypothesis.id, statement: hypothesis.statement,
        });
      }

      return completed(
        {
          interpretation: plan.interpretation,
          stepCount: steps.length,
          unanswerableIf: plan.unanswerableIf,
          runId: result.runId,
        },
        followUps,
      );
    },
  };
}

/**
 * Adds `claim.score` and `verification.run` to a plan that lacks them.
 *
 * Each is appended depending on every step that produces or links claims, so it
 * runs after the material it judges exists. `report.generate` is then made to
 * depend on both — a report written before its claims were checked would state
 * findings whose citations nobody had looked at, which is the specific failure
 * this system exists to prevent.
 */
export function withRequiredIntegritySteps(steps: DirectorPlanOutput["steps"]): DirectorPlanOutput["steps"] {
  const present = new Set(steps.map((step) => step.type));
  const claimProducers = steps
    .filter((step) => step.type === "claim.extract" || step.type === "claim.link_evidence")
    .map((step) => step.key);

  // Nothing produces claims, so there is nothing to verify or score. A plan
  // like that is a different problem, and inventing steps would not fix it.
  if (claimProducers.length === 0) return steps;

  const added: DirectorPlanOutput["steps"] = [];
  if (!present.has("verification.run")) {
    added.push({
      key: "required_verification", type: "verification.run",
      description: "Check every quotation against the source it cites.",
      dependsOnKeys: claimProducers, searchQueries: [], priority: 45,
    });
  }
  if (!present.has("claim.score")) {
    added.push({
      key: "required_scoring", type: "claim.score",
      description: "Compute confidence for every claim from its linked evidence.",
      // Scored after verification when both are added, so a failed citation
      // check is reflected in the number rather than contradicted by it.
      dependsOnKeys: [...claimProducers, ...added.map((step) => step.key)],
      searchQueries: [], priority: 40,
    });
  }
  if (added.length === 0) return steps;

  const addedKeys = added.map((step) => step.key);
  return [...steps, ...added].map((step) =>
    step.type === "report.generate" && !addedKeys.includes(step.key)
      ? { ...step, dependsOnKeys: [...new Set([...step.dependsOnKeys, ...addedKeys])] }
      : step,
  );
}
