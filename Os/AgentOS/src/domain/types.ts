import { z } from 'zod';

export const RunStateSchema = z.enum([
  'CREATED',
  'PLANNING',
  'READY',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT'
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const TaskStateSchema = z.enum([
  'PENDING',
  'BLOCKED',
  'READY',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'SKIPPED'
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const ModelRequirementsSchema = z.object({
  contextWindow: z.number().optional(),
  capabilities: z.array(z.string()).optional(),
  preferredModel: z.string().optional()
});
export type ModelRequirements = z.infer<typeof ModelRequirementsSchema>;

export const AgentDefinitionSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  role: z.string(),
  capabilities: z.array(z.string()),
  modelRequirements: ModelRequirementsSchema.optional(),
  toolPermissions: z.array(z.string()).optional(),
  memoryPermissions: z.array(z.string()).optional(),
  maxConcurrency: z.number().optional(),
  defaultTimeoutMs: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Phase G: what a generic agent runtime tells the model about its role. */
  systemPrompt: z.string().optional()
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentInstanceStateSchema = z.enum(['CREATED', 'ACTIVE', 'TERMINATED', 'FAILED']);
export type AgentInstanceState = z.infer<typeof AgentInstanceStateSchema>;

/**
 * Phase G: a REAL, persisted agent instance.
 *
 * v0.1 had no instance lifecycle at all -- Supervisor fabricated
 * `{ id: 'inst-<defId>', version: '1' }` inline on every execution, so nothing
 * recorded which definition version actually ran, or under which worker.
 */
export const AgentInstanceSchema = z.object({
  id: z.string(),
  runId: z.string(),
  taskId: z.string().optional(),
  definitionId: z.string(),
  /** The exact definition version this instance was created from. */
  version: z.string(),
  state: AgentInstanceStateSchema.default('CREATED'),
  workerId: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  activatedAt: z.string().datetime().optional(),
  terminatedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;

// A3: budgets are non-negative. 0 means "zero allowed", NOT "unset" -- only
// `undefined` means unset. `.nonnegative()` also emits `minimum: 0` into the
// generated JSON Schema, so the API rejects negatives at the boundary.
//
// Truthful status: maxAgents, maxTasks and maxRunDurationMs are ENFORCED.
// maxModelCalls, maxToolCalls and maxCostUsd are DECLARED BUT NOT ENFORCED --
// accounting for them requires the executor-boundary hooks planned for Phase G.
export const ExecutionBudgetSchema = z.object({
  maxAgents: z.number().nonnegative().optional(),
  maxTasks: z.number().nonnegative().optional(),
  maxRunDurationMs: z.number().nonnegative().optional(),
  /** Declared but NOT enforced in v0.2 Phase A. See Phase G. */
  maxModelCalls: z.number().nonnegative().optional(),
  /** Declared but NOT enforced in v0.2 Phase A. See Phase G. */
  maxToolCalls: z.number().nonnegative().optional(),
  /** Declared but NOT enforced in v0.2 Phase A. See Phase G. */
  maxCostUsd: z.number().nonnegative().optional()
});
export type ExecutionBudget = z.infer<typeof ExecutionBudgetSchema>;

export const DependencySchema = z.object({
  taskId: z.string(),
  dependsOn: z.string()
});
export type Dependency = z.infer<typeof DependencySchema>;

export const TaskSchema = z.object({
  /**
   * Caller-visible task id. Unique WITHIN a run, not globally (Phase B).
   * Two different runs may both use "T1"; they are distinct tasks.
   */
  id: z.string(),
  runId: z.string().optional(),
  name: z.string(),
  description: z.string(),
  agentDefinitionId: z.string(),
  fallbackAgentDefinitionId: z.string().optional(),
  state: TaskStateSchema,
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  timeoutMs: z.number().optional(),
  retriesAllowed: z.number().default(0),
  retriesAttempted: z.number().default(0),

  // ---- Phase B ownership projections --------------------------------------
  // Read-only views of the claim/lease/fencing columns. They are populated when
  // a task is read back, and are IGNORED on write: TaskStore.upsert never writes
  // these columns, so a value supplied by an API client cannot grant ownership.
  // Ownership moves only through claim / renewLease / complete.
  /** workerId currently holding the claim, if any. */
  ownerId: z.string().optional(),
  /** Epoch ms after which the claim may be reclaimed. */
  leaseExpiresAt: z.number().optional(),
  /** Monotonic generation; bumped on every claim. Stale fences are rejected. */
  fence: z.number().optional(),
  /** Monotonic execution counter; covers retries AND crash reclaims. */
  attempt: z.number().optional(),
  /** Phase C: epoch ms before which a requeued task must not be claimed (backoff). */
  notBefore: z.number().optional()
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskGraphSchema = z.object({
  tasks: z.array(TaskSchema),
  dependencies: z.array(DependencySchema)
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export const AgentRunSchema = z.object({
  id: z.string(),
  goal: z.string(),
  state: RunStateSchema,
  taskGraph: TaskGraphSchema.optional(),
  budget: ExecutionBudgetSchema.optional(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  result: z.unknown().optional()
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

// Phase H: messaging is implemented for real in ../persistence/contracts.
// The zod enum stays here as the single declaration of the vocabulary; the v0.1
// `AgentMessageSchema` it sat beside was dead schema (zero code references, per
// the audit) and is superseded by the MessageStore contract.
export const MessageTypeSchema = z.enum([
  'REQUEST',
  'RESULT',
  'QUESTION',
  'ANSWER',
  'STATUS',
  'HANDOFF',
  'ARTIFACT',
  'ERROR'
]);

export const ArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  name: z.string(),
  type: z.string(),
  path: z.string(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime()
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// Phase F: the event envelope and the declared vocabulary now live in
// ./events.ts, which also carries per-type payload schemas and stream
// validation. Re-exported here so existing imports keep working.
export { AgentEventSchema, EVENT_TYPES, EventPayloadSchemas, isDeclaredEventType, validateEventStream } from './events';
export type { AgentEvent, EventType, EventValidationIssue } from './events';
