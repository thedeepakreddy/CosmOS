import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, Metadata, UnitInterval } from "./primitives.ts";

/**
 * Computational research.
 *
 * An experiment records enough to be re-run by someone who was not there:
 * code, dependencies, environment, dataset versions and parameters. Anything
 * less is a result you cannot check, which for research purposes is not a
 * result.
 */

export const EXPERIMENT_STATUSES = ["designed", "ready", "running", "completed", "failed", "cancelled"] as const;
export const ExperimentStatus = z.enum(EXPERIMENT_STATUSES);
export type ExperimentStatus = z.infer<typeof ExperimentStatus>;

export const EXPERIMENT_RUNTIMES = ["python", "node", "shell"] as const;
export const ExperimentRuntime = z.enum(EXPERIMENT_RUNTIMES);
export type ExperimentRuntime = z.infer<typeof ExperimentRuntime>;

export const Dataset = z.object({
  id: idSchema("dataset"),
  projectId: idSchema("project"),
  name: z.string().min(1).max(300),
  description: z.string().max(4000).nullable(),
  /** Content hash of the data, so a result is pinned to exact bytes. */
  version: z.string().max(100),
  uri: z.string().max(2000).nullable(),
  storageKey: z.string().max(500).nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  schema: Metadata.nullable(),
  contentHash: z.string().max(64).nullable(),
  createdAt: IsoDateTime,
});
export type Dataset = z.infer<typeof Dataset>;

/** Everything needed to reconstruct the execution context. */
export const ExperimentEnvironment = z.object({
  runtime: ExperimentRuntime,
  runtimeVersion: z.string().max(100).nullable(),
  /** Pinned dependency specifiers, e.g. "numpy==1.26.4". */
  dependencies: z.array(z.string().max(200)).default([]),
  platform: z.string().max(100).nullable(),
  /** Env var names only — never values. Secrets are not recorded. */
  envVarNames: z.array(z.string().max(100)).default([]),
  /** Seeds, recorded so stochastic results can be reproduced. */
  randomSeed: z.number().int().nullable(),
});
export type ExperimentEnvironment = z.infer<typeof ExperimentEnvironment>;

export const Experiment = z.object({
  id: idSchema("experiment"),
  projectId: idSchema("project"),
  hypothesisId: idSchema("hypothesis").nullable(),
  title: z.string().min(1).max(500),
  /** What this experiment would show, and what outcome would falsify it. */
  design: z.string().max(8000),
  expectedOutcome: z.string().max(4000).nullable(),
  falsificationCriteria: z.string().max(2000).nullable(),
  status: ExperimentStatus,
  code: z.string().max(200_000),
  environment: ExperimentEnvironment,
  parameters: Metadata.default({}),
  datasetIds: z.array(idRefSchema("dataset")).default([]),
  designedByRunId: idRefSchema("agentRun").nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Experiment = z.infer<typeof Experiment>;

export const EXPERIMENT_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "cancelled"] as const;
export const ExperimentRunStatus = z.enum(EXPERIMENT_RUN_STATUSES);
export type ExperimentRunStatus = z.infer<typeof ExperimentRunStatus>;

export const ExperimentArtifact = z.object({
  name: z.string().max(300),
  mediaType: z.string().max(200),
  storageKey: z.string().max(500),
  sizeBytes: z.number().int().nonnegative(),
});
export type ExperimentArtifact = z.infer<typeof ExperimentArtifact>;

export const ExperimentRun = z.object({
  id: idSchema("experimentRun"),
  projectId: idSchema("project"),
  experimentId: idSchema("experiment"),
  /** Increments per repeat of the same experiment — the basis for replication counts. */
  attempt: z.number().int().positive(),
  status: ExperimentRunStatus,
  parameters: Metadata.default({}),
  stdout: z.string().max(200_000),
  stderr: z.string().max(200_000),
  exitCode: z.number().int().nullable(),
  /** Machine-readable results the experiment emitted. */
  metrics: z.record(z.string(), z.number()).default({}),
  artifacts: z.array(ExperimentArtifact).default([]),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Agent's reading of what the numbers mean. Separate from the numbers themselves. */
  interpretation: z.string().max(8000).nullable(),
  /** Whether this run reproduced a previous run's result. */
  reproducedRunId: idRefSchema("experimentRun").nullable(),
  reproductionMatched: z.boolean().nullable(),
  errorMessage: z.string().max(4000).nullable(),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type ExperimentRun = z.infer<typeof ExperimentRun>;

/** Request handed to an experiment runner adapter. */
export const ExperimentExecutionRequest = z.object({
  experimentId: z.string().max(64),
  runId: z.string().max(64),
  runtime: ExperimentRuntime,
  code: z.string().max(200_000),
  parameters: Metadata.default({}),
  dependencies: z.array(z.string().max(200)).default([]),
  timeoutMs: z.number().int().positive().default(120_000),
  /** Files to place in the working directory before execution. */
  inputFiles: z.array(z.object({ path: z.string().max(500), contents: z.string() })).default([]),
  /** Whether the runner may reach the network. Off unless a run explicitly needs it. */
  allowNetwork: z.boolean().default(false),
  maxOutputBytes: z.number().int().positive().default(1_000_000),
});
export type ExperimentExecutionRequest = z.infer<typeof ExperimentExecutionRequest>;

export const ExperimentExecutionResult = z.object({
  status: ExperimentRunStatus,
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  metrics: z.record(z.string(), z.number()).default({}),
  artifacts: z.array(ExperimentArtifact).default([]),
  durationMs: z.number().int().nonnegative(),
  errorMessage: z.string().max(4000).nullable(),
  environment: ExperimentEnvironment,
});
export type ExperimentExecutionResult = z.infer<typeof ExperimentExecutionResult>;

/** Cross-run comparison used to decide whether a finding replicated. */
export const ReplicationSummary = z.object({
  experimentId: idRefSchema("experiment"),
  totalRuns: z.number().int().nonnegative(),
  successfulRuns: z.number().int().nonnegative(),
  replications: z.number().int().nonnegative(),
  failedReplications: z.number().int().nonnegative(),
  /** Per-metric spread across runs; wide spread is itself a finding. */
  metricVariance: z.record(z.string(), z.object({ mean: z.number(), stdDev: z.number(), min: z.number(), max: z.number() })).default({}),
  reproducibilityScore: UnitInterval,
});
export type ReplicationSummary = z.infer<typeof ReplicationSummary>;
