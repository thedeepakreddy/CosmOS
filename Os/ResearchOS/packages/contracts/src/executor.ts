import { z } from "zod";
import { idSchema, IsoDateTime, Metadata } from "./primitives.ts";
import { ToolCapability } from "./tool.ts";

/**
 * The external executor protocol.
 *
 * This is the seam that lets a host application act as ResearchOS's hands
 * without either codebase importing the other. An executor registers the
 * capabilities it can fulfil; ResearchOS requests a capability; the executor
 * performs the work in its own environment and posts a result back.
 *
 * ResearchOS never references a specific executor by name in its logic — it
 * asks for `browser` or `python`, and whichever healthy executor advertises
 * that capability receives the request.
 */

export const EXECUTOR_STATUSES = ["registered", "healthy", "degraded", "unreachable", "revoked"] as const;
export const ExecutorStatus = z.enum(EXECUTOR_STATUSES);
export type ExecutorStatus = z.infer<typeof ExecutorStatus>;

export const ExecutorRegistration = z.object({
  /** Stable machine name chosen by the executor, e.g. "echo-desktop-1". */
  name: z.string().min(1).max(100),
  displayName: z.string().max(200).optional(),
  capabilities: z.array(ToolCapability).min(1),
  /** Where ResearchOS should POST requests, when the executor is push-addressable. */
  callbackUrl: z.string().url().optional(),
  /** Omitted for pull-mode executors, which long-poll for work instead. */
  mode: z.enum(["push", "pull"]).default("pull"),
  maxConcurrentRequests: z.number().int().positive().default(4),
  /** Executor-declared version, surfaced in audit logs. */
  version: z.string().max(50).optional(),
  metadata: Metadata.default({}),
});
export type ExecutorRegistration = z.infer<typeof ExecutorRegistration>;

export const Executor = z.object({
  id: idSchema("executor"),
  name: z.string().max(100),
  displayName: z.string().max(200).nullable(),
  capabilities: z.array(ToolCapability),
  callbackUrl: z.string().nullable(),
  mode: z.enum(["push", "pull"]),
  status: ExecutorStatus,
  maxConcurrentRequests: z.number().int().positive(),
  version: z.string().nullable(),
  lastHeartbeatAt: IsoDateTime.nullable(),
  metadata: Metadata.default({}),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Executor = z.infer<typeof Executor>;

export const EXECUTOR_REQUEST_STATUSES = ["pending", "claimed", "succeeded", "failed", "timed_out", "cancelled"] as const;
export const ExecutorRequestStatus = z.enum(EXECUTOR_REQUEST_STATUSES);
export type ExecutorRequestStatus = z.infer<typeof ExecutorRequestStatus>;

export const ExecutorRequest = z.object({
  id: idSchema("executorRequest"),
  projectId: idSchema("project"),
  taskId: idSchema("task").nullable(),
  /** The capability being requested — not a specific executor. */
  capability: ToolCapability,
  /** Tool id whose schema the payload conforms to. */
  toolId: z.string().max(100),
  input: z.unknown(),
  status: ExecutorRequestStatus,
  /** Set once an executor claims the request. */
  executorId: idSchema("executor").nullable(),
  output: z.unknown().nullable(),
  errorMessage: z.string().max(4000).nullable(),
  timeoutMs: z.number().int().positive(),
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
  claimedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
});
export type ExecutorRequest = z.infer<typeof ExecutorRequest>;

/** Result payload an executor posts back. Validated before it touches research state. */
export const ExecutorResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), output: z.unknown(), durationMs: z.number().int().nonnegative().optional() }),
  z.object({ status: z.literal("failed"), errorMessage: z.string().min(1).max(4000), retryable: z.boolean().default(false) }),
]);
export type ExecutorResult = z.infer<typeof ExecutorResult>;
