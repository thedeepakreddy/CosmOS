/**
 * The worker loop.
 *
 * Claim a lease, run the handler, record the outcome, repeat. Everything that
 * makes a research run survivable lives in the interaction between this loop and
 * the task table:
 *
 *   - **Nothing is held in process memory.** State is a row. A worker that dies
 *     mid-task loses at most that task's progress, and its lease lapses so
 *     another worker picks the row up.
 *   - **The lease is renewed while work is in flight.** Without renewal a
 *     genuinely slow task would be handed to a second worker while the first
 *     was still running it, and both would write.
 *   - **Every transition goes through the repository.** A handler returns an
 *     outcome and never touches task state, so there is no path by which a row
 *     ends up in a state the loop does not understand.
 *   - **The budget is checked before dispatch.** A run that has hit a ceiling
 *     stops, and says which ceiling.
 */
import type { EventType, ResearchBudget, Task, TaskOutcome } from "@research-os/contracts";
import { TaskOutcome as TaskOutcomeSchema } from "@research-os/contracts";
import type { EventBus } from "@research-os/events";
import { toLogError, type Logger, type MetricsRegistry, type Tracer } from "@research-os/observability";
import type { ResearchStore } from "@research-os/persistence";
import { newId, systemClock, toResearchError, type Clock } from "@research-os/shared";
import { checkBudget, type BudgetUsage, type BudgetVerdict } from "./budget.ts";
import type { TaskContext, TaskHandlerRegistry } from "./handler.ts";

export interface WorkerOptions {
  readonly store: ResearchStore;
  readonly handlers: TaskHandlerRegistry;
  readonly logger: Logger;
  readonly bus?: EventBus;
  readonly tracer?: Tracer;
  readonly metrics?: MetricsRegistry;
  readonly clock?: Clock;
  /** Identifies this worker in leases and logs. */
  readonly workerId?: string;
  readonly batchSize?: number;
  readonly defaultLeaseMs?: number;
  /** Pause between empty polls. */
  readonly idleDelayMs?: number;
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
}

export interface TickResult {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly parked: number;
  readonly budgetStopped: boolean;
}

export class Worker {
  readonly #store: ResearchStore;
  readonly #handlers: TaskHandlerRegistry;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;
  readonly #tracer: Tracer | undefined;
  readonly #metrics: MetricsRegistry | undefined;
  readonly #clock: Clock;
  readonly #workerId: string;
  readonly #batchSize: number;
  readonly #defaultLeaseMs: number;
  readonly #idleDelayMs: number;
  readonly #backoffMs: number;
  readonly #maxBackoffMs: number;

  #running = false;
  #stopping = false;

  constructor(options: WorkerOptions) {
    this.#store = options.store;
    this.#handlers = options.handlers;
    this.#logger = options.logger.child({ component: "worker" });
    this.#bus = options.bus;
    this.#tracer = options.tracer;
    this.#metrics = options.metrics;
    this.#clock = options.clock ?? systemClock;
    this.#workerId = options.workerId ?? `worker-${newId("task").slice(4, 12)}`;
    this.#batchSize = options.batchSize ?? 4;
    this.#defaultLeaseMs = options.defaultLeaseMs ?? 60_000;
    this.#idleDelayMs = options.idleDelayMs ?? 1000;
    this.#backoffMs = options.backoffMs ?? 2000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  get workerId(): string {
    return this.#workerId;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /**
   * One pass: reclaim abandoned leases, check the budget, claim, dispatch.
   *
   * Exposed separately from `run` so a test can drive the loop deterministically
   * one tick at a time, and so a serverless deployment can invoke a tick per
   * scheduled wake-up rather than holding a process open.
   */
  async tick(projectId?: string): Promise<TickResult> {
    // Crash recovery first: a task abandoned by a dead worker should be
    // reclaimed before new work is taken on, or a queue can starve behind rows
    // nobody is working.
    const reclaimed = await this.#store.tasks.reclaimExpiredLeases(this.#clock.isoNow());
    if (reclaimed.requeued > 0 || reclaimed.failed > 0) {
      this.#logger.info("Reclaimed expired leases", { requeued: reclaimed.requeued, failed: reclaimed.failed });
    }

    // Measured once per tick rather than per task: it changes slowly, and a
    // query per task would cost more than the routing decision saves.
    let budgetPressure = 0;
    if (projectId) {
      const verdict = await this.checkProjectBudget(projectId);
      if (!verdict.withinBudget) {
        await this.#stopForBudget(projectId, verdict);
        return { claimed: 0, completed: 0, failed: 0, parked: 0, budgetStopped: true };
      }
      budgetPressure = verdict.pressure;
    }

    const claimed = await this.#store.tasks.claim({
      workerId: this.#workerId,
      ...(projectId ? { projectId } : {}),
      max: this.#batchSize,
      leaseMs: this.#defaultLeaseMs,
      now: this.#clock.isoNow(),
    });
    if (claimed.length === 0) {
      return { claimed: 0, completed: 0, failed: 0, parked: 0, budgetStopped: false };
    }

    let completed = 0;
    let failed = 0;
    let parked = 0;

    // Tasks in a batch are independent by construction — the claim query only
    // returns rows whose dependencies have completed — so they run concurrently.
    const outcomes = await Promise.all(claimed.map(async (task) => this.#runTask(task, budgetPressure)));
    for (const kind of outcomes) {
      if (kind === "completed") completed++;
      else if (kind === "failed") failed++;
      else parked++;
    }

    return { claimed: claimed.length, completed, failed, parked, budgetStopped: false };
  }

  /** Runs until `stop()` is called. */
  async run(projectId?: string): Promise<void> {
    this.#running = true;
    this.#stopping = false;
    let consecutiveErrors = 0;

    this.#logger.info("Worker started", { workerId: this.#workerId, handlers: this.#handlers.types().length });

    while (!this.#stopping) {
      try {
        const result = await this.tick(projectId);
        consecutiveErrors = 0;
        if (result.budgetStopped) break;
        if (result.claimed === 0) await this.#clock.sleep(this.#idleDelayMs);
      } catch (error) {
        consecutiveErrors++;
        const delay = Math.min(this.#backoffMs * 2 ** (consecutiveErrors - 1), this.#maxBackoffMs);
        // A loop that dies on a transient database hiccup takes the whole run
        // with it, so the loop survives and backs off instead.
        this.#logger.error("Worker tick failed", { error: toLogError(error), consecutiveErrors, retryInMs: delay });
        await this.#clock.sleep(delay);
      }
    }

    this.#running = false;
    this.#logger.info("Worker stopped", { workerId: this.#workerId });
  }

  /** Asks the loop to finish its current tick and exit. */
  stop(): void {
    this.#stopping = true;
  }

  async #runTask(task: Task, budgetPressure: number): Promise<"completed" | "failed" | "parked"> {
    const handler = this.#handlers.get(task.type);
    const logger = this.#logger.child({ taskId: task.id, taskType: task.type, projectId: task.projectId });

    if (!handler) {
      // Not retryable: no amount of waiting registers a handler that was never
      // built, and retrying would burn every attempt to reach the same answer.
      await this.#store.tasks.fail(
        task.id,
        { code: "not_implemented", message: `No handler is registered for task type "${task.type}".`, retryable: false },
        0,
        this.#clock.isoNow(),
      );
      logger.error("No handler for task type", { taskType: task.type });
      return "failed";
    }

    const controller = new AbortController();
    const leaseMs = handler.leaseMs ?? this.#defaultLeaseMs;
    const renew = setInterval(() => {
      void this.#store.tasks
        .renewLease(task.id, task.leasedBy ?? "", leaseMs, this.#clock.isoNow())
        .catch((error: unknown) => logger.warn("Lease renewal failed", { error: toLogError(error) }));
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    renew.unref?.();

    const startedAt = this.#clock.now();
    try {
      const context: TaskContext = {
        task,
        projectId: task.projectId,
        workerId: this.#workerId,
        logger,
        signal: controller.signal,
        budgetPressure,
        heartbeat: async () => {
          await this.#store.tasks.renewLease(task.id, task.leasedBy ?? "", leaseMs, this.#clock.isoNow());
        },
      };

      const outcome = TaskOutcomeSchema.parse(
        this.#tracer
          ? await this.#tracer.withSpan("task", task.type, async (span) => {
              span.setAttributes({ taskId: task.id, projectId: task.projectId, attempt: task.attempts });
              return handler.handle(context);
            })
          : await handler.handle(context),
      );

      const kind = await this.#applyOutcome(task, outcome, logger);
      this.#metrics?.observe("task.duration_ms", this.#clock.now() - startedAt, { type: task.type });
      this.#metrics?.increment("task.outcome", { type: task.type, kind });
      return kind;
    } catch (thrown) {
      const error = toResearchError(thrown);
      await this.#store.tasks.fail(
        task.id,
        { code: error.code, message: error.message, retryable: error.retryable },
        backoffFor(task.attempts),
        this.#clock.isoNow(),
      );
      logger.error("Task threw", { error: toLogError(error), attempt: task.attempts, retryable: error.retryable });
      this.#metrics?.increment("task.outcome", { type: task.type, kind: "threw" });
      await this.#emit(task.projectId, "research.task.failed", {
        taskId: task.id, type: task.type, errorCode: error.code,
        errorMessage: error.message, willRetry: error.retryable && task.attempts < task.maxAttempts,
      });
      return "failed";
    } finally {
      clearInterval(renew);
      controller.abort();
    }
  }

  async #applyOutcome(task: Task, outcome: TaskOutcome, logger: Logger): Promise<"completed" | "failed" | "parked"> {
    const now = this.#clock.isoNow();

    switch (outcome.kind) {
      case "completed": {
        // Follow-ups and the completion commit together. Committing separately
        // would let a crash in between leave a finished task whose next steps
        // were never created — a run that stops for no visible reason.
        await this.#store.transaction(async (tx) => {
          if (outcome.followUps.length > 0) {
            const followUps = outcome.followUps as Task[];
            await tx.tasks.create(followUps);

            /*
             * Work that was waiting on this step now waits on what this step
             * produced.
             *
             * A planned DAG is written before the run, when nobody knows that
             * discovery will find eight sources. Without this, extraction would
             * become runnable the moment discovery completed and would run
             * against sources that had not been ingested yet — finding nothing,
             * and reporting that honestly, which is a correct answer to the
             * wrong question.
             */
            const waiting = await tx.tasks.dependents(task.id);
            const followUpIds = followUps.map((followUp) => followUp.id as string);
            for (const dependent of waiting) {
              await tx.tasks.addDependencies(dependent, followUpIds);
            }
          }
          await tx.tasks.complete(task.id, outcome.output, now);
        });
        await this.#emit(task.projectId, "research.task.completed", {
          taskId: task.id, type: task.type, durationMs: Math.max(0, this.#clock.now() - Date.parse(task.startedAt ?? now)),
        });
        return "completed";
      }

      case "failed": {
        const status = await this.#store.tasks.fail(
          task.id,
          { code: outcome.errorCode, message: outcome.errorMessage, retryable: outcome.retryable },
          backoffFor(task.attempts),
          now,
        );
        logger.warn("Task failed", { errorCode: outcome.errorCode, retryable: outcome.retryable, status });
        await this.#emit(task.projectId, "research.task.failed", {
          taskId: task.id, type: task.type, errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage, willRetry: status === "pending",
        });
        return status === "pending" ? "parked" : "failed";
      }

      case "waiting_for_tool": {
        await this.#store.tasks.waitForTool(task.id, outcome.requestId, now);
        return "parked";
      }

      case "waiting_for_user": {
        await this.#store.tasks.waitForUser(task.id, outcome.prompt, now);
        return "parked";
      }
    }
  }

  /* ---------- Budget ---------- */

  async checkProjectBudget(projectId: string): Promise<BudgetVerdict> {
    const project = await this.#store.projects.findById(projectId);
    if (!project) {
      return { withinBudget: true, exceeded: [], pressure: 0, summary: "Project not found; nothing to enforce." };
    }
    return checkBudget(project.budget as ResearchBudget, await this.projectUsage(projectId));
  }

  async projectUsage(projectId: string): Promise<BudgetUsage> {
    const totals = await this.#store.runs.usageTotals(projectId);
    const counts = await this.#store.tasks.countByStatus(projectId);
    const sources = await this.#store.research.listSources(projectId, { limit: 1000 });

    return {
      modelCalls: totals.modelCalls,
      toolCalls: totals.toolCalls,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.costUsd,
      tasksCreated: Object.values(counts).reduce((total, count) => total + count, 0),
      sourcesDiscovered: sources.length,
      elapsedMs: await this.#elapsedSinceRunStart(projectId),
    };
  }

  /**
   * Wall clock spent on the *current* run, not the age of the project row.
   *
   * Measured from the most recent `research.started` event. Measuring from
   * `createdAt` instead looks equivalent and is not: a project created on
   * Monday, paused, and resumed on Friday would be four days old and would
   * blow a thirty-minute ceiling the instant it resumed — killing precisely the
   * long-lived research that resumability exists to support. Resuming emits a
   * fresh `research.started`, so the clock restarts with the run.
   *
   * Falls back to the project's creation time when no start has been recorded,
   * which is the case for a run whose very first tick this is.
   */
  async #elapsedSinceRunStart(projectId: string): Promise<number> {
    const events = await this.#store.events.read(projectId, { types: ["research.started"], limit: 200 });
    const latestStart = events.at(-1)?.occurredAt;
    if (latestStart) return Math.max(0, this.#clock.now() - Date.parse(latestStart));

    const project = await this.#store.projects.findById(projectId);
    return project ? Math.max(0, this.#clock.now() - Date.parse(project.createdAt)) : 0;
  }

  /**
   * Stops a run that has hit a ceiling.
   *
   * Outstanding tasks are cancelled and the project is failed with the specific
   * ceiling named. A run that quietly stopped would be indistinguishable from
   * one that finished.
   */
  async #stopForBudget(projectId: string, verdict: BudgetVerdict): Promise<void> {
    const now = this.#clock.isoNow();
    const cancelled = await this.#store.tasks.cancelAll(projectId, now);
    await this.#store.projects.updateStatus(projectId, "failed", {
      failureReason: `Budget exhausted. ${verdict.summary}`,
      updatedAt: now,
    });

    this.#logger.warn("Run stopped: budget exhausted", { projectId, cancelledTasks: cancelled, summary: verdict.summary });
    await this.#emit(projectId, "research.failed", { reason: verdict.summary, errorCode: "budget_exhausted" });
  }

  async #emit(projectId: string, type: EventType, payload: Record<string, unknown>): Promise<void> {
    if (!this.#bus) return;
    try {
      const event = await this.#store.events.append({ projectId, type, payload });
      await this.#bus.publish(event);
    } catch (error) {
      // Losing an event must not fail the task that produced it. History is
      // durable in the store; the bus is best-effort delivery on top of it.
      this.#logger.warn("Failed to emit event", { projectId, type, error: toLogError(error) });
    }
  }
}

/** Exponential backoff on task attempts, capped. */
export function backoffFor(attempts: number, baseMs = 2000, maxMs = 300_000): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs);
}
