import { v4 as uuidv4 } from 'uuid';
import { ExecutionBudget, Task } from '../domain/types';
import { ClaimTicket, Stores } from '../persistence/contracts';
import { createSqliteStores } from '../persistence/sqlite';
import { CURRENT_WORKER_ID } from '../runtime/WorkerIdentity';
import { DAGValidator } from './DAGValidator';
import { AgentExecutor } from './Executor';
import { validateExecutorResult } from './executorResult';
import { NON_TERMINAL_RUN_STATES } from '../domain/stateMachines';
import { metrics } from '../observability/metrics';

/**
 * Task concurrency used when a run declares no budget at all.
 *
 * Phase A note, still true: concurrency is read from `budget.maxAgents`, which
 * also means "maximum distinct agent definitions". That conflation is a known
 * P1 defect. Phase B did NOT redesign the knob -- but it did make the ceiling
 * real ACROSS processes (see SqliteTaskStore.claim), where it was previously
 * per-process only.
 */
export const DEFAULT_MAX_CONCURRENCY = 10;

/** Default lease duration. A claim survives this long without renewal. */
export const DEFAULT_LEASE_MS = 30_000;

/**
 * How many times a task may be reclaimed after a worker death, beyond its
 * ordinary retry budget, before it is failed permanently.
 *
 * B11: without this, a task that reliably kills its worker is re-dispatched
 * forever. `attempt` counts every execution (retries AND reclaims), so the cap
 * is expressed against it.
 */
export const MAX_RECLAIM_ATTEMPTS = 3;

/**
 * Phase C: retry backoff.
 *
 * v0.1 requeued a failed task straight to READY -- measured inter-attempt gaps
 * of 0-2ms, i.e. a hot loop against whatever just failed. Delay grows
 * exponentially with the retry number and carries jitter so a wave of tasks
 * failing together does not retry in lockstep.
 */
export const RETRY_BASE_DELAY_MS = 100;
export const RETRY_MAX_DELAY_MS = 30_000;

export function retryDelayMs(retryNumber: number, random: () => number = Math.random): number {
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, retryNumber - 1));
  const capped = Math.min(exponential, RETRY_MAX_DELAY_MS);
  // Full jitter over [capped/2, capped].
  return Math.floor(capped / 2 + random() * (capped / 2));
}

const BUDGET_COUNT_FIELDS: Array<keyof ExecutionBudget> = [
  'maxAgents',
  'maxTasks',
  'maxRunDurationMs',
  'maxModelCalls',
  'maxToolCalls',
  'maxCostUsd'
];

/**
 * A3 (Phase A, preserved): reject structurally invalid budgets.
 * 0 means "zero allowed", NOT "unset". Only `undefined` means unset.
 */
function validateBudget(budget: ExecutionBudget | undefined): void {
  if (!budget) return;
  for (const field of BUDGET_COUNT_FIELDS) {
    const value = budget[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`BUDGET_INVALID: ${field} must be a number`);
    }
    if (value < 0) {
      throw new Error(`BUDGET_INVALID: ${field} must not be negative`);
    }
  }
}

export interface SupervisorOptions {
  stores?: Stores;
  workerId?: string;
  leaseMs?: number;
  /** Injectable clock, so lease expiry can be driven deterministically in tests. */
  now?: () => number;
}

export class Supervisor {
  private readonly stores: Stores;
  readonly workerId: string;
  private readonly leaseMs: number;
  private readonly now: () => number;

  /**
   * One pending re-evaluation timer per run.
   *
   * Reclaim is lease-based, so a worker that adopts a run with healthy leases
   * has nothing to do *yet*. Without a wake-up, abandoned work would only be
   * reclaimed if someone polled from outside. This schedules a single timer at
   * the earliest lease expiry, which is bounded work -- it is NOT the Phase D
   * scheduler redesign.
   */
  private reclaimTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * In-flight executions owned by THIS worker, keyed by `runId|taskId|fence`.
   *
   * Phase C: cancelling a run aborts these signals, so work actually stops
   * instead of running to completion and trying to write into a finished run.
   * Only this worker's executions are here -- another process aborts its own,
   * and the fencing check protects the database either way.
   */
  private inFlight: Map<string, AbortController> = new Map();

  /**
   * Correlation id for the operation currently being processed. Set by the
   * public lifecycle methods so every event they cause is traceable to one
   * originating action.
   */
  private currentCorrelationId: string | undefined;

  constructor(private executor: AgentExecutor, options: SupervisorOptions = {}) {
    this.stores = options.stores ?? createSqliteStores();
    this.workerId = options.workerId ?? CURRENT_WORKER_ID;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Phase F: record that a run was created.
   *
   * The v0.1 schema comment advertised `run.created` and nothing ever emitted
   * it, so the very first thing that happened to a run was invisible.
   */
  recordRunCreated(runId: string, goal: string, taskCount: number, correlationId?: string): void {
    this.emitEvent(runId, 'run.created', { goal, taskCount }, { correlationId });
  }

  /** Wall-clock duration of a run so far, when it has started. */
  private runDurationMs(runId: string): number | undefined {
    const run = this.stores.runs.getMeta(runId);
    if (!run?.startedAt) return undefined;
    return Math.max(0, this.now() - new Date(run.startedAt).getTime());
  }

  /** Run `fn` with a correlation id attached to every event it causes. */
  private withCorrelation<T>(correlationId: string | undefined, fn: () => T): T {
    const previous = this.currentCorrelationId;
    this.currentCorrelationId = correlationId ?? uuidv4();
    try {
      return fn();
    } finally {
      this.currentCorrelationId = previous;
    }
  }

  // ==========================================================================
  // B9: start / resume / recover are three distinct operations.
  //
  // v0.1 routed all three through startRun, which "recovered" by resetting every
  // RUNNING task to READY. Calling start twice therefore re-dispatched in-flight
  // work, and a second process booting stole a healthy worker's tasks. Both are
  // gone: there is no blind RUNNING -> READY reset anywhere in Phase B.
  // ==========================================================================

  /**
   * Begin a run that has not started. Valid only from CREATED.
   *
   * Idempotent by design: calling start on an already-RUNNING run is accepted
   * and simply drives a scheduling pass. It never redispatches in-flight work,
   * because dispatch now requires winning an atomic claim, and a task held under
   * a live lease cannot be claimed.
   */
  async startRun(runId: string, correlationId?: string): Promise<void> {
    return this.withCorrelation(correlationId, () => {
    const run = this.stores.runs.get(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');

    if (run.state === 'RUNNING') {
      // Already started. Safe no-op plus a scheduling pass.
      this.evaluateRun(runId, correlationId);
      return;
    }
    if (run.state === 'PAUSED' || run.state === 'PAUSING') {
      throw new Error('INVALID_STATE_TRANSITION: use resumeRun for a paused run');
    }
    if (run.state !== 'CREATED') {
      throw new Error('INVALID_STATE_TRANSITION');
    }

    this.admitRun(runId);
    });
  }

  /** Resume a paused run. Not crash recovery -- that is recoverRun. */
  async resumeRun(runId: string, correlationId?: string): Promise<void> {
    return this.withCorrelation(correlationId, () => {
    const run = this.stores.runs.get(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (run.state === 'RUNNING') {
      this.evaluateRun(runId, correlationId);
      return;
    }
    if (run.state !== 'PAUSED' && run.state !== 'PAUSING') {
      throw new Error('INVALID_STATE_TRANSITION: run is not paused');
    }

    validateBudget(run.budget);
    // PAUSING is included deliberately: Phase A found that a crash while pausing
    // stranded the run permanently, because nothing accepted that state.
    if (!this.stores.runs.compareAndSetState(runId, ['PAUSED', 'PAUSING'], 'RUNNING')) {
      // Someone else resumed first; their pass is already scheduling.
      return;
    }
    this.emitEvent(runId, 'run.resumed', {});
    this.evaluateRun(runId, this.currentCorrelationId);
    });
  }

  /**
   * B8: adopt a run whose worker may have died.
   *
   * This does NOT reset anything. It only drives a scheduling pass; any task
   * still held under a live lease is untouchable, and only genuinely abandoned
   * work (RUNNING with an expired lease) becomes claimable.
   */
  async recoverRun(runId: string, correlationId?: string): Promise<void> {
    return this.withCorrelation(correlationId, () => {
    const run = this.stores.runs.get(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (run.state !== 'RUNNING' && run.state !== 'PAUSING') {
      throw new Error('INVALID_STATE_TRANSITION: only a running run can be recovered');
    }
    this.emitEvent(runId, 'run.recovering', {});
    this.evaluateRun(runId, this.currentCorrelationId);
    });
  }

  private admitRun(runId: string): void {
    const run = this.stores.runs.get(runId)!;
    validateBudget(run.budget);

    if (run.taskGraph) {
      if (run.budget?.maxTasks !== undefined && run.taskGraph.tasks.length > run.budget.maxTasks) {
        throw new Error('BUDGET_EXCEEDED: maxTasks limit reached');
      }
      if (run.budget?.maxAgents !== undefined) {
        const uniqueAgents = new Set(run.taskGraph.tasks.map((t) => t.agentDefinitionId));
        if (uniqueAgents.size > run.budget.maxAgents) {
          throw new Error('BUDGET_EXCEEDED: maxAgents limit reached');
        }
      }
      DAGValidator.validate(run.taskGraph);
    }

    // CAS: exactly one caller can take a run out of CREATED, so a double start
    // cannot produce two admission passes.
    const started = this.stores.runs.compareAndSetState(runId, ['CREATED'], 'RUNNING', {
      startedAt: run.startedAt || new Date(this.now()).toISOString()
    });
    if (!started) {
      // Lost the race; the winner is already scheduling.
      this.evaluateRun(runId, this.currentCorrelationId);
      return;
    }

    this.emitEvent(runId, 'run.started', {});
    this.evaluateRun(runId, this.currentCorrelationId);
  }

  async pauseRun(runId: string, correlationId?: string): Promise<void> {
    return this.withCorrelation(correlationId, () => {
    const run = this.stores.runs.get(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (run.state !== 'RUNNING') throw new Error('INVALID_STATE_TRANSITION');

    if (!this.stores.runs.compareAndSetState(runId, ['RUNNING'], 'PAUSING')) {
      throw new Error('INVALID_STATE_TRANSITION');
    }
    // Phase F: entering PAUSING is `run.pausing`. `run.paused` now means the
    // run has actually REACHED PAUSED -- v0.1 emitted it here, while tasks were
    // still running, so the event asserted something untrue.
    this.emitEvent(runId, 'run.pausing', {});
    this.evaluateRun(runId, this.currentCorrelationId);
    });
  }

  async cancelRun(runId: string, correlationId?: string): Promise<void> {
    return this.withCorrelation(correlationId, () => {
    const run = this.stores.runs.get(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (run.state === 'COMPLETED' || run.state === 'FAILED' || run.state === 'CANCELLED') {
      return; // Already terminal
    }
    // Phase C: terminate + drain atomically, THEN abort local executions.
    const outcome = this.stores.runs.terminate(
      runId,
      [...NON_TERMINAL_RUN_STATES],
      'CANCELLED',
      { completedAt: new Date(this.now()).toISOString() }
    );
    if (outcome) {
      this.clearReclaimTimer(runId);
      this.abortRun(runId, 'run cancelled');
      metrics.increment('agentos_runs_terminal_total', { state: 'CANCELLED' });
        this.emitEvent(runId, 'run.cancelled', {
        tasksDrained: outcome.drained,
        durationMs: this.runDurationMs(runId)
      });
    }
    });
  }

  /** Abort every in-flight execution this worker holds for a run. */
  private abortRun(runId: string, reason: string): void {
    for (const [key, controller] of this.inFlight) {
      if (key.startsWith(`${runId}|`)) controller.abort(new Error(reason));
    }
  }

  // ==========================================================================
  // Scheduling
  // ==========================================================================

  /**
   * Phase D: incremental evaluation.
   *
   * The v0.1 scheduler called `runs.get(runId)` on every task completion, which
   * hydrated every task and every dependency edge into JS objects, then resolved
   * dependencies with a nested scan. That is O(T + T*D) per completion and
   * O(T^2 * D) per run -- and because `tasks.run_id` was unindexed, the scan
   * cost grew with every task ever stored, in any run, forever.
   *
   * This version reads the run row alone and asks the database set-shaped,
   * indexed questions: how many tasks are in each state, which became
   * unblocked, which have a failed dependency, and what may be claimed now.
   *
   * Correctness is unchanged and still does not rest on any of this: dispatch
   * is settled by the atomic claim (Phase B), so a stale read can only cost a
   * wasted claim attempt, never a duplicate execution.
   */
  private evaluateRun(runId: string, correlationId?: string): void {
    const run = this.stores.runs.getMeta(runId);
    if (!run) return;
    const now = this.now();

    if (run.state === 'PAUSING') {
      if (this.stores.tasks.countLiveClaims(runId, now) === 0) {
        if (this.stores.runs.compareAndSetState(runId, ['PAUSING'], 'PAUSED')) {
          this.emitEvent(runId, 'run.paused', {}, { correlationId });
        }
      }
      return;
    }

    if (run.state !== 'RUNNING') return;

    const counts = this.stores.tasks.countByState(runId);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    if (total === 0) {
      if (this.stores.runs.terminate(runId, ['RUNNING'], 'COMPLETED', {
        completedAt: new Date(now).toISOString()
      })) {
        this.clearReclaimTimer(runId);
        metrics.increment('agentos_runs_terminal_total', { state: 'COMPLETED' });
        this.emitEvent(runId, 'run.completed', { durationMs: this.runDurationMs(runId) }, { correlationId });
      }
      return;
    }

    // Run-level deadline.
    if (run.budget?.maxRunDurationMs !== undefined && run.startedAt) {
      const elapsed = now - new Date(run.startedAt).getTime();
      if (elapsed > run.budget.maxRunDurationMs) {
        const outcome = this.stores.runs.terminate(runId, ['RUNNING'], 'TIMED_OUT', {
          completedAt: new Date(now).toISOString(),
          error: 'RUN_TIMEOUT'
        });
        if (outcome) {
          this.clearReclaimTimer(runId);
          this.abortRun(runId, 'run timed out');
          metrics.increment('agentos_runs_terminal_total', { state: 'TIMED_OUT' });
          this.emitEvent(runId, 'run.failed', {
            error: 'RUN_TIMEOUT', tasksDrained: outcome.drained,
            durationMs: this.runDurationMs(runId)
          }, { correlationId });
        }
        return;
      }
    }

    // Propagate dependency outcomes. Both sets come from indexed SQL rather
    // than a scan of the whole graph.
    for (const taskId of this.stores.tasks.findDependencyFailed(runId)) {
      // Phase F: a SKIPPED transition used to happen silently, so a reader of
      // the event stream could not tell why a task never ran.
      if (this.stores.tasks.setState({ runId, taskId }, 'SKIPPED')) {
        this.emitEvent(runId, 'task.skipped', { taskId }, { taskId, correlationId });
      }
    }
    for (const taskId of this.stores.tasks.findUnblocked(runId)) {
      if (this.stores.tasks.setState({ runId, taskId }, 'READY')) {
        this.emitEvent(runId, 'task.ready', { taskId }, { taskId, correlationId });
      }
    }

    // Re-tally after propagation.
    const after = this.stores.tasks.countByState(runId);
    const hasFailed = (after.FAILED ?? 0) > 0 || (after.TIMED_OUT ?? 0) > 0;
    const terminalCount =
      (after.SUCCEEDED ?? 0) + (after.FAILED ?? 0) + (after.SKIPPED ?? 0) +
      (after.TIMED_OUT ?? 0) + (after.CANCELLED ?? 0);
    const allCompleted = terminalCount === Object.values(after).reduce((a, b) => a + b, 0);

    if (hasFailed) {
      this.clearReclaimTimer(runId);
      // Phase C: terminating a run drains every task still in flight or waiting,
      // in the same transaction.
      const outcome = this.stores.runs.terminate(runId, ['RUNNING'], 'FAILED', {
        completedAt: new Date(now).toISOString(),
        error: 'TASK_FAILED'
      });
      if (outcome) {
        this.abortRun(runId, 'run failed');
        metrics.increment('agentos_runs_terminal_total', { state: 'FAILED' });
        this.emitEvent(runId, 'run.failed', {
          error: 'TASK_FAILED', tasksDrained: outcome.drained,
          durationMs: this.runDurationMs(runId)
        }, { correlationId });
      }
      return;
    }

    if (allCompleted) {
      this.clearReclaimTimer(runId);
      if (this.stores.runs.terminate(runId, ['RUNNING'], 'COMPLETED', {
        completedAt: new Date(now).toISOString()
      })) {
        this.emitEvent(runId, 'run.completed', { durationMs: this.runDurationMs(runId) }, { correlationId });
      }
      return;
    }

    this.dispatch(runId, run.budget?.maxAgents ?? DEFAULT_MAX_CONCURRENCY, correlationId);
    this.scheduleReclaimCheck(runId);
  }

  /**
   * Attempt to claim and execute work.
   *
   * Phase D: candidates come from one indexed query bounded by the number of
   * free slots, rather than from a full listByRun + JS filter. Every dispatch
   * decision is still settled by the atomic claim (Phase B), so a stale
   * candidate simply loses its claim -- it can never double-execute.
   */
  private dispatch(runId: string, maxConcurrency: number, correlationId?: string): void {
    const now = this.now();
    const live = this.stores.tasks.countLiveClaims(runId, now);
    const slots = maxConcurrency - live;
    if (slots <= 0) return;

    // Ask for a few more than we need: some candidates will lose their claim to
    // another worker, and a second round-trip costs more than a slightly wider
    // LIMIT.
    const candidates = this.stores.tasks.listClaimable(runId, now, slots * 2);

    let remaining = slots;
    for (const task of candidates) {
      if (remaining <= 0) break;

      const ticket = this.stores.tasks.claim({
        runId,
        taskId: task.id,
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        now: this.now(),
        maxConcurrent: maxConcurrency
      });

      // Claim lost: another worker owns it, or the run is at its ceiling.
      // The losing worker MUST NOT execute.
      if (!ticket) continue;

      remaining--;
      void this.executeClaimed(runId, task, ticket, correlationId);
    }
  }

  private async executeClaimed(
    runId: string,
    task: Task,
    ticket: ClaimTicket,
    correlationId?: string
  ): Promise<void> {
    const maxAttempts = task.retriesAllowed + 1 + MAX_RECLAIM_ATTEMPTS;
    if (ticket.attempt > maxAttempts) {
      // B11: a task that keeps killing its worker cannot be re-dispatched forever.
      this.stores.tasks.complete(ticket, {
        state: 'FAILED',
        error: `ATTEMPT_LIMIT_EXCEEDED: attempt ${ticket.attempt} exceeds ${maxAttempts}`,
        completedAt: new Date(this.now()).toISOString()
      });
      this.emitEvent(runId, 'task.failed', {
        taskId: task.id, attempt: ticket.attempt, fence: ticket.fence,
        error: 'ATTEMPT_LIMIT_EXCEEDED'
      }, { taskId: task.id, correlationId });
      this.evaluateRun(runId, correlationId);
      return;
    }

    const startedAtMs = this.now();
    const startedAtIso = new Date(startedAtMs).toISOString();

    // Phase G: a REAL, persisted agent instance.
    //
    // v0.1 fabricated `{ id: 'inst-<defId>', version: '1' }` inline on every
    // execution, so nothing recorded which definition version actually ran, for
    // which task, under which worker. Resolving the definition here also pins
    // the exact version -- and a missing definition is now a clear failure
    // rather than an execution against a phantom agent.
    const definition = this.stores.agents.get(task.agentDefinitionId);
    if (!definition) {
      this.stores.tasks.complete(ticket, {
        state: 'FAILED',
        error: `AGENT_DEFINITION_NOT_FOUND: ${task.agentDefinitionId}`,
        completedAt: startedAtIso
      });
      this.emitEvent(runId, 'task.failed', {
        taskId: task.id, attempt: ticket.attempt, fence: ticket.fence,
        error: `AGENT_DEFINITION_NOT_FOUND: ${task.agentDefinitionId}`
      }, { taskId: task.id, correlationId });
      this.evaluateRun(runId, correlationId);
      return;
    }

    const instance = this.stores.instances.create({
      runId,
      taskId: task.id,
      definitionId: definition.id,
      version: definition.version,
      workerId: this.workerId
    });
    this.stores.instances.transition(instance.id, ['CREATED'], 'ACTIVE');

    // Phase H: deliver anything addressed to this task before it runs. Marking
    // delivery is idempotent, so a reclaimed attempt still sees its inbox.
    const inbox = this.stores.messages.inboxFor(runId, task.id, task.agentDefinitionId);
    if (inbox.length > 0) {
      this.stores.messages.markDelivered(runId, inbox.map((m) => m.id));
    }

    // Phase F: one durable row per real execution. A retry used to overwrite the
    // task row, so earlier attempts left no trace and a retried task's
    // startedAt/completedAt were measured as identical.
    this.stores.events.beginAttempt({
      runId, taskId: task.id, attempt: ticket.attempt,
      fence: ticket.fence, workerId: this.workerId, startedAt: startedAtIso
    });

    this.emitEvent(runId, 'task.started', {
      taskId: task.id, attempt: ticket.attempt, fence: ticket.fence
    }, { taskId: task.id, correlationId });

    const inFlightKey = `${runId}|${task.id}|${ticket.fence}`;
    const controller = new AbortController();
    this.inFlight.set(inFlightKey, controller);

    let timeoutHandle: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let ownershipLost = false;

    let state: Task['state'] = 'FAILED';
    let output: unknown;
    let error: string | undefined;

    try {
      heartbeat = setInterval(() => {
        if (!this.stores.tasks.renewLease(ticket, this.leaseMs, this.now())) {
          // Phase C: losing the lease means another worker now owns this task.
          // Abort, so we stop burning resources on work whose result will be
          // rejected by the fencing check anyway.
          ownershipLost = true;
          if (heartbeat) clearInterval(heartbeat);
          controller.abort(new Error('lease lost'));
        }
      }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
      heartbeat.unref?.();

      const timeoutPromise = task.timeoutMs
        ? new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              // Phase C: the timeout aborts the executor as well as unblocking
              // the supervisor. v0.1 only did the latter, so timed-out work ran
              // on to completion in the background.
              controller.abort(new Error('TASK_TIMEOUT'));
              reject(new Error('TASK_TIMEOUT'));
            }, task.timeoutMs);
          })
        : null;

      const executePromise = this.executor.execute(
        instance,
        { ...task, attempt: ticket.attempt, fence: ticket.fence },
        {
          runId, taskId: task.id, attempt: ticket.attempt,
          agentInstanceId: instance.id, signal: controller.signal,
          // Phase H: context addressed to this task by other agents.
          inbox,
          send: (message) => {
            this.stores.messages.send({
              runId,
              type: message.type,
              fromInstanceId: instance.id,
              fromTaskId: task.id,
              toTaskId: message.toTaskId,
              toAgentDefinitionId: message.toAgentDefinitionId,
              payload: message.payload
            });
          }
        }
      );

      const raw = timeoutPromise
        ? await Promise.race([executePromise, timeoutPromise])
        : await executePromise;

      // Phase C: hold the executor to its contract instead of silently treating
      // anything that is not SUCCEEDED as a null-error failure.
      const checked = validateExecutorResult(raw);
      if (!checked.ok) {
        state = 'FAILED';
        error = checked.error;
      } else if (checked.result.status === 'SUCCEEDED') {
        state = 'SUCCEEDED';
        output = checked.result.output;
      } else {
        state = 'FAILED';
        error = checked.result.error ?? 'EXECUTOR_REPORTED_FAILURE';
      }
    } catch (e: any) {
      state = e?.message === 'TASK_TIMEOUT' ? 'TIMED_OUT' : 'FAILED';
      error = e?.message ? String(e.message) : 'EXECUTOR_THREW';
    } finally {
      // A2 (Phase A, preserved): timers are always cleared.
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      this.inFlight.delete(inFlightKey);
      // The instance's lifecycle ends with the execution that created it.
      this.stores.instances.transition(
        instance.id, ['ACTIVE', 'CREATED'],
        state === 'SUCCEEDED' ? 'TERMINATED' : 'FAILED',
        state === 'SUCCEEDED' ? undefined : error
      );
    }

    // B20 preserved: retriesAllowed = N still yields exactly N+1 executions.
    // Phase C widens WHICH outcomes are retryable: a timeout is the commonest
    // transient failure there is, and v0.1 ignored retriesAllowed for it entirely.
    const retryable = state === 'FAILED' || state === 'TIMED_OUT';
    const willRetry = retryable && ticket.retriesAttempted < task.retriesAllowed;
    const nextRetryNumber = ticket.retriesAttempted + 1;
    const backoff = willRetry ? retryDelayMs(nextRetryNumber) : undefined;

    // B7: the write is gated on still owning the claim. If the lease expired and
    // another worker reclaimed (bumping the fence), or the run terminated and
    // drained this task, this returns false and the result is discarded.
    const accepted = this.stores.tasks.complete(ticket, {
      state: state as 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT',
      output,
      error,
      completedAt: new Date(this.now()).toISOString(),
      requeueAsReady: willRetry,
      notBefore: backoff === undefined ? undefined : this.now() + backoff
    });

    const endedAtMs = this.now();
    const durationMs = Math.max(0, endedAtMs - startedAtMs);
    const endedAtIso = new Date(endedAtMs).toISOString();
    const attemptRef = { runId, taskId: task.id, attempt: ticket.attempt };
    const taskCtx = { taskId: task.id, correlationId };

    if (!accepted) {
      const reason = ownershipLost ? 'LEASE_LOST' : 'STALE_FENCE_OR_TERMINAL_RUN';
      this.stores.events.endAttempt(attemptRef, 'DISCARDED', endedAtIso, durationMs, reason);
      metrics.increment('agentos_task_attempts_total', { outcome: 'DISCARDED' });
      this.emitEvent(runId, 'task.result.discarded', {
        taskId: task.id, attempt: ticket.attempt, fence: ticket.fence, reason
      }, taskCtx);
    } else if (willRetry) {
      this.stores.events.endAttempt(attemptRef, state, endedAtIso, durationMs, error);
      metrics.increment('agentos_task_attempts_total', { outcome: 'RETRIED' });
      this.emitEvent(runId, 'task.retry.scheduled', {
        taskId: task.id, attempt: ticket.attempt, fence: ticket.fence,
        retry: nextRetryNumber, backoffMs: backoff ?? 0, error
      }, taskCtx);
    } else {
      this.stores.events.endAttempt(attemptRef, state, endedAtIso, durationMs, error);
      metrics.increment('agentos_task_attempts_total', { outcome: String(state) });
      metrics.observe('agentos_task_duration_ms', durationMs, { outcome: String(state) });
      this.emitEvent(runId, `task.${String(state).toLowerCase()}`, {
        taskId: task.id, attempt: ticket.attempt, fence: ticket.fence, durationMs, error
      }, taskCtx);
    }

    this.evaluateRun(runId, correlationId);
  }

  /**
   * Schedule one re-evaluation when the earliest live lease in this run expires,
   * so abandoned work becomes reclaimable without external polling.
   */
  /**
   * Schedule one re-evaluation at the next instant this run could have work:
   * the soonest live-lease expiry (its owner may have died) or retry-backoff
   * deadline. Phase D: resolved by a single aggregate query instead of loading
   * and scanning every task.
   */
  private scheduleReclaimCheck(runId: string): void {
    const now = this.now();
    const wakeAt = this.stores.tasks.nextWakeAt(runId, now);

    this.clearReclaimTimer(runId);
    if (wakeAt === null) return;

    const delay = Math.max(25, wakeAt - now + 25);
    const timer = setTimeout(() => {
      this.reclaimTimers.delete(runId);
      // A timer-fired pass (a lease lapsing, or a retry backoff expiring) is a
      // NEW causal origin, not part of whatever request started the run. It gets
      // its own correlation id so every event is attributable to some operation
      // -- never to nothing.
      this.evaluateRun(runId, uuidv4());
    }, delay);
    timer.unref?.();
    this.reclaimTimers.set(runId, timer);
  }

  private clearReclaimTimer(runId: string): void {
    const existing = this.reclaimTimers.get(runId);
    if (existing) {
      clearTimeout(existing);
      this.reclaimTimers.delete(runId);
    }
  }

  /** Release all pending timers and abort anything still in flight. Call on shutdown. */
  close(): void {
    for (const timer of this.reclaimTimers.values()) clearTimeout(timer);
    this.reclaimTimers.clear();
    for (const controller of this.inFlight.values()) {
      controller.abort(new Error('supervisor closed'));
    }
    this.inFlight.clear();
  }

  /**
   * Phase F: every event carries a correlation id.
   *
   * `correlationId` identifies the action that caused it -- a worker's run
   * operation, or an API request. `causationId` chains an event to the event
   * that produced it. Without either, the audit found a failed run impossible
   * to reconstruct from telemetry alone.
   */
  private emitEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
    options: { taskId?: string; correlationId?: string; causationId?: string } = {}
  ): string {
    metrics.increment('agentos_events_total', { type });
    const event = this.stores.events.append({
      runId,
      type,
      taskId: options.taskId,
      correlationId: options.correlationId ?? this.currentCorrelationId,
      causationId: options.causationId,
      timestamp: new Date(this.now()).toISOString(),
      payload: { runId, workerId: this.workerId, ...payload }
    });
    return event.id;
  }
}
