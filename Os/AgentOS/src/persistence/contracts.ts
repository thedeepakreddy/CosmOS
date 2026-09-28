import {
  AgentDefinition,
  AgentInstance,
  AgentInstanceState,
  AgentRun,
  Task,
  TaskState
} from '../domain/types';
import { AgentEvent } from '../domain/events';
import { MessageTypeSchema } from '../domain/types';
import { z } from 'zod';

/**
 * B22: persistence seam.
 *
 * Orchestration depends on these interfaces, not on SQLite. The SQLite adapter
 * in ./sqlite implements them. This is the minimum clean seam: enough that the
 * engine no longer imports a concrete store, without expanding Phase B into a
 * full persistence rewrite.
 */

/** Identifies a task. Task ids are unique WITHIN a run, never globally. */
export interface TaskRef {
  runId: string;
  taskId: string;
}

/**
 * Proof that a worker won an atomic claim on a specific task attempt.
 *
 * Every ownership-sensitive write must present a ticket. A write whose fence no
 * longer matches the row is rejected, which is what makes a late result from a
 * superseded worker harmless.
 */
export interface ClaimTicket extends TaskRef {
  workerId: string;
  /** Monotonic generation for this task. Incremented on every successful claim. */
  fence: number;
  /** Monotonic execution counter. Incremented on every successful claim. */
  attempt: number;
  /**
   * Retries CONSUMED as of this claim.
   *
   * Phase C: incremented when a claim re-executes a previously-run task, not
   * when a retry is merely queued. Queuing a retry that a run termination then
   * cancels used to inflate this counter above the real execution count.
   */
  retriesAttempted: number;
  /** Epoch ms after which this claim may be reclaimed by another worker. */
  leaseExpiresAt: number;
}

export interface ClaimOptions {
  runId: string;
  taskId: string;
  workerId: string;
  /** Lease duration in milliseconds. */
  leaseMs: number;
  /** Epoch ms "now", injected so tests can drive lease expiry deterministically. */
  now: number;
  /**
   * Global ceiling on simultaneously-live claims within the run. Enforced inside
   * the same atomic statement as the claim, so it holds across processes.
   * Omit for no ceiling.
   */
  maxConcurrent?: number;
}

/** Terminal outcome a claim holder may write. */
export interface TaskCompletion {
  state: Extract<TaskState, 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED'>;
  output?: unknown;
  error?: string;
  completedAt: string;
  /** When set, the task returns to READY for another attempt instead of terminating. */
  requeueAsReady?: boolean;
  /**
   * Phase C: epoch ms before which a requeued task must not be claimed again.
   * Durable backoff -- it holds across workers and survives a crash.
   */
  notBefore?: number;
}

export interface TaskStore {
  /**
   * Insert or update the non-ownership fields of a task.
   * Never touches owner_id, lease_expires_at, fence or attempt -- those move
   * only through claim/renew/complete/release, which are ownership-checked.
   */
  upsert(task: Task): void;

  get(ref: TaskRef): Task | null;
  listByRun(runId: string): Task[];

  /**
   * Phase E: a bounded page of a run's tasks.
   *
   * `GET /v1/runs/:id/tasks` previously returned every task in one unbounded
   * response, so a large run produced an arbitrarily large payload.
   * `cursor` is the last task_id of the previous page (keyset pagination --
   * stable under concurrent writes, unlike OFFSET).
   */
  pageByRun(runId: string, limit: number, cursor?: string): { tasks: Task[]; nextCursor: string | null };

  /** Total tasks in a run. */
  countByRun(runId: string): number;

  /** Set state without ownership (used for PENDING -> READY / SKIPPED transitions). */
  setState(ref: TaskRef, state: TaskState): boolean;

  /**
   * B4: atomically claim a task for execution.
   *
   * Succeeds only if the task is READY, or is RUNNING with an expired lease
   * (B8 reclaim). Increments fence and attempt. Returns null if the claim was
   * lost -- the caller MUST NOT execute the task in that case.
   */
  claim(options: ClaimOptions): ClaimTicket | null;

  /** B17: extend a lease. Fails if the ticket no longer owns the task. */
  renewLease(ticket: ClaimTicket, leaseMs: number, now: number): ClaimTicket | null;

  /**
   * B7: write a terminal result, gated on still holding the claim.
   * Returns false when the write was rejected as stale -- discard the result.
   */
  complete(ticket: ClaimTicket, completion: TaskCompletion): boolean;

  /** Count tasks in a run whose lease is still live. */
  countLiveClaims(runId: string, now: number): number;

  // ---- Phase D: incremental scheduling -------------------------------------
  // The scheduler used to reload the entire run -- every task and every
  // dependency -- on every task completion, then resolve dependencies in JS.
  // That is O(T + T*D) per completion and O(T^2 * D) per run. These replace it
  // with indexed, set-shaped queries that return only what the scheduler must
  // act on.

  /** Tally of task states in a run, as one GROUP BY. */
  countByState(runId: string): Record<string, number>;

  /**
   * PENDING/BLOCKED tasks whose dependencies have ALL succeeded -- i.e. the
   * tasks that just became runnable. Resolved in SQL, not by scanning.
   */
  findUnblocked(runId: string): string[];

  /** PENDING/BLOCKED tasks that have at least one FAILED dependency. */
  findDependencyFailed(runId: string): string[];

  /**
   * Tasks this worker may attempt to claim right now: READY and past any
   * backoff, plus RUNNING tasks whose lease has expired.
   */
  listClaimable(runId: string, now: number, limit: number): Task[];

  /**
   * Earliest future instant at which this run could have new work: the soonest
   * live-lease expiry (a worker may have died) or retry-backoff deadline.
   * Returns null when there is nothing to wait for.
   */
  nextWakeAt(runId: string, now: number): number | null;

  /** Tasks in a run that are RUNNING with an expired lease. */
  findReclaimable(runId: string, now: number): Task[];

  /**
   * Phase C: force every non-terminal task in a run to CANCELLED.
   *
   * Used when a run reaches a terminal state. Releases any lease, so a worker
   * still executing one of these tasks has its later `complete()` rejected --
   * the state no longer matches -- and its result is discarded rather than
   * landing in a finished run.
   *
   * Returns the number of tasks drained.
   */
  cancelNonTerminal(runId: string, completedAt: string): number;
}

export interface RunStore {
  save(run: AgentRun): void;
  /** Full run INCLUDING its hydrated task graph. Use sparingly -- it is O(tasks). */
  get(id: string): AgentRun | null;
  /**
   * Phase D: the run row WITHOUT hydrating its task graph.
   *
   * The scheduler needs run state and budget on every pass; it does not need
   * every task and edge materialised into JS objects. Reloading the full graph
   * per completion was the core of the quadratic cost.
   */
  getMeta(id: string): Omit<AgentRun, 'taskGraph'> | null;
  /**
   * Runs that have not reached a terminal state. Phase H: this is what a
   * standalone worker polls -- it has no HTTP request telling it what to do.
   */
  listActive(limit?: number): Array<Omit<AgentRun, 'taskGraph'>>;
  /** Compare-and-set the run state. Returns false if `from` no longer matched. */
  compareAndSetState(id: string, from: AgentRun['state'][], to: AgentRun['state'], patch?: Partial<AgentRun>): boolean;

  /**
   * Phase C: move a run to a terminal state AND drain its tasks, atomically.
   *
   * Doing these separately leaves a window in which a worker can claim a task in
   * an already-finished run. One transaction closes it.
   *
   * Returns null if the CAS lost; otherwise the number of tasks drained.
   */
  terminate(
    id: string,
    from: AgentRun['state'][],
    to: AgentRun['state'],
    patch?: Partial<AgentRun>
  ): { drained: number } | null;
}

export interface AgentStore {
  save(agent: AgentDefinition): void;
  /**
   * Phase G: a definition is keyed by (id, version).
   *
   * Omitting `version` returns the newest registered version. v0.1 upserted on
   * id alone, so registering a new version DESTROYED the old one and `version`
   * was a decorative string.
   */
  get(id: string, version?: string): AgentDefinition | null;
  listVersions(id: string): AgentDefinition[];
  /** Definitions whose capabilities cover every one required. */
  findByCapabilities(required: string[]): AgentDefinition[];
}

/** Phase G: the real agent instance lifecycle. */
export interface AgentInstanceStore {
  create(input: Omit<AgentInstance, 'id' | 'state' | 'createdAt'>): AgentInstance;
  /** Guarded transition; false when the instance was not in an expected state. */
  transition(id: string, from: AgentInstanceState[], to: AgentInstanceState, error?: string): boolean;
  get(id: string): AgentInstance | null;
  listByRun(runId: string): AgentInstance[];
  listByTask(runId: string, taskId: string): AgentInstance[];
}

/** Durable, per-run resource usage (Phase G). */
export interface RunUsage {
  runId: string;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Atomic budget accounting.
 *
 * The audit found maxModelCalls, maxToolCalls and maxCostUsd declared in the
 * budget schema with ZERO code references. Reservations here follow the same
 * compare-and-set discipline as the Phase B task claim, so a ceiling holds
 * ACROSS workers rather than being a read-then-act two processes can both pass.
 */
export interface UsageStore {
  get(runId: string): RunUsage;
  /** Atomically reserve one model call. False means the budget is exhausted. */
  reserveModelCall(runId: string, maxCalls?: number): boolean;
  /** Atomically reserve one tool call. False means the budget is exhausted. */
  reserveToolCall(runId: string, maxCalls?: number): boolean;
  /**
   * Record what a completed call actually consumed, and report whether the cost
   * ceiling is now breached (cost is only knowable after the call).
   */
  recordModelUsage(
    runId: string,
    usage: { inputTokens: number; outputTokens: number; costUsd?: number },
    maxCostUsd?: number
  ): { withinBudget: boolean; total: RunUsage };
  /** True when spend is already at or over the ceiling. */
  isCostExhausted(runId: string, maxCostUsd?: number): boolean;
}

/** An event to append. The sequence number and id are assigned by the store. */
export interface AppendEventInput {
  runId: string;
  type: string;
  payload: unknown;
  taskId?: string;
  /** The request or worker action that caused this event. */
  correlationId?: string;
  /** The event that caused this one. */
  causationId?: string;
  timestamp?: string;
}

/** One real execution of a task (Phase F). */
export interface TaskAttemptRecord {
  runId: string;
  taskId: string;
  attempt: number;
  fence: number;
  workerId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  outcome?: string;
  error?: string;
}

export interface EventStore {
  /** Appends with an atomically-assigned per-run sequence number. */
  append(input: AppendEventInput): AgentEvent;
  /** Events for a run, ordered by sequence. `afterSeq` supports tailing. */
  listByRun(runId: string, afterSeq?: number): AgentEvent[];
  listByTask(runId: string, taskId: string): AgentEvent[];

  beginAttempt(record: Omit<TaskAttemptRecord, 'endedAt' | 'durationMs' | 'outcome' | 'error'>): void;
  endAttempt(
    ref: { runId: string; taskId: string; attempt: number },
    outcome: string,
    endedAt: string,
    durationMs: number,
    error?: string
  ): void;
  listAttempts(runId: string, taskId?: string): TaskAttemptRecord[];

  /** Remove events belonging to runs that finished before the cutoff. */
  pruneBefore(cutoffIso: string): number;
}

// ---- Phase H: messaging ------------------------------------------------------

/** The vocabulary is declared once, as a zod enum, in ../domain/types. */
export type MessageType = z.infer<typeof MessageTypeSchema>;

export interface AgentMessage {
  id: string;
  runId: string;
  /** Monotonic within a run, like events: ordering and gaps are detectable. */
  seq: number;
  type: MessageType;
  /** The agent INSTANCE that sent it (Phase G), so it is attributable to a version. */
  fromInstanceId?: string;
  fromTaskId?: string;
  /** Addressed to a task, to any task of an agent definition, or broadcast when both are unset. */
  toTaskId?: string;
  toAgentDefinitionId?: string;
  payload: unknown;
  createdAt: string;
  deliveredAt?: string;
}

export type SendMessageInput = Omit<AgentMessage, 'id' | 'seq' | 'createdAt' | 'deliveredAt'>;

export interface MessageStore {
  send(input: SendMessageInput): AgentMessage;
  listByRun(runId: string, afterSeq?: number): AgentMessage[];
  /** Messages addressed to this task, its agent definition, or broadcast. */
  inboxFor(runId: string, taskId: string, agentDefinitionId?: string): AgentMessage[];
  markDelivered(runId: string, ids: string[]): number;
}

// ---- Phase H: shared rate limiting -------------------------------------------

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/** A rate-limit window shared by every worker, rather than per-process. */
export interface RateLimitStore {
  check(key: string, max: number, windowMs: number, now: number): RateLimitDecision;
  prune(now: number): number;
}

/** The bundle of stores an orchestration component needs. */
export interface Stores {
  runs: RunStore;
  tasks: TaskStore;
  agents: AgentStore;
  events: EventStore;
  /** Phase G */
  instances: AgentInstanceStore;
  usage: UsageStore;
  /** Phase H */
  messages: MessageStore;
  rateLimits: RateLimitStore;
}
