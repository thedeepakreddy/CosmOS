/**
 * The tool registry — the single door every tool call goes through.
 *
 * Its job is not to run tools; providers do that. Its job is to make sure that
 * no call happens without a permission decision, a budget check and a record.
 * Concentrating that here means an agent cannot reach a tool by another path,
 * and a new tool inherits every control by construction rather than by its
 * author remembering to add them.
 *
 * Four controls, in the order they apply:
 *
 *   1. the permission policy (default-deny; see `permissions.ts`);
 *   2. the per-task call budget, so a looping agent cannot spend indefinitely;
 *   3. a concurrency limit per task;
 *   4. a timeout, so a hung external executor cannot wedge a research run.
 *
 * A denial is a returned outcome, not a thrown error. An agent asking for
 * something it may not have is ordinary, expected traffic — the agent is told
 * no, the refusal is recorded, and the run continues.
 */
import type { ToolCapability, ToolDescriptor, ToolPermissionPolicy } from "@research-os/contracts";
import type { Logger, MetricsRegistry, Tracer } from "@research-os/observability";
import { err, isResearchError, systemClock, toResearchError, type Clock } from "@research-os/shared";
import { evaluateToolPermission } from "./permissions.ts";
import type { ToolProvider } from "./provider.ts";
import type { ToolContext, ToolOutcome } from "./tool.ts";

/** What the registry reports about a completed call. Wired to the tool-call ledger. */
export interface ToolCallReport {
  readonly toolId: string;
  readonly capability: ToolCapability;
  readonly provider: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly agentRunId: string | null;
  readonly input: unknown;
  readonly output: unknown;
  readonly status: "succeeded" | "failed" | "denied" | "timed_out";
  readonly errorMessage: string | null;
  readonly durationMs: number;
}

export type ToolCallSink = (report: ToolCallReport) => void | Promise<void>;

export interface ToolRegistryOptions {
  readonly providers?: readonly ToolProvider[];
  readonly logger?: Logger;
  readonly tracer?: Tracer;
  readonly metrics?: MetricsRegistry;
  readonly clock?: Clock;
  readonly onToolCall?: ToolCallSink;
  readonly defaultTimeoutMs?: number;
}

interface TaskUsage {
  calls: number;
  inFlight: number;
}

export class ToolRegistry {
  readonly #providers: ToolProvider[] = [];
  /** toolId -> the provider that serves it. Refreshed by `refresh()`. */
  readonly #routes = new Map<string, { provider: ToolProvider; descriptor: ToolDescriptor }>();
  readonly #usage = new Map<string, TaskUsage>();
  readonly #logger: Logger | undefined;
  readonly #tracer: Tracer | undefined;
  readonly #metrics: MetricsRegistry | undefined;
  readonly #clock: Clock;
  readonly #onToolCall: ToolCallSink | undefined;
  readonly #defaultTimeoutMs: number;

  constructor(options: ToolRegistryOptions = {}) {
    this.#logger = options.logger;
    this.#tracer = options.tracer;
    this.#metrics = options.metrics;
    this.#clock = options.clock ?? systemClock;
    this.#onToolCall = options.onToolCall;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    for (const provider of options.providers ?? []) this.#providers.push(provider);
  }

  addProvider(provider: ToolProvider): this {
    this.#providers.push(provider);
    return this;
  }

  /**
   * Rebuilds the tool routing table from every provider.
   *
   * Called at start-up and whenever an executor registers or drops. The first
   * provider to claim a tool id keeps it, so a local implementation is not
   * silently displaced by a remote one appearing later.
   */
  async refresh(): Promise<void> {
    this.#routes.clear();
    for (const provider of this.#providers) {
      let descriptors: ToolDescriptor[];
      try {
        descriptors = await provider.listCapabilities();
      } catch (error) {
        this.#logger?.warn("Tool provider failed to list capabilities", {
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const descriptor of descriptors) {
        if (!this.#routes.has(descriptor.id)) this.#routes.set(descriptor.id, { provider, descriptor });
      }
    }
  }

  /** Every registered tool, regardless of policy. For operators, not for agents. */
  listAll(): ToolDescriptor[] {
    return [...this.#routes.values()].map((route) => route.descriptor);
  }

  /**
   * The tools a given policy actually permits.
   *
   * What an agent is shown and what it may call come from the same evaluation,
   * so a model is never offered a tool it would then be refused — which would
   * spend a model call to learn something the policy already knew.
   */
  listPermitted(policy: ToolPermissionPolicy): ToolDescriptor[] {
    return this.listAll().filter((descriptor) => evaluateToolPermission(descriptor, policy).allowed);
  }

  /** Permitted tools in the shape a model provider expects. */
  describeForModel(policy: ToolPermissionPolicy): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return this.listPermitted(policy).map((descriptor) => ({
      name: descriptor.id,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
    }));
  }

  /** Per-task counters. Reset when a task finishes so a retry starts clean. */
  resetTask(taskId: string): void {
    this.#usage.delete(taskId);
  }

  usageFor(taskId: string): { calls: number; inFlight: number } {
    const usage = this.#usage.get(taskId);
    return { calls: usage?.calls ?? 0, inFlight: usage?.inFlight ?? 0 };
  }

  async call(toolId: string, input: unknown, context: ToolContext, options: { timeoutMs?: number } = {}): Promise<ToolOutcome> {
    const startedAt = this.#clock.now();
    const route = this.#routes.get(toolId);

    if (!route) {
      return this.#finish(
        { toolId, provider: "unknown", capability: null, input, context },
        { status: "denied", errorCode: "not_found", errorMessage: `No registered provider serves tool "${toolId}".` },
        startedAt,
      );
    }

    const decision = evaluateToolPermission(route.descriptor, context.policy);
    if (!decision.allowed) {
      this.#logger?.warn("Tool call denied", { toolId, projectId: context.projectId, reason: decision.reason });
      return this.#finish(
        { toolId, provider: route.provider.name, capability: route.descriptor.capability, input, context },
        { status: "denied", errorCode: "tool_not_permitted", errorMessage: `Tool "${toolId}" is not permitted: ${decision.reason}` },
        startedAt,
      );
    }

    const taskKey = context.taskId ?? `project:${context.projectId}`;
    const usage = this.#usage.get(taskKey) ?? { calls: 0, inFlight: 0 };

    if (usage.calls >= context.policy.maxCallsPerTask) {
      return this.#finish(
        { toolId, provider: route.provider.name, capability: route.descriptor.capability, input, context },
        {
          status: "denied",
          errorCode: "budget_exhausted",
          errorMessage: `Task has used its ${context.policy.maxCallsPerTask} permitted tool calls. A task that needs more is looping, not researching.`,
        },
        startedAt,
      );
    }
    if (usage.inFlight >= context.policy.maxConcurrentCalls) {
      return this.#finish(
        { toolId, provider: route.provider.name, capability: route.descriptor.capability, input, context },
        {
          status: "denied",
          errorCode: "conflict",
          errorMessage: `Task already has ${usage.inFlight} tool calls in flight, at its concurrency limit.`,
        },
        startedAt,
      );
    }

    usage.calls += 1;
    usage.inFlight += 1;
    this.#usage.set(taskKey, usage);

    try {
      const output = await this.#execute(route, toolId, input, context, options.timeoutMs ?? this.#defaultTimeoutMs);
      this.#metrics?.increment("tool.call", { tool: toolId, provider: route.provider.name, status: "succeeded" });
      // Awaited rather than returned: the `finally` below releases the
      // concurrency slot, and without the await it would release while the
      // call was still being written to the ledger.
      return await this.#finish(
        { toolId, provider: route.provider.name, capability: route.descriptor.capability, input, context },
        { status: "succeeded", output },
        startedAt,
      );
    } catch (thrown) {
      const error = toResearchError(thrown);
      const status = error.code === "timeout" ? "timed_out" : error.code === "tool_not_permitted" ? "denied" : "failed";
      this.#metrics?.increment("tool.call", { tool: toolId, provider: route.provider.name, status });
      this.#logger?.warn("Tool call failed", { toolId, projectId: context.projectId, code: error.code, error: error.message });
      return await this.#finish(
        { toolId, provider: route.provider.name, capability: route.descriptor.capability, input, context },
        { status, errorCode: error.code, errorMessage: error.message },
        startedAt,
      );
    } finally {
      const current = this.#usage.get(taskKey);
      if (current) current.inFlight = Math.max(0, current.inFlight - 1);
    }
  }

  async #execute(
    route: { provider: ToolProvider; descriptor: ToolDescriptor },
    toolId: string,
    input: unknown,
    context: ToolContext,
    timeoutMs: number,
  ): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      // A separate controller so the timeout does not cancel the caller's own
      // signal, and the caller's abort still propagates into the tool.
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort(context.signal?.reason);
      context.signal?.addEventListener("abort", onCallerAbort, { once: true });

      const timeoutError = err.timeout(`Tool "${toolId}" exceeded ${timeoutMs}ms.`);
      let timer: ReturnType<typeof setTimeout> | undefined;

      /*
       * The timeout is a *race*, not just an abort signal.
       *
       * Signalling alone only works for a tool that checks the signal, and the
       * tools most likely to hang are exactly the ones least likely to: an
       * external executor on the far side of a dead socket, or a third-party
       * tool someone wrote in a hurry. Aborting is still worth doing — a
       * cooperative tool stops early and frees its resources — but the registry
       * must stop waiting either way, or one bad tool wedges the research run.
       */
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });

      try {
        return await Promise.race([
          route.provider.execute(toolId, input, { ...context, signal: controller.signal }),
          deadline,
        ]);
      } catch (error) {
        // An abort surfaces as whatever the aborter supplied; turn the timeout
        // case back into a timeout so the orchestrator retries rather than
        // treating a slow executor as a permanent failure.
        if (controller.signal.aborted && isResearchError(controller.signal.reason)) throw controller.signal.reason;
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        context.signal?.removeEventListener("abort", onCallerAbort);
      }
    };

    if (!this.#tracer) return run();
    return this.#tracer.withSpan("tool_call", `${route.provider.name}/${toolId}`, async (span) => {
      span.setAttributes({
        tool: toolId,
        provider: route.provider.name,
        capability: route.descriptor.capability,
        riskLevel: route.descriptor.riskLevel,
        projectId: context.projectId,
      });
      return run();
    });
  }

  async #finish(
    call: { toolId: string; provider: string; capability: ToolCapability | null; input: unknown; context: ToolContext },
    result:
      | { status: "succeeded"; output: unknown }
      | { status: "failed" | "denied" | "timed_out"; errorCode: string; errorMessage: string },
    startedAt: number,
  ): Promise<ToolOutcome> {
    const durationMs = this.#clock.now() - startedAt;

    await this.#onToolCall?.({
      toolId: call.toolId,
      // A call for an unknown tool has no capability; record it as the tool id
      // rather than inventing one, so the ledger stays truthful.
      capability: (call.capability ?? "http_request") as ToolCapability,
      provider: call.provider,
      projectId: call.context.projectId,
      taskId: call.context.taskId ?? null,
      agentRunId: call.context.agentRunId ?? null,
      input: call.input,
      output: result.status === "succeeded" ? result.output : null,
      status: result.status,
      errorMessage: result.status === "succeeded" ? null : result.errorMessage,
      durationMs,
    });

    return result.status === "succeeded"
      ? { status: "succeeded", output: result.output, durationMs, toolId: call.toolId, provider: call.provider }
      : { status: result.status, errorCode: result.errorCode, errorMessage: result.errorMessage, durationMs, toolId: call.toolId, provider: call.provider };
  }
}
