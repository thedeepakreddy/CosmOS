/**
 * The task handler port.
 *
 * A handler is given a task and returns an outcome; it never touches task state
 * directly. That separation is what makes the queue durable: transitions happen
 * in one place, so there is no path by which a handler leaves a row in a state
 * the orchestrator does not understand.
 *
 * Handlers live in `research-core`, which is where research knowledge belongs.
 * Orchestration knows how to run work, not what the work means.
 */
import type { Task, TaskOutcome, TaskType } from "@research-os/contracts";
import type { Logger } from "@research-os/observability";

export interface TaskContext {
  readonly task: Task;
  readonly projectId: string;
  readonly workerId: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /**
   * Fraction of the run's tightest budget ceiling already spent, in [0,1].
   *
   * Computed once per tick and handed to every task in the batch. Handlers pass
   * it to the model router, which trades model strength for reach as a run
   * approaches a ceiling — so a run finishes with a weaker answer rather than
   * running out of budget with nothing to show.
   */
  readonly budgetPressure: number;
  /**
   * Extends this task's lease. A handler doing genuinely long work calls it so
   * the lease does not lapse and the task get handed to a second worker while
   * the first is still running.
   */
  heartbeat(): Promise<void>;
}

export interface TaskHandler {
  readonly type: TaskType;
  /** Lease duration for this task type. Long-running kinds ask for more. */
  readonly leaseMs?: number;
  handle(context: TaskContext): Promise<TaskOutcome>;
}

export class TaskHandlerRegistry {
  readonly #handlers = new Map<TaskType, TaskHandler>();

  register(handler: TaskHandler): this {
    this.#handlers.set(handler.type, handler);
    return this;
  }

  registerAll(handlers: readonly TaskHandler[]): this {
    for (const handler of handlers) this.register(handler);
    return this;
  }

  get(type: TaskType): TaskHandler | undefined {
    return this.#handlers.get(type);
  }

  types(): TaskType[] {
    return [...this.#handlers.keys()];
  }
}
