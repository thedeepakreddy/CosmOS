/**
 * Shared machinery for task handlers.
 *
 * Two things every handler needs and should not each reinvent: loading the
 * project's preferences into an agent context, and emitting a domain event.
 *
 * `blocked` is here because it is the honest outcome that handlers most need and
 * are least likely to reach for. A capability that is not configured is a fact
 * about the deployment, not a transient error, so the task fails terminally with
 * a reason a report can print — rather than retrying three times and then
 * failing with a stack trace nobody can act on.
 */
import { ResearchPreferences, type EventType, type TaskOutcome } from "@research-os/contracts";
import { toLogError } from "@research-os/observability";
import type { TaskContext } from "@research-os/orchestration";
import { err } from "@research-os/shared";
import type { AgentContext } from "../agent.ts";
import type { ResearchDeps } from "../deps.ts";

/** Builds the agent context for a task, reading the project's own preferences. */
export async function agentContextFor(deps: ResearchDeps, task: TaskContext): Promise<AgentContext> {
  const project = await deps.store.projects.findById(task.projectId);
  if (!project) throw err.notFound("Project", task.projectId);

  return {
    projectId: task.projectId,
    taskId: task.task.id,
    store: deps.store,
    router: deps.router,
    logger: task.logger,
    clock: deps.clock,
    preferences: ResearchPreferences.parse({ ...deps.defaultPreferences, ...project.preferences }),
    ...(deps.tools ? { tools: deps.tools } : {}),
    ...(deps.memory ? { memory: deps.memory } : {}),
    ...(deps.tracer ? { tracer: deps.tracer } : {}),
    budgetPressure: task.budgetPressure,
    signal: task.signal,
  };
}

/**
 * A task that cannot proceed because a capability is absent.
 *
 * Not retryable: waiting does not configure an executor. The message is written
 * to be read by someone deciding what to fix, and ends up in the report's
 * limitations.
 */
export function blocked(what: string, reason: string): TaskOutcome {
  return {
    kind: "failed",
    errorCode: "unsupported",
    errorMessage: `BLOCKED: ${what} — ${reason}`,
    retryable: false,
  };
}

export function completed(output: unknown, followUps: readonly unknown[] = []): TaskOutcome {
  return { kind: "completed", output, followUps: [...followUps] };
}

/**
 * Emits a domain event. Never fails the task that produced it.
 *
 * `type` is the declared `EventType`, not a string. An earlier version took a
 * string and cast it away, which let handlers emit types outside the contract's
 * vocabulary — invisible to a client subscribing by type, and rejected by
 * `parseEvent`. The compiler now catches that.
 */
export async function emit(
  deps: ResearchDeps,
  projectId: string,
  type: EventType,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const event = await deps.store.events.append({ projectId, type, payload });
    await deps.bus?.publish(event);
  } catch (error) {
    deps.logger.warn("Failed to emit event", { projectId, type, error: toLogError(error) });
  }
}
