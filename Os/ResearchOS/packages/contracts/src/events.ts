import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, Metadata } from "./primitives.ts";
import { AgentRole } from "./agent.ts";
import { TaskType, TaskStatus } from "./task.ts";
import { ProjectStatus } from "./project.ts";

/**
 * Domain events.
 *
 * Events are the contract that lets a client render a live research run without
 * polling and without understanding ResearchOS internals. They are persisted in
 * an append-only log with a per-project sequence number, which gives two
 * properties that matter:
 *
 *   - a disconnected client can resume exactly where it left off by sending the
 *     last sequence number it saw (SSE `Last-Event-ID`);
 *   - the log is a replayable audit trail of how a conclusion was reached.
 *
 * Payloads carry ids and small scalars, never large bodies. A client that wants
 * the full claim fetches it; that keeps the stream cheap and the event schema
 * stable as entities grow.
 */

export const EVENT_TYPES = [
  "research.project.created",
  "research.project.status_changed",
  "research.started",
  "research.plan.created",
  "research.task.created",
  "research.task.started",
  "research.task.status_changed",
  "research.task.completed",
  "research.task.failed",
  "research.agent.started",
  "research.agent.completed",
  "research.agent.failed",
  "research.question.added",
  "research.hypothesis.created",
  "research.hypothesis.updated",
  "research.source.discovered",
  "research.source.processed",
  "research.source.failed",
  "research.evidence.extracted",
  "research.claim.created",
  "research.claim.updated",
  "research.claim.challenged",
  "research.claim.scored",
  "research.evidence.linked",
  "research.contradiction.detected",
  "research.contradiction.resolved",
  "research.debate.started",
  "research.debate.judged",
  "research.verification.completed",
  "research.experiment.created",
  "research.experiment.started",
  "research.experiment.completed",
  "research.evolution.derived",
  "research.executor.requested",
  "research.executor.result_received",
  "research.budget.warning",
  "research.budget.exhausted",
  "research.report.generated",
  "research.completed",
  "research.failed",
  "research.cancelled",
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

/** Payload schemas, keyed by event type. Kept flat and id-centric on purpose. */
export const EVENT_PAYLOADS = {
  "research.project.created": z.object({ title: z.string(), originalQuestion: z.string() }),
  "research.project.status_changed": z.object({ from: ProjectStatus, to: ProjectStatus, reason: z.string().optional() }),
  "research.started": z.object({ planVersion: z.number().int().positive() }),
  "research.plan.created": z.object({ version: z.number().int().positive(), stepCount: z.number().int().nonnegative(), summary: z.string() }),
  "research.task.created": z.object({ taskId: idRefSchema("task"), type: TaskType, dependsOn: z.array(idRefSchema("task")) }),
  "research.task.started": z.object({ taskId: idRefSchema("task"), type: TaskType, attempt: z.number().int().positive() }),
  "research.task.status_changed": z.object({ taskId: idRefSchema("task"), from: TaskStatus, to: TaskStatus }),
  "research.task.completed": z.object({ taskId: idRefSchema("task"), type: TaskType, durationMs: z.number().int().nonnegative() }),
  "research.task.failed": z.object({ taskId: idRefSchema("task"), type: TaskType, errorCode: z.string(), errorMessage: z.string(), willRetry: z.boolean() }),
  "research.agent.started": z.object({ runId: idRefSchema("agentRun"), role: AgentRole, model: z.string().nullable() }),
  "research.agent.completed": z.object({ runId: idRefSchema("agentRun"), role: AgentRole, durationMs: z.number().int().nonnegative(), costUsd: z.number().nonnegative() }),
  "research.agent.failed": z.object({ runId: idRefSchema("agentRun"), role: AgentRole, errorCode: z.string(), errorMessage: z.string() }),
  "research.question.added": z.object({ questionId: idRefSchema("question"), text: z.string(), kind: z.string() }),
  "research.hypothesis.created": z.object({ hypothesisId: idRefSchema("hypothesis"), statement: z.string() }),
  "research.hypothesis.updated": z.object({ hypothesisId: idRefSchema("hypothesis"), status: z.string(), posteriorConfidence: z.number().nullable() }),
  "research.source.discovered": z.object({ sourceId: idRefSchema("source"), title: z.string(), url: z.string().nullable(), sourceType: z.string() }),
  "research.source.processed": z.object({ sourceId: idRefSchema("source"), chunkCount: z.number().int().nonnegative(), qualityScore: z.number().nullable() }),
  "research.source.failed": z.object({ sourceId: idRefSchema("source"), reason: z.string() }),
  "research.evidence.extracted": z.object({ evidenceId: idRefSchema("evidence"), sourceId: idRefSchema("source"), stance: z.string(), relevance: z.number() }),
  "research.claim.created": z.object({ claimId: idRefSchema("claim"), statement: z.string(), claimType: z.string() }),
  "research.claim.updated": z.object({ claimId: idRefSchema("claim"), status: z.string() }),
  "research.claim.challenged": z.object({ claimId: idRefSchema("claim"), findingId: idRefSchema("finding"), kind: z.string(), severity: z.number() }),
  "research.claim.scored": z.object({ claimId: idRefSchema("claim"), confidence: z.number(), supporting: z.number().int(), contradicting: z.number().int() }),
  "research.evidence.linked": z.object({ claimId: idRefSchema("claim"), evidenceId: idRefSchema("evidence"), stance: z.string() }),
  "research.contradiction.detected": z.object({ contradictionId: idRefSchema("contradiction"), claimIdA: idRefSchema("claim"), claimIdB: idRefSchema("claim"), severity: z.number() }),
  "research.contradiction.resolved": z.object({ contradictionId: idRefSchema("contradiction"), status: z.string(), resolution: z.string() }),
  "research.debate.started": z.object({ debateId: idRefSchema("debate"), topic: z.string(), subjectType: z.string(), subjectId: z.string() }),
  "research.debate.judged": z.object({ debateId: idRefSchema("debate"), position: z.string(), agreementLevel: z.number() }),
  "research.verification.completed": z.object({ targetType: z.string(), targetId: z.string(), passed: z.number().int(), failed: z.number().int() }),
  "research.experiment.created": z.object({ experimentId: idRefSchema("experiment"), title: z.string() }),
  "research.experiment.started": z.object({ experimentId: idRefSchema("experiment"), runId: idRefSchema("experimentRun"), attempt: z.number().int().positive() }),
  "research.experiment.completed": z.object({ experimentId: idRefSchema("experiment"), runId: idRefSchema("experimentRun"), status: z.string(), metrics: z.record(z.string(), z.number()) }),
  /**
   * A cycle's worth of change, summarised.
   *
   * The only deliberately non-id-centric payload here: evolution is a statement
   * about the run rather than about one entity, and the entities it produced
   * emit their own events alongside it.
   */
  "research.evolution.derived": z.object({
    emergentQuestions: z.number().int().nonnegative(),
    deadEndsRecorded: z.number().int().nonnegative(),
    nextDirections: z.number().int().nonnegative(),
  }),
  "research.executor.requested": z.object({ requestId: idRefSchema("executorRequest"), capability: z.string(), toolId: z.string() }),
  "research.executor.result_received": z.object({ requestId: idRefSchema("executorRequest"), status: z.string(), executorId: z.string().nullable() }),
  "research.budget.warning": z.object({ dimension: z.string(), used: z.number(), limit: z.number(), fraction: z.number() }),
  "research.budget.exhausted": z.object({ dimension: z.string(), used: z.number(), limit: z.number() }),
  "research.report.generated": z.object({ reportId: idRefSchema("report"), version: z.number().int().positive(), overallConfidence: z.number() }),
  "research.completed": z.object({ reportId: idRefSchema("report").nullable(), durationMs: z.number().int().nonnegative(), costUsd: z.number().nonnegative() }),
  "research.failed": z.object({ reason: z.string(), errorCode: z.string() }),
  "research.cancelled": z.object({ reason: z.string() }),
} as const satisfies Record<EventType, z.ZodType>;

export type EventPayloads = { [K in EventType]: z.infer<(typeof EVENT_PAYLOADS)[K]> };

/** A persisted domain event. `sequence` is monotonic per project and is the SSE resume token. */
export type ResearchEvent<K extends EventType = EventType> = {
  id: string;
  projectId: string;
  /** Monotonic within a project, starting at 1. */
  sequence: number;
  type: K;
  payload: EventPayloads[K];
  traceId: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
};

export const ResearchEventEnvelope = z.object({
  id: idSchema("event"),
  projectId: idSchema("project"),
  sequence: z.number().int().positive(),
  type: EventType,
  payload: z.unknown(),
  traceId: z.string().nullable(),
  occurredAt: IsoDateTime,
  metadata: Metadata.default({}),
});

/** Validates an event's payload against the schema registered for its type. */
export function parseEvent(input: unknown): ResearchEvent {
  const envelope = ResearchEventEnvelope.parse(input);
  const payloadSchema = EVENT_PAYLOADS[envelope.type];
  const payload = payloadSchema.parse(envelope.payload);
  return { ...envelope, payload } as ResearchEvent;
}

export function isEventType<K extends EventType>(event: ResearchEvent, type: K): event is ResearchEvent<K> {
  return event.type === type;
}
