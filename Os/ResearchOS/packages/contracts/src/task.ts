import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, Metadata } from "./primitives.ts";

/**
 * Task types.
 *
 * Every unit of research work is one of these, dispatched through the durable
 * queue. Keeping the set closed and explicit is what makes a research run
 * resumable: after a crash the orchestrator re-reads rows and knows exactly
 * what each one meant.
 */
export const TASK_TYPES = [
  "plan.create",
  "question.decompose",
  "hypothesis.generate",
  "source.discover",
  "source.ingest",
  "evidence.extract",
  "claim.extract",
  "claim.link_evidence",
  "claim.score",
  "contradiction.detect",
  "critique.run",
  "debate.run",
  "verification.run",
  "experiment.design",
  "experiment.run",
  "evolution.derive",
  "report.generate",
  "executor.request",
] as const;
export const TaskType = z.enum(TASK_TYPES);
export type TaskType = z.infer<typeof TaskType>;

export const TASK_STATUSES = [
  "pending",
  "queued",
  "running",
  "waiting_for_tool",
  "waiting_for_user",
  "completed",
  "failed",
  "cancelled",
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Statuses from which no further transition happens. */
export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled"] as const satisfies readonly TaskStatus[];

/** Statuses where the task is parked waiting on something external. */
export const WAITING_TASK_STATUSES = ["waiting_for_tool", "waiting_for_user"] as const satisfies readonly TaskStatus[];

export const Task = z.object({
  id: idSchema("task"),
  projectId: idSchema("project"),
  type: TaskType,
  status: TaskStatus,
  /** Higher runs first. Ties broken by id, which is creation-ordered. */
  priority: z.number().int().min(0).max(100).default(50),
  /** Task ids that must reach `completed` before this becomes runnable. */
  dependsOn: z.array(idRefSchema("task")).default([]),
  /** Type-specific payload, validated by the handler that owns the type. */
  input: z.unknown(),
  output: z.unknown().nullable(),

  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  /** Worker holding the lease, and when it expires. A dead worker's lease lapses and the task is retried. */
  leasedBy: z.string().max(200).nullable(),
  leaseExpiresAt: IsoDateTime.nullable(),
  /** Not runnable before this time. Carries retry backoff and scheduled work. */
  runAfter: IsoDateTime,

  /** Set when status is waiting_for_tool — the external request being awaited. */
  awaitingRequestId: idRefSchema("executorRequest").nullable(),

  errorCode: z.string().max(100).nullable(),
  errorMessage: z.string().max(4000).nullable(),
  traceId: idRefSchema("trace").nullable(),
  metadata: Metadata.default({}),

  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type Task = z.infer<typeof Task>;

/** What a handler returns. The orchestrator turns this into a state transition. */
export const TaskOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), output: z.unknown(), followUps: z.array(z.unknown()).default([]) }),
  z.object({ kind: z.literal("failed"), errorCode: z.string(), errorMessage: z.string(), retryable: z.boolean() }),
  z.object({ kind: z.literal("waiting_for_tool"), requestId: z.string(), timeoutMs: z.number().int().positive() }),
  z.object({ kind: z.literal("waiting_for_user"), prompt: z.string(), schema: z.unknown().optional() }),
]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/**
 * A research plan: the DAG the director produces. Stored as a plan document so
 * it can be shown to a user and diffed across replans, separately from the
 * task rows it generates.
 */
export const ResearchPlanStep = z.object({
  key: z.string().min(1).max(100),
  type: TaskType,
  description: z.string().max(2000),
  dependsOnKeys: z.array(z.string().max(100)).default([]),
  input: z.unknown(),
  priority: z.number().int().min(0).max(100).default(50),
});
export type ResearchPlanStep = z.infer<typeof ResearchPlanStep>;

export const ResearchPlan = z.object({
  projectId: idSchema("project"),
  /** Increments on every replan; prior versions are retained. */
  version: z.number().int().positive(),
  summary: z.string().max(4000),
  strategy: z.string().max(4000),
  steps: z.array(ResearchPlanStep),
  createdByRunId: idRefSchema("agentRun").nullable(),
  createdAt: IsoDateTime,
});
export type ResearchPlan = z.infer<typeof ResearchPlan>;
