/**
 * Designing and running experiments, and linking new evidence to claims.
 *
 * The rule that governs this file: **an experiment that could not be run
 * produces no result.** Where no runner is configured, the design is stored and
 * the task reports `BLOCKED` — which appears in the report as a limitation.
 * Fabricating observations would be the single most damaging thing this system
 * could do, because a measurement carries authority a prose claim does not.
 */
import {
  Dataset, Experiment, ExperimentExecutionRequest, ExperimentRun, type TaskOutcome,
} from "@research-os/contracts";
import { metricsMatch, summariseReplication } from "@research-os/experiments";
import type { TaskContext, TaskHandler } from "@research-os/orchestration";
import { newId } from "@research-os/shared";
import { runAgent } from "../agent.ts";
import { dataAnalyst } from "../agents/data-analyst.ts";
import { experimenter } from "../agents/experimenter.ts";
import type { ResearchDeps } from "../deps.ts";
import { agentContextFor, blocked, completed, emit } from "./support.ts";

export function experimentDesignHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "experiment.design",
    leaseMs: 300_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const input = (task.task.input ?? {}) as { hypothesisId?: string };

      const hypotheses = await deps.store.projects.listHypotheses(task.projectId);
      const hypothesis = input.hypothesisId
        ? hypotheses.find((item) => item.id === input.hypothesisId)
        // Otherwise the most uncertain untested one: the experiment whose
        // result would move belief furthest.
        : hypotheses
            .filter((item) => item.status === "proposed" || item.status === "testing")
            .sort((a, b) =>
              Math.abs((a.posteriorConfidence ?? a.priorConfidence ?? 0.5) - 0.5) -
              Math.abs((b.posteriorConfidence ?? b.priorConfidence ?? 0.5) - 0.5))[0];

      if (!hypothesis) {
        return completed({ designed: 0, note: "No untested hypothesis is available to design an experiment for." });
      }

      const runner = deps.experimentRunner;
      const datasets = await deps.store.experiments.listDatasets(task.projectId);

      const result = await runAgent(
        experimenter,
        {
          hypothesis: hypothesis.statement,
          falsificationCriteria: hypothesis.falsificationCriteria ?? null,
          // The agent is told what can actually run here, so it does not design
          // a Python experiment for a host with no Python.
          availableRuntimes: runner ? [...runner.supportedRuntimes] : [],
          availableData: datasets.length > 0
            ? datasets.map((dataset) => `${dataset.name} (version ${dataset.version}, ${dataset.rowCount ?? "unknown"} rows)`).join("; ")
            : null,
          networkAllowed: false,
        },
        context,
      );

      const design = result.output;
      const now = deps.clock.isoNow();

      const experiment = Experiment.parse({
        id: newId("experiment"),
        projectId: task.projectId,
        hypothesisId: hypothesis.id,
        title: design.title,
        design: design.design,
        expectedOutcome: design.expectedOutcome,
        falsificationCriteria: design.falsificationCriteria,
        // `ready` only where something can actually run it. A design nobody can
        // execute is `designed`, and the difference is visible in the report.
        status: runner && runner.supportedRuntimes.includes(design.runtime) ? "ready" : "designed",
        code: design.code,
        environment: {
          runtime: design.runtime,
          runtimeVersion: null,
          dependencies: design.dependencies,
          platform: null,
          envVarNames: [],
          randomSeed: typeof design.parameters["randomSeed"] === "number" ? design.parameters["randomSeed"] : null,
        },
        parameters: design.parameters,
        datasetIds: datasets.map((dataset) => dataset.id),
        designedByRunId: result.runId,
        createdAt: now,
        updatedAt: now,
      });

      await deps.store.experiments.createExperiment(experiment);
      await deps.store.projects.updateHypothesis(hypothesis.id, { status: "testing" }, now);

      await emit(deps, task.projectId, "research.experiment.created", {
        experimentId: experiment.id, title: experiment.title,
      });
      await emit(deps, task.projectId, "research.hypothesis.updated", {
        hypothesisId: hypothesis.id, status: "testing", posteriorConfidence: hypothesis.posteriorConfidence,
      });

      return completed({
        experimentId: experiment.id,
        hypothesisId: hypothesis.id,
        status: experiment.status,
        runnable: experiment.status === "ready",
        expectedMetrics: design.expectedMetrics,
        limitations: design.limitations,
      });
    },
  };
}

export function experimentRunHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "experiment.run",
    leaseMs: 600_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const runner = deps.experimentRunner;
      if (!runner) {
        return blocked(
          "experiment execution",
          "no experiment runner is configured. The experiment is designed and stored, but no result exists — " +
            "and a result that was not measured must never be reported as one.",
        );
      }

      const input = (task.task.input ?? {}) as { experimentId?: string; repeats?: number };
      const experiments = await deps.store.experiments.listExperiments(task.projectId);
      const experiment = input.experimentId
        ? experiments.find((item) => item.id === input.experimentId)
        : experiments.find((item) => item.status === "ready");

      if (!experiment) {
        return completed({ ran: 0, note: "No experiment is ready to run." });
      }
      if (!runner.supportedRuntimes.includes(experiment.environment.runtime)) {
        return blocked(
          `experiment ${experiment.id}`,
          `the configured runner cannot execute "${experiment.environment.runtime}"`,
        );
      }

      const context = await agentContextFor(deps, task);
      // Repeated deliberately: one run is an anecdote, and the spread across
      // runs is itself a finding.
      const repeats = Math.min(Math.max(input.repeats ?? 2, 1), 5);
      const runIds: string[] = [];
      // The first successful run is the baseline every later one is compared
      // against. Comparison happens *here*, as each run finishes, because
      // `replicationSummary` counts rows already marked — asking it before
      // anything is marked reports zero replications however well they agreed.
      let baseline: { id: string; metrics: Record<string, number> } | null = null;

      await deps.store.experiments.updateExperimentStatus(experiment.id, "running", deps.clock.isoNow());

      for (let index = 0; index < repeats; index++) {
        task.signal.throwIfAborted();
        const attempt = await deps.store.experiments.nextAttempt(experiment.id);
        const startedAt = deps.clock.isoNow();

        const request = ExperimentExecutionRequest.parse({
          experimentId: experiment.id,
          runId: newId("experimentRun"),
          runtime: experiment.environment.runtime,
          code: experiment.code,
          parameters: experiment.parameters,
          dependencies: experiment.environment.dependencies,
          allowNetwork: false,
        });

        const outcome = await runner.execute(request);
        const matched = baseline === null || outcome.status !== "succeeded"
          ? null
          : metricsMatch(baseline.metrics, outcome.metrics);

        const run = ExperimentRun.parse({
          id: request.runId,
          projectId: task.projectId,
          experimentId: experiment.id,
          attempt,
          status: outcome.status,
          parameters: experiment.parameters,
          stdout: outcome.stdout.slice(0, 200_000),
          stderr: outcome.stderr.slice(0, 200_000),
          exitCode: outcome.exitCode,
          metrics: outcome.metrics,
          artifacts: outcome.artifacts,
          durationMs: outcome.durationMs,
          interpretation: null,
          reproducedRunId: baseline?.id ?? null,
          reproductionMatched: matched,
          errorMessage: outcome.errorMessage,
          startedAt,
          finishedAt: deps.clock.isoNow(),
          createdAt: startedAt,
        });

        await deps.store.experiments.recordRun(run);
        runIds.push(run.id);
        if (baseline === null && outcome.status === "succeeded") {
          baseline = { id: run.id, metrics: outcome.metrics };
        }

        await deps.store.runs.recordToolCall({
          id: newId("modelCall"),
          projectId: task.projectId,
          agentRunId: null,
          toolId: `experiment:${experiment.environment.runtime}`,
          capability: "code_execution",
          input: { experimentId: experiment.id, attempt },
          output: { status: outcome.status, metrics: outcome.metrics },
          status: outcome.status === "succeeded" ? "succeeded" : "failed",
          errorMessage: outcome.errorMessage,
          durationMs: outcome.durationMs,
          executorId: null,
          traceId: null,
          createdAt: deps.clock.isoNow(),
        });
      }

      const replication = await deps.store.experiments.replicationSummary(experiment.id);
      const runs = await deps.store.experiments.listRuns(experiment.id);
      const succeeded = runs.filter((run) => run.status === "succeeded");

      await deps.store.experiments.updateExperimentStatus(
        experiment.id,
        succeeded.length > 0 ? "completed" : "failed",
        deps.clock.isoNow(),
      );

      /*
       * The analyst interprets only what was measured.
       *
       * Skipped entirely when nothing succeeded: asking a model to interpret an
       * empty result set is how a failed experiment acquires a narrative.
       */
      let interpretation: string | null = null;
      let overinterpretations: string[] = [];
      if (succeeded.length > 0) {
        const analysis = await runAgent(
          dataAnalyst,
          {
            question: `Does this experiment support the hypothesis? ${experiment.expectedOutcome ?? experiment.design}`,
            metrics: succeeded.at(-1)?.metrics ?? {},
            variance: replication.metricVariance,
            runCount: runs.length,
            notes: `Falsification criteria: ${experiment.falsificationCriteria ?? "none recorded"}`,
          },
          context,
        );
        interpretation = analysis.output.summary;
        overinterpretations = analysis.output.overinterpretations;
      }

      // Recorded on the run, kept separate from the numbers themselves. The
      // metrics are observations; this is a reading of them, and overwriting
      // the measurement with the reading would lose what actually happened.
      const lastRun = succeeded.at(-1);
      if (lastRun && interpretation) {
        await deps.store.experiments.recordRun(ExperimentRun.parse({ ...lastRun, interpretation }));
      }

      await emit(deps, task.projectId, "research.experiment.completed", {
        experimentId: experiment.id,
        runId: succeeded.at(-1)?.id ?? runs.at(-1)?.id ?? experiment.id,
        status: succeeded.length > 0 ? "succeeded" : "failed",
        metrics: succeeded.at(-1)?.metrics ?? {},
      });

      return completed({
        experimentId: experiment.id,
        runs: runs.length,
        succeeded: succeeded.length,
        failed: runs.length - succeeded.length,
        reproducibilityScore: replication.reproducibilityScore,
        replications: replication.replications,
        failedReplications: replication.failedReplications,
        metricVariance: replication.metricVariance,
        interpretation,
        overinterpretations,
      });
    },
  };
}

/**
 * Registers a dataset against a project.
 *
 * Content-hashed, so a result is pinned to exact bytes rather than to a file
 * name that might mean something different next week.
 */
export async function registerDataset(
  deps: ResearchDeps,
  projectId: string,
  input: { name: string; description?: string; uri?: string; contentHash: string; rowCount?: number },
): Promise<Dataset> {
  const dataset = Dataset.parse({
    id: newId("dataset"),
    projectId,
    name: input.name,
    description: input.description ?? null,
    version: input.contentHash.slice(0, 16),
    uri: input.uri ?? null,
    storageKey: null,
    rowCount: input.rowCount ?? null,
    schema: null,
    contentHash: input.contentHash,
    createdAt: deps.clock.isoNow(),
  });
  await deps.store.experiments.addDataset(dataset);
  return dataset;
}

export { summariseReplication };
