/**
 * Bridges the tool registry to external executors.
 *
 * ResearchOS asks the registry for `browser`; the registry routes to a provider;
 * this provider turns that into a capability request, and whichever executor
 * advertises it does the work somewhere else entirely. Neither side imports the
 * other — the whole coupling is the contract in `contracts/src/executor.ts`.
 *
 * **Why this polls rather than waits on an event.** The result usually arrives
 * at a different process from the one waiting: an API instance receives the POST
 * while a worker holds the task. An in-process event bus cannot cross that
 * boundary, and adding a broker to solve it would be infrastructure bought
 * before there is a problem. Polling the row is the honest mechanism, and the
 * database is already the coordination point for everything else here.
 *
 * For work measured in minutes rather than seconds, this is the wrong path:
 * park the task with `TaskRepository.waitForTool` and let the result resume it,
 * so nothing holds a worker slot while an executor thinks.
 */
import type { ToolCapability, ToolDescriptor } from "@research-os/contracts";
import type { ToolContext, ToolProvider } from "@research-os/tools";
import { err, systemClock, type Clock } from "@research-os/shared";
import type { ExecutorService } from "./service.ts";

export interface ExecutorToolProviderOptions {
  readonly service: ExecutorService;
  /** Tools this provider offers, and the capability each maps to. */
  readonly tools: readonly ToolDescriptor[];
  readonly clock?: Clock;
  readonly pollIntervalMs?: number;
  readonly defaultTimeoutMs?: number;
}

export class ExecutorToolProvider implements ToolProvider {
  readonly name = "executor";
  readonly #service: ExecutorService;
  readonly #tools: readonly ToolDescriptor[];
  readonly #clock: Clock;
  readonly #pollIntervalMs: number;
  readonly #defaultTimeoutMs: number;

  constructor(options: ExecutorToolProviderOptions) {
    this.#service = options.service;
    this.#tools = options.tools;
    this.#clock = options.clock ?? systemClock;
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  }

  /**
   * Only tools with a live executor behind them are listed.
   *
   * The registry uses this to decide what an agent may be offered, so a
   * capability with nothing connected simply does not appear — better than
   * offering a tool that will fail the moment it is called.
   */
  async listCapabilities(): Promise<ToolDescriptor[]> {
    const available: ToolDescriptor[] = [];
    for (const descriptor of this.#tools) {
      const executors = await this.#service.healthyExecutorsFor(descriptor.capability);
      if (executors.length > 0) available.push({ ...descriptor, provider: this.name });
    }
    return available;
  }

  async execute(toolId: string, input: unknown, context: ToolContext): Promise<unknown> {
    const descriptor = this.#tools.find((tool) => tool.id === toolId);
    if (!descriptor) throw err.notFound("Executor-backed tool", toolId);

    const timeoutMs = this.#defaultTimeoutMs;
    const request = await this.#service.requestCapability({
      projectId: context.projectId,
      taskId: context.taskId ?? null,
      capability: descriptor.capability,
      toolId,
      payload: input,
      timeoutMs,
    });

    return this.#awaitResult(request.id, descriptor.capability, timeoutMs, context.signal);
  }

  async #awaitResult(
    requestId: string,
    capability: ToolCapability,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const deadline = this.#clock.now() + timeoutMs;

    for (;;) {
      signal?.throwIfAborted();

      const request = await this.#service.findRequest(requestId);
      /* c8 ignore next */
      if (!request) throw err.internal(`Executor request ${requestId} disappeared while being awaited.`);

      if (request.status === "succeeded") return request.output;
      if (request.status === "failed" || request.status === "cancelled") {
        throw err.tool(request.errorMessage ?? `Executor request ${request.status}.`, { requestId, capability });
      }
      if (request.status === "timed_out" || this.#clock.now() >= deadline) {
        throw err.executorTimeout(capability, timeoutMs);
      }

      await this.#clock.sleep(Math.min(this.#pollIntervalMs, Math.max(0, deadline - this.#clock.now())), signal);
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const executors = await this.#service.listExecutors();
    const healthy = executors.filter((executor) => executor.status === "healthy" || executor.status === "registered");
    return healthy.length > 0
      ? { ok: true, detail: `${healthy.length} executor(s) attached` }
      : { ok: false, detail: "no executor is attached" };
  }
}
