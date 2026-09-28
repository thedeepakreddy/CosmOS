/**
 * The composition root.
 *
 * Everything below this file is a port with an adapter; this is where they are
 * chosen and connected. It is the only place that knows which persistence
 * engine, which model provider and which tools a deployment actually has — and
 * therefore the only place that needs changing to swap any of them.
 *
 * `createResearchEngine` is deliberately explicit about absent capabilities.
 * A deployment with no search tool, no embedding provider and no experiment
 * sandbox is a valid deployment; it simply produces research with recorded gaps
 * instead of failing to start.
 */
import type { ResearchPreferences, TaskType } from "@research-os/contracts";
import { TaskHandlerRegistry, Worker, RunCoordinator, type TaskHandler } from "@research-os/orchestration";
import type { ResearchDeps } from "./deps.ts";
import { planCreateHandler } from "./handlers/planning.ts";
import { sourceDiscoverHandler } from "./handlers/discovery.ts";
import { evidenceExtractHandler, sourceIngestHandler } from "./handlers/evidence.ts";
import {
  claimExtractHandler, claimScoreHandler, contradictionDetectHandler, critiqueHandler, verificationHandler,
} from "./handlers/claims.ts";
import { reportGenerateHandler } from "./handlers/report.ts";
import { evolutionDeriveHandler, hypothesisGenerateHandler, questionDecomposeHandler } from "./handlers/evolution.ts";
import { debateRunHandler } from "./handlers/debate.ts";
import { experimentDesignHandler, experimentRunHandler } from "./handlers/experiments.ts";
import { claimLinkEvidenceHandler, executorRequestHandler } from "./handlers/linking.ts";

/** Every handler this package provides, in the order work naturally flows. */
export function researchHandlers(deps: ResearchDeps): TaskHandler[] {
  return [
    planCreateHandler(deps),
    questionDecomposeHandler(deps),
    hypothesisGenerateHandler(deps),
    sourceDiscoverHandler(deps),
    sourceIngestHandler(deps),
    evidenceExtractHandler(deps),
    claimExtractHandler(deps),
    claimLinkEvidenceHandler(deps),
    verificationHandler(deps),
    claimScoreHandler(deps),
    contradictionDetectHandler(deps),
    critiqueHandler(deps),
    debateRunHandler(deps),
    experimentDesignHandler(deps),
    experimentRunHandler(deps),
    evolutionDeriveHandler(deps),
    executorRequestHandler(deps),
    reportGenerateHandler(deps),
  ];
}

export interface ResearchEngine {
  readonly deps: ResearchDeps;
  readonly handlers: TaskHandlerRegistry;
  readonly coordinator: RunCoordinator;
  /** A worker bound to these handlers. Several may be created and run together. */
  createWorker(options?: { workerId?: string; batchSize?: number }): Worker;
  /** Task types this deployment can actually execute. */
  supportedTaskTypes(): TaskType[];
  /** Capabilities that are absent, and what each means for a research run. */
  capabilityGaps(): string[];
}

export interface ResearchEngineOptions extends ResearchDeps {
  readonly defaultPreferences?: Partial<ResearchPreferences>;
}

export function createResearchEngine(options: ResearchEngineOptions): ResearchEngine {
  const deps: ResearchDeps = options;
  const handlers = new TaskHandlerRegistry().registerAll(researchHandlers(deps));
  const coordinator = new RunCoordinator({
    store: deps.store,
    logger: deps.logger,
    clock: deps.clock,
    ...(deps.bus ? { bus: deps.bus } : {}),
  });

  return {
    deps,
    handlers,
    coordinator,

    createWorker: (workerOptions = {}) =>
      new Worker({
        store: deps.store,
        handlers,
        logger: deps.logger,
        clock: deps.clock,
        ...(deps.bus ? { bus: deps.bus } : {}),
        ...(deps.tracer ? { tracer: deps.tracer } : {}),
        ...workerOptions,
      }),

    supportedTaskTypes: () => handlers.types(),

    /**
     * What this deployment cannot do.
     *
     * Surfaced at startup rather than discovered task by task, so an operator
     * learns that research will have gaps before a run produces them.
     */
    capabilityGaps: () => {
      const gaps: string[] = [];
      if (!deps.tools) {
        gaps.push("No tool registry: sources cannot be discovered or fetched.");
      } else if (deps.tools.listAll().every((tool) => tool.capability !== "web_search" && tool.capability !== "academic_search")) {
        gaps.push("No search tool registered: sources must be supplied as URLs, or discovery will be blocked.");
      }
      if (!deps.ingestion) gaps.push("No ingestion pipeline: sources cannot be parsed into citable chunks.");
      if (!deps.retriever) gaps.push("No retriever: evidence extraction cannot find passages.");
      if (!deps.experimentRunner) gaps.push("No experiment runner: experiments can be designed but not executed.");
      if (!deps.memory) gaps.push("No memory provider: lessons from earlier projects will not inform planning.");
      if (deps.router.describe().every((model) => !model.capabilities.includes("embedding"))) {
        gaps.push("No embedding model: retrieval is lexical only.");
      }
      if (new Set(deps.router.describe().map((model) => model.provider)).size < 2) {
        gaps.push("Only one model provider: verification and debate judging cannot be independent.");
      }
      return gaps;
    },
  };
}
