/**
 * The research run lifecycle.
 *
 * A project moves through explicit states, and each transition is recorded as an
 * event. Two properties follow from that and both matter:
 *
 *   - **A run can be resumed.** Its entire state is rows — the project status,
 *     the task queue, the event log — so a process that dies mid-run is
 *     recovered by reading, not by replaying from the beginning.
 *   - **A stopped run always says why.** `completed`, `failed` and `paused` are
 *     different facts, and a run that simply stopped producing output would be
 *     indistinguishable from one that finished.
 */
import type { EventType, ProjectProgress, ProjectStatus } from "@research-os/contracts";
import type { EventBus } from "@research-os/events";
import type { ResearchStore } from "@research-os/persistence";
import { toLogError, type Logger } from "@research-os/observability";
import { err, systemClock, type Clock } from "@research-os/shared";

/**
 * Legal transitions.
 *
 * Enumerated rather than implied, so an illegal move — reviving a completed
 * project, say — fails loudly instead of leaving the run in a state nothing
 * knows how to interpret.
 */
const TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  draft: ["planning", "cancelled"],
  planning: ["running", "failed", "cancelled", "awaiting_input"],
  running: ["running", "awaiting_input", "paused", "completed", "failed", "cancelled"],
  awaiting_input: ["running", "paused", "cancelled", "failed"],
  paused: ["running", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export interface RunCoordinatorOptions {
  readonly store: ResearchStore;
  readonly logger: Logger;
  readonly bus?: EventBus;
  readonly clock?: Clock;
}

export class RunCoordinator {
  readonly #store: ResearchStore;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;
  readonly #clock: Clock;

  constructor(options: RunCoordinatorOptions) {
    this.#store = options.store;
    this.#logger = options.logger.child({ component: "run" });
    this.#bus = options.bus;
    this.#clock = options.clock ?? systemClock;
  }

  async transition(
    projectId: string,
    to: ProjectStatus,
    options: { reason?: string; force?: boolean } = {},
  ): Promise<void> {
    const project = await this.#store.projects.findById(projectId);
    if (!project) throw err.notFound("Project", projectId);

    if (project.status === to) return;
    if (!options.force && !canTransition(project.status, to)) {
      throw err.conflict(
        `A project cannot move from "${project.status}" to "${to}".`,
        { projectId, from: project.status, to },
      );
    }

    const now = this.#clock.isoNow();
    await this.#store.projects.updateStatus(projectId, to, {
      updatedAt: now,
      ...(to === "failed" ? { failureReason: options.reason ?? "Unspecified failure." } : {}),
      ...(to === "completed" ? { completedAt: now } : {}),
    });

    this.#logger.info("Run status changed", { projectId, from: project.status, to, reason: options.reason });

    // Two events: the specific lifecycle one where the vocabulary has it, and
    // the generic transition, so a client can follow status without knowing
    // every lifecycle event by name.
    const specific = statusEventType(to);
    if (specific) await this.#emit(projectId, specific, specificPayload(to, options.reason));
    await this.#emit(projectId, "research.project.status_changed", {
      from: project.status,
      to,
      ...(options.reason ? { reason: options.reason } : {}),
    });
  }

  /**
   * Decides whether a running project has finished.
   *
   * "No runnable work left" is the completion condition, not "every task
   * succeeded" — a run where some tasks failed but the rest produced a report is
   * a completed run with known gaps, and forcing it to `failed` would discard
   * findings that are perfectly good.
   */
  async settleIfFinished(projectId: string): Promise<ProjectStatus | null> {
    const project = await this.#store.projects.findById(projectId);
    if (!project || project.status !== "running") return null;

    if (await this.#store.tasks.hasRunnableWork(projectId)) return null;

    const counts = await this.#store.tasks.countByStatus(projectId);
    const completed = counts["completed"] ?? 0;
    const failed = counts["failed"] ?? 0;

    // Nothing completed at all means the run never got going; that is a
    // failure, not a thin success.
    if (completed === 0 && failed > 0) {
      await this.transition(projectId, "failed", { reason: `Every task failed (${failed} of ${failed}).` });
      return "failed";
    }

    await this.transition(projectId, "completed", {});
    if (failed > 0) {
      this.#logger.warn("Run completed with failed tasks", { projectId, completed, failed });
    }
    return "completed";
  }

  /** Aggregate counts for the status endpoint, so clients need no extra round trips. */
  async progress(projectId: string): Promise<ProjectProgress> {
    const project = await this.#store.projects.findById(projectId);
    const counts = await this.#store.tasks.countByStatus(projectId);
    const usage = await this.#store.runs.usageTotals(projectId);
    const [sources, evidence, claims, contradictions] = await Promise.all([
      this.#store.research.listSources(projectId, { limit: 1000 }),
      this.#store.research.listEvidence(projectId, { limit: 1000 }),
      this.#store.research.listClaims(projectId, { limit: 1000 }),
      this.#store.research.listContradictions(projectId, "open"),
    ]);

    return {
      tasksTotal: Object.values(counts).reduce((total, count) => total + count, 0),
      tasksCompleted: counts["completed"] ?? 0,
      tasksFailed: counts["failed"] ?? 0,
      tasksRunning: counts["running"] ?? 0,
      sourcesDiscovered: sources.length,
      sourcesProcessed: sources.filter((source) => source.status === "parsed" || source.status === "indexed").length,
      evidenceCount: evidence.length,
      claimsCount: claims.length,
      contradictionsOpen: contradictions.length,
      experimentsCompleted: 0,
      tokensUsed: usage.inputTokens + usage.outputTokens,
      costUsd: usage.costUsd,
      elapsedMs: project ? Math.max(0, this.#clock.now() - Date.parse(project.createdAt)) : 0,
    } as ProjectProgress;
  }

  /**
   * Prepares a project to continue after a restart.
   *
   * This is the resume path. Leases abandoned by dead workers are reclaimed and
   * the project is put back in `running`; the queue then holds everything
   * needed to carry on. Nothing is replayed, because nothing was held in memory.
   */
  async resume(projectId: string): Promise<{ resumed: boolean; requeued: number; failed: number; reason?: string }> {
    const project = await this.#store.projects.findById(projectId);
    if (!project) throw err.notFound("Project", projectId);

    if (project.status === "completed" || project.status === "cancelled") {
      return { resumed: false, requeued: 0, failed: 0, reason: `The project is ${project.status}.` };
    }

    const reclaimed = await this.#store.tasks.reclaimExpiredLeases(this.#clock.isoNow());
    if (!await this.#store.tasks.hasRunnableWork(projectId)) {
      return { resumed: false, requeued: reclaimed.requeued, failed: reclaimed.failed, reason: "No runnable work remains." };
    }

    if (project.status !== "running") {
      await this.transition(projectId, "running", { force: true });
    }
    this.#logger.info("Run resumed", { projectId, requeued: reclaimed.requeued, failedOnResume: reclaimed.failed });
    return { resumed: true, requeued: reclaimed.requeued, failed: reclaimed.failed };
  }

  async #emit(projectId: string, type: EventType, payload: Record<string, unknown>): Promise<void> {
    try {
      const event = await this.#store.events.append({ projectId, type, payload });
      await this.#bus?.publish(event);
    } catch (error) {
      this.#logger.warn("Failed to emit run event", { projectId, type, error: toLogError(error) });
    }
  }
}

/**
 * The lifecycle event for a status, where the contract declares one.
 *
 * `planning`, `paused` and `awaiting_input` have no dedicated event: they are
 * transitions rather than milestones, and `research.project.status_changed`
 * carries them. Inventing event types the contract does not declare would make
 * them invisible to a client subscribing from it.
 */
function statusEventType(status: ProjectStatus): EventType | null {
  switch (status) {
    case "running": return "research.started";
    case "completed": return "research.completed";
    case "failed": return "research.failed";
    case "cancelled": return "research.cancelled";
    default: return null;
  }
}

function specificPayload(status: ProjectStatus, reason: string | undefined): Record<string, unknown> {
  switch (status) {
    case "running": return { planVersion: 1 };
    case "completed": return { reportId: null, durationMs: 0, costUsd: 0 };
    case "failed": return { reason: reason ?? "Unspecified failure.", errorCode: "internal_error" };
    case "cancelled": return { reason: reason ?? "Cancelled." };
    /* c8 ignore next */
    default: return {};
  }
}
