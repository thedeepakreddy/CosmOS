/**
 * Building a running ResearchOS from configuration.
 *
 * This is the composition root: the one place that knows which persistence
 * engine, which model provider and which tools a deployment actually has. It
 * lives at layer 6 rather than inside an application because both the API and
 * the worker need exactly the same assembly, and a second copy would drift —
 * two processes quietly wired to different databases is a failure that takes a
 * long time to notice.
 *
 * Every optional capability is attempted and, where absent, left out; the
 * engine then reports it as a gap. A deployment with no model key still starts,
 * because refusing to boot would leave an operator with no API to ask why.
 */
import { InMemoryEventBus, type EventBus } from "@research-os/events";
import { createLogger, MetricsRegistry, Tracer, toLogError, type Logger } from "@research-os/observability";
import {
  createDatabase, createStore, databaseConfigFromEnv, describeDatabase, migrate,
  type Database, type DatabaseConfig, type ResearchStore,
} from "@research-os/persistence";
import {
  AnthropicProvider, GeminiProvider, ModelRouter, UnconfiguredModelProvider, pricingFromEnv,
  type ModelProvider, type PricingTable,
} from "@research-os/model-router";
import { LocalToolProvider, ToolRegistry, WebFetchTool } from "@research-os/tools";
import { SqlMemoryProvider, ResearchMemory } from "@research-os/memory";
import { ChunkRetriever } from "@research-os/retrieval";
import { IngestionPipeline } from "@research-os/ingestion";
import { ExecutorService, ExecutorToolProvider } from "@research-os/executors";
import { newId, readBoolean, readOptionalString, readString, systemClock, type EnvSource } from "@research-os/shared";
import { createResearchEngine, type ResearchEngine } from "./engine.ts";

export interface RuntimeConfig {
  readonly database: DatabaseConfig;
  readonly databaseDescription: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly logFormat: "json" | "pretty";
  /** Applies migrations at startup. Convenient locally, usually not in production. */
  readonly migrateOnStart: boolean;
  readonly anthropicApiKey: string | undefined;
  readonly geminiApiKey: string | undefined;
  readonly modelPricing: PricingTable;
  readonly tenantId: string | null;
}

export function loadRuntimeConfig(env: EnvSource = process.env): RuntimeConfig {
  const database = databaseConfigFromEnv(env);
  return {
    database,
    databaseDescription: describeDatabase(database),
    logLevel: readString(env, "RESEARCH_OS_LOG_LEVEL", "info") as RuntimeConfig["logLevel"],
    logFormat: readString(env, "RESEARCH_OS_LOG_FORMAT", "json") as RuntimeConfig["logFormat"],
    migrateOnStart: readBoolean(env, "RESEARCH_OS_MIGRATE_ON_START", true),
    anthropicApiKey: readOptionalString(env, "ANTHROPIC_API_KEY"),
    // GOOGLE_API_KEY is accepted as a fallback, but checked second: it is shared
    // with other Google services and so is the likelier to be set for an
    // unrelated reason.
    geminiApiKey: readOptionalString(env, "GEMINI_API_KEY") ?? readOptionalString(env, "GOOGLE_API_KEY"),
    modelPricing: pricingFromEnv(env),
    tenantId: readOptionalString(env, "RESEARCH_OS_TENANT_ID") ?? null,
  };
}

export interface Runtime {
  readonly config: RuntimeConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly store: ResearchStore;
  readonly bus: EventBus;
  readonly metrics: MetricsRegistry;
  readonly tracer: Tracer;
  readonly tools: ToolRegistry;
  readonly executors: ExecutorService;
  readonly engine: ResearchEngine;
  readonly startedAt: number;
  /** Capabilities this deployment lacks. Surfaced on /health. */
  readonly gaps: string[];
  close(): Promise<void>;
}

export interface BuildRuntimeOptions {
  /** Injected by tests, so the whole stack can run without a live provider. */
  readonly modelProvider?: ModelProvider;
  readonly logger?: Logger;
  /** Extra tools, for a deployment that provides search or other capabilities locally. */
  readonly extraTools?: ConstructorParameters<typeof LocalToolProvider>[0];
}

export async function buildRuntime(config: RuntimeConfig, options: BuildRuntimeOptions = {}): Promise<Runtime> {
  const logger = options.logger ?? createLogger({
    level: config.logLevel,
    format: config.logFormat,
    base: { service: "research-os" },
  });

  const db = await createDatabase(config.database);
  if (config.migrateOnStart) {
    const result = await migrate(db, { logger });
    logger.info("Database ready", { target: config.databaseDescription, applied: result.applied });
  }

  const store = createStore(db);
  const bus = new InMemoryEventBus({ logger });
  const metrics = new MetricsRegistry();
  const tracer = new Tracer({ clock: systemClock });

  /* ---------- Model providers ---------- */

  /*
   * Each configured vendor is registered independently.
   *
   * Not `else if`: a deployment holding two keys should get two providers, and
   * that is not merely additive. Independent verification and debate judging
   * require a second *provider*, not a second model — a review by the same
   * vendor that wrote the artifact is a self-review, and the router reports it
   * as one. Two keys is the only configuration in which that gap closes.
   */
  const providers: ModelProvider[] = [];
  if (options.modelProvider) {
    providers.push(options.modelProvider);
  } else {
    const configured: { name: string; build: () => ModelProvider }[] = [];
    if (config.anthropicApiKey) {
      const apiKey = config.anthropicApiKey;
      configured.push({ name: "Anthropic", build: () => new AnthropicProvider({ apiKey, pricing: config.modelPricing }) });
    }
    if (config.geminiApiKey) {
      const apiKey = config.geminiApiKey;
      configured.push({ name: "Gemini", build: () => new GeminiProvider({ apiKey, pricing: config.modelPricing }) });
    }
    for (const { name, build } of configured) {
      try {
        providers.push(build());
      } catch (error) {
        // Almost always a model with no configured price. Logged rather than
        // thrown, so the operator gets a process that can tell them what is
        // wrong — and one vendor's bad pricing does not take down the other.
        logger.error(`${name} provider could not be configured`, { error: toLogError(error) });
      }
    }
  }
  if (providers.length === 0) {
    logger.warn("No model provider is configured; research tasks will fail until one is", {
      hint: "Set ANTHROPIC_API_KEY or GEMINI_API_KEY, together with RESEARCH_OS_MODEL_PRICING.",
    });
    // A placeholder so the router can be built and the process can start.
    // Every call through it fails with the reason and the fix, rather than with
    // an internal detail of whatever stood in for a real provider.
    providers.push(new UnconfiguredModelProvider());
  }

  const router = new ModelRouter({
    providers,
    logger,
    metrics,
    tracer,
    onModelCall: async (record) => {
      await store.runs.recordModelCall({
        id: newId("modelCall"),
        projectId: null,
        agentRunId: null,
        provider: record.provider,
        model: record.model,
        taskKind: record.taskKind,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cachedInputTokens: record.cachedInputTokens,
        costUsd: record.costUsd,
        latencyMs: record.latencyMs,
        stopReason: record.stopReason,
        succeeded: record.succeeded,
        errorMessage: record.errorMessage,
        traceId: null,
        createdAt: new Date().toISOString(),
      });
    },
  });

  /* ---------- Tools, including anything an executor attaches ---------- */

  const executors = new ExecutorService({ repository: store.executors });
  const tools = new ToolRegistry({
    providers: [
      new LocalToolProvider([new WebFetchTool(), ...(options.extraTools ?? [])]),
      // Executors bring capabilities ResearchOS cannot implement itself —
      // a browser, a terminal, a filesystem — without either side importing
      // the other.
      new ExecutorToolProvider({ service: executors, tools: [] }),
    ],
    logger,
    metrics,
    tracer,
    onToolCall: async (report) => {
      await store.runs.recordToolCall({
        id: newId("modelCall"),
        projectId: report.projectId,
        agentRunId: report.agentRunId,
        toolId: report.toolId,
        capability: report.capability,
        input: report.input,
        output: report.output,
        status: report.status,
        errorMessage: report.errorMessage,
        durationMs: report.durationMs,
        executorId: null,
        traceId: null,
        createdAt: new Date().toISOString(),
      });
    },
  });
  await tools.refresh();

  const engine = createResearchEngine({
    store,
    router,
    logger,
    clock: systemClock,
    bus,
    tracer,
    tools,
    memory: new ResearchMemory({
      provider: new SqlMemoryProvider({ repository: store.memory }),
      tenantId: config.tenantId,
      application: "research-os",
    }),
    retriever: new ChunkRetriever({ repository: store.research, router }),
    ingestion: new IngestionPipeline({ tools }),
  });

  const gaps = engine.capabilityGaps();
  if (gaps.length > 0) logger.warn("Starting with capability gaps", { gaps });

  return {
    config, logger, db, store, bus, metrics, tracer, tools, executors, engine,
    startedAt: Date.now(),
    gaps,
    close: async () => {
      await db.close();
    },
  };
}
