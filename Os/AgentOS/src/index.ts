/**
 * AgentOS public API.
 *
 * This is the package entry point. Anything not exported here is internal and
 * may change without notice -- in particular the persistence layer
 * (repositories, the SQLite connection singleton and the migration runner) is
 * deliberately NOT exported, so consumers cannot couple to it.
 */

// ---- Domain contracts -------------------------------------------------------
export {
  RunStateSchema,
  TaskStateSchema,
  ModelRequirementsSchema,
  AgentDefinitionSchema,
  AgentInstanceSchema,
  ExecutionBudgetSchema,
  DependencySchema,
  TaskSchema,
  TaskGraphSchema,
  AgentRunSchema,
  MessageTypeSchema,
  ArtifactSchema,
  AgentEventSchema
} from './domain/types';

export type {
  RunState,
  TaskState,
  ModelRequirements,
  AgentDefinition,
  AgentInstance,
  ExecutionBudget,
  Dependency,
  Task,
  TaskGraph,
  AgentRun,
  Artifact,
  AgentEvent
} from './domain/types';

// ---- Execution contracts ----------------------------------------------------
export type {
  AgentExecutor,
  AgentExecutionContext,
  AgentExecutionResult
} from './engine/Executor';

export type { Planner } from './engine/Planner';

// ---- Orchestration ----------------------------------------------------------
export {
  Supervisor,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_LEASE_MS,
  MAX_RECLAIM_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  retryDelayMs
} from './engine/Supervisor';
export type { SupervisorOptions } from './engine/Supervisor';
export { DAGValidator } from './engine/DAGValidator';

// ---- State machines (Phase C) -----------------------------------------------
export {
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  TERMINAL_RUN_STATES,
  TERMINAL_TASK_STATES,
  isTerminalRunState,
  isTerminalTaskState,
  canTransitionRun,
  canTransitionTask
} from './domain/stateMachines';
export { validateExecutorResult } from './engine/executorResult';

// ---- Persistence seam (Phase B) ---------------------------------------------
// The INTERFACES are public so an alternative backend can be supplied.
// The SQLite adapter classes and the connection singleton stay internal.
export type {
  Stores,
  RunStore,
  TaskStore,
  AgentStore,
  EventStore,
  TaskRef,
  ClaimTicket,
  ClaimOptions,
  TaskCompletion
} from './persistence/contracts';

// ---- Agent runtime + providers (Phase G) ------------------------------------
// The provider CONTRACTS are public so an adapter can be supplied. AgentOS
// itself depends on no model or tool vendor.
export type {
  ModelProvider, ModelRequest, ModelResponse, ModelMessage, ModelToolCall, ModelUsage,
  ToolProvider, ToolSpec, ToolResult, ToolInvocationContext,
  MemoryProvider, MemoryScope, Providers
} from './providers/contracts';

export {
  GenericLLMAgentExecutor, BudgetExhaustedError, DEFAULT_MAX_ITERATIONS
} from './runtime/GenericLLMAgentExecutor';
export type { GenericAgentRuntimeOptions } from './runtime/GenericLLMAgentExecutor';

export type {
  AgentInstanceStore, UsageStore, RunUsage
} from './persistence/contracts';

// ---- Distributed runtime (Phase H) ------------------------------------------
export { startWorker } from './worker';
export type { WorkerOptions, WorkerHandle } from './worker';
export type {
  MessageStore, AgentMessage, SendMessageInput,
  RateLimitStore, RateLimitDecision
} from './persistence/contracts';
export type { OutgoingMessage } from './engine/Executor';

// ---- Worker identity (Phase B) ----------------------------------------------
export { createWorkerId, CURRENT_WORKER_ID } from './runtime/WorkerIdentity';

// ---- Server + client --------------------------------------------------------
export { buildServer } from './api/server';
export { AgentOSClient, AgentOSError } from './sdk/client';
export type { AgentOSClientOptions, TaskPage } from './sdk/client';

// ---- Configuration + API surface (Phase E) ----------------------------------
export { ConfigSchema, loadConfig } from './config';
export type { Config } from './config';
export { ApiError, toApiError, LEAK_PATTERNS } from './api/errors';

// ---- Observability (Phase F) ------------------------------------------------
export {
  EVENT_TYPES, EventPayloadSchemas,
  isDeclaredEventType, validateEventStream
} from './domain/events';
export type { EventType, EventValidationIssue } from './domain/events';
export { Metrics, metrics } from './observability/metrics';
export type { TaskAttemptRecord, AppendEventInput } from './persistence/contracts';
export type { ErrorBody, ErrorCategory } from './api/errors';
