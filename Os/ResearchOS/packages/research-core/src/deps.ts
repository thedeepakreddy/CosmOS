/**
 * What every task handler is given.
 *
 * Assembled once at the composition root and passed down, so a handler declares
 * what it needs rather than reaching for a global. `tools`, `retriever`,
 * `ingestion`, `memory` and `experimentRunner` are optional because a deployment
 * may genuinely lack them — no executor attached, no embedding provider, no
 * sandbox — and a handler that needs a missing capability must report the task
 * blocked rather than pretend it did the work.
 */
import type { ResearchPreferences } from "@research-os/contracts";
import type { EventBus } from "@research-os/events";
import type { Logger, Tracer } from "@research-os/observability";
import type { ResearchStore } from "@research-os/persistence";
import type { ModelRouter } from "@research-os/model-router";
import type { ToolRegistry } from "@research-os/tools";
import type { ResearchMemory } from "@research-os/memory";
import type { ChunkRetriever } from "@research-os/retrieval";
import type { IngestionPipeline } from "@research-os/ingestion";
import type { ExperimentRunner } from "@research-os/experiments";
import type { Clock } from "@research-os/shared";

export interface ResearchDeps {
  readonly store: ResearchStore;
  readonly router: ModelRouter;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly bus?: EventBus;
  readonly tracer?: Tracer;
  readonly tools?: ToolRegistry;
  readonly memory?: ResearchMemory;
  readonly retriever?: ChunkRetriever;
  readonly ingestion?: IngestionPipeline;
  readonly experimentRunner?: ExperimentRunner;
  /** Used when a project's own preferences do not override. */
  readonly defaultPreferences?: Partial<ResearchPreferences>;
}
